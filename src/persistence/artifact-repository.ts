/**
 * ArtifactRepository (PLAN.md §12.1, §17.1, §19 test 31).
 *
 * "Large payloads: redact → hash → content-addressed artifact dir; SQLite
 * keeps metadata + bounded previews." · "Quotas (normative): per-run
 * artifact quota 2GB, global 20GB (admission rejection + event when
 * exceeded)."
 *
 * This is THE unified CAS write path (P1 verifier punch-list item 1): the
 * only place that (a) enforces redaction-before-sink (§17.1 — callers must
 * attest `redacted: true`), (b) enforces quota admission BEFORE any bytes
 * touch disk (so a rejected write never burns real disk space — see
 * `write()` below: the quota check happens strictly before
 * `#writeCasFile`), and (c) durably fsyncs those bytes via the SAME
 * fsync-before-rename primitive `../artifacts/store.ts`'s `ArtifactStore`
 * uses (`../artifacts/cas-fs.ts`), pointed at the identical
 * `<rootDir>/objects/<h[0:2]>/<h[2:4]>/<hash>` layout — a hash written
 * through either surface is readable through the other when they share a
 * root. `../checkpoint/writer.ts` depends on this interface (not the bare
 * `ArtifactStore`) specifically so checkpoint artifacts respect quotas too.
 *
 * Content-addressing: the `artifacts` table is keyed by hash ALONE (one row
 * per unique byte sequence, regardless of how many runs reference it), and
 * the CAS file for a given hash is written at most once. A `write()` call
 * whose bytes already exist is therefore a pure no-op for accounting: it
 * returns the existing record and does NOT add to any quota. This is what
 * keeps quota admission honest about actual disk consumption (§19 test 31).
 *
 * Event-vocabulary note (P1 verifier punch-list item 2): admission
 * rejections are recorded BOTH as their own durable, append-only audit
 * table (`artifact_admission_rejections` — kept exactly as documented; the
 * migration is unchanged, "rename-shaped" for a future table rename that
 * isn't needed yet) AND, whenever the rejection has an owning run, as a
 * real `'artifact.admission.rejected'` event (`../domain/events.ts`)
 * appended to that run's event log in the SAME transaction — see
 * `#recordRejection` below. A purely global, run-less write has no `RunId`
 * to attach a per-run event to and is recorded in the audit table only.
 */
import { randomUUID } from 'node:crypto';
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import { err, ok, type Result } from '../lib/result.js';
import { artifactHash, idempotencyKey, runId, type ArtifactHash, type RunId } from '../domain/ids.js';
import type { Artifact, ArtifactKind } from '../domain/entities.js';
import { draftEvent } from '../domain/events.js';
import type { ArtifactQuotaScope } from '../domain/state.js';
import { sha256Hex } from '../artifacts/hash.js';
import { objectExistsSync, readObjectSync, writeObjectSync } from '../artifacts/cas-fs.js';
import type { SqlDriver } from './driver.js';
import type { EventRepository } from './event-repository.js';
import { registerRun } from './runs.js';

export interface QuotaConfig {
  readonly perRunBytes: number;
  readonly globalBytes: number;
}

/** PLAN §12.1 normative defaults: per-run 2GB, global 20GB. */
export const DEFAULT_QUOTAS: QuotaConfig = {
  perRunBytes: 2 * 1024 ** 3,
  globalBytes: 20 * 1024 ** 3,
};

export const DEFAULT_PREVIEW_MAX_BYTES = 4096;

/** Re-export of the canonical domain type (../domain/state.ts) under this package's existing public name. */
export type AdmissionRejectionScope = ArtifactQuotaScope;

export interface ArtifactAdmissionRejected {
  readonly runId?: RunId;
  readonly attemptedHash: ArtifactHash;
  readonly attemptedSizeBytes: number;
  readonly scope: AdmissionRejectionScope;
  readonly limitBytes: number;
  /** Usage BEFORE this attempt (i.e. what it would have pushed over the limit). */
  readonly currentUsageBytes: number;
  readonly occurredAt: IsoTimestamp;
}

export interface WriteArtifactInput {
  readonly runId?: RunId;
  readonly kind: ArtifactKind;
  readonly bytes: Uint8Array;
  /** Caller asserts redaction already happened (§17.1) — enforced below. */
  readonly redacted: boolean;
  readonly previewMaxBytes?: number;
}

export interface ArtifactRepository {
  /**
   * Redaction-enforced, quota-admitted, fsync-durable write (see module
   * doc). On rejection, the returned `Err` carries the same facts (hash,
   * size, scope, limit, usage) that get durably recorded BOTH as an
   * audit-table row AND — whenever `input.runId` is set — as a real
   * `'artifact.admission.rejected'` event on that run's log.
   */
  write(input: WriteArtifactInput): Result<Artifact, ArtifactAdmissionRejected>;
  get(hash: ArtifactHash): Artifact | undefined;
  readBytes(hash: ArtifactHash): Uint8Array | undefined;
  usedBytesForRun(runId: RunId): number;
  usedBytesGlobal(): number;
  listAdmissionRejections(runId?: RunId): readonly ArtifactAdmissionRejected[];
}

