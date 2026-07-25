/**
 * ACP session adapter conformance — PLAN §19 tests 6–8 against the
 * child-process fake, plus the pieces of §10 the session layer owns:
 * permission mediation (default deny, exact allowlist, role write veto),
 * cancellation across turn phases with grace escalation, process-group
 * cleanup with no orphans (child + grandchild), capability probing, session
 * identity, late updates (#864), and provider-envelope visibility (§13).
 *
 * Integration-style: real child processes, real timers, generous bounds.
 */
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { noPayloadToVerify } from './session.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import {
  fakeAcpChildPath,
  rateLimitErrorEnvelope,
  writeScenarioFile,
  type FakeAcpScenario,
} from '../fake/index.js';
import {
  UnsupportedCapabilityError,
  isAdapterError,
  providerEnvelopeOf,
  type AdapterError,
  type AdapterErrorKind,
  type HarnessAdapter,
  type PermissionRequest,
  type SessionUpdate,
} from '../spi.js';
import type { AcpTransportLimits } from './transport.js';
import {
  AcpStdioAdapter,
  decidePermission,
  isWorkspaceWriteOperation,
  isWriteOperation,
  normalizeSessionUpdate,
  parseConfigOptionsWire,
  resolveModePin,
  type AcpAdapterOptions,
  type SessionModePolicy,
} from './session.js';

const GENEROUS_MS = 20_000;
const SPAWN_NONCE = 'spawn-session-nonce-1';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface MakeOptions {
  readonly limits?: Partial<AcpTransportLimits>;
  readonly permissions?: AcpAdapterOptions['permissions'];
  readonly sessionMode?: AcpAdapterOptions['sessionMode'];
  readonly clock?: AcpAdapterOptions['clock'];
  readonly capabilityOverrides?: AcpAdapterOptions['capabilityOverrides'];
  /** Wrap the fake child in a grandchild-spawning wrapper (test 8). */
  readonly wrapper?: { readonly ignoreSigterm: boolean };
}

async function makeAdapter(
  scenario: FakeAcpScenario,
  options: MakeOptions = {},
): Promise<AcpStdioAdapter> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acp-session-test-'));
  const scenarioPath = await writeScenarioFile(scenario, dir);

  let entry = fakeAcpChildPath();
  if (options.wrapper !== undefined) {
    // A wrapper that (a) optionally shrugs off SIGTERM, (b) spawns a
    // SIGTERM-ignoring grandchild in the SAME process group, then (c) becomes
    // the fake ACP agent by importing it. Only a group-wide SIGKILL reaps
    // everything — exactly what §10.2/§14 demand of the transport.
    const wrapperPath = path.join(dir, 'wrapper.mjs');
    const grandchildProgram = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    await writeFile(
      wrapperPath,
      [
        "import { spawn } from 'node:child_process';",
        options.wrapper.ignoreSigterm ? "process.on('SIGTERM', () => {});" : '',
        `const grand = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildProgram)}], { stdio: 'ignore' });`,
        "process.stderr.write('grandchild pid ' + grand.pid + '\\n');",
        `await import(${JSON.stringify(pathToFileURL(fakeAcpChildPath()).href)});`,
      ].join('\n'),
      'utf8',
    );
    entry = wrapperPath;
  }

  const adapter = new AcpStdioAdapter({
    harnessId: 'fake-acp-child',
    spawn: { command: process.execPath, args: [entry, scenarioPath] },
    spawnId: SPAWN_NONCE,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    ...(options.sessionMode !== undefined ? { sessionMode: options.sessionMode } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.capabilityOverrides !== undefined
      ? { capabilityOverrides: options.capabilityOverrides }
      : {}),
  });
  cleanups.push(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });
  return adapter;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  check: () => boolean,
  label: string,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function grandchildPidOf(adapter: AcpStdioAdapter): Promise<number> {
  let pid: number | undefined;
  await waitUntil(() => {
    const match = adapter.stderrSnapshot()?.head.match(/grandchild pid (\d+)/);
    if (match === null || match === undefined) return false;
    pid = Number(match[1]);
    return Number.isInteger(pid);
  }, 'grandchild pid on stderr');
  return pid!;
}

async function expectAdapterErrorKind(
  promise: Promise<unknown>,
  kind: AdapterErrorKind,
): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(isAdapterError(error), `expected AdapterError, got ${String(error)}`).toBe(true);
    const adapterError = error as AdapterError;
    expect(adapterError.kind).toBe(kind);
    return adapterError;
  }
  throw new Error(`Expected AdapterError kind '${kind}', but the promise resolved`);
}

