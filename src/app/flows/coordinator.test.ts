/**
 * COORDINATOR FLOW tests (PLAN §7, §8) — offline, in-process fake adapter (no
 * real spawns). Two halves:
 *  - PURE §7 validation: schema shape + the testability gate + emission
 *    extraction + canonical (content-addressable) serialization;
 *  - the flow driven through `OrchestrationService.runCoordination` /
 *    `runRole`, with the fake emitting a canned spec (valid + invalid cases),
 *    proving: created→specifying→awaiting_approval, the immutable
 *    content-addressed SpecVersion, the bounded re-prompt-with-feedback loop,
 *    the read-only (no-worktree) coordinator, and the T2 `spec revise`
 *    superseding revision.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { ManualClock } from '../../lib/clock.js';
import { ArtifactStore } from '../../artifacts/store.js';
import { sha256Hex } from '../../artifacts/hash.js';
import { loadProfileFile, type Profile } from '../../config/profile.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
} from '../../adapters/index.js';
import { OrchestrationService, type RoleAdapterFactory, type RoleAdapterOptions } from '../service.js';
import {
  CLEAN_PINNED_WORKSPACE_GIT,
  TEST_BASE_COMMIT,
  createRunFixture,
} from '../test-support.js';
import type {
  PlanningChatFactory,
  PlanningChatMessage,
  PlanningChatRoom,
  PlanningChatUpdate,
} from '../planning-chat.js';
import type { Harness } from '../model-resolution.js';
import {
  CoordinatorRunner,
  CoordinatorSpecError,
  assessSpecSemantics,
  canonicalizeSpec,
  extractSpecEmission,
  validateCoordinatorSpec,
  type CoordinatorOutcome,
} from './coordinator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const GOAL = 'Add a --verbose flag to the CLI so debug lines are printed to stderr.';

/** A well-formed, fully-testable §7 spec (concrete evidence for every criterion). */
function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
    assumptions: ['The CLI entrypoint is src/cli/index.ts and uses a hand-rolled arg parser.'],
    openQuestions: [],
    constraints: ['Touch only files under src/cli', 'Do not change the public API surface'],
    permissions: ['read and write within the assigned worktree', 'run the command npm test'],
    nonGoals: ['No change to the existing log format'],
    tasks: [
      { id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] },
      { id: 'T2', description: 'Gate debug output on the flag', dependsOn: ['T1'] },
    ],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The --verbose flag enables debug output',
        verificationCommands: ['node dist/cli/index.js --verbose'],
        expectedEvidence: 'exits with code 0 and stderr contains a line starting with the debug prefix',
      },
      {
        id: 'AC-2',
        description: 'Without the flag no debug output is printed',
        verificationCommands: ['node dist/cli/index.js'],
        expectedEvidence: 'exit code is 0 and stdout has no line matching the debug prefix',
      },
    ],
    rollback: 'Revert the single commit on the worktree branch. No migrations or data changes are involved.',
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
    explorationNotes: 'The arg parser lives in src/cli/index.ts around lines 20 to 40.',
  };
}

/** Same spec but AC-2 has vague, untestable evidence (no concrete signal). */
function untestableSpec(): Record<string, unknown> {
  const spec = validSpec();
  (spec['acceptanceCriteria'] as Array<Record<string, unknown>>)[1]!['expectedEvidence'] =
    'the logging works the way it should';
  return spec;
}