interface ArtifactRow {
  readonly hash: string;
  readonly run_id: string | null;
  readonly kind: string;
  readonly size_bytes: number;
  readonly redacted: number;
  readonly preview: string | null;
  readonly created_at: string;
}

interface RejectionRow {
  readonly run_id: string | null;
  readonly attempted_hash: string;
  readonly attempted_size_bytes: number;
  readonly scope: string;
  readonly limit_bytes: number;
  readonly current_usage_bytes: number;
  readonly occurred_at: string;
}

function computePreview(bytes: Uint8Array, maxBytes: number): string | undefined {
  if (bytes.length === 0) return undefined;
  const slice = bytes.subarray(0, Math.min(bytes.length, maxBytes));
  return Buffer.from(slice).toString('utf8');
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    hash: artifactHash(row.hash),
    kind: row.kind as ArtifactKind,
    sizeBytes: row.size_bytes,
    redacted: row.redacted === 1,
    createdAt: row.created_at as IsoTimestamp,
    ...(row.run_id !== null ? { runId: runId(row.run_id) } : {}),
    ...(row.preview !== null ? { preview: row.preview } : {}),
  };
}

function rowToRejection(row: RejectionRow): ArtifactAdmissionRejected {
  return {
    attemptedHash: artifactHash(row.attempted_hash),
    attemptedSizeBytes: row.attempted_size_bytes,
    scope: row.scope as AdmissionRejectionScope,
    limitBytes: row.limit_bytes,
    currentUsageBytes: row.current_usage_bytes,
    occurredAt: row.occurred_at as IsoTimestamp,
    ...(row.run_id !== null ? { runId: runId(row.run_id) } : {}),
  };
}

const SELECT_ARTIFACT_SQL =
  'SELECT hash, run_id, kind, size_bytes, redacted, preview, created_at FROM artifacts WHERE hash = ?';