// ---------------------------------------------------------------------------
// Permission mediation core (pure, §10.2)
// ---------------------------------------------------------------------------
describe('permission mediation decision core (§10.2, T20)', () => {
  it('classifies operations conservatively: unknown/absent titles are writes', () => {
    expect(isWriteOperation('read config file')).toBe(false);
    expect(isWriteOperation('list directory')).toBe(false);
    expect(isWriteOperation('write file')).toBe(true);
    expect(isWriteOperation('execute command')).toBe(true);
    expect(isWriteOperation(undefined)).toBe(true);
    expect(isWriteOperation('')).toBe(true);
  });

  it('headless defaults to DENY; only the EXACT operation string is allowlisted', () => {
    expect(decidePermission({ verifyOperationPayload: noPayloadToVerify, mode: 'headless' }, 'write file')).toEqual({
      action: 'deny',
      reason: 'denied_default',
    });
    const policy = { verifyOperationPayload: noPayloadToVerify, mode: 'headless', policy: { allow: ['write file'] } } as const;
    expect(decidePermission(policy, 'write file').action).toBe('allow');
    expect(decidePermission(policy, 'write file 2').action).toBe('deny');
    expect(decidePermission(policy, 'Write File').action).toBe('deny'); // exact match, case-sensitive
    expect(decidePermission(policy, undefined)).toEqual({
      action: 'deny',
      reason: 'denied_unknown_operation',
    });
  });

  // -------------------------------------------------------------------------
  // HIGH-5 (round 4) — the payload veto gates EVERY approval path.
  //
  // The exact-allowlist match ran BEFORE the raw-input classifier, so an
  // allowlisted title was approved with a missing or hostile payload and the
  // binding never ran at all. The verifier legitimately keeps exact
  // per-criterion allowlisted commands, so this path has to be sound on its own
  // — it cannot lean on the implementor's allowlist being empty.
  // -------------------------------------------------------------------------
  describe('verifyOperationPayload — the veto applies to every allow', () => {
    const shellTitle = 'Execute `npm run typecheck`';
    /** Byte-identity between the title's command and the payload's. */
    const verifyOperationPayload = (operation: string | undefined, rawInput: unknown): boolean => {
      const command = (rawInput as { command?: unknown } | null | undefined)?.command;
      const match = operation !== undefined ? /^Execute `(.+)`$/.exec(operation) : null;
      // Fail closed on ambiguity: an unreadable title is non-shell ONLY when the
      // payload also carries no command (mirrors grokShellPayloadMatchesTitle).
      if (match === null) return typeof command !== 'string'
      return typeof command === 'string' && command === match[1];
    };

    it('VETOES an ALLOWLISTED title whose payload is missing or hostile', () => {
      const policy = { mode: 'headless', policy: { allow: [shellTitle] }, verifyOperationPayload } as const;
      // The regression: allowlisted + no payload used to be `allow/allowlisted`.
      expect(decidePermission(policy, shellTitle, undefined)).toEqual({
        action: 'deny',
        reason: 'denied_raw_input_mismatch',
      });
      expect(decidePermission(policy, shellTitle, { command: 'rm -rf /' })).toEqual({
        action: 'deny',
        reason: 'denied_raw_input_mismatch',
      });
      // ...and the honest call still passes.
      expect(decidePermission(policy, shellTitle, { command: 'npm run typecheck' })).toEqual({
        action: 'allow',
        reason: 'allowlisted',
      });
    });

    it('VETOES a READ-ONLY-classified title whose payload diverges', () => {
      const policy = {
        mode: 'headless',
        policy: { allow: [], allowReadOnlyOperation: () => true },
        verifyOperationPayload,
      } as const;
      expect(decidePermission(policy, 'Execute `ls`', { command: 'rm -rf /' })).toEqual({
        action: 'deny',
        reason: 'denied_raw_input_mismatch',
      });
      expect(decidePermission(policy, 'Execute `ls`', { command: 'ls' })).toEqual({
        action: 'allow',
        reason: 'allowlisted_read_only_operation',
      });
    });

    it('VETOES a WORKSPACE-WRITE approval too (no approval path is exempt)', () => {
      const policy = {
        mode: 'headless',
        role: 'implementor',
        policy: { allow: [], workspaceWriteRoot: '/repo' },
        verifyOperationPayload: () => false,
      } as const;
      expect(decidePermission(policy, 'Write `/repo/src/a.ts`', undefined).action).toBe('deny');
    });

    it('a THROWING veto is a denial, never a pass', () => {
      const policy = {
        mode: 'headless',
        policy: { allow: [shellTitle] },
        verifyOperationPayload: (): boolean => {
          throw new Error('classifier exploded');
        },
      } as const;
      expect(decidePermission(policy, shellTitle, { command: 'npm run typecheck' })).toEqual({
        action: 'deny',
        reason: 'denied_raw_input_mismatch',
      });
    });

    it('runs BEFORE the interactive branch — no mediation mode can bypass it', () => {
      // Round-4 evaluated the veto only after `mode === 'interactive'` returned,
      // so an interactive decider (or a configured handler) could forward a
      // `selected` option for a payload that was never bound to its title.
      const policy = { verifyOperationPayload: noPayloadToVerify, mode: 'interactive', onRequest: async () => ({ kind: 'cancelled' as const }) };
      expect(
        decidePermission({ ...policy, verifyOperationPayload } as never, shellTitle, {
          command: 'rm -rf /',
        }),
      ).toEqual({ action: 'deny', reason: 'denied_raw_input_mismatch' });
      // An honest interactive request still reaches the human.
      expect(
        decidePermission({ ...policy, verifyOperationPayload } as never, shellTitle, {
          command: 'npm run typecheck',
        }),
      ).toEqual({ action: 'interactive', reason: 'interactive' });
    });

    it('no veto configured leaves every existing decision untouched', () => {
      const policy = { verifyOperationPayload: noPayloadToVerify, mode: 'headless', policy: { allow: [shellTitle] } } as const;
      expect(decidePermission(policy, shellTitle, undefined)).toEqual({
        action: 'allow',
        reason: 'allowlisted',
      });
    });
  });

  it('admits only trusted read-only classifier matches and fails closed when it throws', () => {
    const allowReadOnlyOperation = (operation: string): boolean => operation === 'safe inspection';
    const policy = {
      verifyOperationPayload: noPayloadToVerify, mode: 'headless',
      policy: { allow: [], allowReadOnlyOperation },
    } as const;
    expect(decidePermission(policy, 'safe inspection')).toEqual({
      action: 'allow',
      reason: 'allowlisted_read_only_operation',
    });
    expect(decidePermission(policy, 'unsafe mutation')).toEqual({
      action: 'deny',
      reason: 'denied_default',
    });
    expect(
      decidePermission(
        {
          verifyOperationPayload: noPayloadToVerify, mode: 'headless',
          policy: {
            allow: [],
            allowReadOnlyOperation: () => {
              throw new Error('classifier bug');
            },
          },
        },
        'unknown operation',
      ),
    ).toEqual({ action: 'deny', reason: 'denied_default' });
  });

  it('coordinator/verifier WRITE requests are always denied — in every mode, over any allowlist', () => {
    expect(
      decidePermission(
        { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'verifier', policy: { allow: ['write file'] } },
        'write file',
      ),
    ).toEqual({ action: 'deny', reason: 'denied_role_write' });
    expect(
      decidePermission(
        { verifyOperationPayload: noPayloadToVerify, mode: 'interactive', role: 'coordinator', handler: async () => ({ kind: 'cancelled' }) },
        'write file',
      ),
    ).toEqual({ action: 'deny', reason: 'denied_role_write' });
    // Read-only operations are NOT vetoed for those roles.
    expect(
      decidePermission(
        { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'verifier', policy: { allow: ['read config'] } },
        'read config',
      ).action,
    ).toBe('allow');
    // Implementor writes follow the normal policy.
    expect(
      decidePermission(
        { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'implementor', policy: { allow: ['write file'] } },
        'write file',
      ).action,
    ).toBe('allow');
    expect(decidePermission({ verifyOperationPayload: noPayloadToVerify, mode: 'interactive' }, 'write file').action).toBe('interactive');
  });

  it('allows only path-qualified structured writes inside an implementor worktree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'acp-workspace-write-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'acp-workspace-outside-'));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });
    await symlink(outside, path.join(root, 'escape'));

    const insideTitle = `Write \`${path.join(root, 'new-file.txt')}\``;
    const outsideTitle = `Write \`${path.join(outside, 'new-file.txt')}\``;
    const symlinkTitle = `Edit \`${path.join(root, 'escape', 'new-file.txt')}\``;
    const policy = {
      verifyOperationPayload: noPayloadToVerify, mode: 'headless',
      role: 'implementor',
      policy: { allow: [], workspaceWriteRoot: root },
    } as const;

    expect(isWorkspaceWriteOperation(insideTitle, root)).toBe(true);
    expect(decidePermission(policy, insideTitle)).toEqual({
      action: 'allow',
      reason: 'allowlisted_workspace_write',
    });
    expect(isWorkspaceWriteOperation(outsideTitle, root)).toBe(false);
    expect(isWorkspaceWriteOperation(symlinkTitle, root)).toBe(false);
    expect(decidePermission(policy, 'Bash `touch new-file.txt`').action).toBe('deny');
    expect(decidePermission(policy, `Write ${path.join(root, 'unquoted.txt')}`).action).toBe('deny');
    expect(
      decidePermission(
        { ...policy, role: 'verifier' },
        insideTitle,
      ),
    ).toEqual({ action: 'deny', reason: 'denied_role_write' });
  });
});

