/**
 * Machine-decidable inventory of §3A.2 modules and acceptance test titles.
 * Reads sibling sources (same technique as src/app/commands/module-boundaries.test.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

/** Every required A1–A13, B1–B6, C1–C9 title string. */
export const REQUIRED_OPERATION_TEST_TITLES = [
  // A1–A13 (operation-repository.test.ts)
  'accepted → claimed → running → succeeded walks the full lifecycle and stamps a terminal timestamp',
  'running ⇄ waiting_for_input moves both ways, including waiting_for_input → running',
  'cancellation is legal from every pre-terminal state, including accepted and claimed',
  'a lapsed lease returns a claimed/running operation to accepted with attemptCount incremented and owner/lease cleared',
  'an illegal transition is rejected without mutating the stored row',
  'the operations table carries every §3A.2 column and enforces UNIQUE(actor, idempotencyKey)',
  'the operations schema ships as a NEW migration and leaves migration 1 untouched',
  'a retry with a matching commandHash returns the existing operation and inserts no second row',
  'a retry with a mismatched payload returns conflict and inserts no second row',
  'the same idempotencyKey under a different actor is a distinct operation',
  'the stored versioned payload survives to re-drive a start that never bound a runId',
  'accept() commits the accepted row before returning: a close+reopen still sees it',
  'get / getByIdempotency / listByRun / listUnsettled expose operation state for polling',
  // B1–B6 (operation-write-path.test.ts)
  'createRun and the operation→run binding commit in ONE transaction',
  'a throw inside the binding transaction leaves neither the run nor the binding — no orphan run',
  'replaying a rolled-back start binds exactly one run and creates no duplicate',
  'every projections.save call in the new operation modules passes an explicit eventCursor',
  'save-then-recover on the operation binding path does not double-fold',
  'the cursor-less save landmine is real: the same sequence without a cursor double-folds',
  // C1–C9 (operation-recovery.test.ts)
  'a start with no bound runId re-drives from the stored versioned payload',
  'a start whose run sits in created/specifying re-drives coordinator drafting',
  'a run whose run sits in approved with no durable round plans handle_run, not handle_resume',
  'a run that crashed mid-loop plans handle_resume',
  'resume plans handle_resume and recheck plans handle_recheck',
  'a run claimed by a live owner withholds instead of double-driving',
  'a terminal operation plans no action',
  'an operation whose run already advanced reconciles from durable run state instead of re-driving',
  'reconcileOperationFromRunPhase settles merge_ready/failed/cancelled and returns undefined otherwise',
] as const;

const REQUIRED_MODULES = [
  'src/persistence/operation-repository.ts',
  'src/persistence/operation-repository.test.ts',
  'src/persistence/operation-write-path.test.ts',
  'src/persistence/operation-suite-manifest.test.ts',
  'src/app/commands/operation-recovery.ts',
  'src/app/commands/operation-recovery.test.ts',
] as const;