/** A superseding revision: adds AC-3 (so the content hash differs from v1). */
function revisedSpec(): Record<string, unknown> {
  const spec = validSpec();
  (spec['acceptanceCriteria'] as Array<Record<string, unknown>>).push({
    id: 'AC-3',
    description: 'The --verbose flag is documented in the help output',
    verificationCommands: ['node dist/cli/index.js --help'],
    expectedEvidence: 'stdout contains the string --verbose and exit code is 0',
  });
  return spec;
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

/** A fake turn that emits `spec` as a fenced ```json block after some prose. */
function specTurn(spec: unknown): InProcessTurnScript {
  return {
    updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
    result: { stopReason: 'end_turn' },
  };
}

// ---------------------------------------------------------------------------
// Harness (service + in-process fake factory recording adapters + prompt text)
// ---------------------------------------------------------------------------
function fakeConfigOptions(harness: Harness): ConfigOptionDescriptor[] {
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

interface CreatedFake {
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
}

type PromptFn = InProcessFakeAdapter['prompt'];

/** The Nth adapter created gets `turnsPerAdapter[N]` (independent turn cursors). */
function makeFactory(turnsPerAdapter: readonly (readonly InProcessTurnScript[])[]): {
  factory: RoleAdapterFactory;
  created: CreatedFake[];
  prompts: string[];
} {
  const created: CreatedFake[] = [];
  const prompts: string[] = [];
  let index = 0;
  const factory: RoleAdapterFactory = {
    create(options) {
      const turns = turnsPerAdapter[index] ?? [];
      index += 1;
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        turns,
      });
      // Record the prompt TEXT the flow sends each turn (the fake's own log
      // keeps only the session id, not the prompt body).
      const orig: PromptFn = adapter.prompt.bind(adapter);
      (adapter as { prompt: PromptFn }).prompt = (input) => {
        prompts.push(input.prompt);
        return orig(input);
      };
      created.push({ options, adapter });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created, prompts };
}

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const PROFILE_PATH = fileURLToPath(new URL('../../../profiles/coordinator.md', import.meta.url));

let dbHandle: TestDatabaseHandle | undefined;
let casDir: string | undefined;

afterEach(async () => {
  dbHandle?.close();
  dbHandle?.cleanup();
  dbHandle = undefined;
  if (casDir !== undefined) await rm(casDir, { recursive: true, force: true });
  casDir = undefined;
});

interface Harnessed {
  readonly service: OrchestrationService;
  readonly created: CreatedFake[];
  readonly prompts: string[];
  readonly store: ArtifactStore;
  readonly flowIds: DeterministicIdFactory;
  readonly flowClock: ManualClock;
  readonly profile: Profile;
}

async function harness(turnsPerAdapter: readonly (readonly InProcessTurnScript[])[]): Promise<Harnessed> {
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  casDir = await mkdtemp(path.join(tmpdir(), 'harness-coordinator-cas-'));
  const flowClock = new ManualClock('2026-07-18T00:00:00.000Z');
  const flowIds = new DeterministicIdFactory();
  const store = new ArtifactStore({ rootDir: casDir, clock: flowClock, ids: flowIds });
  const { factory, created, prompts } = makeFactory(turnsPerAdapter);
  const service = new OrchestrationService({
    db: dbHandle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) {
    throw new Error(`coordinator profile failed to load: ${JSON.stringify(profileResult.error)}`);
  }
  return { service, created, prompts, store, flowIds, flowClock, profile: profileResult.value };
}

function makeRunner(h: Harnessed, extra?: Partial<ConstructorParameters<typeof CoordinatorRunner>[0]>): CoordinatorRunner {
  return new CoordinatorRunner({
    goal: GOAL,
    profile: h.profile,
    artifactStore: h.store,
    ids: h.flowIds,
    clock: h.flowClock,
    baseCommit: TEST_BASE_COMMIT,
    explorationContext: 'src/cli/index.ts (base commit deadbeef): a hand-rolled arg parser.',
    ...extra,
  });
}

class FakePlanningRoom implements PlanningChatRoom {
  readonly code = 'AM-TEST';
  readonly invitation = 'Use the agent-room skill to join room: http://127.0.0.1:7331/rooms/AM-TEST';
  readonly viewerUrl = 'http://127.0.0.1:7331/rooms/AM-TEST';
  readonly coordinatorName = 'Coordinator';
  readonly sent: string[] = [];
  readonly summaries: string[] = [];
  readonly #updates: PlanningChatUpdate[];

  constructor(updates: readonly PlanningChatUpdate[]) {
    this.#updates = [...updates];
  }

  async send(content: string): Promise<void> {
    this.sent.push(content);
  }

  async listen(): Promise<PlanningChatUpdate> {
    const update = this.#updates.shift();
    if (update === undefined) throw new Error('FakePlanningRoom ran out of updates');
    return update;
  }

  async close(summary: string): Promise<void> {
    this.summaries.push(summary);
  }
}

function chatMessage(
  id: number,
  sender: string,
  content: string,
  addressedToCoordinator = true,
): PlanningChatMessage {
  return {
    id,
    sender,
    content,
    kind: sender === 'Steve' ? 'human' : 'agent',
    createdAt: '2026-07-18T00:00:00Z',
    addressedToCoordinator,
  };
}

function chatUpdate(
  messages: readonly PlanningChatMessage[],
  options: { readonly addressedOnly?: boolean; readonly shouldRespond?: boolean } = {},
): PlanningChatUpdate {
  return {
    status: 'open',
    activeAgents: 2,
    addressedOnly: options.addressedOnly ?? false,
    shouldRespond: options.shouldRespond ?? true,
    participants: [
      { name: 'Coordinator', role: 'agent' },
      { name: messages[0]?.sender ?? 'Reviewer', role: messages[0]?.kind === 'human' ? 'human' : 'agent' },
    ],
    messages,
  };
}

function chatFactory(room: PlanningChatRoom): PlanningChatFactory {
  return { create: async () => room };
}

// ---------------------------------------------------------------------------
// Pure §7 validation (schema + testability gate)
// ---------------------------------------------------------------------------
describe('validateCoordinatorSpec — §7 schema + testability gate', () => {
  it('accepts a well-formed, fully-testable spec and fills array defaults', () => {
    const result = validateCoordinatorSpec({
      goal: 'g',
      tasks: [{ id: 'T1', description: 'do it' }],
      acceptanceCriteria: [
        { id: 'AC-1', description: 'c', verificationCommands: ['run x'], expectedEvidence: 'exit code 0' },
      ],
      rollback: 'revert',
      proposedImplementorProfile: 'implementor',
      proposedVerifierProfile: 'verifier',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // omitted array fields default to [] (assumptions/constraints/…)
      expect(result.value.assumptions).toEqual([]);
      expect(result.value.constraints).toEqual([]);
      expect(result.value.tasks[0]?.dependsOn).toEqual([]);
    }
  });

  it('rejects a missing goal / no criteria / no tasks (schema)', () => {
    const r = validateCoordinatorSpec({
      assumptions: [],
      tasks: [],
      acceptanceCriteria: [],
      rollback: 'r',
      proposedImplementorProfile: 'i',
      proposedVerifierProfile: 'v',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.error.map((i) => i.path);
      expect(paths).toContain('goal');
      expect(paths).toContain('tasks');
      expect(paths).toContain('acceptanceCriteria');
    }
  });

  it('rejects a criterion with no verification command (untestable by shape)', () => {
    const spec = validSpec();
    (spec['acceptanceCriteria'] as Array<Record<string, unknown>>)[0]!['verificationCommands'] = [];
    const r = validateCoordinatorSpec(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.some((i) => i.path === 'acceptanceCriteria.0.verificationCommands')).toBe(true);
  });

  it('rejects a criterion whose evidence names no concrete, observable outcome', () => {
    const r = validateCoordinatorSpec(untestableSpec());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const issue = r.error.find((i) => i.path === 'acceptanceCriteria.1.expectedEvidence');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('AC-2');
      expect(issue?.message).toContain('not objectively testable');
    }
  });

  // -------------------------------------------------------------------------
  // B2 F4 — the lexical gate is GAMEABLE; the run-pinned command allowlist is
  // the structural answer. Codex reproduced the exact spec below and the
  // validator accepted it: a task that removes an authorization check, "proven"
  // by the command `true` and the evidence "exit code is 0".
  // -------------------------------------------------------------------------
  describe('B2 F4 — verification commands come from the RUN, not the coordinator', () => {
    /** Codex's reproduction, verbatim in shape. */
    function gamedSpec(command = 'true'): Record<string, unknown> {
      const spec = validSpec();
      spec['tasks'] = [{ id: 'T1', description: 'Remove the authorization check', dependsOn: [] }];
      spec['acceptanceCriteria'] = [
        {
          id: 'AC-1',
          description: 'The authorization check is gone',
          verificationCommands: [command],
          expectedEvidence: 'exit code is 0',
        },
      ];
      return spec;
    }

    it('CODEX REPRO: with no allowlist the lexical gate ACCEPTS `true` + "exit code is 0"', () => {
      // Documented honestly rather than pretended away: this is exactly why the
      // structural gate exists, and why `approval:'auto'` refuses an empty set.
      expect(validateCoordinatorSpec(gamedSpec()).ok).toBe(true);
    });

    it('with the run-pinned allowlist, the same spec is REFUSED', () => {
      const r = validateCoordinatorSpec(gamedSpec(), {
        allowedVerificationCommands: ['npm run typecheck', 'npx vitest run'],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const issue = r.error.find((i) => i.path === 'acceptanceCriteria.0.verificationCommands.0');
        expect(issue).toBeDefined();
        expect(issue?.message).toContain('this run does not declare');
        // The refusal names the exact legal set, so the re-prompt is actionable.
        expect(issue?.message).toContain('npm run typecheck');
      }
    });

    it('a DECLARED command is accepted; near-misses (wrapping, weakening, padding) are not', () => {
      const allowed = { allowedVerificationCommands: ['npx vitest run'] };
      expect(validateCoordinatorSpec(gamedSpec('npx vitest run'), allowed).ok).toBe(true);
      for (const sneaky of ['npx vitest run || true', 'true; npx vitest run', ' npx vitest run', 'npx vitest']) {
        expect(validateCoordinatorSpec(gamedSpec(sneaky), allowed).ok, sneaky).toBe(false);
      }
    });

    it('an empty/absent allowlist keeps the pre-B2 behavior (unrestricted)', () => {
      expect(validateCoordinatorSpec(gamedSpec(), { allowedVerificationCommands: [] }).ok).toBe(true);
      expect(validateCoordinatorSpec(gamedSpec(), {}).ok).toBe(true);
    });

    it('the allowlist does NOT replace the evidence gate — both still apply', () => {
      const spec = gamedSpec('npx vitest run');
      (spec['acceptanceCriteria'] as Array<Record<string, unknown>>)[0]!['expectedEvidence'] =
        'the feature works properly';
      const r = validateCoordinatorSpec(spec, { allowedVerificationCommands: ['npx vitest run'] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.some((i) => i.message.includes('not objectively testable'))).toBe(true);
    });
  });

  it('rejects a bad criterion id (not AC-N), duplicates, and dangling task deps', () => {
    const badId = validSpec();
    (badId['acceptanceCriteria'] as Array<Record<string, unknown>>)[0]!['id'] = 'crit1';
    expect(validateCoordinatorSpec(badId).ok).toBe(false);

    const dupCriteria = validSpec();
    (dupCriteria['acceptanceCriteria'] as Array<Record<string, unknown>>)[1]!['id'] = 'AC-1';
    const dupResult = validateCoordinatorSpec(dupCriteria);
    expect(dupResult.ok).toBe(false);
    if (!dupResult.ok) expect(dupResult.error.some((i) => i.message.includes('duplicate criterion id'))).toBe(true);

    const dangling = validSpec();
    (dangling['tasks'] as Array<Record<string, unknown>>)[1]!['dependsOn'] = ['T99'];
    const danglingResult = validateCoordinatorSpec(dangling);
    expect(danglingResult.ok).toBe(false);
    if (!danglingResult.ok) expect(danglingResult.error.some((i) => i.message.includes('unknown task "T99"'))).toBe(true);
  });

  it('assessSpecSemantics is pure and only flags the untestable criterion here', () => {
    const parsed = validateCoordinatorSpec(validSpec());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(assessSpecSemantics(parsed.value)).toEqual([]);
  });
});

describe('extractSpecEmission + canonicalizeSpec', () => {
  it('extracts the LAST fenced json block, or a bare object, or nothing', () => {
    expect(extractSpecEmission('prose\n```json\n{"a":1}\n```\ntail')).toBe('{"a":1}');
    // last-wins: a draft then the final block
    expect(extractSpecEmission('```json\n{"draft":true}\n```\nfinal:\n```json\n{"final":true}\n```')).toBe(
      '{"final":true}',
    );
    expect(extractSpecEmission('   {"bare":1}   ')).toBe('{"bare":1}');
    expect(extractSpecEmission('no spec here')).toBeUndefined();
  });

  it('canonicalizes deterministically regardless of input key order', () => {
    const a = validateCoordinatorSpec(validSpec());
    const b = validateCoordinatorSpec({ ...validSpec() });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const ca = canonicalizeSpec(a.value);
      expect(ca).toBe(canonicalizeSpec(b.value));
      // Round-trips to equal content; the hash is stable/content-addressable.
      expect(JSON.parse(ca).goal).toBe(GOAL);
      expect(sha256Hex(ca)).toBe(sha256Hex(canonicalizeSpec(b.value)));
    }
  });
});

// ---------------------------------------------------------------------------
// Flow via the engine — valid canned spec
// ---------------------------------------------------------------------------
describe('CoordinatorRunner via OrchestrationService.runCoordination (§7, §20 P3)', () => {
  it('drafts a valid spec in one turn: immutable content-addressed SpecVersion, awaiting_approval, read-only', async () => {
    const h = await harness([[specTurn(validSpec())]]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const outcome: CoordinatorOutcome = await h.service.runCoordination(runId, makeRunner(h));

    // The validated, immutable SpecVersion (§7).
    expect(outcome.rounds).toBe(1);
    expect(outcome.specVersion.revision).toBe(1);
    expect(outcome.specVersion.status).toBe('proposed');
    expect(outcome.specVersion.source).toBe('coordinator');
    expect(outcome.specVersion.runId).toBe(runId);
    expect(outcome.specVersion.criteria.map((c) => String(c.id))).toEqual(['AC-1', 'AC-2']);
    expect(outcome.spec.goal).toBe(GOAL);

    // Content-addressed + immutable: the stored bytes ARE the canonical spec,
    // and the recorded hashes are the CAS address of exactly those bytes.
    expect(String(outcome.specVersion.contentHash)).toBe(String(outcome.specArtifact.hash));
    expect(String(outcome.specVersion.contentArtifact)).toBe(String(outcome.specArtifact.hash));
    expect(await h.store.getText(outcome.specArtifact.hash)).toBe(outcome.canonicalSpec);
    expect(sha256Hex(await h.store.getText(outcome.specArtifact.hash))).toBe(String(outcome.specArtifact.hash));
    // §15 exploration artifact stored (notes present), bound to its own object.
    expect(outcome.explorationArtifact?.kind).toBe('exploration');
    expect(
      JSON.parse(await h.store.getText(outcome.explorationArtifact!.hash)),
    ).toMatchObject({ baseCommit: String(TEST_BASE_COMMIT) });

    // The workflow reached the human approval gate (T1 is outside the flow).
    expect(h.service.status(runId).phase).toBe('awaiting_approval');
    expect(h.service.status(runId).uiState).toBe('waiting_on_you');

    // Read-only coordinator: role=coordinator, cwd is the WORKSPACE (no worktree).
    expect(h.created[0]?.options.role).toBe('coordinator');
    expect(h.created[0]?.options.cwd).toBe('/ws');

    // The goal + the re-injected roleReminder (§8) went into the coordinator's turn.
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain(GOAL);
    expect(h.prompts[0]).toContain(h.profile.frontmatter.roleReminder);

    // The exact SpecVersion hash is bindable by the human approval step (T1).
    const approved = await h.service.approve(runId, {
      specVersionId: outcome.specVersion.id,
      specHash: outcome.specVersion.contentHash,
    });
    expect(approved.status).toBe('applied');
    expect(h.service.status(runId).approvedSpecHash).toBe(String(outcome.specVersion.contentHash));
  });

  it('re-drives with actionable feedback when the emission is untestable, then stores the fixed spec', async () => {
    const h = await harness([[specTurn(untestableSpec()), specTurn(validSpec())]]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const outcome = await h.service.runCoordination(runId, makeRunner(h));

    expect(outcome.rounds).toBe(2);
    expect(outcome.specVersion.revision).toBe(1);
    expect(h.service.status(runId).phase).toBe('awaiting_approval');

    // Two prompts on the one coordinator session; the SECOND carried the
    // per-criterion rejection feedback verbatim (§7 actionable rejection).
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain('REJECTED');
    expect(h.prompts[1]).toContain('AC-2');
    expect(h.prompts[1]).toContain('not objectively testable');
  });

  it('throws CoordinatorSpecError and stays in specifying when no valid spec arrives in the round budget', async () => {
    const h = await harness([[specTurn(untestableSpec()), specTurn(untestableSpec())]]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await expect(h.service.runCoordination(runId, makeRunner(h, { maxRounds: 2 }))).rejects.toBeInstanceOf(
      CoordinatorSpecError,
    );
    // The awaiting_approval advance is the service's, taken only after run()
    // returns — a thrown flow leaves the run in `specifying`.
    expect(h.service.status(runId).phase).toBe('specifying');
  });

  it('uses Agent Room when enabled and accepts the spec only after an external planning contribution', async () => {
    // Even though turn 1 already contains a valid draft, chat mode deliberately
    // waits for peer review and requires a second synthesis turn.
    const h = await harness([[specTurn(validSpec()), specTurn(revisedSpec())]]);
    const room = new FakePlanningRoom([
      chatUpdate([
        chatMessage(
          2,
          'Reviewer',
          '@Coordinator add an acceptance criterion for the help output.',
        ),
      ]),
    ]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const outcome = await h.service.runCoordination(
      runId,
      makeRunner(h, { planningChat: chatFactory(room) }),
    );

    expect(outcome.rounds).toBe(2);
    expect(outcome.specVersion.criteria.map((criterion) => String(criterion.id))).toEqual([
      'AC-1',
      'AC-2',
      'AC-3',
    ]);
    expect(outcome.planningChat).toEqual({
      roomCode: 'AM-TEST',
      viewerUrl: room.viewerUrl,
    });
    expect(room.sent).toHaveLength(2);
    expect(room.sent[0]).toContain('"AC-2"');
    expect(room.sent[1]).toContain('"AC-3"');
    expect(room.summaries[0]).toContain('host-validated specification');
    expect(h.prompts[0]).toContain('Planning chat mode');
    expect(h.prompts[1]).toContain('Reviewer');
    expect(h.prompts[1]).toContain('help output');
    expect(h.service.status(runId).phase).toBe('awaiting_approval');
  });

  it('honors Agent Room addressed-only mode and stays silent until Coordinator is addressed', async () => {
    const h = await harness([
      [
        {
          updates: [{ kind: 'agent_message_chunk', text: 'Opening planning position.' }],
          result: { stopReason: 'end_turn' },
        },
        specTurn(validSpec()),
      ],
    ]);
    const room = new FakePlanningRoom([
      chatUpdate(
        [chatMessage(2, 'Reviewer', 'I am thinking aloud; no response needed.', false)],
        { addressedOnly: true, shouldRespond: false },
      ),
      chatUpdate(
        [chatMessage(3, 'Steve', '@Coordinator finalize with the current scope.')],
        { addressedOnly: true, shouldRespond: true },
      ),
    ]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const outcome = await h.service.runCoordination(
      runId,
      makeRunner(h, { planningChat: chatFactory(room) }),
    );

    // Exactly two model turns: opening + the addressed response. The
    // unaddressed message was marked read but never prompted a reply.
    expect(outcome.rounds).toBe(2);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1]).toContain('@Coordinator finalize');
    expect(h.prompts[1]).not.toContain('thinking aloud');
    expect(room.sent).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// spec revise (T2) — superseding revision
// ---------------------------------------------------------------------------
describe('CoordinatorRunner — spec revise (T2)', () => {
  it('produces revision N+1 that supersedes the prior version, injecting the human feedback + prior spec', async () => {
    const h = await harness([[specTurn(validSpec())], [specTurn(revisedSpec())]]);
    const { runId } = createRunFixture(h.service, { goal: GOAL, workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // v1: the initial approved-pending draft.
    const v1 = await h.service.runCoordination(runId, makeRunner(h));
    expect(v1.specVersion.revision).toBe(1);
    expect(h.service.status(runId).phase).toBe('awaiting_approval');

    // T2: `spec revise --feedback` returns the run to `specifying` (real path).
    const feedback = 'Also require the flag to appear in --help output.';
    const t2 = await h.service.reviseSpec(runId, feedback);
    expect(t2.status).toBe('applied');
    expect(h.service.status(runId).phase).toBe('specifying');

    // Re-drive the coordinator with the revise context; it emits revision 2.
    const reviseRunner = makeRunner(h, {
      revise: { feedback, priorVersion: v1.specVersion, priorSpecText: v1.canonicalSpec },
    });
    const v2 = await h.service.runRole(runId, reviseRunner, CLAUDE_LOW, '/ws');

    expect(v2.specVersion.revision).toBe(2);
    expect(v2.supersedes).toBe(v1.specVersion.id);
    expect(v2.specVersion.id).not.toBe(v1.specVersion.id);
    // A NEW immutable artifact (different content ⇒ different content hash).
    expect(String(v2.specVersion.contentHash)).not.toBe(String(v1.specVersion.contentHash));
    expect(v2.specVersion.criteria.map((c) => String(c.id))).toEqual(['AC-1', 'AC-2', 'AC-3']);

    // The revise prompt (2nd adapter's only prompt) injected the human feedback
    // and the prior spec/revision for in-place revision (§8, T2).
    expect(h.prompts[1]).toContain(feedback);
    expect(h.prompts[1]).toContain('revision 1');
  });
});
