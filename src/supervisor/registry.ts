/**
 * Process identity registry (PLAN.md §14 bullet 1, §12.3).
 *
 * "registry persists {pid, pgid, process start-time, executable path,
 * generation id, HARNESS_SPAWN_ID nonce}; identity re-verification before
 * ANY signal (ps lookup: pid + start-time + executable must all match;
 * ambiguity -> never kill, emit alert event); startup orphan reaping kills
 * only identity-verified processes."
 *
 * This is the SINGLE gate every other supervisor component signals a real OS
 * process through (`watchdog.ts`'s emergency kill goes through
 * `signalVerified`, never `process.kill` directly) — "any signal (watchdog,
 * reaper, cancel) requires full identity re-verification" (§14). A pid is a
 * reused OS identifier: the whole point of this module is that a STALE
 * record (the process it named has exited and the pid/pgid have since been
 * recycled by an unrelated process) can NEVER result in that unrelated
 * process being signaled — verification failure always degrades to "skip +
 * alert," never "kill anyway."
 *
 * `ProcessRegistryStore` is intentionally storage-agnostic: this package
 * owns no persistence table (that is `src/persistence/**`'s ownership), so
 * `InMemoryProcessRegistryStore` is the shipped default (sufficient for one
 * orchestrator-process lifetime — startup orphan reaping across a CRASHED
 * orchestrator additionally needs the store to have been durable, which a
 * caller achieves by implementing `ProcessRegistryStore` over the existing
 * generic `ProjectionRepository`/persistence primitives; P4a W2-6 ships
 * exactly that wiring: `src/app/process-registry-store.ts`'s
 * `DurableProcessRegistryStore`, assembled by `OrchestrationService`).
 */
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import type { AssignmentId, ProcessGenerationId, RunId, SegmentId } from '../domain/ids.js';
import {
  createPsClient,
  type EnvNonceVerifier,
  type PsClient,
  type ProcessIdentitySample,
} from './ps.js';

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
/**
 * W2-6: the §14 identity of ONE spawned child, captured at spawn time —
 * {pid, pgid, process start-time, executable path, generation id,
 * `HARNESS_SPAWN_ID` nonce}. This is the shape a `RoleAdapterHandle`
 * exposes (`captureProcessIdentity`) and the baseline every later
 * verification compares against; `ProcessIdentityRecord` is the same
 * identity plus registry bookkeeping (owning run/segment links + when it
 * was recorded).
 */
export interface ProcessIdentity {
  readonly generationId: ProcessGenerationId;
  readonly pid: number;
  readonly pgid: number;
  /** Opaque `ps lstart` token captured AT CAPTURE time — compared for exact equality only (see `./ps.ts`). */
  readonly startedAt: string;
  readonly executablePath: string;
  /** `HARNESS_SPAWN_ID` nonce this process was spawned with (§10.1). */
  readonly spawnNonce: string;
}

export interface ProcessIdentityRecord extends ProcessIdentity {
  readonly runId?: RunId;
  readonly segmentId?: SegmentId;
  readonly assignmentId?: AssignmentId;
  readonly recordedAt: IsoTimestamp;
}

/** `nonce_mismatch` / `nonce_unverifiable` (W2-6): the ps identity matched
 * but the startup reaper's env-nonce re-verification contradicted it or
 * could not run — both WITHHOLD the signal (§14: never kill on ambiguity). */
export type IdentityVerdict = 'match' | 'mismatch' | 'gone' | 'nonce_mismatch' | 'nonce_unverifiable';

export type IdentityVerification =
  | { readonly verdict: 'match'; readonly observed: ProcessIdentitySample }
  | { readonly verdict: 'mismatch'; readonly observed: ProcessIdentitySample; readonly reason: string }
  | { readonly verdict: 'gone' }
  | { readonly verdict: 'nonce_mismatch'; readonly observed: ProcessIdentitySample; readonly reason: string }
  | {
      readonly verdict: 'nonce_unverifiable';
      readonly observed: ProcessIdentitySample;
      readonly reason: string;
    };

/** Raised whenever a signal/reap was WITHHELD because identity could not be confirmed (§14: "ambiguity -> never kill, emit alert event"). */
export interface IdentityAlert {
  readonly record: ProcessIdentityRecord;
  readonly verification: IdentityVerification;
  readonly attemptedAction: 'signal' | 'reap';
  readonly attemptedSignal?: NodeJS.Signals;
  readonly occurredAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
export interface ProcessRegistryStore {
  put(record: ProcessIdentityRecord): void;
  get(generationId: ProcessGenerationId): ProcessIdentityRecord | undefined;
  remove(generationId: ProcessGenerationId): void;
  list(): readonly ProcessIdentityRecord[];
}

export class InMemoryProcessRegistryStore implements ProcessRegistryStore {
  readonly #records = new Map<ProcessGenerationId, ProcessIdentityRecord>();

