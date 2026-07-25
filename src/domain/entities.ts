/**
 * Domain entities (PLAN.md §6.1, §12.2).
 *
 * The `Event` entity lives in `./events.ts` (append-only envelope with
 * runId + monotonic per-run sequence + idempotency key).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type {
  AcpSessionId,
  ArtifactHash,
  AssignmentId,
  CheckpointId,
  CriterionId,
  EventSequence,
  GitSha,
  LimitIncidentId,
  MemoryEntryId,
  MergeReadinessId,
  NativeSessionId,
  ProcessGenerationId,
  RunId,
  SegmentId,
  SpecHash,
  SpecVersionId,
  TurnId,
  VerificationId,
  WaveId,
} from './ids.js';
import type {
  CheckpointReason,
  DetectionTier,
  EtaSource,
  LimitIncidentKind,
  Operation,
  OperationKind,
  RestartCounters,
  RoleName,
  RunPhase,
  Suspension,
  WorktreeTaint,
} from './state.js';

// ---------------------------------------------------------------------------
// Policies (per-assignment)
// ---------------------------------------------------------------------------
/** §10.2: interactive surfaces requests; headless denies unless allowlisted. */
export interface PermissionPolicy {
  readonly mode: 'interactive' | 'headless';
  /** Exact operations allowlisted for headless mode (unknown → deny). */
  readonly allowlist: readonly string[];
}

/** §13 failover policy per assignment; default `wait` + notify. */
export type FailoverPolicy = 'wait' | 'switch_model' | 'switch_harness' | 'ask';

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
export interface Run {
  readonly id: RunId;
  readonly goal: string;
  readonly workspacePath: string;
  readonly phase: RunPhase;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Bound on T1 (approval binds the exact SpecVersion hash). */
  readonly approvedSpecVersionId?: SpecVersionId;
  readonly approvedSpecHash?: SpecHash;
}

// ---------------------------------------------------------------------------
// SpecVersion (immutable, content-hash; §7)
// ---------------------------------------------------------------------------
export interface AcceptanceCriterion {
  /** Stable id referenced by Verification and Checkpoint criterion states. */
  readonly id: CriterionId;
  readonly description: string;
  readonly verificationCommands: readonly string[];
  readonly expectedEvidence?: string;
}

export type SpecVersionStatus = 'proposed' | 'approved' | 'superseded';

