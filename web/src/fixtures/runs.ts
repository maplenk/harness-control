import type {
  FleetGroupTitle,
  FleetRun,
  RunOverviewData,
} from './types';

/**
 * Canonical runs A–E from docs/UI-DESIGN-BRIEF.md §23.
 * Run A goal drops the brief's backticks around --verbose so verification
 * commands stay free of shell-hostile characters.
 */
export const FIXTURE_RUNS: readonly FleetRun[] = [
  {
    id: 'run-a',
    goal: 'Add a --verbose flag to the CLI',
    phase: 'verifying',
    suspension: 'none',
    operation: 'prompt_turn',
    group: 'Needs attention',
    glyph: '◐',
    fleetLabel: 'Waiting on you',
    roleTag: 'Verifier · Sonnet',
  },
  {
    id: 'run-b',
    goal: 'Fix retry behavior in the job queue',
    phase: 'awaiting_approval',
    suspension: 'none',
    operation: 'idle',
    group: 'Needs attention',
    glyph: '◐',
    fleetLabel: 'Waiting on you',
    roleTag: 'Coordinator',
  },
  {
    id: 'run-c',
    goal: 'Refactor import boundaries',
    phase: 'implementing',
    suspension: 'paused_limit',
    operation: 'idle',
    group: 'Paused / recovering',
    glyph: '‖',
    fleetLabel: 'Paused—limit',
    roleTag: 'Implementor · Codex',
  },
  {
    id: 'run-d',
    goal: 'Replace legacy config loader',
    phase: 'implementing',
    suspension: 'breaker_open',
    operation: 'idle',
    group: 'Needs attention',
    glyph: '▲',
    fleetLabel: 'Breaker open',
    roleTag: 'Implementor · Codex',
  },
  {
    id: 'run-e',
    goal: 'Update CLI documentation',
    phase: 'merge_ready',
    suspension: 'none',
    operation: 'idle',
    group: 'Recently completed',
    glyph: '✓',
    fleetLabel: 'Merge-ready',
    roleTag: 'Merge-ready',
  },
];

/** The four rail groups in display order. */
export const FIXTURE_GROUPS: readonly FleetGroupTitle[] = [
  'Needs attention',
  'Active',
  'Paused / recovering',
  'Recently completed',
];

/** Canonical Run A — the selected run for this fixture shell. */
export const FIXTURE_SELECTED_RUN_ID = 'run-a';

/** Overview projection for canonical Run A. */
export const FIXTURE_OVERVIEW: RunOverviewData = {
  id: 'run-a',
  goal: 'Add a --verbose flag to the CLI',
  phase: 'verifying',
  phaseLabel: 'Verifying',
  suspension: 'none',
  operation: 'prompt_turn',
  commit: 'c254435',
  costMeasured: 0.55,
  costEstimated: 0.5,
  roleLanes: [
    {
      role: 'Coordinator',
      harness: 'Claude',
      model: 'Opus',
      effort: 'low',
    },
    {
      role: 'Implementor',
      harness: 'Codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
    },
    {
      role: 'Verifier',
      harness: 'Claude',
      model: 'Sonnet',
      effort: 'medium',
    },
  ],
  workflowNodes: ['Spec', 'Approval', 'Implement', 'Verify', 'Merge-ready'],
};
