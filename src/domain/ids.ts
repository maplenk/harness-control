import type { Brand } from '../lib/brand.js';
import type { IdFactory } from '../lib/id-factory.js';

// ---------------------------------------------------------------------------
// Distinct id types (PLAN.md §6.1): SessionSegment keeps FOUR distinct ids —
// segment / ACP session / provider-native session / process generation — plus
// the owning run. Branding makes accidental cross-assignment a type error.
// ---------------------------------------------------------------------------
export type RunId = Brand<string, 'RunId'>;
export type SegmentId = Brand<string, 'SegmentId'>;
export type AcpSessionId = Brand<string, 'AcpSessionId'>;
export type NativeSessionId = Brand<string, 'NativeSessionId'>;
export type ProcessGenerationId = Brand<string, 'ProcessGenerationId'>;

// ---- Other entity ids ------------------------------------------------------
export type SpecVersionId = Brand<string, 'SpecVersionId'>;
export type AssignmentId = Brand<string, 'AssignmentId'>;
export type TurnId = Brand<string, 'TurnId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type MergeReadinessId = Brand<string, 'MergeReadinessId'>;
export type LimitIncidentId = Brand<string, 'LimitIncidentId'>;
export type MemoryEntryId = Brand<string, 'MemoryEntryId'>;
/** P4b-1 durable alert identity (an `alert.raised` supporting event, §5cc). */
export type AlertId = Brand<string, 'AlertId'>;
/** Stable acceptance-criterion id inside a SpecVersion (PLAN §7). */
export type CriterionId = Brand<string, 'CriterionId'>;
/** Reserved for post-MVP parallel waves (PLAN §4.2, §6.1). */
export type WaveId = Brand<string, 'WaveId'>;

// ---- Content addressing / hashes ------------------------------------------
/** sha-256 hex digest addressing an artifact in the CAS (PLAN §12.1). */
export type ArtifactHash = Brand<string, 'ArtifactHash'>;
/** Content hash of an immutable SpecVersion (PLAN §6.1). */
export type SpecHash = Brand<string, 'SpecHash'>;
export type GitSha = Brand<string, 'GitSha'>;

// ---- Event log primitives --------------------------------------------------
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
/** Monotonic per-run event sequence (assigned by the event log at append). */
export type EventSequence = Brand<number, 'EventSequence'>;
/**
 * Placeholder sequence carried by events that have not been appended yet
 * (PLAN §6.1: append-only, monotonic per-run sequence). Persisted events
 * always have sequence >= 1.
 */
export const SEQUENCE_UNASSIGNED = -1 as EventSequence;

// ---- Constructors (explicit, greppable casts) ------------------------------
export const runId = (value: string): RunId => value as RunId;
export const segmentId = (value: string): SegmentId => value as SegmentId;
export const acpSessionId = (value: string): AcpSessionId => value as AcpSessionId;
export const nativeSessionId = (value: string): NativeSessionId => value as NativeSessionId;
export const processGenerationId = (value: string): ProcessGenerationId =>
  value as ProcessGenerationId;
export const specVersionId = (value: string): SpecVersionId => value as SpecVersionId;
export const assignmentId = (value: string): AssignmentId => value as AssignmentId;
export const turnId = (value: string): TurnId => value as TurnId;
export const checkpointId = (value: string): CheckpointId => value as CheckpointId;
export const verificationId = (value: string): VerificationId => value as VerificationId;
export const mergeReadinessId = (value: string): MergeReadinessId => value as MergeReadinessId;
export const limitIncidentId = (value: string): LimitIncidentId => value as LimitIncidentId;
export const memoryEntryId = (value: string): MemoryEntryId => value as MemoryEntryId;
export const alertId = (value: string): AlertId => value as AlertId;
export const criterionId = (value: string): CriterionId => value as CriterionId;
export const waveId = (value: string): WaveId => value as WaveId;
export const artifactHash = (value: string): ArtifactHash => value as ArtifactHash;
export const specHash = (value: string): SpecHash => value as SpecHash;
export const gitSha = (value: string): GitSha => value as GitSha;
export const idempotencyKey = (value: string): IdempotencyKey => value as IdempotencyKey;

/** Assigned (persisted) sequences are positive integers. */
export function eventSequence(value: number): EventSequence {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Event sequence must be a positive integer, got ${value}`);
  }
  return value as EventSequence;
}

// ---- Typed minting via injected IdFactory ---------------------------------
// (ACP/native session ids are issued by adapters/providers, never minted
// locally, so no minters exist for them — constructors only.)
export const newRunId = (ids: IdFactory): RunId => runId(ids.nextId('run'));
export const newSegmentId = (ids: IdFactory): SegmentId => segmentId(ids.nextId('seg'));
export const newProcessGenerationId = (ids: IdFactory): ProcessGenerationId =>
  processGenerationId(ids.nextId('pgen'));
export const newSpecVersionId = (ids: IdFactory): SpecVersionId => specVersionId(ids.nextId('spec'));
export const newAssignmentId = (ids: IdFactory): AssignmentId => assignmentId(ids.nextId('asg'));
export const newTurnId = (ids: IdFactory): TurnId => turnId(ids.nextId('turn'));
export const newCheckpointId = (ids: IdFactory): CheckpointId => checkpointId(ids.nextId('ckpt'));
export const newVerificationId = (ids: IdFactory): VerificationId =>
  verificationId(ids.nextId('verif'));
export const newMergeReadinessId = (ids: IdFactory): MergeReadinessId =>
  mergeReadinessId(ids.nextId('mrg'));
export const newLimitIncidentId = (ids: IdFactory): LimitIncidentId =>
  limitIncidentId(ids.nextId('lim'));
export const newMemoryEntryId = (ids: IdFactory): MemoryEntryId => memoryEntryId(ids.nextId('mem'));
export const newWaveId = (ids: IdFactory): WaveId => waveId(ids.nextId('wave'));
export const newIdempotencyKey = (ids: IdFactory): IdempotencyKey =>
  idempotencyKey(ids.nextId('idem'));
