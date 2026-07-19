/**
 * ProcessSampleRepository (PLAN.md §12.1, §14, §19 test 31).
 *
 * "telemetry (vitals) aggregated per-minute in projections, raw samples
 * pruned." The §14 watchdog samples the full process tree's RSS on a 5s
 * adaptive tick; `recordRawSample` stores each tick. `aggregateWindow`
 * folds every raw tick in `[windowStart, windowStart + windowSeconds)` for
 * a (run, segment) into ONE `ProcessSample` row (the aggregated projection
 * type already defined in `../domain/entities.ts`) and PRUNES the raw rows
 * it just folded — this is what keeps `raw_process_samples` bounded instead
 * of growing for the lifetime of a long-paused/restarting run.
 *
 * Aggregation is safe to call repeatedly for the same window (e.g. a live
 * watchdog closing a window slightly before every last sample has landed):
 * a second call against an already-aggregated (now-empty) window is a
 * no-op that leaves the existing aggregate untouched; a call that finds
 * MORE raw samples for a window already aggregated MERGES into the
 * existing row (max-of-max, weighted mean, summed count) rather than
 * clobbering it.
 */
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import {
  processGenerationId as brandProcessGenerationId,
  runId as brandRunId,
  segmentId as brandSegmentId,
  type ProcessGenerationId,
  type RunId,
  type SegmentId,
} from '../domain/ids.js';
import type { ProcessSample } from '../domain/entities.js';
import type { SqlDriver } from './driver.js';
import { registerRun } from './runs.js';

export const DEFAULT_WINDOW_SECONDS = 60;

/** Sentinel for "no segment scope" in the aggregate PRIMARY KEY (SQLite treats NULL as distinct-from-NULL for uniqueness). */
const SEGMENT_SCOPE_NONE = '*';

export interface RawProcessSample {
  readonly runId: RunId;
  readonly segmentId?: SegmentId;
  readonly processGenerationId?: ProcessGenerationId;
  readonly sampledAt: IsoTimestamp;
  readonly rssBytes: number;
}

export interface AggregateWindowInput {
  readonly runId: RunId;
  readonly segmentId?: SegmentId;
  readonly windowStart: IsoTimestamp;
  /** Default 60 (per-minute, §12.1). */
  readonly windowSeconds?: number;
}

export interface AggregateClosedWindowsInput {
  readonly runId: RunId;
  readonly segmentId?: SegmentId;
  /**
   * The current wall-clock time. Every per-minute window whose END is at or
   * before `now` has fully closed and is folded + pruned; the in-progress
   * window (end after `now`) is left untouched so a live sampler keeps writing
   * into it.
   */
  readonly now: IsoTimestamp;
  /** Default 60 (per-minute, §12.1). */
  readonly windowSeconds?: number;
}

export interface ProcessSampleRepository {
  recordRawSample(input: RawProcessSample): void;
  /** Returns the folded `ProcessSample`, or `undefined` if no raw samples fell in the window. */
  aggregateWindow(input: AggregateWindowInput): ProcessSample | undefined;
  /**
   * §12.1 retention driver: fold + prune EVERY minute-aligned window for this
   * (run, segment) that has fully closed relative to `now`. This is the
   * production caller that keeps `raw_process_samples` bounded — without it
   * raw ticks accumulate for the life of the run. Returns the aggregates it
   * produced/merged (empty when nothing has closed yet). Idempotent: a second
   * call re-folds nothing because the raw rows were pruned.
   */
  aggregateClosedWindows(input: AggregateClosedWindowsInput): readonly ProcessSample[];
  listAggregates(runId: RunId): readonly ProcessSample[];
  listRawSamples(runId: RunId): readonly RawProcessSample[];
  countRawSamples(runId: RunId): number;
}

interface RawRow {
  readonly run_id: string;
  readonly segment_id: string | null;
  readonly process_generation_id: string | null;
  readonly sampled_at: string;
  readonly rss_bytes: number;
}

interface AggregateRow {
  readonly run_id: string;
  readonly segment_id: string | null;
  readonly process_generation_id: string | null;
  readonly window_start: string;
  readonly window_seconds: number;
  readonly rss_max_bytes: number;
  readonly rss_mean_bytes: number;
  readonly sample_count: number;
}

