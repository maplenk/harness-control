/**
 * §19 test 31 (part B): "telemetry aggregation" + raw pruning.
 * §12.1: "telemetry (vitals) aggregated per-minute in projections, raw
 * samples pruned." §14: watchdog RSS sampling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { processGenerationId, runId, segmentId } from '../domain/ids.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN = runId('run_telemetry_1');
const SEG_A = segmentId('seg_telemetry_a');
const SEG_B = segmentId('seg_telemetry_b');
const PGEN = processGenerationId('pgen_telemetry_1');

const WINDOW_1_START = isoTimestamp('2026-07-18T10:00:00.000Z');
const WINDOW_2_START = isoTimestamp('2026-07-18T10:01:00.000Z');

describe.each(DRIVER_KINDS)('ProcessSampleRepository (%s) — §19 test 31 telemetry aggregation', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('folds raw samples in a 60s window into one ProcessSample and PRUNES only the raw rows it aggregated', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const telemetry = handle.db.telemetry;

    // window 1: three ticks for SEG_A
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, processGenerationId: PGEN, sampledAt: isoTimestamp('2026-07-18T10:00:05.000Z'), rssBytes: 100 });
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, processGenerationId: PGEN, sampledAt: isoTimestamp('2026-07-18T10:00:15.000Z'), rssBytes: 300 });
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, processGenerationId: PGEN, sampledAt: isoTimestamp('2026-07-18T10:00:45.000Z'), rssBytes: 200 });
    // window 2: one tick, must NOT be touched by aggregating window 1
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:01:10.000Z'), rssBytes: 500 });

    expect(telemetry.countRawSamples(RUN)).toBe(4);

    const aggregate = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_1_START });

    expect(aggregate).toMatchObject({
      runId: RUN,
      segmentId: SEG_A,
      processGenerationId: PGEN,
      windowStart: WINDOW_1_START,
      windowSeconds: 60,
      rssMaxBytes: 300,
      rssMeanBytes: 200,
      sampleCount: 3,
    });

    // The 3 window-1 raw rows are pruned; the window-2 row survives untouched.
    expect(telemetry.countRawSamples(RUN)).toBe(1);
    const remaining = telemetry.listRawSamples(RUN);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.sampledAt).toBe('2026-07-18T10:01:10.000Z');

    expect(telemetry.listAggregates(RUN)).toEqual([aggregate]);
  });

  it('aggregating an empty window is a safe no-op: no bogus zero row, existing aggregate untouched', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const telemetry = handle.db.telemetry;

    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:00:05.000Z'), rssBytes: 100 });
    const first = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_1_START });
    expect(first?.sampleCount).toBe(1);

    // Nothing left to aggregate for window 1 (already pruned) — must not touch the existing row.
    const again = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_1_START });
    expect(again).toBeUndefined();
    expect(telemetry.listAggregates(RUN)).toEqual([first]);

    // A window that never had any data at all: also undefined, no row created.
    const neverSampled = telemetry.aggregateWindow({
      runId: RUN,
      segmentId: SEG_A,
      windowStart: isoTimestamp('2026-07-18T12:00:00.000Z'),
    });
    expect(neverSampled).toBeUndefined();
    expect(telemetry.listAggregates(RUN)).toHaveLength(1);
  });

  it('re-aggregating a window that gained MORE samples since its first aggregation MERGES (max-of-max, weighted mean, summed count)', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const telemetry = handle.db.telemetry;

    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:01:10.000Z'), rssBytes: 500 });
    const firstPass = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_2_START });
    expect(firstPass).toMatchObject({ rssMaxBytes: 500, rssMeanBytes: 500, sampleCount: 1 });

    // More ticks land in the SAME window before it's next aggregated.
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:01:20.000Z'), rssBytes: 700 });
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:01:30.000Z'), rssBytes: 300 });

    const merged = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_2_START });
    expect(merged).toMatchObject({ rssMaxBytes: 700, rssMeanBytes: 500, sampleCount: 3 });
    expect(telemetry.listAggregates(RUN)).toEqual([merged]); // one row, not two
    expect(telemetry.countRawSamples(RUN)).toBe(0);
  });

  it('scopes both aggregation and pruning by segment: one segment cannot see or delete another segment\'s ticks', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const telemetry = handle.db.telemetry;

    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_A, sampledAt: isoTimestamp('2026-07-18T10:00:10.000Z'), rssBytes: 100 });
    telemetry.recordRawSample({ runId: RUN, segmentId: SEG_B, sampledAt: isoTimestamp('2026-07-18T10:00:20.000Z'), rssBytes: 999 });

    const aggregateA = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_A, windowStart: WINDOW_1_START });
    expect(aggregateA).toMatchObject({ segmentId: SEG_A, rssMaxBytes: 100, sampleCount: 1 });

    // SEG_B's raw sample must have survived SEG_A's aggregation untouched.
    expect(telemetry.countRawSamples(RUN)).toBe(1);
    expect(telemetry.listRawSamples(RUN)[0]).toMatchObject({ segmentId: SEG_B, rssBytes: 999 });

    const aggregateB = telemetry.aggregateWindow({ runId: RUN, segmentId: SEG_B, windowStart: WINDOW_1_START });
    expect(aggregateB).toMatchObject({ segmentId: SEG_B, rssMaxBytes: 999, sampleCount: 1 });

    expect(telemetry.listAggregates(RUN)).toHaveLength(2);
    expect(telemetry.countRawSamples(RUN)).toBe(0);
  });

  it('supports a run-level (no segment scope) aggregation window', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const telemetry = handle.db.telemetry;
    telemetry.recordRawSample({ runId: RUN, sampledAt: isoTimestamp('2026-07-18T10:00:10.000Z'), rssBytes: 42 });
    const aggregate = telemetry.aggregateWindow({ runId: RUN, windowStart: WINDOW_1_START });
    expect(aggregate).toMatchObject({ rssMaxBytes: 42, sampleCount: 1 });
    expect(aggregate?.segmentId).toBeUndefined();
  });
});
