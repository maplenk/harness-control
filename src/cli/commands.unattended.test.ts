/**
 * B2 — the UNATTENDED path, end to end: does a run pinned to `approval:'auto'`
 * actually reach the IMPLEMENTOR with no human in it, and does a run pinned to
 * `approval:'human'` still refuse to?
 *
 * `src/cli/commands.auto-approval.test.ts` pins the SIGNATURE (who signed, what
 * hash, how it is reported). This file pins the CONSEQUENCE — the thing an
 * operator actually wants to know before switching the knob on:
 *
 *  1. AUTO reaches the implementor. `start` + `run` are the ONLY two commands
 *     issued; the run spawns a real implementor child and reaches
 *     `merge_ready`, and the event log contains exactly one `spec.approved`,
 *     signed `auto`, with NO `approvedBy:'human'` anywhere. Asserted on the
 *     durable EVENT log (`child.spawned {role:'implementor'}`), not on the
 *     command's return value: "the CLI said merge_ready" is not "an
 *     implementor ran".
 *  2. HUMAN does NOT reach the implementor. The mirror image, and the direction
 *     that has to hold for the default to mean anything: the same two commands,
 *     the same scripts, a run pinned `human` — `run` REFUSES (`not_approved`),
 *     NO implementor child is ever spawned, and the engine's own signature is
 *     refused at the service gate (`approval_mode_not_auto`) if anything tries
 *     to supply one. Both halves, because "auto is refused" without "and
 *     therefore no work happened" is a guard nobody proved fires.
 *  3. The COMMITTED dogfood configs are what they claim. The unattended path is
 *     a config file, so the file is the guard: `dogfood.auto.config.json` must
 *     parse as `approval:'auto'` with a non-empty allowlist that actually bites,
 *     and `dogfood.config.json` must stay `human`. A committed config that
 *     stopped parsing would fail at `start` on a paying run; a committed "auto"
 *     config that silently became `human` would park an unattended run at a gate
 *     nobody is watching.
 *
 * Wiring is deliberately the same shape as `commands.auto-approval.test.ts`:
 * the SHIPPED `executeCommand` surface, in-process fake adapters, a real temp
 * git repo, both SQLite drivers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { artifactHash, specHash as toSpecHash, specVersionId as toSpecVersionId, type RunId } from '../domain/ids.js';
import {
  availableDriverKinds,
  openTestDatabase,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import type { DriverKind } from '../persistence/index.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import { loadEngineConfigFromFile, parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import { isErr, unwrap } from '../lib/result.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import { GitWorktreeManager } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import {
  OrchestrationService,
  SpecApprovalRefusedError,
  type Harness,
  type RoleAdapterFactory,
  type RoleModelSpec,
} from '../app/index.js';
import { CoordinatorRunner, validateCoordinatorSpec } from '../app/flows/coordinator.js';
import type { EvidenceRecorder } from '../app/flows/verifier.js';
import type { VerificationRunner } from '../app/flows/implementor.js';
import { executeCommand, type CliFlowDeps } from './commands.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));

/** The committed dogfood configs — the files an operator actually passes to `start`. */
const DOGFOOD_AUTO_CONFIG = fileURLToPath(new URL('../../scripts/dogfood/dogfood.auto.config.json', import.meta.url));
const DOGFOOD_HUMAN_CONFIG = fileURLToPath(new URL('../../scripts/dogfood/dogfood.config.json', import.meta.url));

/** B2 F4: `approval:'auto'` REQUIRES a run-pinned verification allowlist. */
const ALLOWED_COMMANDS = ['echo check-ac1'] as const;
const HUMAN_CONFIG = (): EngineConfig => unwrap(parseEngineConfig({}));
const AUTO_CONFIG = (): EngineConfig =>
  unwrap(parseEngineConfig({ approval: 'auto', verification: { allowedCommands: [...ALLOWED_COMMANDS] } }));

function configOptionsFor(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
    assumptions: ['The CLI entrypoint is src/cli/index.ts.'],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: ['No change to the existing log format'],
    tasks: [{ id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] }],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The --verbose flag enables debug output',
        verificationCommands: ['echo check-ac1'],
        expectedEvidence: 'exits with code 0 and stderr contains the debug prefix',
      },
    ],
    rollback: 'Revert the single commit on the worktree branch.',
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
  };
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