function rowToRawSample(row: RawRow): RawProcessSample {
  return {
    runId: brandRunId(row.run_id),
    sampledAt: row.sampled_at as IsoTimestamp,
    rssBytes: row.rss_bytes,
    ...(row.segment_id !== null ? { segmentId: brandSegmentId(row.segment_id) } : {}),
    ...(row.process_generation_id !== null
      ? { processGenerationId: brandProcessGenerationId(row.process_generation_id) }
      : {}),
  };
}

function rowToProcessSample(row: AggregateRow): ProcessSample {
  return {
    runId: brandRunId(row.run_id),
    windowStart: row.window_start as IsoTimestamp,
    windowSeconds: row.window_seconds,
    rssMaxBytes: row.rss_max_bytes,
    rssMeanBytes: row.rss_mean_bytes,
    sampleCount: row.sample_count,
    ...(row.segment_id !== null ? { segmentId: brandSegmentId(row.segment_id) } : {}),
    ...(row.process_generation_id !== null
      ? { processGenerationId: brandProcessGenerationId(row.process_generation_id) }
      : {}),
  };
}

function addSeconds(iso: IsoTimestamp, seconds: number): IsoTimestamp {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString() as IsoTimestamp;
}

const INSERT_RAW_SQL = `
  INSERT INTO raw_process_samples (run_id, segment_id, process_generation_id, sampled_at, rss_bytes)
  VALUES (?, ?, ?, ?, ?)
`;
const SELECT_RAW_WINDOW_SQL = `
  SELECT run_id, segment_id, process_generation_id, sampled_at, rss_bytes
  FROM raw_process_samples
  WHERE run_id = ? AND segment_id IS ? AND sampled_at >= ? AND sampled_at < ?
  ORDER BY sampled_at ASC
`;
const DELETE_RAW_WINDOW_SQL = `
  DELETE FROM raw_process_samples
  WHERE run_id = ? AND segment_id IS ? AND sampled_at >= ? AND sampled_at < ?
`;
const SELECT_RAW_SAMPLED_AT_BY_SEGMENT_SQL = `
  SELECT sampled_at FROM raw_process_samples
  WHERE run_id = ? AND segment_id IS ?
  ORDER BY sampled_at ASC
`;
const SELECT_RAW_BY_RUN_SQL = `
  SELECT run_id, segment_id, process_generation_id, sampled_at, rss_bytes
  FROM raw_process_samples WHERE run_id = ? ORDER BY sampled_at ASC
`;
const COUNT_RAW_BY_RUN_SQL = 'SELECT COUNT(*) AS n FROM raw_process_samples WHERE run_id = ?';
const UPSERT_AGGREGATE_SQL = `
  INSERT INTO process_sample_aggregates
    (run_id, segment_key, segment_id, process_generation_id, window_start, window_seconds, rss_max_bytes, rss_mean_bytes, sample_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (run_id, segment_key, window_start) DO UPDATE SET
    process_generation_id = excluded.process_generation_id,
    window_seconds = excluded.window_seconds,
    rss_max_bytes = MAX(rss_max_bytes, excluded.rss_max_bytes),
    rss_mean_bytes = (rss_mean_bytes * sample_count + excluded.rss_mean_bytes * excluded.sample_count)
                      / (sample_count + excluded.sample_count),
    sample_count = sample_count + excluded.sample_count
`;
const SELECT_AGGREGATES_SQL = `
  SELECT run_id, segment_id, process_generation_id, window_start, window_seconds, rss_max_bytes, rss_mean_bytes, sample_count
  FROM process_sample_aggregates WHERE run_id = ? ORDER BY window_start ASC, segment_key ASC
`;

export class SqliteProcessSampleRepository implements ProcessSampleRepository {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;

  constructor(driver: SqlDriver, clock: Clock) {
    this.#driver = driver;
    this.#clock = clock;
  }