  put(record: ProcessIdentityRecord): void {
    this.#records.set(record.generationId, record);
  }

  get(generationId: ProcessGenerationId): ProcessIdentityRecord | undefined {
    return this.#records.get(generationId);
  }

  remove(generationId: ProcessGenerationId): void {
    this.#records.delete(generationId);
  }

  list(): readonly ProcessIdentityRecord[] {
    return [...this.#records.values()];
  }
}

// ---------------------------------------------------------------------------
// Registration input
// ---------------------------------------------------------------------------
export interface RegisterProcessInput {
  readonly generationId: ProcessGenerationId;
  readonly pid: number;
  readonly pgid: number;
  readonly spawnNonce: string;
  readonly runId?: RunId;
  readonly segmentId?: SegmentId;
  readonly assignmentId?: AssignmentId;
}

export interface ReapResultEntry {
  readonly generationId: ProcessGenerationId;
  readonly action: 'killed' | 'skipped';
  readonly verification: IdentityVerification;
}

export interface ReapSummary {
  readonly entries: readonly ReapResultEntry[];
  readonly killedCount: number;
  readonly skippedCount: number;
}

export interface ProcessRegistryDeps {
  readonly clock: Clock;
  readonly store?: ProcessRegistryStore;
  readonly ps?: PsClient;
  /**
   * W2-6 startup-reaping nonce re-verification (§14): where the platform
   * allows reading the child's env (darwin/linux best-effort, `./ps.ts`),
   * `reapOrphans` re-verifies the recorded `HARNESS_SPAWN_ID` nonce on top
   * of the pid+start-time+executable match. A non-`match` outcome —
   * including "could not read the env" — WITHHOLDS the signal and raises
   * the alert instead (never kill on ambiguity). Omitted = ps identity
   * alone governs (the standalone-module behavior; the application service
   * always wires the real verifier).
   */
  readonly envNonce?: EnvNonceVerifier;
  /** Actually deliver an OS signal to the process GROUP; overridable for tests. Default: `process.kill(-pgid, signal)`. */
  readonly sendSignal?: (pgid: number, signal: NodeJS.Signals) => void;
  readonly onAlert?: (alert: IdentityAlert) => void;
}

function defaultSendSignal(pgid: number, signal: NodeJS.Signals): void {
  process.kill(-pgid, signal);
}

/**
 * Structural surface `watchdog.ts` depends on (narrower than the full class)
 * so it can be exercised with a test double without pulling in the whole
 * registry.
 */
export interface VerifiedSignaler {
  signalVerified(generationId: ProcessGenerationId, signal: NodeJS.Signals): IdentityVerification;
}

export class ProcessRegistry implements VerifiedSignaler {
  readonly #clock: Clock;
  readonly #store: ProcessRegistryStore;
  readonly #ps: PsClient;
  readonly #envNonce: EnvNonceVerifier | undefined;
  readonly #sendSignal: (pgid: number, signal: NodeJS.Signals) => void;
  readonly #onAlert: ((alert: IdentityAlert) => void) | undefined;

  constructor(deps: ProcessRegistryDeps) {
    this.#clock = deps.clock;
    this.#store = deps.store ?? new InMemoryProcessRegistryStore();
    this.#ps = deps.ps ?? createPsClient(deps.clock);
    this.#envNonce = deps.envNonce;
    this.#sendSignal = deps.sendSignal ?? defaultSendSignal;
    this.#onAlert = deps.onAlert;
  }

  get store(): ProcessRegistryStore {
    return this.#store;
  }

  /**
   * Samples the process's identity RIGHT NOW and persists it as the
   * baseline every future `verify()` call compares against. Throws if `pid`
   * doesn't currently resolve — registration only ever happens immediately
   * after a real spawn, so an unresolvable pid here means the caller raced
   * its own child's startup, not a legitimate "gone" outcome.
   */
  register(input: RegisterProcessInput): ProcessIdentityRecord {
    const observed = this.#ps.sampleIdentity(input.pid);
    if (!observed) {
      throw new Error(
        `ProcessRegistry.register: pid ${input.pid} does not currently resolve via ps — cannot capture a baseline identity`,
      );
    }
    const record: ProcessIdentityRecord = {
      generationId: input.generationId,
      pid: input.pid,
      pgid: input.pgid,
      startedAt: observed.startedAt,
      executablePath: observed.executablePath,
      spawnNonce: input.spawnNonce,
      recordedAt: this.#clock.nowIso(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.segmentId !== undefined ? { segmentId: input.segmentId } : {}),
      ...(input.assignmentId !== undefined ? { assignmentId: input.assignmentId } : {}),
    };
    this.#store.put(record);
    return record;
  }

