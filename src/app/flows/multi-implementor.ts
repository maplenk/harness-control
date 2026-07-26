/**
 * B5 — THE MULTI-IMPLEMENTOR DRIVER: N implementors, one tree, one commit
 * (execution-modes spec §R2 + §3.3, the "shared-tree parallelism" row).
 *
 * The substrate for this landed with B3/B4 — execution modes, write boundaries,
 * approval-time R1, the write-scope commit gate — but nothing ran more than one
 * implementor. This module is the engine that was missing. It deliberately does
 * NOT generalize the run: a run still has ONE workspace, ONE engine assignment id,
 * ONE lease, ONE round record and ONE verification. What it fans out is the
 * IMPLEMENTOR HALF of a round.
 *
 * ## Why one commit and not N (the §R2 decision, stated once, here)
 *
 * A git checkout has one HEAD and one index. N assignments sharing a tree cannot
 * land on N branches — not as a policy choice, as a property of git. The reason
 * that is acceptable rather than a compromise is §R2's other half: **implementors
 * never run git.** The host stages and commits after the turns, so N agents
 * writing disjoint paths (R1) produce one tree state, and the host produces ONE
 * commit containing all of it.
 *
 * That commit is what the verifier is handed. There is exactly one implementation
 * commit per round, bound to the full criteria set, verified once — which is the
 * same contract every existing round already has, and is why nothing downstream of
 * the commit needed to change. N commits would have required per-assignment
 * branches, an integration merge, and a second verification stage (spec §3.4,
 * Track C) — none of which single-repo shared-tree parallelism needs.
 *
 * ## What the join is honest about
 *
 * Each sub-assignment's turn either ends `end_turn` or it does not. If ANY of them
 * did not, the round's joined stop reason is abnormal, `adjudicateImplementorDeliverable`
 * returns `no_deliverable`, and `runRole` persists that verdict ATOMICALLY and
 * throws — so the round does not advance to verification and cannot become
 * `merge_ready`. The siblings' work is still COMMITTED first, so nothing is lost
 * and an operator can inspect exactly what landed. "Two of three delivered" is
 * reported as a round that did not deliver, with per-assignment detail — never as
 * a round that succeeded.
 *
 * ## The residual, stated where the code is
 *
 * With concurrent writers in one tree the host cannot attribute a dirty path to an
 * agent. Per-assignment confinement is therefore PREVENTION (each session carries
 * its own narrower `WriteBoundary` through the ACP write rule); the commit gate is
 * DETECTION against the UNION. A path outside every declared scope refuses; an
 * agent that wrote into a SIBLING's scope on a harness this engine does not mediate
 * would be admitted by the union gate. That is a real limit of the shared-tree
 * shape, not an oversight — isolated parallelism (spec §3.4/Track C) is what buys
 * per-assignment attribution, at the cost of N worktrees and an integration stage.
 *
 * Read consistency is the other documented exposure (spec §1): B may read a file A
 * is mid-write. Writes cannot collide (R1); a reader can observe an intermediate.
 * This is the same exposure two humans have in one checkout.
 */
import type { AcpStopReason } from '../../domain/entities.js';
import type { AssignmentId, RunId } from '../../domain/ids.js';
import type { Clock } from '../../lib/clock.js';
import {
  disjointWriteBoundaries,
  type WorktreeHandle,
  type WriteBoundary,
} from '../../worktree/index.js';
import { redactText } from '../../redaction/index.js';
import type { RoleModelSpec } from '../model-resolution.js';
import type { RoleRunner, RoleSession } from '../role-runner.js';
import {
  AutoRespawnSignal,
  LimitPausedError,
  ResourceExhaustedError,
  type OrchestrationService,
} from '../service.js';
import type { AssignmentRoundState } from '../projections.js';
import {
  ImplementorFlow,
  type AssignmentRoundOutcome,
  type ImplementorContext,
  type ImplementorFlowOptions,
  type ImplementorResult,
  type ImplementorTurnOutcome,
} from './implementor.js';