const coordinatorTurn = (spec: unknown): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
  result: { stopReason: 'end_turn' },
});

const implementorTurn = (text: string): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

const verifierTurn = (
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string }>,
): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: JSON.stringify({ criteria: rows }) }],
  result: { stopReason: 'end_turn' },
});

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

interface Scripts {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}

/**
 * The adapter factory ALSO records every role it was asked to construct. A
 * refusal that still built an implementor adapter would be a refusal that
 * happened too late, and the event-log assertion alone would not see it.
 */
function makeFactory(scripts: Scripts, constructed: string[]): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options) {
      const role = options.role;
      constructed.push(role);
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const queue = scripts[role as keyof Scripts] ?? [];
      const script: AdapterScript = queue[idx] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (input) => {
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    async record(input) {
      n += 1;
      return artifactHash(`ev_${String(input.criterionId)}_${n}`);
    },
  };
}

let dbHandle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;
let worktrees: GitWorktreeManager | undefined;

afterEach(async () => {
  if (worktrees !== undefined) {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  worktrees = undefined;
  dbHandle?.close();
  dbHandle?.cleanup();
  dbHandle = undefined;
  await repo?.cleanup();
  repo = undefined;
});

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly deps: { readonly ids: DeterministicIdFactory; readonly flows: CliFlowDeps };
  /** Every role the adapter factory was asked to construct, in order. */
  readonly constructedRoles: readonly string[];
}

async function setup(kind: DriverKind, config: EngineConfig, scripts: Scripts): Promise<Wired> {
  repo = await makeTempGitRepo('harness-cli-unattended-');
  dbHandle = await openTestDatabase({ kind, file: true });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: dbHandle.db.clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const constructedRoles: string[] = [];
  const adapterFactory = makeFactory(scripts, constructedRoles);
  const db = dbHandle.db;
  const service = new OrchestrationService({ db, ids, adapterFactory, config });
  const store = new ArtifactStore({ rootDir: dbHandle.casRoot, clock: db.clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error(`coordinator profile failed to load: ${JSON.stringify(profileResult.error)}`);
  const profile: Profile = profileResult.value;
  const mgr = worktrees;
  const flows: CliFlowDeps = {
    ids,
    clock: db.clock,
    buildCoordinatorRunner: ({ goal, revise, baseCommit }) =>
      new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock: db.clock,
        baseCommit,
        allowedVerificationCommands: config.verification.allowedCommands,
        maxRounds: 1,
        ...(revise !== undefined ? { revise } : {}),
      }),
    openWorktrees: async () => mgr,
    evidence: fakeEvidence(),
    runVerification: PASS_VERIFY,
  };
  return { service, db, deps: { ids, flows }, constructedRoles };
}

/** The full implement→verify script a `merge_ready` run needs. */
const WORKING_SCRIPTS = (): Scripts => ({
  coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
  implementor: [
    {
      writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
      turns: [implementorTurn('Implemented --verbose.')],
    },
  ],
  verifier: [{ turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }])] }],
});

/** Roles for which the durable log records a FULLY spawned child (W2-1). */
function spawnedRoles(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events
    .listByRun(runId)
    .filter((e) => e.type === 'child.spawned')
    .map((e) => (e.payload as { role: string }).role);
}

