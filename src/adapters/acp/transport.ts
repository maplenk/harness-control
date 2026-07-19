/**
 * Generic ACP stdio transport (PLAN.md §10 — every numeric limit normative).
 *
 * One instance owns ONE child process speaking newline-delimited JSON-RPC 2.0
 * (ACP) on stdout/stdin:
 * - spawned in its OWN process group (`detached:true`) with an identity nonce
 *   in `HARNESS_SPAWN_ID` (§10.1) and a minimal env allowlist (§17.1);
 * - stdout is EXCLUSIVELY protocol: max line 1MiB, malformed JSON, and
 *   decoded-event queue overflow (1,000) are TERMINAL events (§10.2) — the
 *   transport fails fatal, rejects everything pending, and reaps the group;
 * - stderr is retained bounded (64KiB head + 64KiB tail) and redacted before
 *   it is exposed to any sink (§17.1);
 * - request timeouts: handshake 15s, turn 30min (both terminal);
 * - termination ladder: SIGTERM to the process group → 2s grace → SIGKILL to
 *   the process group → reap. The 3s CANCEL grace that precedes this ladder
 *   is driven by the session layer (`session.ts`), which owns turn state.
 *
 * The transport is protocol-mechanics only: framing, correlation, bounds,
 * lifecycle. ACP *semantics* (initialize/capability probe, sessions, prompts,
 * permission mediation) live in `session.ts`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BoundedQueue } from '../../lib/bounded-queue.js';
import {
  DEFAULT_REDACTION_CONFIG,
  redactText,
  type RedactionConfig,
} from '../../redaction/index.js';
import { AdapterError } from '../spi.js';

// ---------------------------------------------------------------------------
// Normative limits (PLAN §10.2). Defaults ARE the normative numbers; tests
// shrink them via `AcpTransportOptions.limits` to observe the behavior in
// bounded time while asserting these constants stay normative.
// ---------------------------------------------------------------------------
export interface AcpTransportLimits {
  /** §10.2: handshake timeout 15s. */
  readonly handshakeTimeoutMs: number;
  /** §10.2: turn timeout 30min. */
  readonly turnTimeoutMs: number;
  /** §10.2: max protocol line 1MiB (terminal on breach). */
  readonly maxLineBytes: number;
  /** §10.2: decoded-event queue 1,000 (overflow = terminal event + cleanup). */
  readonly queueCapacity: number;
  /** §10.2: stderr retention 64KiB head … */
  readonly stderrHeadBytes: number;
  /** … and 64KiB tail. */
  readonly stderrTailBytes: number;
  /** §10.2: cancel grace 3s (session layer drives it; the bound lives here). */
  readonly cancelGraceMs: number;
  /** §10.2: terminate grace 2s between SIGTERM and SIGKILL. */
  readonly terminateGraceMs: number;
  /**
   * NON-normative fairness knob: max decoded events dispatched per macrotask
   * tick. Bounds work per loop turn so a flooding child cannot starve the
   * host; a producer that outruns this drain fills the queue and trips the
   * normative 1,000 bound above.
   */
  readonly dispatchBatchSize: number;
}

export const ACP_TRANSPORT_LIMITS: AcpTransportLimits = {
  handshakeTimeoutMs: 15_000,
  turnTimeoutMs: 30 * 60_000,
  maxLineBytes: 1024 * 1024,
  queueCapacity: 1000,
  stderrHeadBytes: 64 * 1024,
  stderrTailBytes: 64 * 1024,
  cancelGraceMs: 3000,
  terminateGraceMs: 2000,
  dispatchBatchSize: 100,
};

