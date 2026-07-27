/**
 * Side-effect-free read models for the local operator UI.
 *
 * These readers never call CLI command dispatch, alert delivery, resume, or
 * any other composition that can append an event. They assemble durable
 * projections and the append-only log inside one SQLite read transaction.
 */
import type {
  CriterionResult,
  EvidenceReceipt,
  MergeReadiness,
} from '../domain/entities.js';
import { runId, type RunId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import type { Database, RegisteredRun } from '../persistence/index.js';
import { listRuns } from '../persistence/index.js';
import { DurableDesiredModelStore } from '../app/desired-model-store.js';
import {
  ASSIGNMENT_ROUND_PROJECTION_PREFIX,
  IMPLEMENT_VERIFY_LOOP_PROJECTION,
  MERGE_READINESS_BLOCKED_PROJECTION,
  ROLE_ROUND_PROJECTION,
  RUN_META_PROJECTION,
  SPEC_DRAFT_PROJECTION,
  migrateMergeReadinessBlockedState,
  resolveAssignmentRoundState,
  resolvePersistedExecutionMode,
  type AssignmentRoundState,
  type ImplementVerifyLoopState,
  type MergeReadinessBlockedState,
  type RoleRoundProjection,
  type RunMeta,
  type SpecDraftState,
  type UiState,
} from '../app/projections.js';
import { OrchestrationService, loadRunConfig } from '../app/service.js';
import type { RoleModelSpec } from '../app/model-resolution.js';
import { DEFAULT_ENGINE_CONFIG } from '../config/loader.js';
import type {
  OperationKind,
  RunPhase,
  SuspensionKind,
} from '../domain/state.js';
import type { VerificationCommand } from '../domain/verification-command.js';
import { normalizeVerificationCommands } from '../domain/verification-command.js';

export interface FleetRunSnapshot {
  readonly runId: string;
  readonly goal: string;
  readonly phase: RunPhase;
  readonly suspension: SuspensionKind;
  readonly operation: OperationKind;
  readonly uiState: UiState;
  readonly repositories: readonly { readonly id: string; readonly path: string }[];
  readonly activeImplementors: number;
  readonly updatedAt: string;
  readonly asOfSequence: number;
}

export interface FleetSnapshot {
  readonly runs: readonly FleetRunSnapshot[];
}

export interface TaskSnapshot {
  readonly id: string;
  readonly description: string;
  readonly dependsOn: readonly string[];
}

export interface AssignmentSnapshot {
  readonly id: string;
  readonly repo: string;
  readonly taskScope: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly executionMode: 'worktree' | 'in_place';
  readonly implementor?: RoleModelSpec;
  readonly stage: 'pending' | 'running' | 'delivered' | 'no_deliverable';
  readonly round?: number;
  readonly stopReason?: string;
  readonly diagnostic?: string;
}

export type CriterionSnapshotVerdict =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'unproven';

export interface CriterionSnapshot {
  readonly id: string;
  readonly description: string;
  readonly commands: readonly VerificationCommand[];
  readonly expectedEvidence: string;
  readonly verdict: CriterionSnapshotVerdict;
  readonly evidenceRefs: readonly string[];
  readonly receipts: readonly {
    readonly id: string;
    readonly command: string;
    readonly cwd: string;
    readonly exitCode: number;
    readonly launchFailed?: boolean;
    readonly receiptRef: string;
  }[];
  readonly note?: string;
}

export interface ModelSnapshot {
  readonly effective?: RoleModelSpec;
  readonly desired?: RoleModelSpec & {
    readonly requestedAt: string;
    readonly assignmentId?: string;
  };
}

export interface RunSnapshot {
  readonly runId: string;
  readonly asOfSequence: number;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
  readonly goal: string;
  readonly repositories: readonly {
    readonly id: string;
    readonly path: string;
    readonly baseCommit?: string;
  }[];
  readonly phase: RunPhase;
  readonly suspension: SuspensionKind;
  readonly suspensionDetail: string | null;
  readonly operation: OperationKind;
  readonly uiState: UiState;
  readonly childActive: boolean;
  readonly approval: {
    readonly mode: 'human' | 'auto' | 'unknown' | 'pending';
    readonly specVersionId?: string;
    readonly specHash?: string;
    readonly approvedSpecHash?: string;
  };
  readonly executionMode: 'worktree' | 'in_place';
  readonly spec?: {
    readonly canonicalSpec: string;
    readonly tasks: readonly TaskSnapshot[];
    readonly assignments: readonly AssignmentSnapshot[];
  };
  readonly assignments: readonly AssignmentSnapshot[];
  readonly models: Readonly<Record<string, ModelSnapshot>>;
  readonly cost: {
    readonly measuredUsd: number;
    readonly estimatedUsd: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly turns: number;
  };
  readonly verification: {
    readonly criteria: readonly CriterionSnapshot[];
    readonly remediationRounds: readonly {
      readonly round: number;
      readonly maxRounds: number;
      readonly at: string;
    }[];
    readonly latestFixRequest?: string;
    readonly mergeReadiness?: MergeReadiness;
    readonly subsetWarning?: string;
  };
  readonly eventCount: number;
}

interface ParsedSpecAssignment {
  readonly id: string;
  readonly taskScope: string;
  readonly writeScope: readonly string[];
  readonly criteria: readonly string[];
  readonly dependsOn: readonly string[];
  readonly repo: string;
  readonly executionMode?: 'worktree' | 'in_place';
  readonly implementor?: RoleModelSpec;
}

interface ParsedSpec {
  readonly tasks: readonly TaskSnapshot[];
  readonly assignments: readonly ParsedSpecAssignment[];
}

/** Build the Fleet collection from real run metadata only. */
export function buildFleetSnapshot(db: Database): FleetSnapshot {
  const runs: FleetRunSnapshot[] = [];
  for (const registered of listRuns(db.driver)) {
    const snapshot = buildRunSnapshot(db, registered);
    if (snapshot === undefined) continue;
    runs.push({
      runId: snapshot.runId,
      goal: snapshot.goal,
      phase: snapshot.phase,
      suspension: snapshot.suspension,
      operation: snapshot.operation,
      uiState: snapshot.uiState,
      repositories: snapshot.repositories.map(({ id, path }) => ({ id, path })),
      activeImplementors:
        snapshot.phase === 'implementing'
          ? Math.max(
              1,
              snapshot.assignments.filter(
                (assignment) =>
                  assignment.stage === 'pending' || assignment.stage === 'running',
              ).length,
            )
          : 0,
      updatedAt: snapshot.updatedAt,
      asOfSequence: snapshot.asOfSequence,
    });
  }
  return { runs };
}

/**
 * Assemble one run at a single SQLite read boundary. `undefined` means the
 * registry row is not a real run (no immutable metadata).
 */
export function buildRunSnapshot(
  db: Database,
  registered: RegisteredRun | RunId,
): RunSnapshot | undefined {
  return db.transaction(() => {
    const owner = typeof registered === 'string' ? runId(registered) : registered.runId;
    const metaRecord = db.projections.get<RunMeta>(owner, RUN_META_PROJECTION);
    if (metaRecord === undefined) return undefined;

    const events = db.events.listByRun(owner);
    const latestEvent = events.at(-1);
    const firstSeenAt =
      typeof registered === 'string'
        ? (events[0]?.occurredAt ?? metaRecord.updatedAt)
        : registered.firstSeenAt;
    const config = loadRunConfig(db, owner) ?? DEFAULT_ENGINE_CONFIG;
    const service = new OrchestrationService({ db, config });
    const status = service.status(owner);
    const draft = db.projections.get<SpecDraftState>(owner, SPEC_DRAFT_PROJECTION)?.state;
    const round = db.projections.get<RoleRoundProjection>(owner, ROLE_ROUND_PROJECTION)?.state;
    const loop = db.projections.get<ImplementVerifyLoopState>(
      owner,
      IMPLEMENT_VERIFY_LOOP_PROJECTION,
    )?.state;
    const blocked = migrateMergeReadinessBlockedState(
      db.projections.get<MergeReadinessBlockedState>(
        owner,
        MERGE_READINESS_BLOCKED_PROJECTION,
      )?.state,
    );
    const parsed = parseCanonicalSpec(draft?.canonicalSpec);
    const executionMode =
      loop === undefined
        ? (metaRecord.state.defaultExecutionMode ?? 'worktree')
        : resolvePersistedExecutionMode(loop.worktree);
    const assignments = buildAssignments(
      db,
      owner,
      parsed,
      draft,
      loop,
      status.phase,
      executionMode,
      metaRecord.state.requestedImplementor,
    );
    const mergeReadiness = latestMergeReadiness(events, blocked);
    const criteria = buildCriteria(draft, events, blocked, status.phase);
    const remediationRounds = events
      .filter((event) => event.type === 'remediation.started')
      .map((event) => ({
        round: event.payload.round,
        maxRounds: event.payload.maxRounds,
        at: event.occurredAt,
      }));
    const desired = new DurableDesiredModelStore(db).listForRun(owner);
    const models: Record<string, ModelSnapshot> = {
      coordinator: { effective: metaRecord.state.coordinator },
    };
    if (metaRecord.state.requestedImplementor !== undefined) {
      models['implementor'] = { effective: metaRecord.state.requestedImplementor };
    }
    if (metaRecord.state.requestedVerifier !== undefined) {
      models['verifier'] = { effective: metaRecord.state.requestedVerifier };
    }
    if (loop !== undefined) {
      models['implementor'] = { effective: loop.implementor };
      models['verifier'] = { effective: loop.verifier };
    } else if (round?.modelSpec !== undefined) {
      models[round.role] = { effective: round.modelSpec };
    }
    for (const target of desired) {
      const existing = models[target.role] ?? {};
      models[target.role] = {
        ...existing,
        desired: {
          harness: target.harness as RoleModelSpec['harness'],
          model: target.model,
          ...(target.effort !== undefined
            ? { effort: target.effort as NonNullable<RoleModelSpec['effort']> }
            : {}),
          requestedAt: target.requestedAt,
          ...('assignmentId' in target && typeof target.assignmentId === 'string'
            ? { assignmentId: target.assignmentId }
            : {}),
        },
      };
    }

    const asOfSequence = latestEvent === undefined ? 0 : Number(latestEvent.sequence);
    const approvalMode =
      status.specApprovedBy ??
      (status.approvedSpecHash !== undefined ? 'unknown' : 'pending');
    const suspensionDetail =
      status.autoRecovering !== undefined
        ? `Interrupted — auto-recovering (attempt ${status.autoRecovering.attempt})`
        : status.suspension === 'resource_exhausted'
          ? 'RSS memory budget crossed. Raise the audited role budget before resuming.'
          : status.suspension === 'paused_limit'
            ? 'Provider usage limit reached. Reset time may be unavailable.'
            : status.suspension === 'interrupted'
              ? 'Interrupted — manual resume required.'
              : status.suspension === 'paused_user'
                ? 'Paused by the operator.'
                : status.suspension === 'breaker_open'
                  ? 'Recovery breaker is open.'
                  : null;

    return {
      runId: String(owner),
      asOfSequence,
      firstSeenAt,
      updatedAt: latestEvent?.occurredAt ?? metaRecord.updatedAt,
      goal: metaRecord.state.goal,
      repositories: [
        {
          id: 'default',
          path: metaRecord.state.workspacePath,
          ...(metaRecord.state.baseCommit !== undefined
            ? { baseCommit: String(metaRecord.state.baseCommit) }
            : {}),
        },
      ],
      phase: status.phase,
      suspension: status.suspension,
      suspensionDetail,
      operation: status.operation,
      uiState: status.uiState,
      childActive: status.childActive,
      approval: {
        mode: approvalMode,
        ...(draft !== undefined ? { specVersionId: String(draft.specVersionId) } : {}),
        ...(draft !== undefined ? { specHash: String(draft.specHash) } : {}),
        ...(status.approvedSpecHash !== undefined
          ? { approvedSpecHash: String(status.approvedSpecHash) }
          : {}),
      },
      executionMode,
      ...(draft !== undefined
        ? {
            spec: {
              canonicalSpec: draft.canonicalSpec,
              tasks: parsed.tasks,
              assignments,
            },
          }
        : {}),
      assignments,
      models,
      cost: {
        measuredUsd: status.cost.totalCostUsd,
        estimatedUsd: status.cost.totalEstimatedCostUsd ?? 0,
        inputTokens: status.cost.totalInputTokens,
        outputTokens: status.cost.totalOutputTokens,
        turns: status.cost.turns,
      },
      verification: {
        criteria,
        remediationRounds,
        ...(round?.role === 'implementor' && round.round > 1
          ? parsePersistedTaskScope(round.inputs)
          : {}),
        ...(mergeReadiness !== undefined ? { mergeReadiness } : {}),
        ...(mergeReadiness !== undefined && mergeReadiness.ready
          ? {
              subsetWarning:
                'Nothing was merged or pushed. Merge the verified commit manually; for a multi-repository composition, merging a subset breaks the verified composition.',
            }
          : {}),
      },
      eventCount: events.length,
    };
  });
}

function parseCanonicalSpec(canonicalSpec: string | undefined): ParsedSpec {
  if (canonicalSpec === undefined) return { tasks: [], assignments: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(canonicalSpec);
  } catch {
    return { tasks: [], assignments: [] };
  }
  if (!isRecord(raw)) return { tasks: [], assignments: [] };
  const tasks = Array.isArray(raw['tasks'])
    ? raw['tasks'].flatMap((entry): TaskSnapshot[] => {
        if (!isRecord(entry)) return [];
        const id = text(entry['id']);
        const description = text(entry['description']);
        if (id === undefined || description === undefined) return [];
        return [{ id, description, dependsOn: strings(entry['dependsOn']) }];
      })
    : [];
  const assignments = Array.isArray(raw['assignments'])
    ? raw['assignments'].flatMap((entry): ParsedSpecAssignment[] => {
        if (!isRecord(entry)) return [];
        const id = text(entry['id']);
        const taskScope = text(entry['taskScope']);
        if (id === undefined || taskScope === undefined) return [];
        const implementor = parseRoleSpec(entry['proposedImplementorProfile']);
        const mode =
          entry['executionMode'] === 'in_place' || entry['executionMode'] === 'worktree'
            ? entry['executionMode']
            : undefined;
        return [
          {
            id,
            taskScope,
            writeScope: strings(entry['writeScope']),
            criteria: strings(entry['criteria']),
            dependsOn: strings(entry['dependsOn']),
            repo: text(entry['repo']) ?? 'default',
            ...(mode !== undefined ? { executionMode: mode } : {}),
            ...(implementor !== undefined ? { implementor } : {}),
          },
        ];
      })
    : [];
  return { tasks, assignments };
}

function buildAssignments(
  db: Database,
  owner: RunId,
  parsed: ParsedSpec,
  draft: SpecDraftState | undefined,
  loop: ImplementVerifyLoopState | undefined,
  phase: RunPhase,
  runMode: 'worktree' | 'in_place',
  requestedImplementor: RoleModelSpec | undefined,
): readonly AssignmentSnapshot[] {
  const source: readonly ParsedSpecAssignment[] =
    parsed.assignments.length > 0
      ? parsed.assignments
      : [
          {
            id: loop?.assignmentId !== undefined ? String(loop.assignmentId) : 'primary',
            taskScope: loop?.taskScope ?? draft?.goal ?? 'Run assignment',
            writeScope: loop?.worktree?.writeScope ?? [],
            criteria: draft?.criteria.map((criterion) => String(criterion.id)) ?? [],
            dependsOn: [],
            repo: 'default',
          },
        ];
  return source.map((assignment) => {
    const persisted = resolveAssignmentRoundState(
      db.projections.get<unknown>(
        owner,
        `${ASSIGNMENT_ROUND_PROJECTION_PREFIX}${assignment.id}`,
      )?.state,
    );
    const stage = assignmentStage(persisted, phase);
    const implementor = requestedImplementor ?? assignment.implementor;
    return {
      id: assignment.id,
      repo: assignment.repo,
      taskScope: assignment.taskScope,
      writeScope: assignment.writeScope,
      criteria: assignment.criteria,
      dependsOn: assignment.dependsOn,
      executionMode: loop === undefined ? runMode : (assignment.executionMode ?? runMode),
      ...(implementor !== undefined ? { implementor } : {}),
      stage,
      ...(persisted !== undefined ? { round: persisted.round } : {}),
      ...(persisted?.stopReason !== undefined
        ? { stopReason: persisted.stopReason }
        : {}),
      ...(persisted?.diagnostic !== undefined
        ? { diagnostic: persisted.diagnostic }
        : {}),
    };
  });
}

function assignmentStage(
  persisted: AssignmentRoundState | undefined,
  phase: RunPhase,
): AssignmentSnapshot['stage'] {
  if (persisted !== undefined) return persisted.stage;
  return phase === 'implementing' ? 'running' : 'pending';
}

function buildCriteria(
  draft: SpecDraftState | undefined,
  events: readonly DomainEvent[],
  blocked: MergeReadinessBlockedState | undefined,
  phase: RunPhase,
): readonly CriterionSnapshot[] {
  if (draft === undefined) return [];
  const failed = latestEventOfType(events, 'verification.completed.failed');
  const passed = latestEventOfType(events, 'verification.completed.passed');
  const blockedResults = new Map(
    (blocked?.verification.criteria ?? []).map((result) => [
      String(result.criterionId),
      result,
    ]),
  );
  const receipts = blocked?.verification.evidenceReceipts ?? [];
  return draft.criteria.map((criterion) => {
    const id = String(criterion.id);
    const detailed = blockedResults.get(id);
    const verdict = criterionVerdict(id, detailed, failed, passed, phase);
    return {
      id,
      description: criterion.description,
      commands: normalizeVerificationCommands(criterion.verificationCommands),
      expectedEvidence:
        criterion.expectedEvidence ?? 'No expected-evidence description was stored for this criterion.',
      verdict,
      evidenceRefs: detailed?.evidenceRefs.map(String) ?? [],
      receipts: receipts
        .filter((receipt) => String(receipt.criterionId) === id)
        .map(receiptView),
      ...(detailed?.note !== undefined ? { note: detailed.note } : {}),
    };
  });
}

function criterionVerdict(
  id: string,
  detailed: CriterionResult | undefined,
  failed: Extract<DomainEvent, { type: 'verification.completed.failed' }> | undefined,
  passed: Extract<DomainEvent, { type: 'verification.completed.passed' }> | undefined,
  phase: RunPhase,
): CriterionSnapshotVerdict {
  if (detailed !== undefined) return detailed.verdict;
  if (failed !== undefined) {
    if (failed.payload.failedCriteria.some((criterion) => String(criterion) === id)) {
      return 'failed';
    }
    if (failed.payload.unprovenCriteria.some((criterion) => String(criterion) === id)) {
      return 'unproven';
    }
    return 'passed';
  }
  if (passed !== undefined) return 'passed';
  return phase === 'verifying' ? 'running' : 'pending';
}

function receiptView(receipt: EvidenceReceipt): CriterionSnapshot['receipts'][number] {
  return {
    id: receipt.receiptId,
    command: receipt.argv.join(' '),
    cwd: receipt.cwd,
    exitCode: receipt.exitCode,
    ...(receipt.launchFailed !== undefined
      ? { launchFailed: receipt.launchFailed }
      : {}),
    receiptRef: String(receipt.receiptRef),
  };
}

function latestMergeReadiness(
  events: readonly DomainEvent[],
  blocked: MergeReadinessBlockedState | undefined,
): MergeReadiness | undefined {
  const passed = latestEventOfType(events, 'verification.completed.passed');
  return passed?.payload.mergeReadiness ?? blocked?.mergeReadiness;
}

function latestEventOfType<T extends DomainEvent['type']>(
  events: readonly DomainEvent[],
  type: T,
): Extract<DomainEvent, { type: T }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type) return event as Extract<DomainEvent, { type: T }>;
  }
  return undefined;
}

function parsePersistedTaskScope(
  inputs: string | undefined,
): { readonly latestFixRequest: string } | Record<string, never> {
  if (inputs === undefined) return {};
  try {
    const parsed = JSON.parse(inputs) as { taskScope?: unknown };
    return typeof parsed.taskScope === 'string'
      ? { latestFixRequest: parsed.taskScope }
      : {};
  } catch {
    return {};
  }
}

function parseRoleSpec(raw: unknown): RoleModelSpec | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const [harness, model, effort] = raw.split(':');
  if (
    harness !== 'claude' &&
    harness !== 'codex' &&
    harness !== 'grok' &&
    harness !== 'opencode'
  ) {
    return undefined;
  }
  if (model === undefined || model === '') return undefined;
  return {
    harness,
    model,
    ...(effort !== undefined && effort !== ''
      ? { effort: effort as NonNullable<RoleModelSpec['effort']> }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