/**
 * One spec-declared sub-assignment as the loop drives it. Derived from the
 * APPROVED spec's `assignments[]` — the canonical bytes the approval hash binds —
 * so the decomposition that executes is provably the decomposition that was
 * approved, not one reconstructed from a projection that could have drifted.
 */
export interface LoopAssignment {
  readonly id: string;
  /** The bounded task this implementor is given (§8). */
  readonly taskScope: string;
  /** Repo-relative paths this implementor, and only it, may write. */
  readonly writeScope: readonly string[];
  /** Per-assignment implementor profile; the run's implementor is the default. */
  readonly implementor?: RoleModelSpec;
}

export interface MultiImplementorDeps {
  readonly service: OrchestrationService;
  readonly clock: Clock;
}

export interface MultiImplementorInput {
  readonly runId: RunId;
  /** The RUN's engine assignment id — owns the workspace, lease, round, receipts. */
  readonly assignmentId: AssignmentId;
  readonly round: number;
  /** The ONE shared workspace every sub-assignment writes in. */
  readonly handle: WorktreeHandle;
  readonly assignments: readonly LoopAssignment[];
  /** The round's base implementor context; `taskScope` is replaced per assignment. */
  readonly context: ImplementorContext;
  readonly options: ImplementorFlowOptions;
  /** The run's resolved implementor spec (per-assignment overrides win). */
  readonly implementorSpec: RoleModelSpec;
}

/** Bounded diagnostic for a sub-assignment that threw rather than stopped. */
const MAX_SUB_ASSIGNMENT_DIAGNOSTIC = 4 * 1024;

/**
 * A sub-assignment's turn outcome, before the join. `turn` is present exactly
 * when the turn ran to a stop reason (normal or not); a THROW leaves it absent
 * and carries the reason in `diagnostic`.
 */
interface SubAssignmentOutcome {
  readonly assignment: LoopAssignment;
  readonly boundary: WriteBoundary;
  readonly turn?: ImplementorTurnOutcome;
  readonly stage: 'delivered' | 'no_deliverable';
  readonly stopReason?: AcpStopReason;
  readonly diagnostic?: string;
}

/**
 * The joined round. `complete` means every sub-assignment ended `end_turn`;
 * anything else is `partial` (some did) or `none` (none did) — and BOTH are
 * reported as a round that did not deliver.
 */
export interface MultiAssignmentJoin {
  readonly kind: 'complete' | 'partial' | 'none';
  readonly outcomes: readonly AssignmentRoundOutcome[];
  /** The stop reason the round reports: `end_turn` iff every assignment did. */
  readonly stopReason: AcpStopReason;
  readonly delivered: number;
  readonly total: number;
}

/**
 * The joined stop reason: `end_turn` only when EVERY assignment ended normally.
 * Otherwise the FIRST abnormal stop, in spec order, so the reported reason is one
 * that actually happened rather than a synthesized summary. A sub-assignment that
 * threw has no ACP stop reason at all — `cancelled` is the honest stand-in (the
 * turn did not run to a stop), and its diagnostic carries the real cause.
 */
function joinStopReason(outcomes: readonly SubAssignmentOutcome[]): AcpStopReason {
  for (const outcome of outcomes) {
    if (outcome.stage === 'delivered') continue;
    return outcome.stopReason ?? 'cancelled';
  }
  return 'end_turn';
}

export function joinAssignmentOutcomes(
  outcomes: readonly SubAssignmentOutcome[],
): MultiAssignmentJoin {
  const delivered = outcomes.filter((outcome) => outcome.stage === 'delivered').length;
  return {
    kind: delivered === outcomes.length ? 'complete' : delivered === 0 ? 'none' : 'partial',
    outcomes: outcomes.map((outcome) => ({
      id: outcome.assignment.id,
      writeScope: outcome.assignment.writeScope,
      stage: outcome.stage,
      ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.diagnostic !== undefined ? { diagnostic: outcome.diagnostic } : {}),
    })),
    stopReason: joinStopReason(outcomes),
    delivered,
    total: outcomes.length,
  };
}