export interface SpecVersion {
  readonly id: SpecVersionId;
  readonly runId: RunId;
  /** 1-based revision counter within the run. */
  readonly revision: number;
  readonly contentHash: SpecHash;
  /** CAS ref of the full structured spec document. */
  readonly contentArtifact: ArtifactHash;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly source: 'coordinator' | 'imported';
  readonly status: SpecVersionStatus;
  readonly createdAt: IsoTimestamp;
  readonly approvedAt?: IsoTimestamp;
  readonly supersededBy?: SpecVersionId;
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------
export type AssignmentStatus =
  | 'pending'
  | 'active'
  | 'stale' // spec superseded (T3)
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Assignment {
  readonly id: AssignmentId;
  readonly runId: RunId;
  readonly role: RoleName;
  readonly specVersionId: SpecVersionId;
  readonly specHash: SpecHash;
  readonly baseCommit: GitSha;
  /** Absent for read-only roles (coordinator/verifier work read-only). */
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly permissionPolicy: PermissionPolicy;
  readonly failoverPolicy: FailoverPolicy;
  /** Reserved for post-MVP parallel waves (§4.2). */
  readonly waveId?: WaveId;
  readonly status: AssignmentStatus;
  /** Axis 2 lives on Assignment/Segment (§6.2). */
  readonly suspension: Suspension;
  readonly counters: RestartCounters;
  readonly createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// SessionSegment — one harness-native session (§6.1, §11.1)
// ---------------------------------------------------------------------------
export type SegmentStatus = 'starting' | 'running' | 'closed' | 'interrupted';

export type SegmentCloseReason =
  | 'completed'
  | 'limit_pause'
  | 'user_pause'
  | 'crash'
  | 'cancelled'
  | 'superseded_by_successor';

export interface SessionSegment {
  readonly id: SegmentId;
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  readonly harnessId: string;
  readonly model: string;
  /** Distinct ids persisted separately (§11.1). */
  readonly acpSessionId?: AcpSessionId;
  readonly nativeSessionId?: NativeSessionId;
  readonly processGenerationId?: ProcessGenerationId;
  /** Checkpoint-successor lineage (§11.2, §12.2). */
  readonly predecessorSegmentId?: SegmentId;
  readonly status: SegmentStatus;
  readonly closeReason?: SegmentCloseReason;
  /** Axis 3: at most one operation in flight (§6.2). */
  readonly operation: Operation;
  readonly suspension: Suspension;
  readonly lastCompletedTurnId?: TurnId;
  readonly eventCursor?: EventSequence;
  readonly startedAt: IsoTimestamp;
  readonly closedAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------
/** §3: ACP's closed StopReason enum. */
export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

/** §17.2 honest cost accounting: adapter-reported or conservative estimate. */
export interface TurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly source: 'adapter' | 'estimated';
}

export interface Turn {
  readonly id: TurnId;
  readonly runId: RunId;
  readonly segmentId: SegmentId;
  /** 1-based index within the segment. */
  readonly index: number;
  readonly status: 'in_flight' | 'completed' | 'cancelled' | 'failed';
  readonly stopReason?: AcpStopReason;
  readonly usage?: TurnUsage;
  readonly startedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Artifact (content-addressed; §12.1)
// ---------------------------------------------------------------------------
export type ArtifactKind =
  | 'checkpoint'
  | 'spec'
  | 'exploration'
  | 'diff'
  | 'evidence'
  | 'transcript'
  | 'stderr'
  | 'other';

export interface Artifact {
  readonly hash: ArtifactHash;
  readonly runId?: RunId;
  readonly kind: ArtifactKind;
  readonly sizeBytes: number;
  /** Bounded preview kept in SQLite; full payload lives in the CAS. */
  readonly preview?: string;
  /** §17.1 invariant: redaction happens BEFORE every sink; must be true. */
  readonly redacted: boolean;
  readonly createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// MemoryEntry (§15)
// ---------------------------------------------------------------------------
export type MemoryType = 'constraint' | 'decision' | 'fact' | 'risk' | 'evidence';
/** `global` scope is deferred post-MVP (§15). */
export type MemoryScope = 'run' | 'role' | 'project';
export type MemoryTrust = 'trusted' | 'untrusted';

export interface MemoryEntry {
  readonly id: MemoryEntryId;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  readonly runId?: RunId;
  readonly role?: RoleName;
  /** Provenance: the event and/or artifact this entry derives from. */
  readonly sourceEventSequence?: EventSequence;
  readonly sourceArtifactHash?: ArtifactHash;
  readonly trust: MemoryTrust;
  readonly contentHash: ArtifactHash;
  /** Redacted content (redaction-before-persistence, §17.1). */
  readonly content: string;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Verification (binds spec hash + base commit + implementation commit)
// ---------------------------------------------------------------------------
export type CriterionVerdict = 'passed' | 'failed' | 'unproven';

export interface CriterionResult {
  readonly criterionId: CriterionId;
  readonly verdict: CriterionVerdict;
  /** Evidence the verifier gathered ITSELF (§8) — CAS refs. */
  readonly evidenceRefs: readonly ArtifactHash[];
  readonly note?: string;
}

/** F13 host-created proof for one declared verification-command execution. */
export interface EvidenceReceipt {
  /** Host-generated logical id; the immutable receipt body is stored in CAS. */
  readonly receiptId: string;
  readonly receiptRef: ArtifactHash;
  readonly runId: RunId;
  readonly criterionId: CriterionId;
  readonly specHash: SpecHash;
  readonly implementationCommit: GitSha;
  /** Exact host process invocation, including the shell and approved command. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly stdoutRef: ArtifactHash;
  readonly stderrRef: ArtifactHash;
  /** Digest of the redacted stdout/stderr bytes bound into this receipt. */
  readonly outputDigest: string;
  readonly toolchain: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly provisioningMarker: string;
  };
}

export interface Verification {
  readonly id: VerificationId;
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  readonly specHash: SpecHash;
  readonly baseCommit: GitSha;
  readonly implementationCommit: GitSha;
  readonly criteria: readonly CriterionResult[];
  /** Host attestations supplied to the verifier and enforced by the gate. */
  readonly evidenceReceipts: readonly EvidenceReceipt[];
  /** Any failed/unproven blocks (§8) → 'blocked'. */
  readonly outcome: 'all_verified' | 'blocked';
  readonly completedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// MergeReadiness (§16; report only — never auto-merged)
// ---------------------------------------------------------------------------
export interface VerificationHarnessPair {
  readonly implementor: string;
  readonly verifier: string;
}

export interface MergeReadiness {
  readonly id: MergeReadinessId;
  readonly runId: RunId;
  readonly verificationId: VerificationId;
  readonly specHash: SpecHash;
  readonly baseCommit: GitSha;
  readonly verifiedCommit: GitSha;
  /** Resolved runtime harnesses; proves the independence decision in the audit. */
  readonly resolvedHarnesses: VerificationHarnessPair;
  readonly destinationClean: boolean;
  /** W1-F4: the implementation worktree was clean at probe time (post-commit
   * verification commands can dirty it — that content is in NO commit). */
  readonly worktreeClean: boolean;
  readonly baseDrifted: boolean;
  readonly conflicts: boolean;
  readonly requiredTestsPassed: boolean;
  /** CAS refs of the host receipts enforced for this report. */
  readonly evidenceReceiptRefs: readonly ArtifactHash[];
  readonly ready: boolean;
  /** The §16 blockers when NOT ready (empty iff `ready`); W1-F1 maps these to
   * `integration_blocker` fix-requests and the T23 trigger payload. */
  readonly blockers: readonly string[];
  /** Exact manual integration commands; MVP never executes them (§16). */
  readonly manualIntegrationCommands: readonly string[];
  readonly createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// LimitIncident (§6.1, §13)
// ---------------------------------------------------------------------------
export type LimitResolution =
  | 'pending'
  | 'resumed'
  | 'failed_over'
  | 'cancelled'
  | 'noted_only'; // T7/T8: incident recorded with nothing to suspend

export interface LimitIncident {
  readonly id: LimitIncidentId;
  readonly runId: RunId;
  /** May reference a CLOSED segment (T7 late signals, issue #864). */
  readonly segmentId?: SegmentId;
  readonly provider: string;
  readonly incidentKind: LimitIncidentKind;
  readonly detectionTier: DetectionTier;
  readonly resumesAt?: IsoTimestamp;
  readonly etaSource: EtaSource;
  readonly source: 'structured' | 'parsed';
  readonly resolution: LimitResolution;
  readonly occurredAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// ProcessSample (aggregated projection; raw samples pruned — §12.1, §14)
// ---------------------------------------------------------------------------
export interface ProcessSample {
  readonly runId: RunId;
  readonly segmentId?: SegmentId;
  readonly processGenerationId?: ProcessGenerationId;
  /** Aggregation window start (per-minute by default). */
  readonly windowStart: IsoTimestamp;
  readonly windowSeconds: number;
  readonly rssMaxBytes: number;
  readonly rssMeanBytes: number;
  readonly sampleCount: number;
}

// ---------------------------------------------------------------------------
// Checkpoint (§12.2 — mechanical, synchronous, no LLM in the pause path)
// ---------------------------------------------------------------------------
export interface SegmentLineage {
  readonly predecessorSegmentId?: SegmentId;
  readonly harnessId: string;
  readonly model: string;
  readonly acpSessionId?: AcpSessionId;
  readonly nativeSessionId?: NativeSessionId;
  readonly finalTurnId?: TurnId;
}

export interface WorktreeState {
  readonly headSha: GitSha;
  /** Verbatim `git status --porcelain` snapshot. */
  readonly statusPorcelain: string;
  readonly diffHash: ArtifactHash;
  readonly lockfileCleanupPerformed: boolean;
  readonly taintFlags: readonly WorktreeTaint[];
}

/** Recorded honestly: a mid-turn checkpoint does NOT claim completed work. */
export interface IncompleteOperation {
  readonly operation: OperationKind;
  readonly detail?: string;
  readonly startedAt: IsoTimestamp;
}

export type CriterionCheckpointState = 'pending' | 'passed' | 'failed' | 'unproven';

export interface CheckpointContent {
  readonly lineage: SegmentLineage;
  readonly lastCompletedTurnId?: TurnId;
  readonly eventCursor: EventSequence;
  readonly specHash: SpecHash;
  readonly criterionStates: ReadonlyArray<{
    readonly criterionId: CriterionId;
    readonly state: CriterionCheckpointState;
  }>;
  readonly constraints: readonly string[];
  readonly permissionPolicy: PermissionPolicy;
  readonly confirmedDecisions: readonly string[];
  readonly unresolvedRisks: readonly string[];
  readonly failingTests: readonly string[];
  readonly artifactRefs: readonly ArtifactHash[];
  readonly worktree: WorktreeState;
  readonly incompleteOperation?: IncompleteOperation;
}

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly runId: RunId;
  readonly segmentId: SegmentId;
  readonly assignmentId?: AssignmentId;
  /**
   * CAS hash of the serialized content. Atomicity (§12.2): artifact written
   * first; `checkpoint.recorded` commits with this hash in the SAME
   * transaction as the state transition. Also the no-progress comparator
   * (§14: identical content-hash across 2 consecutive restarts → breaker).
   */
  readonly artifactHash: ArtifactHash;
  readonly reason: CheckpointReason;
  readonly content: CheckpointContent;
  readonly createdAt: IsoTimestamp;
}