  /**
   * W2-6: persist an identity that was ALREADY captured at the spawn seam
   * (`RoleAdapterHandle.captureProcessIdentity` sampled `ps` itself at
   * capture time — that sample IS the baseline), stamped with the owning
   * run/segment links. No re-sampling here: re-sampling later could observe
   * a different (recycled) process and poison the baseline. The application
   * service calls this BEFORE `child.spawned` commits, so a crash anywhere
   * after the OS process exists leaves a durable record for startup reaping.
   */
  registerCaptured(
    identity: ProcessIdentity,
    links?: {
      readonly runId?: RunId;
      readonly segmentId?: SegmentId;
      readonly assignmentId?: AssignmentId;
    },
  ): ProcessIdentityRecord {
    const record: ProcessIdentityRecord = {
      ...identity,
      recordedAt: this.#clock.nowIso(),
      ...(links?.runId !== undefined ? { runId: links.runId } : {}),
      ...(links?.segmentId !== undefined ? { segmentId: links.segmentId } : {}),
      ...(links?.assignmentId !== undefined ? { assignmentId: links.assignmentId } : {}),
    };
    this.#store.put(record);
    return record;
  }

  /** Re-verifies a tracked record's identity against a fresh `ps` sample. Never mutates the store. */
  verify(generationId: ProcessGenerationId): IdentityVerification {
    const record = this.#store.get(generationId);
    if (!record) return { verdict: 'gone' };
    return this.#compare(record, this.#ps.sampleIdentity(record.pid));
  }

  /**
   * Re-verifies identity and signals the process GROUP ONLY on an exact
   * match. On mismatch/gone, NO signal is sent and an alert is raised
   * instead (§14: "ambiguity -> never kill, emit alert event") — the
   * verification outcome is still returned so the caller can react (e.g.
   * surface it to an operator) without ever having to guess whether a kill
   * actually happened.
   */
  signalVerified(generationId: ProcessGenerationId, signal: NodeJS.Signals): IdentityVerification {
    const record = this.#store.get(generationId);
    const verification = record ? this.#compare(record, this.#ps.sampleIdentity(record.pid)) : { verdict: 'gone' as const };
    if (verification.verdict === 'match' && record) {
      this.#sendSignal(record.pgid, signal);
    } else if (record) {
      this.#raiseAlert(record, verification, 'signal', signal);
    }
    return verification;
  }

  /**
   * W3-2 cross-process stop: re-verify a tracked generation's FULL §14
   * identity — ps identity (pid + start-time + executable) AND, where the
   * platform lets us read the child's env, the recorded `HARNESS_SPAWN_ID`
   * nonce — and signal its process GROUP ONLY on a full match. This is the
   * gate a SECOND CLI process uses to terminate the child a FIRST process is
   * driving: the record is durable (SQLite projection store), so the second
   * process reaches it, while the first observes the death through its
   * transport and folds the generation-matched stop.
   *
   * Any AMBIGUITY — a ps mismatch (recycled pid), a contradicting nonce, or
   * an unreadable nonce — WITHHOLDS the signal and raises the §14 alert
   * instead (never signal a recycled pid). A provably-GONE process is a
   * benign no-op: nothing to signal, nothing recycled, no alert. Unlike
   * `reapOrphans` this targets ONE generation and NEVER mutates the store —
   * the owning process's dispose ladder / stop-fold owns the record's
   * lifecycle. Returns the verification so the caller knows whether the
   * signal went out (and can walk the §10.2 escalation ladder).
   */
  signalVerifiedStrict(generationId: ProcessGenerationId, signal: NodeJS.Signals): IdentityVerification {
    const record = this.#store.get(generationId);
    if (record === undefined) return { verdict: 'gone' };
    const verification = this.#verifyWithNonce(record);
    if (verification.verdict === 'match') {
      this.#sendSignal(record.pgid, signal);
    } else if (verification.verdict !== 'gone') {
      // Ambiguity (mismatch / nonce contradiction / unreadable nonce) →
      // withhold + alert; a definite `gone` is benign and never alerts.
      this.#raiseAlert(record, verification, 'signal', signal);
    }
    return verification;
  }