const TITLE_TO_FILE: Readonly<Record<string, string>> = {
  // A*
  'accepted → claimed → running → succeeded walks the full lifecycle and stamps a terminal timestamp':
    'src/persistence/operation-repository.test.ts',
  'running ⇄ waiting_for_input moves both ways, including waiting_for_input → running':
    'src/persistence/operation-repository.test.ts',
  'cancellation is legal from every pre-terminal state, including accepted and claimed':
    'src/persistence/operation-repository.test.ts',
  'a lapsed lease returns a claimed/running operation to accepted with attemptCount incremented and owner/lease cleared':
    'src/persistence/operation-repository.test.ts',
  'an illegal transition is rejected without mutating the stored row':
    'src/persistence/operation-repository.test.ts',
  'the operations table carries every §3A.2 column and enforces UNIQUE(actor, idempotencyKey)':
    'src/persistence/operation-repository.test.ts',
  'the operations schema ships as a NEW migration and leaves migration 1 untouched':
    'src/persistence/operation-repository.test.ts',
  'a retry with a matching commandHash returns the existing operation and inserts no second row':
    'src/persistence/operation-repository.test.ts',
  'a retry with a mismatched payload returns conflict and inserts no second row':
    'src/persistence/operation-repository.test.ts',
  'the same idempotencyKey under a different actor is a distinct operation':
    'src/persistence/operation-repository.test.ts',
  'the stored versioned payload survives to re-drive a start that never bound a runId':
    'src/persistence/operation-repository.test.ts',
  'accept() commits the accepted row before returning: a close+reopen still sees it':
    'src/persistence/operation-repository.test.ts',
  'get / getByIdempotency / listByRun / listUnsettled expose operation state for polling':
    'src/persistence/operation-repository.test.ts',
  // B*
  'createRun and the operation→run binding commit in ONE transaction':
    'src/persistence/operation-write-path.test.ts',
  'a throw inside the binding transaction leaves neither the run nor the binding — no orphan run':
    'src/persistence/operation-write-path.test.ts',
  'replaying a rolled-back start binds exactly one run and creates no duplicate':
    'src/persistence/operation-write-path.test.ts',
  'every projections.save call in the new operation modules passes an explicit eventCursor':
    'src/persistence/operation-write-path.test.ts',
  'save-then-recover on the operation binding path does not double-fold':
    'src/persistence/operation-write-path.test.ts',
  'the cursor-less save landmine is real: the same sequence without a cursor double-folds':
    'src/persistence/operation-write-path.test.ts',
  // C*
  'a start with no bound runId re-drives from the stored versioned payload':
    'src/app/commands/operation-recovery.test.ts',
  'a start whose run sits in created/specifying re-drives coordinator drafting':
    'src/app/commands/operation-recovery.test.ts',
  'a run whose run sits in approved with no durable round plans handle_run, not handle_resume':
    'src/app/commands/operation-recovery.test.ts',
  'a run that crashed mid-loop plans handle_resume':
    'src/app/commands/operation-recovery.test.ts',
  'resume plans handle_resume and recheck plans handle_recheck':
    'src/app/commands/operation-recovery.test.ts',
  'a run claimed by a live owner withholds instead of double-driving':
    'src/app/commands/operation-recovery.test.ts',
  'a terminal operation plans no action':
    'src/app/commands/operation-recovery.test.ts',
  'an operation whose run already advanced reconciles from durable run state instead of re-driving':
    'src/app/commands/operation-recovery.test.ts',
  'reconcileOperationFromRunPhase settles merge_ready/failed/cancelled and returns undefined otherwise':
    'src/app/commands/operation-recovery.test.ts',
};

describe('§3A.2 operation suite manifest', () => {
  it('ships every §3A.2 operation module and test file', () => {
    for (const rel of REQUIRED_MODULES) {
      const abs = path.join(REPO_ROOT, rel);
      expect(fs.existsSync(abs), `missing ${rel}`).toBe(true);
    }
  });

  it('declares every required §3A.2 acceptance test title', () => {
    expect(REQUIRED_OPERATION_TEST_TITLES.length).toBe(13 + 6 + 9);
    for (const title of REQUIRED_OPERATION_TEST_TITLES) {
      const rel = TITLE_TO_FILE[title];
      expect(rel, `no file mapping for title: ${title}`).toBeDefined();
      const source = fs.readFileSync(path.join(REPO_ROOT, rel!), 'utf8');
      expect(source, `title missing from ${rel}: ${title}`).toContain(title);
    }
  });

  it('exports the operation surface from the persistence barrel and the root barrel', async () => {
    const fromPersistence = await import('./index.js');
    const fromRoot = await import('../index.js');

    for (const [label, mod] of [
      ['persistence', fromPersistence],
      ['root', fromRoot],
    ] as const) {
      expect(mod.SqliteOperationRepository, `${label}.SqliteOperationRepository`).toBeDefined();
      expect(mod.OPERATION_LIFECYCLE_STATES, `${label}.OPERATION_LIFECYCLE_STATES`).toBeDefined();
      expect(mod.TERMINAL_OPERATION_STATES, `${label}.TERMINAL_OPERATION_STATES`).toBeDefined();
      expect(mod.OPERATION_TRANSITIONS, `${label}.OPERATION_TRANSITIONS`).toBeDefined();
      expect(mod.bindRunToOperationAtomically, `${label}.bindRunToOperationAtomically`).toBeDefined();
    }
  });
});