/** Operator-facing summary of a fan-out that did not fully deliver. */
export function describeMultiAssignmentJoin(join: MultiAssignmentJoin): string | undefined {
  if (join.kind === 'complete') return undefined;
  const failed = join.outcomes.filter((outcome) => outcome.stage === 'no_deliverable');
  return [
    `multi-assignment round did not deliver: ${join.delivered}/${join.total} assignment(s) finished normally.`,
    ...failed.map(
      (outcome) =>
        `  - ${outcome.id} [${outcome.writeScope.join(', ') || '(whole root)'}]: ` +
        `${outcome.stopReason ?? 'no stop reason'}${outcome.diagnostic !== undefined ? ` — ${outcome.diagnostic}` : ''}`,
    ),
    'Work that DID land is committed and inspectable; the round is not certified because part of the ' +
      'decomposition produced nothing. The next remediation round re-drives the assignments that failed.',
  ].join('\n');
}

function boundedDiagnostic(text: string): string {
  const redacted = redactText(text);
  return redacted.length <= MAX_SUB_ASSIGNMENT_DIAGNOSTIC
    ? redacted
    : `${redacted.slice(0, MAX_SUB_ASSIGNMENT_DIAGNOSTIC)}…[truncated]`;
}

/**
 * Build the FLOW for a MULTI-assignment implementor round.
 *
 * The engine dispatches this ONE runner exactly as it dispatches a single
 * implementor: one round record, one phase advance, one adjudication, one
 * receipt. `runRole` hands it the session for the FIRST sub-assignment; the rest
 * are spawned from inside `run()` through `runRole` WITHOUT a dispatch, so they
 * get the full provider lifecycle (model pin, permission mediation with their OWN
 * write boundary, cost folding, RSS watchdog, the `maxLiveChildren` cap) while
 * touching none of the per-run round/phase state that only the round owns.
 *
 * That asymmetry is deliberate. Concurrent DISPATCHED rounds would fight over a
 * single `RoleRoundProjection` and a single phase, and the last writer would
 * define the round — the failure mode this design refuses to build.
 */
