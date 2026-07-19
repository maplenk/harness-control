/**
 * Mechanical checkpoint writer (PLAN.md §12.2): synchronous in the sense
 * that matters — no LLM call anywhere on this path, purely a deterministic
 * serialize + redact + content-addressed write + event construction.
 *
 * Goes through the UNIFIED artifact write path (P1 verifier punch-list item
 * 1: `../persistence/artifact-repository.ts`'s `ArtifactRepository`, not
 * the bare `ArtifactStore`) so checkpoint artifacts are quota-admitted,
 * fsync-durable, and redacted exactly like every other artifact — "the
 * checkpoint writer must go through it so checkpoint artifacts respect
 * quotas." Because that repository's `write()` takes already-redacted
 * bytes with an explicit attestation (it cannot safely auto-redact
 * arbitrary `Uint8Array` content), this module redacts the canonical JSON
 * serialization itself, via the same `redactText` every other string sink
 * uses (§17.1), before handing it off.
 *
 * Atomicity contract: by the time this function RESOLVES with an `Ok`, the
 * checkpoint's artifact bytes are already fsynced and durable at their
 * content-addressed path (`ArtifactRepository.write` fsyncs before it
 * returns — see src/artifacts/cas-fs.ts). The `checkpoint.recorded` event
 * this function builds carries that hash. This module does NOT append the
 * event or own persistence — the caller is responsible for appending it
 * atomically with the state transition in the same repository transaction
 * (§12.2/§6.3). If that transaction never lands (crash, process death), the
 * artifact this event would have referenced remains on disk but
 * unreferenced by any committed event: `collectReferencedArtifactHashes`
 * (src/artifacts/gc.ts) run over the ACTUALLY-committed event log will not
 * include its hash, so `ArtifactStore.gcSweep` reclaims it —
 * "artifact-without-event is invisible to replay and GC'd; event-without-
 * artifact is impossible."
 *
 * Quota admission is a REAL possible outcome here (§12.1 draws no exception
 * for checkpoints): a run that has exhausted its artifact quota can have a
 * checkpoint write REJECTED. This is surfaced honestly as an `Err` — never
 * swallowed, never a fabricated success — mirroring
 * `ArtifactRepository.write`'s own `Result` contract exactly.
 */
import type { Clock } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import { isErr, ok, unwrap, type Result } from '../lib/result.js';
import { newCheckpointId, newIdempotencyKey, type AssignmentId, type RunId, type SegmentId } from '../domain/ids.js';
import type { Checkpoint, CheckpointContent } from '../domain/entities.js';
import type { CheckpointReason } from '../domain/state.js';
import { draftEvent, type EventOfType } from '../domain/events.js';
import type { ArtifactAdmissionRejected, ArtifactRepository } from '../persistence/artifact-repository.js';
import { DEFAULT_REDACTION_CONFIG, redactText, type RedactionConfig } from '../redaction/redact.js';
import { canonicalStringify } from './serialize.js';

export interface CheckpointWriterDeps {
  readonly artifacts: ArtifactRepository;
  readonly clock: Clock;
  readonly ids: IdFactory;
  /** Defaults to `DEFAULT_REDACTION_CONFIG` (§17.1). */
  readonly redactionConfig?: RedactionConfig;
}

export interface WriteCheckpointInput {
  readonly runId: RunId;
  readonly segmentId: SegmentId;
  readonly assignmentId?: AssignmentId;
  readonly reason: CheckpointReason;
  readonly content: CheckpointContent;
}

export interface WriteCheckpointResult {
  readonly checkpoint: Checkpoint;
  /** Ready-to-append event; NOT appended by this function (see module doc). */
  readonly event: EventOfType<'checkpoint.recorded'>;
}

export async function writeCheckpoint(
  deps: CheckpointWriterDeps,
  input: WriteCheckpointInput,
): Promise<Result<WriteCheckpointResult, ArtifactAdmissionRejected>> {
  const serialized = canonicalStringify(input.content);
  const redacted = redactText(serialized, deps.redactionConfig ?? DEFAULT_REDACTION_CONFIG);

  // Quota admission + fsync-before-rename happen INSIDE write() before it
  // returns (§12.2 "artifact fsync first"). The artifact's hash — and
  // therefore the event below — cannot exist until this completes; that
  // dependency IS the ordering guarantee. A quota rejection short-circuits
  // here with no checkpoint/event ever constructed.
  const written = deps.artifacts.write({
    runId: input.runId,
    kind: 'checkpoint',
    bytes: Buffer.from(redacted, 'utf8'),
    redacted: true,
  });
  if (isErr(written)) return written;
  const artifact = unwrap(written);

  const checkpointIdValue = newCheckpointId(deps.ids);
  const createdAt = deps.clock.nowIso();

  const checkpoint: Checkpoint = {
    id: checkpointIdValue,
    runId: input.runId,
    segmentId: input.segmentId,
    artifactHash: artifact.hash,
    reason: input.reason,
    content: input.content,
    createdAt,
    ...(input.assignmentId !== undefined ? { assignmentId: input.assignmentId } : {}),
  };

  const event = draftEvent({
    type: 'checkpoint.recorded',
    runId: input.runId,
    payload: {
      checkpointId: checkpointIdValue,
      artifactHash: artifact.hash,
      reason: input.reason,
      segmentId: input.segmentId,
    },
    idempotencyKey: newIdempotencyKey(deps.ids),
    occurredAt: createdAt,
  });

  return ok({ checkpoint, event });
}
