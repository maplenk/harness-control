/**
 * Role-flow SEAM (PLAN §5, §8) — the boundary between the application service
 * (this package, which owns the machinery: spawning via the adapter factory,
 * initialize/create-session, model+effort pinning §11.2, permission mediation
 * §10.2, cost accounting §17.2) and the three role FLOWS
 * (coordinator/implementor/verifier), which are built in the NEXT phase (§20
 * P3) and plug their turn logic in here.
 *
 * The service does everything provider-shaped and hands the flow a live
 * `RoleSession`: the flow only decides what to prompt and when it is done,
 * calling `RoleSession.prompt(...)`. Permission requests are surfaced to the
 * configured `PermissionMediation` (interactive callback OR headless policy)
 * INSIDE the adapter's mediation engine (the service wires it at spawn); the
 * §10.2 coordinator/verifier write-veto and default-deny apply there in every
 * mode. `usage_update`/turn usage stream automatically into the run's cost
 * projection — the flow never touches the adapter, the DB, or the transition
 * engine directly.
 */
import type { RunId } from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import type {
  CapabilityRecord,
  PermissionOutcome,
  PermissionRequest,
  PromptResult,
  SessionHandle,
  SessionUpdate,
} from '../adapters/spi.js';
import type { AppliedConfigOption, ResolvedRoleModel } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Permission mediation (§10.2, T20) — the run-level configured mediator
// ---------------------------------------------------------------------------
/**
 * How permission requests are answered: an interactive human callback, or a
 * headless allowlist of EXACT operation strings (unknown → deny; §10.2). Maps
 * onto the adapter's `PermissionMediationConfig` with the role attached (so
 * the coordinator/verifier write-veto engages) when the service spawns a role.
 */
export type PermissionMediation =
  | {
      readonly mode: 'interactive';
      readonly onRequest: (request: PermissionRequest) => Promise<PermissionOutcome>;
    }
  | {
      readonly mode: 'headless';
      /** Exact operation strings allowed; omitted/empty = deny everything. */
      readonly allow?: readonly string[];
    };

// ---------------------------------------------------------------------------
// The live session handed to a flow
// ---------------------------------------------------------------------------
export interface RolePromptInput {
  readonly prompt: string;
  /**
   * Optional streaming observer. The service wraps this: `usage_update`s are
   * folded into cost accounting first, then forwarded here; permission
   * requests are already mediated by the adapter before they reach the flow.
   */
  readonly onUpdate?: (update: SessionUpdate) => void;
}

export interface RoleSession {
  readonly runId: RunId;
  readonly role: RoleName;
  /** The resolved model/effort actually pinned for this session (§11.2). */
  readonly model: ResolvedRoleModel;
  /** Per-intent §11.2 pin outcomes (which option ids were set, echoes). */
  readonly configApplied: readonly AppliedConfigOption[];
  readonly capabilities: CapabilityRecord;
  readonly handle: SessionHandle;
  readonly workspacePath: string;
  /** Working directory for this role (workspace for read-only roles; the
   * assigned worktree for the implementor). */
  readonly cwd: string;
  /**
   * Drive one prompt turn. At most one in-flight per session (§6.2). Usage is
   * folded into the run's cost projection; a pre-turn estimated-budget refusal
   * (§17.2) throws `BudgetExceededError` before the turn starts.
   */
  prompt(input: RolePromptInput): Promise<PromptResult>;
  /**
   * F8 (C) — §12.2's `pre_verify_handoff` safe boundary, the ONE checkpoint
   * trigger a FLOW owns (the other four — cadence, pre_pause, pre_model_switch,
   * pre_graceful_stop — are the service's own turn/pause/stop machinery, and
   * this seam deliberately cannot request them).
   *
   * The flow calls this immediately after it has committed its deliverable and
   * before handing off to verification, so the §12.2 checkpoint carries the
   * COMMITTED head. Without it, the last checkpoint of every committing round
   * is a prompt-turn-boundary one recording the PRE-commit head, and a crash in
   * the commit→next-checkpoint window leaves the round's own commit looking
   * like tamper to §16.3 (the F8 (A) forward-containment acceptance is the
   * belt; this is the suspenders).
   *
   * Written through the SAME assembler + cadence-window reset as every other
   * checkpoint.
   *
   * BLOCKER-2 — FATAL on failure, unlike the cadence hook. This checkpoint is
   * the round's RECEIPT: the durable assertion "this commit is mine" that resume
   * requires before adopting a drifted worktree. A round that continued
   * unreceipted would be silently unresumable, and could only be re-adopted on
   * topology (reachability) — which is authorization by the wrong property. So
   * a failed or quota-rejected write REJECTS (`RoundReceiptError`) and the round
   * fails honestly. The commit is already durable in the worktree; only
   * automatic resume is withheld. The `written` flag is therefore always true
   * on a resolved call — it stays on the result for honest reporting.
   */
  checkpointVerifyHandoff(): Promise<{ readonly written: boolean }>;
}

