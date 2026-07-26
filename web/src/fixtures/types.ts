/**
 * Standalone string-literal unions copied (not imported) from the engine's
 * phase / suspension / operation vocabularies. web/ must stay self-contained.
 */

/** Axis 1 — Run.phase (10 values). */
export type RunPhase =
  | 'created'
  | 'specifying'
  | 'awaiting_approval'
  | 'approved'
  | 'implementing'
  | 'verifying'
  | 'needs_remediation'
  | 'merge_ready'
  | 'cancelled'
  | 'failed';

/** Axis 2 — SuspensionKind (6 values, including paused_user and resource_exhausted). */
export type SuspensionKind =
  | 'none'
  | 'paused_limit'
  | 'paused_user'
  | 'breaker_open'
  | 'interrupted'
  | 'resource_exhausted';

/** Axis 3 — OperationKind (7 values). */
export type OperationKind =
  | 'idle'
  | 'prompt_turn'
  | 'initial_config_pin'
  | 'model_switch'
  | 'checkpoint_write'
  | 'git_op'
  | 'resume_probe';

/** One of the four fleet-rail group titles, in display order. */
export type FleetGroupTitle =
  | 'Needs attention'
  | 'Active'
  | 'Paused / recovering'
  | 'Recently completed';

export interface RoleLane {
  readonly role: 'Coordinator' | 'Implementor' | 'Verifier';
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
}

/** One run as projected into the fleet rail. */
export interface FleetRun {
  readonly id: string;
  readonly goal: string;
  readonly phase: RunPhase;
  readonly suspension: SuspensionKind;
  readonly operation: OperationKind;
  /** Fleet-rail group this run belongs to. */
  readonly group: FleetGroupTitle;
  /** Derived fleet status glyph (◐ ● ‖ ▲ ✓ …). */
  readonly glyph: string;
  /** Derived fleet status label (Waiting on you / Verifying / …). */
  readonly fleetLabel: string;
  /** Role tag shown under the goal (e.g. "Verifier · Sonnet"). */
  readonly roleTag: string;
}

/** Full overview projection for the selected run. */
export interface RunOverviewData {
  readonly id: string;
  readonly goal: string;
  readonly phase: RunPhase;
  readonly phaseLabel: string;
  readonly suspension: SuspensionKind;
  readonly operation: OperationKind;
  readonly commit: string;
  readonly costMeasured: number;
  readonly costEstimated: number;
  readonly roleLanes: readonly RoleLane[];
  /** Five workflow nodes in order: Spec → Approval → Implement → Verify → Merge-ready. */
  readonly workflowNodes: readonly string[];
}