  recordRawSample(input: RawProcessSample): void {
    registerRun(this.#driver, this.#clock, input.runId);
    this.#driver
      .prepare(INSERT_RAW_SQL)
      .run([
        input.runId,
        input.segmentId ?? null,
        input.processGenerationId ?? null,
        input.sampledAt,
        input.rssBytes,
      ]);
  }

  aggregateWindow(input: AggregateWindowInput): ProcessSample | undefined {
    const windowSeconds = input.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    const windowEnd = addSeconds(input.windowStart, windowSeconds);
    const segmentParam = input.segmentId ?? null;
    return this.#driver.transaction(() => {
      const rows = this.#driver
        .prepare(SELECT_RAW_WINDOW_SQL)
        .all<RawRow>([input.runId, segmentParam, input.windowStart, windowEnd]);
      if (rows.length === 0) return undefined;

      const rssValues = rows.map((row) => row.rss_bytes);
      const rssMaxBytes = Math.max(...rssValues);
      const rssMeanBytes = rssValues.reduce((sum, value) => sum + value, 0) / rssValues.length;
      const sampleCount = rows.length;
      const processGeneration = rows[rows.length - 1]!.process_generation_id;
      const segmentKey = input.segmentId ?? SEGMENT_SCOPE_NONE;

      this.#driver
        .prepare(UPSERT_AGGREGATE_SQL)
        .run([
          input.runId,
          segmentKey,
          segmentParam,
          processGeneration,
          input.windowStart,
          windowSeconds,
          rssMaxBytes,
          rssMeanBytes,
          sampleCount,
        ]);
      this.#driver
        .prepare(DELETE_RAW_WINDOW_SQL)
        .run([input.runId, segmentParam, input.windowStart, windowEnd]);

      // Read back the merged row so a re-aggregation of a window that
      // already had an aggregate reports the MERGED totals, not just this
      // call's slice.
      const merged = this.#driver
        .prepare(
          'SELECT run_id, segment_id, process_generation_id, window_start, window_seconds, rss_max_bytes, rss_mean_bytes, sample_count FROM process_sample_aggregates WHERE run_id = ? AND segment_key = ? AND window_start = ?',
        )
        .get<AggregateRow>([input.runId, segmentKey, input.windowStart]);
      return merged ? rowToProcessSample(merged) : undefined;
    });
  }

  aggregateClosedWindows(input: AggregateClosedWindowsInput): readonly ProcessSample[] {
    const windowSeconds = input.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    const windowMs = windowSeconds * 1000;
    const nowMs = Date.parse(input.now);
    const segmentParam = input.segmentId ?? null;
    const rows = this.#driver
      .prepare(SELECT_RAW_SAMPLED_AT_BY_SEGMENT_SQL)
      .all<{ sampled_at: string }>([input.runId, segmentParam]);
    // Snap each raw tick to its minute-aligned window start; keep only windows
    // whose END (start + windowSeconds) has already passed `now`.
    const closedStarts = new Set<number>();
    for (const row of rows) {
      const start = Math.floor(Date.parse(row.sampled_at) / windowMs) * windowMs;
      if (start + windowMs <= nowMs) closedStarts.add(start);
    }
    const folded: ProcessSample[] = [];
    for (const start of [...closedStarts].sort((a, b) => a - b)) {
      const result = this.aggregateWindow({
        runId: input.runId,
        windowStart: new Date(start).toISOString() as IsoTimestamp,
        windowSeconds,
        ...(input.segmentId !== undefined ? { segmentId: input.segmentId } : {}),
      });
      if (result !== undefined) folded.push(result);
    }
    return folded;
  }

  listAggregates(owner: RunId): readonly ProcessSample[] {
    return this.#driver.prepare(SELECT_AGGREGATES_SQL).all<AggregateRow>([owner]).map(rowToProcessSample);
  }

  listRawSamples(owner: RunId): readonly RawProcessSample[] {
    return this.#driver.prepare(SELECT_RAW_BY_RUN_SQL).all<RawRow>([owner]).map(rowToRawSample);
  }

  countRawSamples(owner: RunId): number {
    const row = this.#driver.prepare(COUNT_RAW_BY_RUN_SQL).get<{ n: number }>([owner]);
    return row?.n ?? 0;
  }
}