// ---------------------------------------------------------------------------
// The flow strategy the engine calls
// ---------------------------------------------------------------------------
/**
 * The seam the three flows implement (next phase). `run` receives a live,
 * fully-configured `RoleSession` and returns the flow's own result type
 * (e.g. the coordinator's proposed spec, the verifier's per-criterion
 * verdicts). The service owns the surrounding lifecycle (spawn → configure →
 * `run` → dispose) and the workflow phase advances around it.
 */
/**
 * F2 (§review dogfood): the round-completion verdict an adjudicator returns.
 * `completed` = a real deliverable (or a legitimate pre-existing-satisfaction
 * no-op) → the round completes and verification may proceed. `no_deliverable` =
 * the round produced nothing it stands behind (abnormal stop, a claimed commit
 * that disagrees with host HEAD, or a remediation round with no new commit) →
 * `runRole` persists the round `no_deliverable` ATOMICALLY (never `completed`
 * first) and throws, so a restart/resume can never read it as "verify next".
 */
export type RoleRoundOutcome = 'completed' | 'no_deliverable';

interface RoleRunnerBase<TResult> {
  /**
   * Exact shell commands this flow must execute as evidence. Native Claude
   * uses these for verifier `Bash(command)` permissions; Grok maps them to
   * exact ACP operation titles for implementor self-checks. Other transports
   * may ignore the hint and keep their own permission mediation.
   */
  readonly allowedShellCommands?: readonly string[];
  run(session: RoleSession): Promise<TResult>;
}

export interface ImplementorRoleRunner<TResult = unknown> extends RoleRunnerBase<TResult> {
  readonly role: 'implementor';
  /**
   * Optional sink-safe, bounded explanation persisted with a no-deliverable
   * verdict. This keeps provider stderr/permission evidence available after
   * the isolated child home is disposed.
   */
  diagnoseRoundOutcome?(result: TResult): string | undefined;
  /**
   * F2: adjudicate the round's deliverable AT completion time. `runRole` calls
   * this with the flow's result for every implementor invocation, including a
   * dispatchless/standalone call. Dispatched rounds persist the returned stage
   * in the SAME write that would have marked the round `completed`; standalone
   * calls still reject `no_deliverable` before returning.
   */
  adjudicateRoundOutcome(result: TResult): Promise<RoleRoundOutcome> | RoleRoundOutcome;
}

export interface ReadOnlyRoleRunner<TResult = unknown> extends RoleRunnerBase<TResult> {
  readonly role: Exclude<RoleName, 'implementor'>;
  readonly adjudicateRoundOutcome?: never;
}

/** Role-discriminated contract: implementors cannot omit deliverable adjudication. */
export type RoleRunner<TResult = unknown> =
  | ImplementorRoleRunner<TResult>
  | ReadOnlyRoleRunner<TResult>;