describe('abnormal prompt diagnostics', () => {
  it('returns redacted bounded stderr with a provider-originated cancelled stop', async () => {
    const adapter = await makeAdapter({
      stderr: { perTurn: ['provider cancelled; api_key=super-secret-value'] },
      turns: [{ response: { stopReason: 'cancelled' } }],
    });
    await adapter.initialize();
    const session = await adapter.createSession({ cwd: tmpdir() });
    const result = await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });

    expect(result.stopReason).toBe('cancelled');
    expect(result.diagnostics?.stderr?.totalBytes).toBeGreaterThan(0);
    expect(result.diagnostics?.stderr?.head).toContain('provider cancelled');
    expect(result.diagnostics?.stderr?.head).not.toContain('super-secret-value');
    expect(result.diagnostics?.childExit).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PLAN §19 test 6 — permission default-deny (+allowlist allow, unknown deny)
// ---------------------------------------------------------------------------
describe('PLAN §19 test 6 — permission mediation on the wire', () => {
  it(
    'headless with NO policy: default DENY answers the reject option; the request is surfaced',
    async () => {
      const adapter = await makeAdapter({
        turns: [{ permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } }],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });
      expect(result.stopReason).toBe('end_turn'); // denied, turn continues

      const surfaced = updates.find((update) => update.kind === 'permission_request');
      expect(surfaced).toBeDefined();

      expect(adapter.permissionDecisions).toHaveLength(1);
      const decision = adapter.permissionDecisions[0]!;
      expect(decision.action).toBe('deny');
      expect(decision.reason).toBe('denied_default');
      expect(decision.operation).toBe('write file');
      expect(decision.optionId).toBe('reject_once'); // the child's reject option
    },
    GENEROUS_MS,
  );

  it(
    'headless allowlist: the EXACT operation is allowed via the allow option',
    async () => {
      const adapter = await makeAdapter(
        {
          turns: [{ permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } }],
        },
        {
          permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'implementor', policy: { allow: ['write file'] } },
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const result = await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      expect(result.stopReason).toBe('end_turn');
      const decision = adapter.permissionDecisions[0]!;
      expect(decision.action).toBe('allow');
      expect(decision.reason).toBe('allowlisted');
      expect(decision.optionId).toBe('allow_once');
    },
    GENEROUS_MS,
  );

  it(
    'unknown operation (not allowlisted) is denied ON THE WIRE: with no reject option the deny falls back to a cancelled outcome and the turn stops',
    async () => {
      const adapter = await makeAdapter(
        {
          turns: [
            {
              permission: {
                toolTitle: 'delete production database',
                options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
              },
              response: { stopReason: 'end_turn' },
            },
          ],
        },
        { permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', policy: { allow: ['some other op'] } } },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const result = await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      // The child maps a cancelled permission outcome to a cancelled turn —
      // proof the deny crossed the wire rather than being silently allowed.
      expect(result.stopReason).toBe('cancelled');
      const decision = adapter.permissionDecisions[0]!;
      expect(decision.action).toBe('deny');
      expect(decision.reason).toBe('denied_default');
      expect(decision.optionId).toBeUndefined();
    },
    GENEROUS_MS,
  );

  it(
    'verifier WRITE is denied even when allowlisted (role veto, §10.2/§8)',
    async () => {
      const adapter = await makeAdapter(
        {
          turns: [{ permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } }],
        },
        {
          permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'verifier', policy: { allow: ['write file'] } },
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      const decision = adapter.permissionDecisions[0]!;
      expect(decision.action).toBe('deny');
      expect(decision.reason).toBe('denied_role_write');
      expect(decision.optionId).toBe('reject_once');
    },
    GENEROUS_MS,
  );

  it(
    'interactive handler receives the request and its outcome is forwarded',
    async () => {
      const seen: PermissionRequest[] = [];
      const adapter = await makeAdapter(
        {
          turns: [{ permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } }],
        },
        {
          permissions: {
            verifyOperationPayload: noPayloadToVerify, mode: 'interactive',
            role: 'implementor',
            handler: async (request) => {
              seen.push(request);
              return { kind: 'selected', optionId: 'allow_once' };
            },
          },
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const result = await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      expect(result.stopReason).toBe('end_turn');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.toolTitle).toBe('write file');
      expect(seen[0]!.options.map((option) => option.optionId)).toEqual([
        'allow_once',
        'reject_once',
      ]);
      const decision = adapter.permissionDecisions[0]!;
      expect(decision.action).toBe('interactive');
      expect(decision.optionId).toBe('allow_once');
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// PLAN §19 test 7 — cancellation during startup/permission-wait/streaming/tool-exec
// ---------------------------------------------------------------------------
describe('PLAN §19 test 7 — cancellation across turn phases', () => {
  it(
    'during startup (no output yet): cooperative cancel settles the turn as cancelled, child stays alive',
    async () => {
      const adapter = await makeAdapter({
        cancel: { behavior: 'acknowledge' },
        turns: [{ delayBeforeResponseMs: 8000 }],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const turn = adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      await sleep(80);
      await adapter.cancelTurn({ sessionId: session.acpSessionId });
      const result = await turn;
      expect(result.stopReason).toBe('cancelled');
      expect(adapter.exitInfo).toBeUndefined(); // no escalation was needed
    },
    GENEROUS_MS,
  );

  it(
    'during streaming: cancel lands mid-updates and the turn settles cancelled',
    async () => {
      const adapter = await makeAdapter({
        cancel: { behavior: 'acknowledge' },
        turns: [
          {
            updates: Array.from({ length: 50 }, (_, i) => ({ text: `chunk ${i}` })),
            updateDelayMs: 25,
            delayBeforeResponseMs: 5000,
          },
        ],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const turn = adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });
      await waitUntil(() => updates.length >= 2, 'streaming started');
      await adapter.cancelTurn({ sessionId: session.acpSessionId });
      const result = await turn;
      expect(result.stopReason).toBe('cancelled');
      expect(updates.length).toBeLessThan(50); // genuinely mid-stream
    },
    GENEROUS_MS,
  );

  it(
    'during permission-wait: cancel answers the pending permission as cancelled and settles the turn; a late resolvePermission is invalid_state',
    async () => {
      const adapter = await makeAdapter(
        {
          cancel: { behavior: 'acknowledge' },
          turns: [{ permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } }],
        },
        { permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'interactive' } }, // no handler → waits for resolvePermission
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const turn = adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });
      await waitUntil(
        () => updates.some((update) => update.kind === 'permission_request'),
        'permission request surfaced',
      );
      await adapter.cancelTurn({ sessionId: session.acpSessionId });
      const result = await turn;
      expect(result.stopReason).toBe('cancelled');

      const request = updates.find(
        (update): update is Extract<SessionUpdate, { kind: 'permission_request' }> =>
          update.kind === 'permission_request',
      )!.request;
      await expectAdapterErrorKind(
        adapter.resolvePermission({
          sessionId: session.acpSessionId,
          requestId: request.requestId,
          outcome: { kind: 'selected', optionId: 'allow_once' },
        }),
        'invalid_state',
      );
    },
    GENEROUS_MS,
  );

  it(
    'during tool-exec with cancel IGNORED: grace expires → escalation terminates the child, turn still settles cancelled (never a crash)',
    async () => {
      const adapter = await makeAdapter(
        {
          cancel: { behavior: 'ignore' },
          turns: [{ delayBeforeResponseMs: 60_000 }],
        },
        { limits: { cancelGraceMs: 250, terminateGraceMs: 300 } },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const turn = adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      await sleep(80);
      await adapter.cancelTurn({ sessionId: session.acpSessionId });
      const result = await turn;
      expect(result.stopReason).toBe('cancelled'); // authoritative signal (§10.2)
      await waitUntil(() => adapter.exitInfo !== undefined, 'child terminated by escalation');
      // Node dies on the first (SIGTERM) rung here.
      expect(adapter.exitInfo?.signal).toBe('SIGTERM');
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// PLAN §19 test 8 — process-group cleanup, no orphans (child + grandchild)
// ---------------------------------------------------------------------------
describe('PLAN §19 test 8 — process-group cleanup with no orphans', () => {
  it(
    'cancel escalation SIGKILLs the whole group: a SIGTERM-ignoring agent AND its grandchild are both reaped',
    async () => {
      const adapter = await makeAdapter(
        {
          cancel: { behavior: 'ignore' },
          turns: [{ delayBeforeResponseMs: 60_000 }],
        },
        {
          wrapper: { ignoreSigterm: true },
          limits: { cancelGraceMs: 250, terminateGraceMs: 250 },
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const grandchildPid = await grandchildPidOf(adapter);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      const turn = adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      await sleep(80);
      await adapter.cancelTurn({ sessionId: session.acpSessionId });
      const result = await turn;
      expect(result.stopReason).toBe('cancelled');

      await waitUntil(() => adapter.exitInfo !== undefined, 'agent reaped');
      // SIGTERM was ignored, so the ladder's last rung did the work.
      expect(adapter.exitInfo?.signal).toBe('SIGKILL');
      const childPid = adapter.transportPid!;
      await waitUntil(() => !isProcessAlive(grandchildPid), 'grandchild reaped with the group');
      await waitUntil(() => !isProcessAlive(childPid), 'agent process gone');
    },
    GENEROUS_MS,
  );

  it(
    'close() alone reaps the whole group, including a SIGTERM-ignoring grandchild',
    async () => {
      const adapter = await makeAdapter({}, { wrapper: { ignoreSigterm: false } });
      await adapter.initialize();
      await adapter.createSession({ cwd: tmpdir() });
      const grandchildPid = await grandchildPidOf(adapter);
      const childPid = adapter.transportPid!;
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await adapter.close();
      await adapter.close(); // idempotent

      await waitUntil(() => !isProcessAlive(childPid), 'agent process gone after close');
      await waitUntil(() => !isProcessAlive(grandchildPid), 'grandchild reaped after close');
      expect(adapter.exitInfo).toBeDefined();
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// Capability probe, identity, late updates, provider envelopes
// ---------------------------------------------------------------------------
describe('ACP session adapter — probe/identity/late updates/envelopes (§10.1, §11.1, #864, §13)', () => {
  it(
    'initialize records the §9 capability record from the probe; unsupported ops throw typed errors',
    async () => {
      const adapter = await makeAdapter({});
      const record = await adapter.initialize();

      expect(record.protocol).toEqual({ name: 'acp', version: '1' });
      expect(record.executable.packageName).toBe('fake-acp-child');
      expect(record.sessionOps).toEqual({
        create: true,
        load: true, // the fake advertises loadSession
        resume: false,
        fork: false,
        cancel: true,
      });
      expect(record.modelMechanism).toBe('unsupported');
      expect(record.permissionRequests).toBe(true);
      expect(record.mcpConfig).toEqual({ supported: false, reportOnly: true });
      expect(adapter.probedCapabilities).toEqual({
        load: true,
        resume: false,
        fork: false,
        setConfigOption: false,
        setMode: false,
        spawnIdEchoed: true, // §10.1 HARNESS_SPAWN_ID echoed
        authMethods: [], // H-2: none advertised by the default fake
      });
      // §9: optional members OMITTED, not stubbed.
      const asSpi: HarnessAdapter = adapter;
      expect(asSpi.resumeSession).toBeUndefined();
      expect(asSpi.forkSession).toBeUndefined();

      const session = await adapter.createSession({ cwd: tmpdir() });
      // TX-2: the fake serves the REAL SessionConfigOption shape; the session
      // layer maps category→kind, options[].value→values, currentValue→current.
      const options = await adapter.listConfigOptions(session.acpSessionId);
      expect(options.find((option) => option.id === 'model')).toEqual({
        id: 'model',
        kind: 'model',
        values: ['fake-small', 'fake-large'],
        current: 'fake-small',
      });
      expect(options.find((option) => option.id === 'mode')?.kind).toBe('mode');
      // §9: unsupported capability is a TYPED error, never silent (the probe
      // did not advertise set_config_option and no override supplied it).
      const error = await expectAdapterErrorKind(
        adapter.setConfigOption({ sessionId: session.acpSessionId, optionId: 'model', value: 'x' }),
        'unsupported_capability',
      );
      expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    },
    GENEROUS_MS,
  );

  it(
    'profile capability overrides layer over the probed record',
    async () => {
      const adapter = await makeAdapter(
        {},
        { capabilityOverrides: { usageLimitReporting: 'structured', auth: 'supported' } },
      );
      const record = await adapter.initialize();
      expect(record.usageLimitReporting).toBe('structured');
      expect(record.auth).toBe('supported');
      expect(record.sessionOps.load).toBe(true); // probed fields intact
    },
    GENEROUS_MS,
  );

  it(
    'session identity: create returns the advertised id; load of the exact id succeeds and replayed updates never crash (counted as orphans)',
    async () => {
      const adapter = await makeAdapter({
        load: { replayUpdates: [{ text: 'replayed 1' }, { text: 'replayed 2' }] },
      });
      await adapter.initialize();
      const loaded = await adapter.loadSession({
        acpSessionId: 'sess_fake_000001' as never,
        cwd: tmpdir(),
      });
      expect(String(loaded.acpSessionId)).toBe('sess_fake_000001');
      await waitUntil(() => adapter.orphanUpdateCount >= 2, 'replay updates counted');
      expect(adapter.callbackErrorCount).toBe(0);

      // Prompting an id nobody created/loaded is a typed session_not_found.
      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: 'sess_unknown' as never, prompt: 'x' }),
        'session_not_found',
      );
    },
    GENEROUS_MS,
  );

  it(
    'late session/update after the prompt response is attributed to the closed turn and MUST NOT throw — even when the consumer callback throws',
    async () => {
      const adapter = await makeAdapter({
        turns: [
          {
            updates: [{ text: 'on time' }],
            response: { stopReason: 'end_turn' },
            lateUpdates: [{ text: 'late straggler' }],
            lateUpdateDelayMs: 60,
          },
          { updates: [{ text: 'second turn ok' }], response: { stopReason: 'end_turn' } },
        ],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });

      const received: string[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => {
          if (update.kind === 'agent_message_chunk') {
            received.push(update.text);
            if (update.text === 'late straggler') throw new Error('consumer bug');
          }
        },
      });
      expect(result.stopReason).toBe('end_turn');
      expect(received).toEqual(['on time']); // turn closed before the straggler

      await waitUntil(() => received.includes('late straggler'), 'late update delivered');
      expect(adapter.callbackErrorCount).toBeGreaterThanOrEqual(1); // swallowed, not thrown

      // The adapter is still healthy: a second turn runs cleanly.
      const second = await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'again' });
      expect(second.stopReason).toBe('end_turn');
    },
    GENEROUS_MS,
  );

  it(
    'a provider error envelope rejects the prompt with provider_error and classifies structured (agent text never classifies)',
    async () => {
      const clock = new ManualClock('2026-07-18T00:00:00.000Z');
      const adapter = await makeAdapter(
        { turns: [{ error: rateLimitErrorEnvelope({ retryAfterSeconds: 900 }) }] },
        { clock },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const error = await expectAdapterErrorKind(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' }),
        'provider_error',
      );

      const envelope = providerEnvelopeOf(error);
      expect(envelope).toBeDefined();
      const classification = adapter.classifyError(envelope);
      expect(classification.kind).toBe('usage_limit');
      expect(classification.source).toBe('structured');
      expect(classification.detectionTier).toBe('structured');
      expect(classification.resumesAt).toBe('2026-07-18T00:15:00.000Z');

      // §9/§13: free text NEVER classifies — always unknown_provider_error.
      expect(adapter.classifyError('I seem to have hit a rate limit, resuming at 9pm').kind).toBe(
        'unknown_provider_error',
      );
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// P2 live-gate regressions (docs/reviews/p2-live-gate.md TX-1..TX-3b, P-1..P-3)
// — the fake child ENFORCES the recorded real wire shapes, so each of these
// fails offline if the corresponding session-layer fix regresses.
// ---------------------------------------------------------------------------
const SET_CONFIG_CAPS = { modelMechanism: 'session_set_config_option' } as const;

describe('P2 live-gate regression TX-1 — mcpServers is wire-required on session/new AND session/load', () => {
  it(
    'createSession and loadSession pass the strict child (which -32602-rejects cwd-only frames)',
    async () => {
      const adapter = await makeAdapter({});
      await adapter.initialize();
      // If the adapter ever drops mcpServers again, the child answers with the
      // recorded zod-shaped -32602 and this createSession call rejects.
      const session = await adapter.createSession({ cwd: tmpdir() });
      expect(String(session.acpSessionId)).toBe('sess_fake_000001');
      const loaded = await adapter.loadSession({
        acpSessionId: session.acpSessionId,
        cwd: tmpdir(),
      });
      expect(String(loaded.acpSessionId)).toBe('sess_fake_000001');
    },
    GENEROUS_MS,
  );
});

describe('P2 live-gate regression TX-2 — real config-option shape normalization', () => {
  it('parses the REAL {id,name,category,type,currentValue,options:[{value}]} shape', () => {
    expect(
      parseConfigOptionsWire([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5.6-sol',
          options: [
            { value: 'gpt-5.6-sol', name: 'Sol' },
            { value: 'gpt-5.6-terra', name: 'Terra' },
          ],
        },
        {
          id: 'effort',
          name: 'Reasoning effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'high',
          options: [{ value: 'low' }, { value: 'high' }],
        },
        {
          id: 'fast-mode',
          name: 'Fast mode',
          category: 'custom_thing',
          type: 'boolean',
          currentValue: false,
        },
      ]),
    ).toEqual([
      {
        id: 'model',
        kind: 'model',
        values: ['gpt-5.6-sol', 'gpt-5.6-terra'],
        current: 'gpt-5.6-sol',
      },
      { id: 'effort', kind: 'reasoning', values: ['low', 'high'], current: 'high' },
      { id: 'fast-mode', kind: 'other', values: ['true', 'false'], current: 'false' },
    ]);
  });

  it('flattens grouped select options and skips idless entries; non-arrays yield []', () => {
    expect(
      parseConfigOptionsWire([
        {
          id: 'model',
          category: 'model',
          type: 'select',
          currentValue: 'a1',
          options: [
            { group: 'alpha', name: 'Alpha', options: [{ value: 'a1' }, { value: 'a2' }] },
            { group: 'beta', name: 'Beta', options: [{ value: 'b1' }] },
          ],
        },
        { name: 'no id — skipped' },
      ]),
    ).toEqual([{ id: 'model', kind: 'model', values: ['a1', 'a2', 'b1'], current: 'a1' }]);
    expect(parseConfigOptionsWire(undefined)).toEqual([]);
    expect(parseConfigOptionsWire('nope')).toEqual([]);
  });

  it(
    'model discovery through the SPI is no longer blind: kinds/values/current populated over the wire',
    async () => {
      const adapter = await makeAdapter({});
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const model = (await adapter.listConfigOptions(session.acpSessionId)).find(
        (option) => option.id === 'model',
      );
      expect(model?.kind).toBe('model');
      expect(model?.values).toEqual(['fake-small', 'fake-large']);
      expect(model?.current).toBe('fake-small');
    },
    GENEROUS_MS,
  );
});

describe('P2 live-gate regression TX-3/TX-3b — configId param + confirm-by-echo via configOptions[].currentValue', () => {
  it(
    'setConfigOption crosses the wire as configId and resolves echoed:true from the configOptions echo',
    async () => {
      const adapter = await makeAdapter({}, { capabilityOverrides: SET_CONFIG_CAPS });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      // The strict child rejects optionId frames with the recorded -32602, so
      // success here proves the wire param is configId (TX-3).
      const result = await adapter.setConfigOption({
        sessionId: session.acpSessionId,
        optionId: 'model',
        value: 'fake-large',
      });
      // TX-3b/§11.2: the echo is read from configOptions[].currentValue —
      // there is NO result.value on the real wire.
      expect(result).toEqual({ effectiveValue: 'fake-large', echoed: true });
      // The refreshed echo replaced our per-session view.
      const model = (await adapter.listConfigOptions(session.acpSessionId)).find(
        (option) => option.id === 'model',
      );
      expect(model?.current).toBe('fake-large');
    },
    GENEROUS_MS,
  );

  it(
    'a value outside the advertised set surfaces the data-less handler -32602 as provider_error',
    async () => {
      const adapter = await makeAdapter({}, { capabilityOverrides: SET_CONFIG_CAPS });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const error = await expectAdapterErrorKind(
        adapter.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'model',
          value: 'gpt-9-guessed',
        }),
        'provider_error',
      );
      expect(providerEnvelopeOf(error)).toEqual({ code: -32602, message: 'Invalid params' });
      // Fail-safe classification (§13): unknown_provider_error, never breaker.
      expect(adapter.classifyError(providerEnvelopeOf(error)).kind).toBe('unknown_provider_error');
    },
    GENEROUS_MS,
  );
});

describe('P2 live-gate regression P-1 — per-role session-mode pinning at session setup', () => {
  const CLAUDE_STYLE: SessionModePolicy = {
    byRole: {
      coordinator: { mechanism: 'session_set_mode', value: 'default' },
      implementor: { mechanism: 'session_set_mode', value: 'default' },
      verifier: { mechanism: 'session_set_mode', value: 'default' },
    },
    defaultPin: { mechanism: 'session_set_mode', value: 'default' },
  };
  const CODEX_STYLE: SessionModePolicy = {
    byRole: {
      coordinator: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
      implementor: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'agent' },
      verifier: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
    },
    defaultPin: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
  };

  it('resolveModePin: per-role pin first, defaultPin for unknown/absent roles', () => {
    expect(resolveModePin(CODEX_STYLE, 'implementor')?.value).toBe('agent');
    expect(resolveModePin(CODEX_STYLE, 'verifier')?.value).toBe('read-only');
    expect(resolveModePin(CODEX_STYLE, undefined)?.value).toBe('read-only');
    expect(resolveModePin({ byRole: {} }, 'implementor')).toBeUndefined();
  });

  it(
    "claude-style: session/set_mode 'default' (never 'auto') is pinned on create AND load, recorded per session",
    async () => {
      const adapter = await makeAdapter(
        {},
        {
          permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'implementor' },
          sessionMode: CLAUDE_STYLE,
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await adapter.loadSession({ acpSessionId: session.acpSessionId, cwd: tmpdir() });
      expect(adapter.modePins).toHaveLength(2);
      for (const pin of adapter.modePins) {
        expect(pin).toMatchObject({
          sessionId: 'sess_fake_000001',
          role: 'implementor',
          mechanism: 'session_set_mode',
          value: 'default',
        });
      }
    },
    GENEROUS_MS,
  );

  it(
    'codex-style: read-only for the verifier is pinned via the TX-3-corrected set_config_option and CONFIRMED by echo',
    async () => {
      const adapter = await makeAdapter(
        {},
        {
          permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'verifier' },
          sessionMode: CODEX_STYLE,
        },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      expect(adapter.modePins).toEqual([
        expect.objectContaining({
          mechanism: 'session_set_config_option',
          optionId: 'mode',
          value: 'read-only',
          echoed: true, // effective-value echo observed (TX-3b channel)
        }),
      ]);
      // The pinned mode is the session's current mode — not the 'auto' default.
      const mode = (await adapter.listConfigOptions(session.acpSessionId)).find(
        (option) => option.id === 'mode',
      );
      expect(mode?.current).toBe('read-only');
    },
    GENEROUS_MS,
  );

  it(
    'fail-loud: a pin outside the advertised mode set FAILS the session setup (no silent permissive default)',
    async () => {
      const adapter = await makeAdapter(
        {},
        {
          permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', role: 'implementor' },
          sessionMode: {
            byRole: {},
            defaultPin: { mechanism: 'session_set_mode', value: 'not-a-real-mode' },
          },
        },
      );
      await adapter.initialize();
      await expectAdapterErrorKind(adapter.createSession({ cwd: tmpdir() }), 'invalid_argument');
      // The unpinned session was DROPPED — nothing can run it in the
      // permissive default mode.
      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: 'sess_fake_000001' as never, prompt: 'x' }),
        'session_not_found',
      );
    },
    GENEROUS_MS,
  );

  it(
    'without a policy nothing is pinned (bare-transport tests remain undisturbed)',
    async () => {
      const adapter = await makeAdapter({});
      await adapter.initialize();
      await adapter.createSession({ cwd: tmpdir() });
      expect(adapter.modePins).toEqual([]);
    },
    GENEROUS_MS,
  );
});

describe('P2 live-gate regression P-2 — {}-style sessionCapabilities advertisement counts', () => {
  it(
    'sessionCapabilities.resume/fork advertised as EMPTY OBJECTS are probed as supported',
    async () => {
      const adapter = await makeAdapter({
        handshake: { sessionCapabilities: { resume: {}, fork: {}, list: {}, close: {} } },
      });
      const record = await adapter.initialize();
      expect(adapter.probedCapabilities).toMatchObject({
        load: true,
        resume: true, // was false pre-fix: truthy() only accepted `true`
        fork: true,
      });
      expect(record.sessionOps.resume).toBe(true);
      expect(record.sessionOps.fork).toBe(true);
      // false/null/absent still mean NOT advertised.
      expect(adapter.probedCapabilities?.setConfigOption).toBe(false);
      expect(adapter.probedCapabilities?.setMode).toBe(false);
    },
    GENEROUS_MS,
  );
});

describe('P2 live-gate regression P-3 — real session/update kinds normalize; unknown kinds survive', () => {
  it('normalizes every live-observed kind into its typed event', () => {
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'usage_update', used: 7349, size: 272000 }),
    ).toEqual({ kind: 'usage_update', usedTokens: 7349, contextWindowSize: 272000 });
    expect(
      normalizeSessionUpdate({
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 0.42, currency: 'USD' },
      }),
    ).toEqual({
      kind: 'usage_update',
      usedTokens: 10,
      contextWindowSize: 100,
      cost: { amount: 0.42, currency: 'USD' },
    });
    expect(
      normalizeSessionUpdate({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Reply with exactly: OK' },
      }),
    ).toEqual({ kind: 'user_message_chunk', text: 'Reply with exactly: OK' });
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'session_info_update', title: 'Gate run' }),
    ).toEqual({ kind: 'session_info_update', title: 'Gate run' });
    expect(
      normalizeSessionUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact' }, { name: 'review' }, { bogus: true }],
      }),
    ).toEqual({ kind: 'available_commands_update', commandNames: ['compact', 'review'] });
    expect(
      normalizeSessionUpdate({
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            type: 'select',
            currentValue: 'sonnet',
            options: [{ value: 'sonnet' }, { value: 'opus' }],
          },
        ],
      }),
    ).toEqual({
      kind: 'config_option_update',
      configOptions: [
        { id: 'model', kind: 'model', values: ['sonnet', 'opus'], current: 'sonnet' },
      ],
    });
    expect(
      normalizeSessionUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'default' }),
    ).toEqual({ kind: 'current_mode_update', currentModeId: 'default' });
  });

  it('malformed real kinds and unknown kinds pass through as unknown — never dropped, never thrown', () => {
    const malformedUsage = { sessionUpdate: 'usage_update', used: 'lots' };
    expect(normalizeSessionUpdate(malformedUsage)).toEqual({ kind: 'unknown', raw: malformedUsage });
    const novel = { sessionUpdate: 'some_future_kind', payload: 1 };
    expect(normalizeSessionUpdate(novel)).toEqual({ kind: 'unknown', raw: novel });
    expect(normalizeSessionUpdate(undefined)).toEqual({ kind: 'unknown', raw: undefined });
  });

  it(
    'the default per-turn usage_update crosses the wire as a typed event (§17.2 feed)',
    async () => {
      const adapter = await makeAdapter({
        turns: [
          {
            updates: [{ text: 'OK' }, { raw: { sessionUpdate: 'mystery_kind', x: 1 } }],
            response: { stopReason: 'end_turn' },
          },
        ],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });
      expect(result.stopReason).toBe('end_turn');
      // Adapter-reported usage on the settled response (REAL Usage shape).
      expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 22, source: 'adapter' });
      const usage = updates.find((update) => update.kind === 'usage_update');
      expect(usage).toEqual({ kind: 'usage_update', usedTokens: 1200, contextWindowSize: 200000 });
      // The scripted unknown kind was passed through un-dropped.
      expect(updates.some((update) => update.kind === 'unknown')).toBe(true);
      expect(adapter.callbackErrorCount).toBe(0);
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// P2 live-gate regression H-2 — ACP authenticate seam + turn-evidence-honest
// auth tracking (docs/reviews/p2-live-gate.md, finding H-2)
// ---------------------------------------------------------------------------
describe('P2 live-gate regression H-2 — authenticate seam + auth evidence', () => {
  it(
    'advertised authMethods are probed at initialize (live shape: api-key + chat-gpt)',
    async () => {
      const adapter = await makeAdapter({
        handshake: { authMethods: [{ id: 'api-key' }, { id: 'chat-gpt', name: 'ChatGPT' }] },
      });
      await adapter.initialize();
      expect(adapter.probedCapabilities?.authMethods).toEqual(['api-key', 'chat-gpt']);
    },
    GENEROUS_MS,
  );

  it(
    'authenticate resolves on ACP acceptance — and acceptance is NOT validated auth evidence',
    async () => {
      const adapter = await makeAdapter({
        handshake: { authMethods: [{ id: 'api-key' }] },
      });
      await adapter.initialize();
      await expect(adapter.authenticate({ methodId: 'api-key' })).resolves.toBeUndefined();
      // The live H-2 probe: authenticate accepted in 3ms for a key that
      // 401'd on the next turn — acceptance must never upgrade evidence.
      expect(adapter.authEvidence.validatedTurnAt).toBeUndefined();
      expect(adapter.authEvidence.authFailureAt).toBeUndefined();
    },
    GENEROUS_MS,
  );

  it(
    'a rejected authenticate surfaces as provider_error with the envelope intact',
    async () => {
      const adapter = await makeAdapter({
        authenticate: { error: { code: -32602, message: 'Invalid params' } },
      });
      await adapter.initialize();
      await expect(adapter.authenticate({ methodId: 'gateway' })).rejects.toMatchObject({
        kind: 'provider_error',
      });
    },
    GENEROUS_MS,
  );

  it(
    'a successful (non-cancelled) turn records validatedTurnAt — the ONLY path to supported',
    async () => {
      const adapter = await makeAdapter({});
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      expect(adapter.authEvidence.validatedTurnAt).toBeUndefined();
      await adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' });
      expect(adapter.authEvidence.validatedTurnAt).toBeDefined();
      expect(adapter.authEvidence.authFailureAt).toBeUndefined();
    },
    GENEROUS_MS,
  );

  it(
    'an auth-classified provider envelope records authFailureAt (invalid credentials stay not-supported)',
    async () => {
      const adapter = await makeAdapter({
        turns: [
          { error: { code: -32603, message: 'auth', data: { errorKind: 'auth' } } },
        ],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await expect(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' }),
      ).rejects.toMatchObject({ kind: 'provider_error' });
      expect(adapter.authEvidence.authFailureAt).toBeDefined();
      expect(adapter.authEvidence.validatedTurnAt).toBeUndefined();
    },
    GENEROUS_MS,
  );

  it(
    'a NON-auth provider envelope does NOT record auth-failure evidence',
    async () => {
      const adapter = await makeAdapter({
        turns: [{ error: rateLimitErrorEnvelope() }],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await expect(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' }),
      ).rejects.toMatchObject({ kind: 'provider_error' });
      expect(adapter.authEvidence.authFailureAt).toBeUndefined();
    },
    GENEROUS_MS,
  );
});