/**
 * §17.1 minimal env allowlist for children. Only these keys are inherited
 * from the orchestrator's environment; credentials travel only via
 * `AcpSpawnSpec.env` when a provider requires them.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
];

// ---------------------------------------------------------------------------
// Options / surfaces
// ---------------------------------------------------------------------------
/** Lockfile-pinned executable to spawn (§10.1: exact resolved binary). */
export interface AcpSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** Extra child env (layered over the allowlisted inheritance). */
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpTransportOptions {
  readonly harnessId: string;
  readonly spawn: AcpSpawnSpec;
  /** §10.1 identity nonce; generated when omitted. Exposed as `spawnId`. */
  readonly spawnId?: string;
  readonly limits?: Partial<AcpTransportLimits>;
  readonly redaction?: RedactionConfig;
}

export interface JsonRpcErrorEnvelope {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcRespondBody =
  | { readonly result: unknown }
  | { readonly error: JsonRpcErrorEnvelope };

export type NotificationHandler = (method: string, params: unknown) => void;
/** Incoming agent→client request (e.g. session/request_permission). */
export type IncomingRequestHandler = (
  id: number | string,
  method: string,
  params: unknown,
) => void;
export type FatalHandler = (error: AdapterError) => void;

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Redacted, bounded stderr retention (§10.2, §17.1). */
export interface StderrSnapshot {
  readonly head: string;
  readonly tail: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  /** Which normative bound a timeout represents (→ AdapterError kind). */
  readonly timeoutKind?: 'handshake' | 'turn';
}

const NEWLINE = 0x0a;
type TransportState = 'created' | 'running' | 'closing' | 'closed';

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------
export class AcpStdioTransport {
  readonly harnessId: string;
  readonly limits: AcpTransportLimits;
  readonly spawnId: string;

  readonly #spec: AcpSpawnSpec;
  readonly #redaction: RedactionConfig;

  #state: TransportState = 'created';
  #child: ChildProcessWithoutNullStreams | undefined;
  #exitInfo: ExitInfo | undefined;
  #exitResolve: (() => void) | undefined;
  readonly #exitPromise: Promise<void>;
  #fatalError: AdapterError | undefined;

  // JSON-RPC correlation.
  #nextRequestId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  #onNotification: NotificationHandler | undefined;
  #onIncomingRequest: IncomingRequestHandler | undefined;
  #onFatal: FatalHandler | undefined;

  // Wire framing.
  #lineChunks: Buffer[] = [];
  #lineBytes = 0;

  // Decoded-event queue (§10.2 bound 1,000; overflow = terminal).
  readonly #queue: BoundedQueue<Record<string, unknown>>;
  #dispatchScheduled = false;
  #dispatchHandle: NodeJS.Immediate | undefined;

  // Bounded stderr (head + tail ring).
  #stderrHead: Buffer[] = [];
  #stderrHeadBytes = 0;
  #stderrTail: Buffer[] = [];
  #stderrTailBytes = 0;
  #stderrTotalBytes = 0;

  // Diagnostics (never throw on the hot path — count instead).
  #handlerErrorCount = 0;
  #unmatchedResponseCount = 0;

  readonly #timers = new Set<NodeJS.Timeout>();
  #closePromise: Promise<void> | undefined;