/** Every recorded approval signature, in log order. */
function approvalSigners(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events
    .listByRun(runId)
    .filter((e) => e.type === 'spec.approved')
    .map((e) => (e.payload as { approvedBy?: string }).approvedBy ?? '(absent)');
}

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('B2 unattended path [%s]', (kind) => {
  // -------------------------------------------------------------------------
  // 1 — AUTO reaches the implementor, with no human approval event
  // -------------------------------------------------------------------------
  it("approval:'auto' — start + run alone reach the IMPLEMENTOR; no human approval event exists", async () => {
    const { service, db, deps, constructedRoles } = await setup(kind, AUTO_CONFIG(), WORKING_SCRIPTS());

    // COMMAND 1 of 2. No `approve` is issued anywhere in this test.
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    expect(start.json['phase']).toBe('approved');

    // COMMAND 2 of 2.
    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.exitCode).toBe(0);
    expect(run.json['outcome']).toBe('merge_ready');

    // THE CLAIM: an implementor child really was spawned. Asserted on the
    // durable log (W2-1 `child.spawned` is appended only AFTER every §11.2 pin
    // succeeded) and cross-checked against what the adapter factory was asked
    // to build — a CLI return value is not evidence that a role ran.
    expect(spawnedRoles(db, runId)).toContain('implementor');
    expect(constructedRoles).toContain('implementor');

    // ...and NO human signed anything. Exactly one signature, and it is `auto`.
    expect(approvalSigners(db, runId)).toEqual(['auto']);
    expect(approvalSigners(db, runId)).not.toContain('human');
    expect(service.status(runId).specApprovedBy).toBe('auto');
  });

  // -------------------------------------------------------------------------
  // 2 — HUMAN does NOT reach the implementor, and refuses an engine signature
  // -------------------------------------------------------------------------
  it("approval:'human' — the SAME two commands never reach the implementor (run refuses, nothing spawned)", async () => {
    const { service, db, deps, constructedRoles } = await setup(kind, HUMAN_CONFIG(), WORKING_SCRIPTS());

    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    expect(start.json['phase']).toBe('awaiting_approval');

    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    // The guard FIRES: refused, with the reason named.
    expect(run.exitCode).toBe(1);
    expect(run.json['error']).toBe('not_approved');
    expect(run.json['phase']).toBe('awaiting_approval');

    // ...and it fired in time. No implementor was spawned, and none was even
    // constructed — only the coordinator round ever ran.
    expect(spawnedRoles(db, runId)).not.toContain('implementor');
    expect(constructedRoles).not.toContain('implementor');
    expect(approvalSigners(db, runId)).toEqual([]);
  });

  it("approval:'human' — the ENGINE's own signature is REFUSED at the service gate, on a run with a REAL draft", async () => {
    const { service, db, deps } = await setup(kind, HUMAN_CONFIG(), WORKING_SCRIPTS());

    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    // Everything a legitimate auto-approval has EXCEPT the pin: a durable
    // completion record, a live draft projection, and the exact drafted
    // version + hash. Only the run's pinned mode is different, so the refusal
    // can only come from the signer check.
    await expect(
      service.approve(
        runId,
        {
          specVersionId: toSpecVersionId(spec.specVersionId),
          specHash: toSpecHash(spec.specHash),
          mode: 'auto',
        },
        {},
      ),
    ).rejects.toThrow(SpecApprovalRefusedError);

    await service
      .approve(
        runId,
        {
          specVersionId: toSpecVersionId(spec.specVersionId),
          specHash: toSpecHash(spec.specHash),
          mode: 'auto',
        },
        {},
      )
      .then(
        () => expect.fail('a human-pinned run must never accept an engine signature'),
        (error: unknown) => {
          expect(error).toBeInstanceOf(SpecApprovalRefusedError);
          expect((error as SpecApprovalRefusedError).reason).toBe('approval_mode_not_auto');
        },
      );

    // Nothing was written: the run is still at the gate with no signature.
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(approvalSigners(db, runId)).toEqual([]);

    // And the SAME run still accepts a real human approval — the guard is
    // surgical, not a blanket refusal (house rule: never refuse what the
    // status quo accepts).
    const approved = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: false,
      },
      {},
      deps,
    );
    expect(approved.exitCode).toBe(0);
    expect(approvalSigners(db, runId)).toEqual(['human']);
  });

  // -------------------------------------------------------------------------
  // 3 — `status --json` names the SIGNER, so an unattended runner can branch on
  //     engine state instead of on the config file it happened to pass.
  //     Three-valued on purpose: 'auto', 'human', and ABSENT = unknown.
  // -------------------------------------------------------------------------
  it("status --json reports specApprovedBy:'auto' for an engine-signed run", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), WORKING_SCRIPTS());
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {}, deps);
    expect(status.json['specApprovedBy']).toBe('auto');
    expect(status.json['approvedSpecHash']).toBe((start.json['spec'] as { specHash: string }).specHash);
    // The reported signer must equal the DURABLE event, not a value the CLI
    // decided — that disagreement is the whole hazard this field carries.
    expect(status.json['specApprovedBy']).toBe(approvalSigners(db, runId).at(-1));
  });

  it("status --json OMITS specApprovedBy before approval and reports 'human' after one", async () => {
    const { service, db, deps } = await setup(kind, HUMAN_CONFIG(), WORKING_SCRIPTS());
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    // Not approved at all: the key is ABSENT, and so is the hash. Absence must
    // never be rendered as a signer — an unattended runner must read "no
    // approval yet", never "a human did it".
    const before = await executeCommand(service, db, { kind: 'status', json: true, runId }, {}, deps);
    expect(before.json).not.toHaveProperty('specApprovedBy');
    expect(before.json).not.toHaveProperty('approvedSpecHash');

    await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: false,
      },
      {},
      deps,
    );
    const after = await executeCommand(service, db, { kind: 'status', json: true, runId }, {}, deps);
    expect(after.json['specApprovedBy']).toBe('human');
    expect(after.json['specApprovedBy']).toBe(approvalSigners(db, runId).at(-1));
  });

  // -------------------------------------------------------------------------
  // 4 — `approve` is not merely unnecessary on an auto run: it is REJECTED.
  //     This is why the unattended script must branch on the run's PHASE
  //     rather than always calling `approve` (scripts/dogfood/run-slice.sh).
  // -------------------------------------------------------------------------
  it("approval:'auto' — a redundant `approve` of the already-bound spec is REJECTED, not a no-op", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), WORKING_SCRIPTS());
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    const redundant = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: false,
      },
      {},
      deps,
    );
    // T1 is illegal from `approved`, so the operator-facing outcome is a
    // rejection with a non-zero exit — which is exactly what would abort a
    // `set -euo pipefail` runner script that approves unconditionally.
    expect(redundant.exitCode).not.toBe(0);
    expect(redundant.json['outcome']).toBe('rejected');
    // The engine's own signature stands, unduplicated.
    expect(approvalSigners(db, runId)).toEqual(['auto']);
    expect(service.status(runId).phase).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// 4 — the COMMITTED dogfood configs are what they claim to be