const INSERT_ARTIFACT_SQL = `
  INSERT INTO artifacts (hash, run_id, kind, size_bytes, redacted, preview, created_at)
  VALUES (?, ?, ?, ?, 1, ?, ?)
`;
const SUM_RUN_SQL = 'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifacts WHERE run_id = ?';
const SUM_GLOBAL_SQL = 'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM artifacts';
const INSERT_REJECTION_SQL = `
  INSERT INTO artifact_admission_rejections
    (run_id, attempted_hash, attempted_size_bytes, scope, limit_bytes, current_usage_bytes, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;
const SELECT_REJECTIONS_BY_RUN_SQL =
  'SELECT run_id, attempted_hash, attempted_size_bytes, scope, limit_bytes, current_usage_bytes, occurred_at FROM artifact_admission_rejections WHERE run_id = ? ORDER BY row_id ASC';
const SELECT_REJECTIONS_ALL_SQL =
  'SELECT run_id, attempted_hash, attempted_size_bytes, scope, limit_bytes, current_usage_bytes, occurred_at FROM artifact_admission_rejections ORDER BY row_id ASC';

export class SqliteArtifactRepository implements ArtifactRepository {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;
  readonly #casRoot: string;
  readonly #events: EventRepository;
  readonly #quotas: QuotaConfig;

  constructor(
    driver: SqlDriver,
    clock: Clock,
    casRoot: string,
    events: EventRepository,
    quotas: QuotaConfig = DEFAULT_QUOTAS,
  ) {
    this.#driver = driver;
    this.#clock = clock;
    this.#casRoot = casRoot;
    this.#events = events;
    this.#quotas = quotas;
  }

  write(input: WriteArtifactInput): Result<Artifact, ArtifactAdmissionRejected> {
    if (!input.redacted) {
      throw new Error(
        'ArtifactRepository.write: redaction must happen BEFORE every sink (§17.1) — refusing an artifact marked redacted:false',
      );
    }
    const hash = artifactHash(sha256Hex(Buffer.from(input.bytes)));
    const existing = this.get(hash);
    if (existing) {
      // Content-addressed dedup: metadata (and its quota charge) is already
      // accounted for. Still HEAL a physically-missing object — e.g. a
      // filesystem-level `ArtifactStore.gcSweep()` run against this same
      // `casRoot` reclaimed the bytes without knowing about this SQL row —
      // by re-writing the SAME already-admitted bytes, never re-charging
      // any quota for content that was already counted once.
      if (!objectExistsSync(this.#casRoot, String(hash))) {
        writeObjectSync(this.#casRoot, String(hash), Buffer.from(input.bytes), randomUUID());
      }
      return ok(existing);
    }

    const size = input.bytes.length;
    return this.#driver.transaction(() => {
      if (input.runId !== undefined) {
        const runUsage = this.usedBytesForRun(input.runId);
        if (runUsage + size > this.#quotas.perRunBytes) {
          return err(this.#recordRejection(input.runId, hash, size, 'per_run', this.#quotas.perRunBytes, runUsage));
        }
      }
      const globalUsage = this.usedBytesGlobal();
      if (globalUsage + size > this.#quotas.globalBytes) {
        return err(
          this.#recordRejection(input.runId, hash, size, 'global', this.#quotas.globalBytes, globalUsage),
        );
      }

      if (input.runId !== undefined) registerRun(this.#driver, this.#clock, input.runId);
      this.#writeCasFile(hash, input.bytes);
      const createdAt = this.#clock.nowIso();
      const preview = computePreview(input.bytes, input.previewMaxBytes ?? DEFAULT_PREVIEW_MAX_BYTES);
      this.#driver
        .prepare(INSERT_ARTIFACT_SQL)
        .run([hash, input.runId ?? null, input.kind, size, preview ?? null, createdAt]);
      const artifact: Artifact = {
        hash,
        kind: input.kind,
        sizeBytes: size,
        redacted: true,
        createdAt,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        ...(preview !== undefined ? { preview } : {}),
      };
      return ok(artifact);
    });
  }

  /**
   * Records the rejection twice: the append-only audit row (unchanged
   * shape/table — "keep the migration as documented") AND, whenever there's
   * an owning run, a real `'artifact.admission.rejected'` event in that
   * run's log (P1 verifier punch-list item 2). Both writes share the caller's
   * enclosing `#driver.transaction()` (nested transactions compose — see
   * ../persistence/driver.ts), so a crash can never leave one without the
   * other. The idempotency key is content-derived (hash/scope/usage), not
   * freshly minted, so a retried rejection of the exact same attempt dedupes
   * to the same logical event instead of appending a duplicate.
   */
  #recordRejection(
    owner: RunId | undefined,
    hash: ArtifactHash,
    size: number,
    scope: AdmissionRejectionScope,
    limitBytes: number,
    currentUsageBytes: number,
  ): ArtifactAdmissionRejected {
    const occurredAt = this.#clock.nowIso();
    if (owner !== undefined) registerRun(this.#driver, this.#clock, owner);
    this.#driver
      .prepare(INSERT_REJECTION_SQL)
      .run([owner ?? null, hash, size, scope, limitBytes, currentUsageBytes, occurredAt]);

    if (owner !== undefined) {
      this.#events.append(
        draftEvent({
          type: 'artifact.admission.rejected',
          runId: owner,
          payload: { attemptedHash: hash, attemptedSizeBytes: size, scope, limitBytes, currentUsageBytes },
          idempotencyKey: idempotencyKey(`artifact-admission-rejected:${owner}:${hash}:${scope}:${currentUsageBytes}`),
          occurredAt,
        }),
      );
    }

    return {
      attemptedHash: hash,
      attemptedSizeBytes: size,
      scope,
      limitBytes,
      currentUsageBytes,
      occurredAt,
      ...(owner !== undefined ? { runId: owner } : {}),
    };
  }

  /** Delegates to the SAME fsync-before-rename primitive `ArtifactStore` uses (../artifacts/cas-fs.ts). */
  #writeCasFile(hash: ArtifactHash, bytes: Uint8Array): void {
    writeObjectSync(this.#casRoot, String(hash), Buffer.from(bytes), randomUUID());
  }

  get(hash: ArtifactHash): Artifact | undefined {
    const row = this.#driver.prepare(SELECT_ARTIFACT_SQL).get<ArtifactRow>([hash]);
    return row ? rowToArtifact(row) : undefined;
  }

  readBytes(hash: ArtifactHash): Uint8Array | undefined {
    if (!objectExistsSync(this.#casRoot, String(hash))) return undefined;
    return new Uint8Array(readObjectSync(this.#casRoot, String(hash)));
  }

  usedBytesForRun(owner: RunId): number {
    const row = this.#driver.prepare(SUM_RUN_SQL).get<{ total: number }>([owner]);
    return row?.total ?? 0;
  }

  usedBytesGlobal(): number {
    const row = this.#driver.prepare(SUM_GLOBAL_SQL).get<{ total: number }>([]);
    return row?.total ?? 0;
  }

  listAdmissionRejections(owner?: RunId): readonly ArtifactAdmissionRejected[] {
    const rows =
      owner !== undefined
        ? this.#driver.prepare(SELECT_REJECTIONS_BY_RUN_SQL).all<RejectionRow>([owner])
        : this.#driver.prepare(SELECT_REJECTIONS_ALL_SQL).all<RejectionRow>([]);
    return rows.map(rowToRejection);
  }
}