  constructor(options: AcpTransportOptions) {
    this.harnessId = options.harnessId;
    this.#spec = options.spawn;
    this.limits = { ...ACP_TRANSPORT_LIMITS, ...options.limits };
    this.spawnId = options.spawnId ?? `spawn_${randomUUID()}`;
    this.#redaction = options.redaction ?? DEFAULT_REDACTION_CONFIG;
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#exitResolve = resolve;
    });
    this.#queue = new BoundedQueue<Record<string, unknown>>({
      capacity: this.limits.queueCapacity,
      policy: 'dead_letter',
      onDeadLetter: () => {
        this.fail(
          new AdapterError(
            'queue_overflow',
            `Decoded-event queue overflowed its bound of ${this.limits.queueCapacity} (§10.2)`,
            { harnessId: this.harnessId },
          ),
        );
      },
    });
  }

  // ---- Introspection -------------------------------------------------------
  get state(): TransportState {
    return this.#state;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exitInfo;
  }

  get fatalError(): AdapterError | undefined {
    return this.#fatalError;
  }

  get handlerErrorCount(): number {
    return this.#handlerErrorCount;
  }

  get unmatchedResponseCount(): number {
    return this.#unmatchedResponseCount;
  }

  /** Resolves once the child has exited (never rejects). */
  get exited(): Promise<void> {
    return this.#exitPromise;
  }

  onNotification(handler: NotificationHandler): void {
    this.#onNotification = handler;
  }

  onIncomingRequest(handler: IncomingRequestHandler): void {
    this.#onIncomingRequest = handler;
  }

  onFatal(handler: FatalHandler): void {
    this.#onFatal = handler;
  }

  // ---- Lifecycle -----------------------------------------------------------
  /** Spawn the child in its own process group. Rejects with `spawn_failed`. */
  async start(): Promise<void> {
    if (this.#state !== 'created') {
      throw new AdapterError('invalid_state', `start() in state '${this.#state}'`, {
        harnessId: this.harnessId,
      });
    }

    const env: Record<string, string> = {};
    for (const key of CHILD_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, this.#spec.env ?? {});
    env['HARNESS_SPAWN_ID'] = this.spawnId;

    const child = spawn(this.#spec.command, [...this.#spec.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group (§10.1) — group-wide reaping (§14)
      ...(this.#spec.cwd !== undefined ? { cwd: this.#spec.cwd } : {}),
      env,
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;

    await new Promise<void>((resolve, reject) => {
      const onError = (cause: Error): void => {
        this.#state = 'closed';
        this.#exitInfo = { code: null, signal: null };
        this.#exitResolve?.();
        reject(
          new AdapterError('spawn_failed', `Failed to spawn ${this.#spec.command}: ${cause.message}`, {
            harnessId: this.harnessId,
            cause,
          }),
        );
      };
      child.once('error', onError);
      child.once('spawn', () => {
        child.removeListener('error', onError);
        resolve();
      });
    });

    this.#state = 'running';
    // Post-spawn errors (EPIPE etc.) must not become uncaught exceptions.
    child.on('error', () => {
      /* exit handler owns the consequences */
    });
    child.stdin.on('error', () => {
      /* write-after-death is handled at the call sites */
    });
    child.stdout.on('data', (chunk: Buffer) => this.#onStdoutData(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.#onStderrData(chunk));
    child.once('exit', (code, signal) => this.#onExit(code, signal));
  }

  /**
   * Terminal failure (§10.2 explicit terminal events): first fatal wins,
   * everything pending rejects with it, the process group is SIGKILLed and
   * reaped. Public so the session layer can escalate protocol-semantic
   * failures (version mismatch, identity mismatch) through the same path.
   */
  fail(error: AdapterError): void {
    if (this.#fatalError !== undefined || this.#state === 'closed') return;
    this.#fatalError = error;
    this.#cancelDispatch();
    this.#rejectAllPending(error);
    try {
      this.#onFatal?.(error);
    } catch {
      this.#handlerErrorCount += 1;
    }
    // Terminal cleanup: no graceful rung for a broken wire — SIGKILL group.
    this.#state = 'closing';
    this.#killGroup('SIGKILL');
  }

  /**
   * Termination ladder (§10.2): SIGTERM group → `terminateGraceMs` → SIGKILL
   * group → await exit. Idempotent; safe to call on an already-dead child.
   */
  async terminate(): Promise<void> {
    if (this.#child === undefined) {
      this.#state = 'closed';
      return;
    }
    if (this.#state !== 'closed') this.#state = 'closing';
    if (this.#exitInfo === undefined) {
      this.#killGroup('SIGTERM');
      const graceful = await this.#raceExit(this.limits.terminateGraceMs);
      if (!graceful) {
        this.#killGroup('SIGKILL');
        await this.#exitPromise;
      }
    }
    // Sweep stragglers sharing the group (grandchildren) even after a clean
    // leader exit — the group id survives the leader on POSIX.
    this.#killGroup('SIGKILL');
  }

  /** Full shutdown: terminate ladder + reap + release timers. Idempotent. */
  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closePromise = (async () => {
        this.#cancelDispatch();
        this.#rejectAllPending(
          new AdapterError('unexpected_eof', 'Transport closed with requests outstanding', {
            harnessId: this.harnessId,
          }),
        );
        await this.terminate();
        for (const timer of this.#timers) clearTimeout(timer);
        this.#timers.clear();
        this.#state = 'closed';
      })();
    }
    return this.#closePromise;
  }

  // ---- Outbound ------------------------------------------------------------
  request(method: string, params: unknown, options: RequestOptions = {}): Promise<unknown> {
    if (this.#fatalError !== undefined) return Promise.reject(this.#fatalError);
    if (this.#state !== 'running') {
      return Promise.reject(
        new AdapterError('invalid_state', `request(${method}) in state '${this.#state}'`, {
          harnessId: this.harnessId,
        }),
      );
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject };
      this.#pending.set(id, entry);
      if (options.timeoutMs !== undefined) {
        const kind: 'handshake_timeout' | 'turn_timeout' =
          options.timeoutKind === 'handshake' ? 'handshake_timeout' : 'turn_timeout';
        const bound = options.timeoutMs;
        entry.timer = setTimeout(() => {
          this.#timers.delete(entry.timer!);
          // Both timeout bounds are terminal (§10.2): fail rejects all pending.
          this.fail(
            new AdapterError(kind, `${method} exceeded its ${bound}ms bound (§10.2)`, {
              harnessId: this.harnessId,
            }),
          );
        }, options.timeoutMs);
        this.#timers.add(entry.timer);
      }
      const written = this.#writeLine({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      });
      if (!written) {
        this.#settlePending(id)?.reject(
          new AdapterError('unexpected_eof', `Child not writable for ${method}`, {
            harnessId: this.harnessId,
          }),
        );
      }
    });
  }

  /** Fire a notification. Returns false when the child is not writable. */
  notify(method: string, params: unknown): boolean {
    if (this.#state !== 'running' || this.#fatalError !== undefined) return false;
    return this.#writeLine({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /** Answer an incoming agent→client request. */
  respond(id: number | string, body: JsonRpcRespondBody): boolean {
    if (this.#state !== 'running' || this.#fatalError !== undefined) return false;
    return this.#writeLine({ jsonrpc: '2.0', id, ...body });
  }

  // ---- Stderr --------------------------------------------------------------
  /** Redacted before exposure (§17.1: redaction before every sink).
   * Truncation-order note: the head/tail byte caps are applied at CAPTURE
   * time (a stream cannot be redacted before it is bounded), so a cap can
   * cut mid-quote/mid-escape. That cut shape is exactly what the pattern
   * layer's sensitive-key-gated UNTERMINATED-QUOTE fallback covers when the
   * snapshot is redacted here over the full captured buffers. */
  stderrSnapshot(): StderrSnapshot {
    const head = Buffer.concat(this.#stderrHead).toString('utf8');
    const tail = Buffer.concat(this.#stderrTail).toString('utf8');
    return {
      head: redactText(head, this.#redaction),
      tail: redactText(tail, this.#redaction),
      totalBytes: this.#stderrTotalBytes,
      truncated: this.#stderrTotalBytes > this.#stderrHeadBytes + this.#stderrTailBytes,
    };
  }

  // ---- Internals: wire in --------------------------------------------------
  #onStdoutData(chunk: Buffer): void {
    if (this.#fatalError !== undefined || this.#state === 'closed') return;
    let rest = chunk;
    for (;;) {
      const newlineIndex = rest.indexOf(NEWLINE);
      if (newlineIndex === -1) {
        if (rest.length > 0) {
          this.#lineChunks.push(rest);
          this.#lineBytes += rest.length;
        }
        if (this.#lineBytes > this.limits.maxLineBytes) {
          this.fail(
            new AdapterError(
              'oversized_frame',
              `Protocol line exceeded ${this.limits.maxLineBytes} bytes (§10.2)`,
              { harnessId: this.harnessId },
            ),
          );
        }
        return;
      }

      const head = rest.subarray(0, newlineIndex);
      rest = rest.subarray(newlineIndex + 1);
      const lineBytes = this.#lineBytes + head.length;
      let lineBuffer: Buffer;
      if (this.#lineChunks.length > 0) {
        this.#lineChunks.push(head);
        lineBuffer = Buffer.concat(this.#lineChunks);
        this.#lineChunks = [];
        this.#lineBytes = 0;
      } else {
        lineBuffer = head;
      }
      if (lineBytes > this.limits.maxLineBytes) {
        this.fail(
          new AdapterError(
            'oversized_frame',
            `Protocol line of ${lineBytes} bytes exceeded ${this.limits.maxLineBytes} (§10.2)`,
            { harnessId: this.harnessId },
          ),
        );
        return;
      }
      const line = lineBuffer.toString('utf8');
      if (line.trim() === '') continue;
      this.#ingestLine(line);
      if (this.#fatalError !== undefined) return;
    }
  }

  #ingestLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new AdapterError(
          'malformed_frame',
          // §17.1 REDACT BEFORE TRUNCATE: redact the FULL line first, then
          // bound — slicing first could cut mid-quote/mid-escape and
          // un-terminate a string before redaction ever saw it.
          `Malformed JSON on stdout (§10.2): ${redactText(line, this.#redaction).slice(0, 160)}`,
          { harnessId: this.harnessId },
        ),
      );
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      this.fail(
        new AdapterError('malformed_frame', 'Protocol frame is not a JSON object (§10.2)', {
          harnessId: this.harnessId,
        }),
      );
      return;
    }
    // Enqueue; overflow triggers the dead-letter → queue_overflow fatal.
    this.#queue.enqueue(message as Record<string, unknown>);
    if (this.#fatalError === undefined) this.#scheduleDispatch();
  }

  #scheduleDispatch(): void {
    if (this.#dispatchScheduled) return;
    this.#dispatchScheduled = true;
    this.#dispatchHandle = setImmediate(() => {
      this.#dispatchScheduled = false;
      this.#dispatchHandle = undefined;
      let dispatched = 0;
      while (
        dispatched < this.limits.dispatchBatchSize &&
        this.#fatalError === undefined &&
        this.#state !== 'closed'
      ) {
        const message = this.#queue.dequeue();
        if (message === undefined) return;
        this.#deliver(message);
        dispatched += 1;
      }
      if (!this.#queue.isEmpty && this.#fatalError === undefined && this.#state !== 'closed') {
        this.#scheduleDispatch();
      }
    });
  }

  #cancelDispatch(): void {
    if (this.#dispatchHandle !== undefined) {
      clearImmediate(this.#dispatchHandle);
      this.#dispatchHandle = undefined;
      this.#dispatchScheduled = false;
    }
  }

  #deliver(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];

    // Response to one of OUR requests.
    if (method === undefined && (typeof id === 'number' || typeof id === 'string')) {
      const entry = typeof id === 'number' ? this.#settlePending(id) : undefined;
      if (entry === undefined) {
        this.#unmatchedResponseCount += 1;
        return;
      }
      if ('error' in message && message['error'] !== undefined && message['error'] !== null) {
        const envelope = message['error'] as JsonRpcErrorEnvelope;
        entry.reject(
          new AdapterError(
            'provider_error',
            `${entry.method} failed: ${String(envelope.message ?? 'provider error')}`,
            { harnessId: this.harnessId, envelope },
          ),
        );
      } else {
        entry.resolve(message['result']);
      }
      return;
    }

    if (typeof method !== 'string') {
      this.#unmatchedResponseCount += 1;
      return;
    }

    // Agent→client request (needs a response) vs notification.
    if (id !== undefined && (typeof id === 'number' || typeof id === 'string')) {
      if (this.#onIncomingRequest === undefined) {
        this.respond(id, {
          error: { code: -32601, message: `No handler for agent request ${method}` },
        });
        return;
      }
      try {
        this.#onIncomingRequest(id, method, message['params']);
      } catch {
        this.#handlerErrorCount += 1;
      }
      return;
    }

    try {
      this.#onNotification?.(method, message['params']);
    } catch {
      // Late/foreign updates MUST NOT crash the transport (§10.2, #864).
      this.#handlerErrorCount += 1;
    }
  }

  // ---- Internals: stderr ---------------------------------------------------
  get #stderrHeadBytesCap(): number {
    return this.limits.stderrHeadBytes;
  }

  get #stderrHeadBytesUsed(): number {
    return this.#stderrHeadBytes;
  }

  #onStderrData(chunk: Buffer): void {
    this.#stderrTotalBytes += chunk.length;
    // Head: first N bytes, byte-exact.
    if (this.#stderrHeadBytesUsed < this.#stderrHeadBytesCap) {
      const room = this.#stderrHeadBytesCap - this.#stderrHeadBytesUsed;
      const take = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.#stderrHead.push(take);
      this.#stderrHeadBytes += take.length;
    }
    // Tail: ring of the last N bytes.
    this.#stderrTail.push(chunk);
    this.#stderrTailBytes += chunk.length;
    while (this.#stderrTailBytes > this.limits.stderrTailBytes && this.#stderrTail.length > 0) {
      const oldest = this.#stderrTail[0]!;
      const excess = this.#stderrTailBytes - this.limits.stderrTailBytes;
      if (oldest.length <= excess) {
        this.#stderrTail.shift();
        this.#stderrTailBytes -= oldest.length;
      } else {
        this.#stderrTail[0] = oldest.subarray(excess);
        this.#stderrTailBytes -= excess;
      }
    }
  }

  // ---- Internals: lifecycle ------------------------------------------------
  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exitInfo = { code, signal };
    // The leader is gone; sweep the group for stragglers (grandchildren).
    this.#killGroup('SIGKILL');
    const wasVoluntary = this.#state === 'closing' || this.#state === 'closed';
    if (!wasVoluntary && this.#fatalError === undefined) {
      this.fail(
        new AdapterError(
          'unexpected_eof',
          `Child exited unexpectedly (code=${String(code)}, signal=${String(signal)}) (§10.2)`,
          { harnessId: this.harnessId },
        ),
      );
    } else {
      // Voluntary shutdown: anything still pending settles as EOF.
      this.#rejectAllPending(
        new AdapterError('unexpected_eof', 'Child exited during shutdown', {
          harnessId: this.harnessId,
        }),
      );
    }
    this.#exitResolve?.();
  }

  #settlePending(id: number): PendingRequest | undefined {
    const entry = this.#pending.get(id);
    if (entry === undefined) return undefined;
    this.#pending.delete(id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      this.#timers.delete(entry.timer);
    }
    return entry;
  }

  #rejectAllPending(error: AdapterError): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settlePending(id)?.reject(error);
    }
  }

  #writeLine(message: Record<string, unknown>): boolean {
    const child = this.#child;
    if (child === undefined || this.#exitInfo !== undefined || child.stdin.destroyed) {
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the whole process group (negative pid). §14 identity note: the
   * group id is the child pid we spawned this generation (detached), verified
   * live via the `exit` bookkeeping above; ESRCH is swallowed.
   */
  #killGroup(signal: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: group already gone — reaping is idempotent.
    }
  }

  async #raceExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitInfo !== undefined) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#timers.delete(timer);
        resolve(false);
      }, timeoutMs);
      this.#timers.add(timer);
      void this.#exitPromise.then(() => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        resolve(true);
      });
    });
  }
}