export function multiImplementorFlow(deps: MultiImplementorDeps, input: MultiImplementorInput) {
  const { service } = deps;
  const { handle, assignments } = input;
  if (assignments.length === 0) {
    throw new Error('multiImplementorFlow requires at least one assignment');
  }
  // §14 `maxLiveChildren` is a REAL, cross-process cap on live children, and it
  // ships sized for serial runs (3). A decomposition with MORE assignments than
  // the cap can never have them all live, so the Nth spawn would be refused
  // mid-fan-out and reported as that assignment failing — a confusing verdict for
  // what is really a configuration mismatch. Refused UP FRONT instead, with the
  // knob named.
  //
  // Deliberately only the case that PROVABLY cannot fit. The cap is global and
  // counts other processes' children too, so "will these N fit right now" is not
  // a question this can answer — and answering it by guessing would refuse
  // decompositions that are perfectly legal (rule 3). An unpinned config skips
  // the check for the same reason: "I could not read the cap" is not "it is too
  // small".
  const cap = service.getRunConfig(input.runId)?.maxLiveChildren;
  if (cap !== undefined && assignments.length > cap) {
    throw new Error(
      `this run's decomposition declares ${assignments.length} concurrent implementors but the run is pinned to ` +
        `maxLiveChildren=${cap}, so they can never all be live. Raise \`maxLiveChildren\` to at least ` +
        `${assignments.length} in the engine config used at \`start\` (config is immutable per run), or have the ` +
        'coordinator split the work into fewer assignments.',
    );
  }
  // R1 for the fan-out, at its ONLY producer. Overlapping scopes never get as far
  // as a session: this throws before any spawn, so no agent is ever confined to a
  // boundary that another agent also owns.
  const boundaries = disjointWriteBoundaries(
    handle.executionMode,
    handle.worktreePath,
    assignments.map((assignment) => ({ id: assignment.id, declaredScope: assignment.writeScope })),
  );

  /** The per-assignment flow: same context, its own task scope and boundary. */
  const flowFor = (index: number): ImplementorFlow => {
    const assignment = assignments[index] as LoopAssignment;
    const boundary = boundaries.perAssignment[index] as WriteBoundary;
    return new ImplementorFlow(
      { ...handle, writeBoundary: boundary },
      { ...input.context, taskScope: assignment.taskScope },
      input.options,
    );
  };

  const record = (outcome: SubAssignmentOutcome): void => {
    const state: AssignmentRoundState = {
      id: outcome.assignment.id,
      round: input.round,
      stage: outcome.stage,
      writeScope: outcome.assignment.writeScope,
      ...(outcome.stopReason !== undefined ? { stopReason: outcome.stopReason } : {}),
      ...(outcome.diagnostic !== undefined ? { diagnostic: outcome.diagnostic } : {}),
      at: deps.clock.nowIso(),
    };
    // Durable the moment THIS assignment settles — never at the join. A crash in
    // the gap between two assignments must not cost the one that finished.
    service.saveAssignmentRound(input.runId, state);
  };

  /**
   * Already-settled sub-assignments from a PREVIOUS attempt at this same round.
   * Only a `delivered` record for THIS round skips a re-drive: a `no_deliverable`
   * record is precisely the assignment that must run again, and a record from
   * another round says nothing about this one.
   */
  const alreadyDelivered = (assignment: LoopAssignment): boolean => {
    const persisted = service.getAssignmentRound(input.runId, assignment.id);
    return persisted !== undefined && persisted.round === input.round && persisted.stage === 'delivered';
  };

  /**
   * WHICH assignment holds the dispatched session — the FIRST one that still
   * needs driving.
   *
   * This has to be decided HERE, at construction, not inside `run()`: `runRole`
   * spawns the lead's provider BEFORE it calls `run`, so a lead chosen after the
   * spawn could only skip the prompt, not the child. On a resumed round the
   * already-delivered assignments must cost nothing at all, and a spawned-then-
   * idle provider is not nothing.
   *
   * When EVERY assignment is already delivered the lead is index 0 anyway: the
   * round still needs one session, because the host commit publishes the round's
   * `pre_verify_handoff` receipt through it, and a round with no receipt is a
   * round that cannot be resumed.
   */
  const leadIndex = Math.max(
    0,
    assignments.findIndex((assignment) => !alreadyDelivered(assignment)),
  );

  const outcomes: SubAssignmentOutcome[] = new Array<SubAssignmentOutcome>(assignments.length);

  /** Drive the LEAD sub-assignment on the ALREADY-OPEN dispatched session. */
  const driveLead = async (session: RoleSession): Promise<ImplementorTurnOutcome | undefined> => {
    const assignment = assignments[leadIndex] as LoopAssignment;
    const boundary = boundaries.perAssignment[leadIndex] as WriteBoundary;
    if (alreadyDelivered(assignment)) {
      // Reachable only when every assignment is already delivered (see above):
      // its writes are in the tree from the interrupted attempt, and re-prompting
      // would pay for the turn twice and let a second turn contradict the first.
      outcomes[leadIndex] = { assignment, boundary, stage: 'delivered', stopReason: 'end_turn' };
      return undefined;
    }
    try {
      const turn = await flowFor(leadIndex).runTurn(session);
      const outcome: SubAssignmentOutcome = {
        assignment,
        boundary,
        turn,
        stage: turn.stopReason === 'end_turn' ? 'delivered' : 'no_deliverable',
        stopReason: turn.stopReason,
      };
      outcomes[leadIndex] = outcome;
      record(outcome);
      return turn;
    } catch (error) {
      // The LEAD's failure is the ROUND's failure: it holds the dispatched round,
      // so `runRole`'s crash/limit spine must see it verbatim (T13, auto-respawn,
      // failover). Recording first keeps the fact durable either way.
      const outcome: SubAssignmentOutcome = {
        assignment,
        boundary,
        stage: 'no_deliverable',
        diagnostic: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
      };
      outcomes[leadIndex] = outcome;
      record(outcome);
      throw error;
    }
  };

  /**
   * A sibling error the RUN must act on, not an assignment that failed.
   *
   * `LimitPausedError` / `AutoRespawnSignal` / `ResourceExhaustedError` are
   * control flow: by the time they surface the engine has ALREADY recorded a
   * durable suspension for the whole run (T4 / T13 / the RSS ceiling). Recording
   * one as "this assignment produced nothing" and carrying on would commit and
   * adjudicate a round whose run is durably paused — the fan-out quietly
   * overruling the pause spine. They are re-raised after the join instead, so the
   * lead's `runRole` and the loop's own failover/respawn handlers see them
   * exactly as they would from a single implementor.
   */
  const isRunControlSignal = (error: unknown): boolean =>
    error instanceof LimitPausedError ||
    error instanceof AutoRespawnSignal ||
    error instanceof ResourceExhaustedError;

  /** Set by a sibling whose failure belongs to the RUN; re-raised after the join. */
  let siblingControlSignal: { readonly error: unknown } | undefined;

  /** Drive one SIBLING sub-assignment in its own, UNDISPATCHED provider session. */
  const driveSibling = async (index: number): Promise<void> => {
    const assignment = assignments[index] as LoopAssignment;
    const boundary = boundaries.perAssignment[index] as WriteBoundary;
    if (alreadyDelivered(assignment)) {
      outcomes[index] = { assignment, boundary, stage: 'delivered', stopReason: 'end_turn' };
      return;
    }
    const flow = flowFor(index);
    let turn: ImplementorTurnOutcome | undefined;
    const runner: RoleRunner<ImplementorTurnOutcome> = {
      role: 'implementor',
      allowedShellCommands: flow.allowedShellCommands,
      // The session's OWN boundary — narrower than the round's union. This is the
      // per-assignment PREVENTION half; the union commit gate is the detection half.
      writeBoundary: boundary,
      run: async (session) => {
        turn = await flow.runTurn(session);
        return turn;
      },
      // A sub-assignment's turn has no commit of its own to adjudicate (§R2: one
      // host commit for the round), so the only deliverable question it CAN answer
      // is whether the turn ended normally. `runRole` throws `NoDeliverableError`
      // on `no_deliverable`, which the catch below turns into this assignment's
      // recorded outcome — the siblings keep running.
      adjudicateRoundOutcome: (result) =>
        result.stopReason === 'end_turn' ? 'completed' : 'no_deliverable',
      diagnoseRoundOutcome: (result) =>
        result.stopReason === 'end_turn'
          ? undefined
          : `stopReason=${result.stopReason}; toolCalls=${result.toolCalls.length}; permissionRequests=${result.permissionRequests.length}`,
    };
    try {
      // NO dispatch: the round record, the phase advance and the receipt belong to
      // the ROUND (the lead's dispatch), not to any one assignment. A second
      // dispatched round here would overwrite the first.
      await service.runRole(
        input.runId,
        runner,
        assignment.implementor ?? input.implementorSpec,
        handle.worktreePath,
      );
      const outcome: SubAssignmentOutcome = {
        assignment,
        boundary,
        ...(turn !== undefined ? { turn } : {}),
        stage: 'delivered',
        stopReason: turn?.stopReason ?? 'end_turn',
      };
      outcomes[index] = outcome;
      record(outcome);
    } catch (error) {
      // FAILURE ISOLATION (spec §3.3): a sibling that fails fails ITSELF. The
      // others keep running and the join reports the partial honestly. The
      // outcome is recorded FIRST either way, so a run-level signal below still
      // leaves this assignment's verdict durable.
      const outcome: SubAssignmentOutcome = {
        assignment,
        boundary,
        ...(turn !== undefined ? { turn } : {}),
        stage: 'no_deliverable',
        ...(turn?.stopReason !== undefined ? { stopReason: turn.stopReason } : {}),
        diagnostic: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
      };
      outcomes[index] = outcome;
      record(outcome);
      // …but a pause/respawn/exhaustion is the RUN's, not this assignment's.
      if (siblingControlSignal === undefined && isRunControlSignal(error)) {
        siblingControlSignal = { error };
      }
    }
  };

  let join: MultiAssignmentJoin | undefined;

  return {
    role: 'implementor' as const,
    // Identical for every assignment — they come from the ONE immutable spec.
    allowedShellCommands: flowFor(leadIndex).allowedShellCommands,
    /** The LEAD session's boundary; each sibling session carries its own. */
    writeBoundary: boundaries.perAssignment[leadIndex] as WriteBoundary,
    /** The union the ONE host commit is gated against — exposed for tests. */
    commitBoundary: boundaries.union,
    /** The join, once `run` has produced one. */
    join: (): MultiAssignmentJoin | undefined => join,
    /** Operator-facing explanation of a fan-out that did not fully deliver. */
    joinDiagnostic: (): string | undefined =>
      join !== undefined ? describeMultiAssignmentJoin(join) : undefined,

    async run(session: RoleSession): Promise<ImplementorResult> {
      // CONCURRENT: every sibling is started BEFORE the lead is awaited, so the N
      // turns genuinely overlap against one base. `driveSibling` never rejects (it
      // records its own failure and returns), so only the lead can propagate — and
      // the lead's failure IS the round's failure, because it holds the dispatched
      // round that `runRole`'s crash/limit spine acts on.
      const siblings: Promise<void>[] = [];
      for (let index = 0; index < assignments.length; index += 1) {
        if (index !== leadIndex) siblings.push(driveSibling(index));
      }
      let leadTurn: ImplementorTurnOutcome | undefined;
      let leadFailure: unknown;
      let leadFailed = false;
      try {
        leadTurn = await driveLead(session);
      } catch (error) {
        leadFailed = true;
        leadFailure = error;
      }
      // Always join the siblings before deciding anything: their outcomes are
      // durable either way, and abandoning a live child would leak a spawn slot.
      // `driveSibling` never rejects, so this cannot short-circuit and strand a
      // still-running sibling — which `Promise.all` over throwing tasks would.
      await Promise.all(siblings);
      // The LEAD's failure outranks: it holds the dispatched round, so it is the
      // round's failure. Otherwise a sibling's run-level pause/respawn/exhaustion
      // is re-raised now, unwinding into exactly the handlers a single
      // implementor's would have.
      if (leadFailed) throw leadFailure;
      if (siblingControlSignal !== undefined) throw siblingControlSignal.error;

      join = joinAssignmentOutcomes(outcomes);
      // THE ONE HOST COMMIT (§R2). It happens even for a PARTIAL join: work that
      // landed must not be thrown away, and an operator has to be able to see what
      // a failed decomposition produced. The join's stop reason is what then makes
      // the round's verdict honest.
      return flowFor(leadIndex).commitRound(
        session,
        leadTurn ?? {
          // The lead was SKIPPED as already-delivered on a resumed round: it
          // produced no turn in this process, and inventing agent messages for it
          // would be fabrication. The commit half needs none of them.
          stopReason: 'end_turn',
          agentMessages: [],
          toolCalls: [],
          permissionRequests: [],
          configApplied: session.configApplied,
        },
        {
          commitBoundary: boundaries.union,
          assignments: join.outcomes,
          stopReason: join.stopReason,
        },
      );
    },
  };
}

/** What `multiImplementorFlow` returns — a flow, wrapped by the loop's runner. */
export type MultiImplementorFlow = ReturnType<typeof multiImplementorFlow>;