//
// Driver-independent (pure file + schema), so it runs once rather than per
// driver. This is the guard on the unattended path itself: the path IS a config
// file, and a config file that stopped meaning `auto` would silently park an
// unattended run at a gate nobody is watching.
// ---------------------------------------------------------------------------
describe('the committed dogfood configs', () => {
  it("dogfood.auto.config.json parses as approval:'auto' with an allowlist the engine will enforce", () => {
    const loaded = loadEngineConfigFromFile(DOGFOOD_AUTO_CONFIG);
    if (isErr(loaded)) {
      expect.fail(
        `scripts/dogfood/dogfood.auto.config.json does not parse: ${loaded.error
          .map((i) => `${i.path === '' ? '(root)' : i.path}: ${i.message}`)
          .join('; ')}`,
      );
    }
    expect(loaded.value.approval).toBe('auto');
    // Non-empty is not decoration: the schema REFUSES `auto` without it, so a
    // config that lost this key would fail at `start` on a paying run.
    expect(loaded.value.verification.allowedCommands.length).toBeGreaterThan(0);
  });

  it('the auto config\'s allowlist actually BITES — a coordinator citing an undeclared command is refused', () => {
    const loaded = loadEngineConfigFromFile(DOGFOOD_AUTO_CONFIG);
    if (isErr(loaded)) expect.fail('auto config does not parse');
    const allowed = [...loaded.value.verification.allowedCommands];

    const specCiting = (command: unknown): unknown => ({
      ...validSpec(),
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'the criterion',
          verificationCommands: [command],
          expectedEvidence: 'exits with code 0',
        },
      ],
    });

    // The codex F4 repro command: a coordinator's own invention.
    const invented = validateCoordinatorSpec(specCiting('true'), { allowedVerificationCommands: allowed });
    expect(invented.ok).toBe(false);
    if (!invented.ok) {
      expect(JSON.stringify(invented.error)).toContain('which this run does not declare');
    }

    // ...and a command the config DOES declare is accepted, so the guard is a
    // filter and not a wall (both directions).
    const declared = validateCoordinatorSpec(specCiting(allowed[0]), { allowedVerificationCommands: allowed });
    expect(declared.ok).toBe(true);
  });

  it("dogfood.config.json stays the HUMAN-gated config (the default path is unchanged)", () => {
    const loaded = loadEngineConfigFromFile(DOGFOOD_HUMAN_CONFIG);
    if (isErr(loaded)) expect.fail('dogfood.config.json does not parse');
    expect(loaded.value.approval).toBe('human');
  });
});
