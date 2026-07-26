/**
 * Public surface of the persistence package (PLAN.md §12.1, §12.3).
 * Ownership: src/persistence/**.
 */
export type { DriverKind, PreparedStatement, RunResult, SqlDriver, SqlParam } from './driver.js';
export { BetterSqlite3Driver, isNodeSqliteAvailable, openDriver } from './drivers/index.js';
export type { BetterSqlite3DriverOptions, OpenDriverOptions } from './drivers/index.js';

export type { AppliedMigration, Migration } from './migrations.js';
export { MIGRATIONS, listAppliedMigrations, runMigrations } from './migrations.js';

export { registerRun } from './runs.js';

export type { AppendOutcome, EventRepository, ListByRunOptions } from './event-repository.js';
export { SqliteEventRepository } from './event-repository.js';

export type { FreeTextForm, RegisteredFreeTextField } from './metadata-redaction.js';
export {
  EVENT_FREE_TEXT_FIELDS,
  PROJECTION_FREE_TEXT_FIELDS,
  redactEventPayload,
  redactProjectionState,
} from './metadata-redaction.js';

export type { ProjectionRecord, ProjectionRepository } from './projection-repository.js';
export { SqliteProjectionRepository } from './projection-repository.js';

export type {
  AdmissionRejectionScope,
  ArtifactAdmissionRejected,
  ArtifactRepository,
  QuotaConfig,
  WriteArtifactInput,
} from './artifact-repository.js';
export { DEFAULT_PREVIEW_MAX_BYTES, DEFAULT_QUOTAS, SqliteArtifactRepository } from './artifact-repository.js';

export type {
  AggregateWindowInput,
  ProcessSampleRepository,
  RawProcessSample,
} from './telemetry-repository.js';
export { DEFAULT_WINDOW_SECONDS, SqliteProcessSampleRepository } from './telemetry-repository.js';

export type { Database, OpenDatabaseOptions } from './database.js';
export { openDatabase } from './database.js';

export type { AppendTriggerOptions, AppendWithProjectionResult, ProjectionUpdate } from './write-path.js';
export { appendTriggerWithEffects } from './write-path.js';

export type {
  AcceptOperationInput,
  AcceptOperationResult,
  OperationBindingDatabase,
  OperationId,
  OperationLifecycleState,
  OperationOwner,
  OperationRecord,
  OperationRepository,
  TerminalOperationState,
  TransitionOperationInput,
  TransitionOperationResult,
} from './operation-repository.js';
export {
  OPERATION_COMMAND_PAYLOAD_VERSION,
  OPERATION_LIFECYCLE_STATES,
  OPERATION_TRANSITIONS,
  TERMINAL_OPERATION_STATES,
  OperationRunBindingConflictError,
  SqliteOperationRepository,
  bindRunToOperationAtomically,
  hashOperationCommand,
  isLegalOperationTransition,
  isTerminalOperationState,
  operationId,
} from './operation-repository.js';