  /**
   * Startup orphan reaping (§14): verify every persisted record; SIGKILL
   * (or `signal`) the process group ONLY for identity-verified matches —
   * removed from the registry once handled. Mismatched/gone records are
   * left exactly as they are (never killed, never silently dropped) and
   * reported back via `onAlert` + the returned summary, so a caller can
   * decide what stale bookkeeping means for its own recovery flow.
   *
   * W2-6: when an `envNonce` verifier is configured, a ps-identity match is
   * additionally re-verified against the recorded `HARNESS_SPAWN_ID` nonce
   * by reading the child's env (darwin/linux best-effort). Only a nonce
   * `match` kills; a contradicting nonce (`nonce_mismatch`) or an unreadable
   * env (`nonce_unverifiable`) WITHHOLDS the signal and raises the §14
   * alert — verification unavailable is ambiguity, and ambiguity never kills.
   */
  reapOrphans(signal: NodeJS.Signals = 'SIGKILL'): ReapSummary {
    const entries: ReapResultEntry[] = [];
    for (const record of this.#store.list()) {
      const verification = this.#verifyWithNonce(record);
      if (verification.verdict === 'match') {
        this.#sendSignal(record.pgid, signal);
        this.#store.remove(record.generationId);
        entries.push({ generationId: record.generationId, action: 'killed', verification });
      } else {
        this.#raiseAlert(record, verification, 'reap', signal);
        entries.push({ generationId: record.generationId, action: 'skipped', verification });
      }
    }
    return {
      entries,
      killedCount: entries.filter((e) => e.action === 'killed').length,
      skippedCount: entries.filter((e) => e.action === 'skipped').length,
    };
  }

  /**
   * Full §14 verification: the ps-identity compare, then — on a ps match and
   * when an `envNonce` verifier is configured — the recorded
   * `HARNESS_SPAWN_ID` nonce re-read from the child's env (darwin/linux
   * best-effort). A contradicting nonce (`nonce_mismatch`) or an unreadable
   * env (`nonce_unverifiable`) downgrades the match: verification unavailable
   * is ambiguity, and ambiguity never kills. Shared by `reapOrphans`
   * (startup) and `signalVerifiedStrict` (W3-2 cross-process stop).
   */
  #verifyWithNonce(record: ProcessIdentityRecord): IdentityVerification {
    const verification = this.#compare(record, this.#ps.sampleIdentity(record.pid));
    if (verification.verdict !== 'match' || this.#envNonce === undefined) return verification;
    const nonceVerdict = this.#envNonce.verifyNonce(record.pid, record.spawnNonce);
    if (nonceVerdict === 'mismatch') {
      return {
        verdict: 'nonce_mismatch',
        observed: verification.observed,
        reason: 'env HARNESS_SPAWN_ID does not carry the recorded spawn nonce',
      };
    }
    if (nonceVerdict === 'unavailable') {
      return {
        verdict: 'nonce_unverifiable',
        observed: verification.observed,
        reason: 'child env not readable on this platform/process — nonce re-verification unavailable',
      };
    }
    return verification;
  }

  #compare(record: ProcessIdentityRecord, observed: ProcessIdentitySample | undefined): IdentityVerification {
    if (!observed) return { verdict: 'gone' };
    const reasons: string[] = [];
    if (observed.pid !== record.pid) reasons.push(`pid ${record.pid} → ${observed.pid}`);
    if (observed.pgid !== record.pgid) reasons.push(`pgid ${record.pgid} → ${observed.pgid}`);
    if (observed.startedAt !== record.startedAt) reasons.push('start-time mismatch');
    if (observed.executablePath !== record.executablePath) {
      reasons.push(`executable '${record.executablePath}' → '${observed.executablePath}'`);
    }
    if (reasons.length === 0) return { verdict: 'match', observed };
    return { verdict: 'mismatch', observed, reason: reasons.join('; ') };
  }

  #raiseAlert(
    record: ProcessIdentityRecord,
    verification: IdentityVerification,
    attemptedAction: 'signal' | 'reap',
    attemptedSignal: NodeJS.Signals,
  ): void {
    this.#onAlert?.({
      record,
      verification,
      attemptedAction,
      attemptedSignal,
      occurredAt: this.#clock.nowIso(),
    });
  }
}
