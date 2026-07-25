/**
 * Git worktree manager (PLAN.md §16).
 *
 * §16 items 1-2: require a git repo; resolve an immutable base SHA; create
 * a dedicated branch + worktree OUTSIDE the primary checkout (default
 * sibling dir, or os-tmp per config — `./paths.ts`).
 * §16 item 3 / §16.3: single-writer lease per assignment — `createWorktree`
 * grants it, `releaseLease` gives it up WITHOUT deleting the worktree
 * (child stopped: pause/kill/crash), `reacquireLease`/`reattach` take it
 * back up for a resume/restart, refusing while the worktree is tainted and
 * unvalidated.
 * §16.2: all `git worktree add/remove` (and, per `validate()`'s own doc
 * comment, the §16.3 validation routine's git plumbing) serialized per
 * repo through `GitOpMutex` (`./mutex.ts`), which also exposes the
 * git-op-lease observability surface the supervisor's kill path consumes
 * (§14) via `currentGitOpLease`/`awaitGitOpIdle`.
 * §16.3: `markTainted` + `validate` — see `./validate.ts` for the
 * reconciliation policy; this class layers "which assignment currently
 * needs validation before its lease can be reacquired" bookkeeping on top.
 *
 * NOT owned here: deciding WHEN to call any of this (that is the
 * application service's job, built on top of PLAN §6.3's transition
 * table) — this module only makes the operations available, safe, and
 * serialized. Mirrors `src/checkpoint/writer.ts`'s documented-not-enforced
 * caller-ordering contract: e.g. `releaseLease` does not itself invoke
 * `validate` — PLAN §16.3 says validation runs BEFORE the lease releases
 * at pause/kill, which is a caller-sequencing responsibility, not
 * something this method can safely infer on its own (validation needs a
 * checkpoint reference the manager has no way to look up).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import type { AssignmentId } from '../domain/ids.js';
import { gitSha, type GitSha } from '../domain/ids.js';
import type { WorktreeState } from '../domain/entities.js';
import type { WorktreeTaint } from '../domain/state.js';
import * as git from './git.js';
import { AdvisoryGitLease, openAdvisoryGitLease } from './advisory-lease.js';
import { GitOpMutex, type AwaitIdleOutcome, type GitOpLeaseSnapshot } from './mutex.js';
import {
  DEFAULT_BASE_DIR_STRATEGY,
  branchNameFor,
  isPathInside,
  resolveBaseDir,
  worktreePathFor,
  type WorktreeBaseDirStrategy,
} from './paths.js';
import { removeStaleIndexLock, validateWorktree, type ValidateWorktreeResult } from './validate.js';
import { WorktreeError } from './errors.js';
import { resolveExecutionMode, type ExecutionMode } from '../domain/execution-mode.js';
import {
  openInPlaceCheckpoint,
  restoreCheckpointHead,
  revertToCheckpoint,
  type InPlaceCheckpoint,
  type InPlaceRevertOutcome,
} from './in-place.js';
import {
  boundariesOverlap,
  pathsOutsideBoundary,
  writeBoundary,
  writeScopeConflictError,
  type WriteBoundary,
} from './write-scope.js';
import {
  defaultProvisionRuntime,
  gcProvisionStages,
  PROVISION_COMMAND_TIMEOUT_MS,
  provisionWorktreeDeps,
  type ProvisionGit,
  type ProvisionOutcome,
  type ProvisionRuntime,
  type ProvisionStrategy,
  type ProvisionWarnSink,
} from './provision.js';

/**
 * F7: the real committed-HEAD / ignore git plumbing the provisioner uses.
 * F9 (P5): each probe is spawned with the provisioning deadline, so a wedged git
 * child is KILLED rather than merely abandoned (`provision.ts` separately bounds
 * the promise, which covers an injected seam that never settles at all).
 */
const REAL_PROVISION_GIT: ProvisionGit = {
  isPathIgnored: (worktreePath, pathspec) =>
    git.isPathIgnored(worktreePath, pathspec, PROVISION_COMMAND_TIMEOUT_MS),
  isPathTracked: (worktreePath, pathspec) =>
    git.isPathTracked(worktreePath, pathspec, PROVISION_COMMAND_TIMEOUT_MS),
  readFileAtHead: (worktreePath, relpath) =>
    git.readFileAtHead(worktreePath, relpath, PROVISION_COMMAND_TIMEOUT_MS),
};

export interface WorktreeManagerOptions {
  readonly primaryRepoRoot: string;
  readonly clock: Clock;
  /** Defaults to `DEFAULT_BASE_DIR_STRATEGY` (sibling dir — §16 item 2). */
  readonly baseDirStrategy?: WorktreeBaseDirStrategy;
  /**
   * W3-5 cross-process git-op lease (§16.2 + §14). Defaults to a real
   * `ps`-identity-backed lease whose lock dir lives under the primary repo's
   * `.git`. Injectable so tests can script a stale/dead holder deterministically
   * or shrink the acquire timeout.
   */
  readonly advisoryLease?: AdvisoryGitLease;
  /**
   * F7 dependency-provisioning strategy for `provisionForVerification`
   * (config `worktree.provision`). `auto` (default) clones the primary's
   * `node_modules` when the committed fingerprint matches and APFS is available,
   * else `npm ci`; `clone`/`install` force a lane (both fall back to install on
   * a non-clonable host); `none` disables managed provisioning.
   */
  readonly provision?: ProvisionStrategy;
  /** F7 structured warning sink for non-fatal provisioning path notes. */
  readonly provisionWarn?: ProvisionWarnSink;
  /**
   * F7 host runtime (APFS clone + `npm ci`) — injectable so tests exercise the
   * REAL clone/rename/fail-closed/git logic while faking the two genuinely
   * expensive host operations. Defaults to `defaultProvisionRuntime()`.
   */
  readonly provisionRuntime?: ProvisionRuntime;
  /** F7 read-only git plumbing — injectable; defaults to the real `git.ts`. */
  readonly provisionGit?: ProvisionGit;
  /**
   * F9 (P5): deadline for every external command / injected seam call on the
   * provisioning path (default `PROVISION_COMMAND_TIMEOUT_MS`, 10 min — the
   * verification runner's per-command cap). On expiry provisioning fails closed
   * and the mutex + advisory lease are released with the unwinding throw, rather
   * than a stalled `npm ci`/`cp` wedging the run and every peer process forever.
   * Shrunk in tests to drive a hung seam deterministically.
   */
  readonly provisionTimeoutMs?: number;
}

export interface WorktreeHandle {
  readonly assignmentId: AssignmentId;
  /** Canonicalized (`git rev-parse --show-toplevel`) primary checkout root. */
  readonly repoRoot: string;
  /**
   * The directory the agent runs in. In `worktree` mode this is the isolated
   * worktree; in `in_place` mode it IS `repoRoot` — the name is kept because
   * every downstream consumer (cwd, §16 probe, provisioning, receipts) means
   * "the tree this assignment works in", and renaming it would have touched
   * ~460 call sites to say the same thing.
   */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: GitSha;
  readonly createdAt: IsoTimestamp;
  /** False after `releaseLease`, true again after `reacquireLease`/`reattach`/`createWorktree`. */
  readonly leased: boolean;
  /**
   * B3: which execution mode produced this handle. REQUIRED, not optional — the
   * mode decides whether `removeWorktree` may delete the directory and whether
   * `discardToCommit` is a rollback or a destruction of the user's checkout, and
   * an optional field would let a future construction path silently default to
   * the destructive answer.
   */
  readonly executionMode: ExecutionMode;
  /**
   * B4: WHERE this assignment may write. REQUIRED for the same reason: this is
   * the value the permission chokepoint and the commit gate consult, so a handle
   * without one would be a session with no write boundary at all. In today's
   * single-assignment shape it is the whole `worktreePath`, which is byte-for-byte
   * the pre-B4 decision.
   */
  readonly writeBoundary: WriteBoundary;
}

export interface CreateWorktreeInput {
  readonly assignmentId: AssignmentId;
  /** Exact immutable commit selected when the run was created (§16 item 1). */
  readonly baseCommit: GitSha;
  /**
   * B4 declared write scope, repo-relative. OMITTED (the default) means the
   * whole worktree — exactly today's behaviour. Supplied, it NARROWS what the
   * implementor may write and what a revert may destroy.
   */
  readonly writeScope?: readonly string[];
}

/**
 * B3 in-place workspace creation. No `worktreePath` and no provisioning: the
 * work happens in the primary checkout itself, on an assignment branch, with the
 * start checkpoint as the revert target.
 */
export interface CreateInPlaceInput {
  readonly assignmentId: AssignmentId;
  readonly baseCommit: GitSha;
  /**
   * B4 declared write scope, repo-relative. For a SINGLE in-place assignment an
   * empty scope (the whole checkout) is the honest default — the agent is the
   * only writer. For N concurrent assignments in one checkout a scope is what
   * makes R1 enforceable, and two live overlapping scopes are REFUSED here.
   */
  readonly writeScope?: readonly string[];
  /** Durable write of the start checkpoint, before the tree is touched. */
  readonly persistCheckpoint: (checkpoint: InPlaceCheckpoint) => void;
}

export interface ReattachInput {
  readonly assignmentId: AssignmentId;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: GitSha;
  /** Taint flags carried over from persisted state (e.g. a `Checkpoint.content.worktree.taintFlags` snapshot), so a restart doesn't lose an un-cleared taint. */
  readonly taintFlags?: readonly WorktreeTaint[];
  /**
   * B3: the persisted execution mode. This is UNTRUSTED persisted JSON, not a
   * typed value — every record written before B3 has no mode at all — so it goes
   * through `resolveExecutionMode`, which gives absence its only honest meaning
   * (`worktree`, the status quo). Never widen this to `ExecutionMode`: that would
   * be a compile-time claim about bytes on disk.
   */
  readonly executionMode?: unknown;
  /** B3/B4: the persisted declared write scope (absent = the whole root). */
  readonly writeScope?: readonly string[];
  /** B3: the persisted start checkpoint, required to re-arm the in-place revert. */
  readonly inPlaceCheckpoint?: InPlaceCheckpoint;
}

export interface RemoveWorktreeOptions {
  /** Forwarded to `git worktree remove --force`; defaults to `true` (final cleanup is unconditional — validation, if desired, is a separate EARLIER step). */
  readonly force?: boolean;
}

export interface ValidateOptions {
  /**
   * F8 (A) / BLOCKER-2: the interrupted round's own RECEIPT — the exact commit
   * it published for itself at its commit boundary. A drifted HEAD is accepted
   * only if it EQUALS this sha (with ancestry as a corroborating sanity check);
   * see `validate.ts`'s decision-tree row 3b. Only the INTERRUPTED-IMPLEMENTOR
   * adoption path supplies it. Absent — every other caller, and an interrupted
   * round that published no receipt — keeps the strict any-drift-refuses policy.
   *
   * Deliberately NOT a boolean: a boolean would re-admit
   * topology-as-authorization, where any reachable commit satisfies the gate.
   */
  readonly acceptDriftToCommit?: GitSha;
}

/**
 * `GitWorktreeManager.open()` is the only constructor: it verifies
 * `primaryRepoRoot` is really a git repo (§16 item 1) and canonicalizes it
 * BEFORE the instance exists, so every already-constructed manager is
 * known-valid. Mirrors `src/persistence/database.ts`'s `openDatabase`
 * async-factory convention.
 */
export class GitWorktreeManager {
  readonly #clock: Clock;
  readonly #primaryRepoRoot: string;
  readonly #baseDir: string;
  readonly #mutex: GitOpMutex;
  readonly #advisoryLease: AdvisoryGitLease;
  readonly #handles = new Map<AssignmentId, WorktreeHandle>();
  readonly #leasedPaths = new Set<string>();
  readonly #taints = new Map<AssignmentId, Set<WorktreeTaint>>();
  /**
   * B3: the start checkpoint of every LIVE in-place assignment — the revert
   * target, kept next to the handle so `revertInPlace` cannot be called with a
   * checkpoint belonging to some other assignment.
   */
  readonly #inPlaceCheckpoints = new Map<AssignmentId, InPlaceCheckpoint>();
  // F7 dependency provisioning.
  readonly #provisionStrategy: ProvisionStrategy;
  readonly #provisionRuntime: ProvisionRuntime;
  readonly #provisionGit: ProvisionGit;
  readonly #provisionWarn?: ProvisionWarnSink;
  readonly #provisionTimeoutMs?: number;

  private constructor(
    clock: Clock,
    primaryRepoRoot: string,
    baseDirStrategy: WorktreeBaseDirStrategy,
    advisoryLease: AdvisoryGitLease,
    provision: {
      readonly strategy: ProvisionStrategy;
      readonly runtime: ProvisionRuntime;
      readonly git: ProvisionGit;
      readonly warn?: ProvisionWarnSink;
      readonly timeoutMs?: number;
    },
  ) {
    this.#clock = clock;
    this.#primaryRepoRoot = primaryRepoRoot;
    this.#baseDir = resolveBaseDir(primaryRepoRoot, baseDirStrategy);
    this.#mutex = new GitOpMutex(clock);
    this.#advisoryLease = advisoryLease;
    this.#provisionStrategy = provision.strategy;
    this.#provisionRuntime = provision.runtime;
    this.#provisionGit = provision.git;
    if (provision.warn !== undefined) this.#provisionWarn = provision.warn;
    if (provision.timeoutMs !== undefined) this.#provisionTimeoutMs = provision.timeoutMs;
  }

  static async open(options: WorktreeManagerOptions): Promise<GitWorktreeManager> {
    if (!(await git.isInsideWorkTree(options.primaryRepoRoot))) {
      throw new WorktreeError('not_a_git_repo', `Not a git repository: ${options.primaryRepoRoot}`);
    }
    const topLevel = await git.resolveTopLevel(options.primaryRepoRoot);
    // W3-5: the cross-process lock lives under the REAL `.git` dir (transparently
    // following the linked-worktree `.git`-file indirection), so every OS process
    // opening a manager on this repo contends on the same lock.
    const advisoryLease =
      options.advisoryLease ?? openAdvisoryGitLease(await git.absoluteGitDir(topLevel), options.clock);
    return new GitWorktreeManager(
      options.clock,
      topLevel,
      options.baseDirStrategy ?? DEFAULT_BASE_DIR_STRATEGY,
      advisoryLease,
      {
        strategy: options.provision ?? 'auto',
        runtime: options.provisionRuntime ?? defaultProvisionRuntime(),
        git: options.provisionGit ?? REAL_PROVISION_GIT,
        ...(options.provisionWarn !== undefined ? { warn: options.provisionWarn } : {}),
        ...(options.provisionTimeoutMs !== undefined ? { timeoutMs: options.provisionTimeoutMs } : {}),
      },
    );
  }

  get primaryRepoRoot(): string {
    return this.#primaryRepoRoot;
  }

  get baseDir(): string {
    return this.#baseDir;
  }

  /** F7 dependency-provisioning strategy this manager runs (config
   * `worktree.provision`). The loop driver reads it to decide whether the
   * implementor commit must EXCLUDE `node_modules` (active — a provisioned,
   * git-ignored toolchain must never enter HEAD) or keep normal `git add -A`
   * semantics (`'none'` — the operator owns node_modules; round-2 #3). */
  get provisionStrategy(): ProvisionStrategy {
    return this.#provisionStrategy;
  }

  // -------------------------------------------------------------------
  // §14 git-op lease observability (supervisor kill-path consumption)
  // -------------------------------------------------------------------
  /** The git op currently holding this repo's mutex, if any. Never blocks. */
  currentGitOpLease(): GitOpLeaseSnapshot | undefined {
    return this.#mutex.currentLease(this.#primaryRepoRoot);
  }

  /** §14/§16.2: "kill waits for op completion or the emergency ceiling." */
  awaitGitOpIdle(deadlineMs: number): Promise<AwaitIdleOutcome> {
    return this.#mutex.awaitIdle(this.#primaryRepoRoot, deadlineMs);
  }

  // -------------------------------------------------------------------
  // Handle / taint bookkeeping (read-only queries)
  // -------------------------------------------------------------------
  handleFor(assignmentId: AssignmentId): WorktreeHandle | undefined {
    return this.#handles.get(assignmentId);
  }

  isTainted(assignmentId: AssignmentId): boolean {
    return (this.#taints.get(assignmentId)?.size ?? 0) > 0;
  }

  taintsFor(assignmentId: AssignmentId): readonly WorktreeTaint[] {
    return [...(this.#taints.get(assignmentId) ?? [])];
  }

  /**
   * §14/§16.3: called by the supervisor's kill path (emergency kill,
   * deadline termination) to record that this worktree needs `validate()`
   * before its lease can be reacquired. Pure bookkeeping — the transition
   * engine (`src/domain/transitions.ts`) independently emits the DOMAIN
   * event (`worktree.tainted`) for the event log; this only gates THIS
   * manager's own reuse operations.
   */
  markTainted(assignmentId: AssignmentId, taint: WorktreeTaint): void {
    const set = this.#taints.get(assignmentId) ?? new Set<WorktreeTaint>();
    set.add(taint);
    this.#taints.set(assignmentId, set);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  /**
   * §16 items 1-3: resolve immutable base SHA, create branch + worktree
   * outside the primary checkout, grant the lease. Deliberately `async`
   * (even though its body could technically return the mutex's promise
   * directly): the guard clauses below throw SYNCHRONOUSLY, and wrapping
   * the whole method in `async` is what turns those into a rejected
   * promise instead of a synchronous throw at the CALL SITE — every
   * method on this class that returns `Promise<T>` must reject, never
   * throw, on ALL of its failure paths, early or late, so callers can
   * uniformly `await`/`.catch()` regardless of which path failed.
   */
  async createWorktree(input: CreateWorktreeInput): Promise<WorktreeHandle> {
    const { assignmentId } = input;
    const requestedBase = (input as Partial<CreateWorktreeInput>).baseCommit;
    if (typeof requestedBase !== 'string' || !/^[0-9a-f]{40}$/.test(requestedBase)) {
      throw new WorktreeError(
        'invalid_base_commit',
        `createWorktree requires baseCommit to be an exact 40-character lowercase commit SHA; got ${JSON.stringify(requestedBase)}`,
      );
    }
    if (this.#handles.has(assignmentId)) {
      throw new WorktreeError('already_leased', `Assignment already has a tracked worktree: ${String(assignmentId)}`);
    }
    const worktreePath = worktreePathFor(this.#baseDir, assignmentId);
    if (isPathInside(this.#primaryRepoRoot, worktreePath)) {
      throw new WorktreeError('unsafe_path', `Resolved worktree path is inside the primary checkout: ${worktreePath}`);
    }
    if (this.#leasedPaths.has(worktreePath)) {
      throw new WorktreeError('path_already_leased', `Worktree path already leased by another assignment: ${worktreePath}`);
    }
    // B4: the boundary is built BEFORE the tree exists (see `write-scope.ts` on
    // why the constructor is pure) and refused here if it collides with a live
    // one. With no declared scope this is the whole worktree — byte-for-byte the
    // pre-B4 containment root, and two worktrees are always disjoint directories.
    const boundary = writeBoundary({
      mode: 'worktree',
      executionRoot: worktreePath,
      ...(input.writeScope !== undefined ? { declaredScope: input.writeScope } : {}),
    });
    this.#assertScopeDisjoint(assignmentId, boundary);
    const branch = branchNameFor(assignmentId);

    // §16.2: in-process mutex (this manager) THEN the W3-5 cross-process
    // advisory lease (a second OS process on the same repo) — both held across
    // the `git worktree add`, which alone can corrupt `.git/worktrees` if raced.
    return this.#mutex.runExclusive(this.#primaryRepoRoot, 'worktree_add', { assignmentId, worktreePath }, () =>
      this.#advisoryLease.withLease(async () => {
        // Do not trust the GitSha brand at runtime: JavaScript, casts, and
        // deserialized input can still supply HEAD, a short id, or another
        // symbolic ref. Resolve the supplied full id and require byte-for-byte
        // equality before it is allowed to become a worktree base.
        const baseSha = await git.resolveSha(this.#primaryRepoRoot, requestedBase);
        if (baseSha !== requestedBase) {
          throw new WorktreeError(
            'invalid_base_commit',
            `baseCommit resolved to a different commit: supplied=${requestedBase} resolved=${baseSha}`,
          );
        }
        fs.mkdirSync(this.#baseDir, { recursive: true });
        await git.worktreeAdd(this.#primaryRepoRoot, worktreePath, branch, baseSha);
        const handle: WorktreeHandle = {
          assignmentId,
          repoRoot: this.#primaryRepoRoot,
          worktreePath,
          branch,
          baseSha: gitSha(baseSha),
          createdAt: this.#clock.nowIso(),
          leased: true,
          executionMode: 'worktree',
          writeBoundary: boundary,
        };
        this.#handles.set(assignmentId, handle);
        this.#leasedPaths.add(worktreePath);
        return handle;
      }),
    );
  }

  /**
   * B3 — open an `in_place` workspace: no `git worktree add`, no provisioning.
   * The implementor works in THIS checkout, on `harness/assignment/<id>`, with a
   * durable start checkpoint as the revert target (`./in-place.ts`).
   *
   * What this method owns that the free function does not:
   *  - the same §16.2 in-process mutex + W3-5 cross-process advisory lease every
   *    other tree-mutating operation holds (the branch switch mutates the SHARED
   *    checkout, so it is strictly MORE contended than `git worktree add`, not
   *    less);
   *  - the single-writer lease, keyed on the repo root — which is what stops two
   *    in-place assignments from both owning the whole checkout;
   *  - R1: refusing a scope that overlaps a LIVE assignment's scope.
   */
  async createInPlaceWorkspace(input: CreateInPlaceInput): Promise<WorktreeHandle> {
    const { assignmentId } = input;
    const requestedBase = (input as Partial<CreateInPlaceInput>).baseCommit;
    if (typeof requestedBase !== 'string' || !/^[0-9a-f]{40}$/.test(requestedBase)) {
      throw new WorktreeError(
        'invalid_base_commit',
        `createInPlaceWorkspace requires baseCommit to be an exact 40-character lowercase commit SHA; got ${JSON.stringify(requestedBase)}`,
      );
    }
    if (this.#handles.has(assignmentId)) {
      throw new WorktreeError('already_leased', `Assignment already has a tracked worktree: ${String(assignmentId)}`);
    }
    const boundary = writeBoundary({
      mode: 'in_place',
      executionRoot: this.#primaryRepoRoot,
      ...(input.writeScope !== undefined ? { declaredScope: input.writeScope } : {}),
    });
    this.#assertScopeDisjoint(assignmentId, boundary);
    // The single-writer lease is keyed on the PATH, and in-place mode's path is
    // the checkout itself. A whole-root in-place assignment therefore excludes
    // every other whole-root one by the mechanism that already exists; scoped
    // siblings pass here and are separated by `#assertScopeDisjoint` above.
    if (boundary.declared.length === 0 && this.#leasedPaths.has(this.#primaryRepoRoot)) {
      throw new WorktreeError(
        'path_already_leased',
        `the primary checkout ${this.#primaryRepoRoot} is already leased in-place by another assignment`,
      );
    }
    const branch = branchNameFor(assignmentId);

    return this.#mutex.runExclusive(this.#primaryRepoRoot, 'worktree_add', { assignmentId, worktreePath: this.#primaryRepoRoot }, () =>
      this.#advisoryLease.withLease(async () => {
        const checkpoint = await openInPlaceCheckpoint({
          assignmentId,
          rootPath: this.#primaryRepoRoot,
          baseSha: requestedBase as GitSha,
          branch,
          clock: this.#clock,
          persist: input.persistCheckpoint,
        });
        const handle: WorktreeHandle = {
          assignmentId,
          repoRoot: this.#primaryRepoRoot,
          worktreePath: this.#primaryRepoRoot,
          branch,
          baseSha: checkpoint.baseSha,
          createdAt: checkpoint.createdAt,
          leased: true,
          executionMode: 'in_place',
          writeBoundary: boundary,
        };
        this.#handles.set(assignmentId, handle);
        this.#inPlaceCheckpoints.set(assignmentId, checkpoint);
        if (boundary.declared.length === 0) this.#leasedPaths.add(this.#primaryRepoRoot);
        return handle;
      }),
    );
  }

  /** B3: the start checkpoint of a live in-place assignment (the revert target). */
  inPlaceCheckpointFor(assignmentId: AssignmentId): InPlaceCheckpoint | undefined {
    return this.#inPlaceCheckpoints.get(assignmentId);
  }

  /**
   * B3 — the guarded revert. Refuses (leaving the tree untouched) when any dirty
   * path falls outside this assignment's write scope; see `./in-place.ts` for why
   * that refusal is unconditional. Mutex-held: it rewrites the shared checkout.
   */
  async revertInPlace(assignmentId: AssignmentId): Promise<InPlaceRevertOutcome> {
    const handle = this.#requireHandle(assignmentId);
    const checkpoint = this.#inPlaceCheckpoints.get(assignmentId);
    if (handle.executionMode !== 'in_place' || checkpoint === undefined) {
      throw new WorktreeError(
        'not_found',
        `no in-place start checkpoint for assignment ${String(assignmentId)}; a revert target is never inferred`,
      );
    }
    return this.#mutex.runExclusive(
      this.#primaryRepoRoot,
      'other',
      { assignmentId, worktreePath: handle.worktreePath },
      () =>
        this.#advisoryLease.withLease(() =>
          revertToCheckpoint({ checkpoint, boundary: handle.writeBoundary }),
        ),
    );
  }

  /**
   * R1 at the SUBSTRATE, not at a call site.
   *
   * Approval-time scope checking (the coordinator spec gate) is where a human
   * sees a bad decomposition, but it is a check on a DOCUMENT. This is a check on
   * the live set of workspaces this manager has actually handed out, so a run
   * that reached here by any route — a hand-built input, a resumed record, a
   * future flow nobody has written yet — still cannot obtain two overlapping
   * write boundaries at the same time.
   */
  #assertScopeDisjoint(assignmentId: AssignmentId, boundary: WriteBoundary): void {
    for (const [otherId, other] of this.#handles) {
      if (otherId === assignmentId) continue;
      const overlap = boundariesOverlap(other.writeBoundary, boundary);
      if (overlap !== undefined) {
        throw writeScopeConflictError(String(otherId), String(assignmentId), overlap);
      }
    }
  }

  /**
   * Releases the single-writer lease (child stopped: pause/kill/crash)
   * WITHOUT deleting the worktree from disk, so a later
   * `reacquireLease`/`reattach` can resume it. Idempotent. Per §16.3,
   * callers MUST run `validate()` BEFORE calling this when the segment
   * stopped abnormally — see this module's doc comment for why that
   * ordering is not enforced structurally here.
   */
  releaseLease(assignmentId: AssignmentId): void {
    const handle = this.#requireHandle(assignmentId);
    if (!handle.leased) return;
    this.#handles.set(assignmentId, { ...handle, leased: false });
    this.#leasedPaths.delete(handle.worktreePath);
  }

  /**
   * Re-acquires the lease for an assignment already tracked in THIS
   * manager instance's memory (same-process resume/restart — T9/T12/T15).
   * Refuses while tainted-and-unvalidated (§16.3: "before any restart or
   * verification").
   */
  reacquireLease(assignmentId: AssignmentId): WorktreeHandle {
    const handle = this.#requireHandle(assignmentId);
    if (handle.leased) {
      throw new WorktreeError('already_leased', `Assignment already holds its lease: ${String(assignmentId)}`);
    }
    this.#requireNotTainted(assignmentId);
    if (this.#leasedPaths.has(handle.worktreePath)) {
      throw new WorktreeError('path_already_leased', `Worktree path already leased: ${handle.worktreePath}`);
    }
    const next: WorktreeHandle = { ...handle, leased: true };
    this.#handles.set(assignmentId, next);
    this.#leasedPaths.add(handle.worktreePath);
    return next;
  }

  /**
   * Re-registers a worktree handle after an ORCHESTRATOR PROCESS restart
   * (fresh in-memory state, §12.3) from persisted `Assignment` data.
   * Verifies `worktreePath` really is a registered worktree of this
   * manager's repo (`git worktree list --porcelain`) before trusting it,
   * and refuses while tainted-and-unvalidated exactly like
   * `reacquireLease`.
   */
  async reattach(input: ReattachInput): Promise<WorktreeHandle> {
    if (this.#handles.has(input.assignmentId)) {
      throw new WorktreeError('already_leased', `Assignment already tracked in this process: ${String(input.assignmentId)}`);
    }
    const resolvedPath = path.resolve(input.worktreePath);
    const known = await this.#listWorktreePaths();
    if (!known.has(resolvedPath)) {
      throw new WorktreeError(
        'not_found',
        `Path is not a registered worktree of ${this.#primaryRepoRoot}: ${resolvedPath}`,
      );
    }
    for (const taint of input.taintFlags ?? []) this.markTainted(input.assignmentId, taint);
    this.#requireNotTainted(input.assignmentId);
    if (this.#leasedPaths.has(resolvedPath)) {
      throw new WorktreeError('path_already_leased', `Worktree path already leased: ${resolvedPath}`);
    }
    // B3: `git worktree list --porcelain` lists the PRIMARY checkout first, so an
    // in-place root passes the registration check above exactly as a worktree
    // does — which is why the mode has to come from the persisted record rather
    // than being inferred from the path.
    const executionMode = resolveExecutionMode(input.executionMode);
    const boundary = writeBoundary({
      mode: executionMode,
      executionRoot: resolvedPath,
      ...(input.writeScope !== undefined ? { declaredScope: input.writeScope } : {}),
    });
    this.#assertScopeDisjoint(input.assignmentId, boundary);
    const handle: WorktreeHandle = {
      assignmentId: input.assignmentId,
      repoRoot: this.#primaryRepoRoot,
      worktreePath: resolvedPath,
      branch: input.branch,
      baseSha: input.baseSha,
      createdAt: this.#clock.nowIso(),
      leased: true,
      executionMode,
      writeBoundary: boundary,
    };
    this.#handles.set(input.assignmentId, handle);
    this.#leasedPaths.add(resolvedPath);
    if (executionMode === 'in_place' && input.inPlaceCheckpoint !== undefined) {
      this.#inPlaceCheckpoints.set(input.assignmentId, input.inPlaceCheckpoint);
    }
    return handle;
  }

  /**
   * §16.3 validation routine — mutex-protected (index.lock cleanup
   * safety, §16.2; see `validate.ts`'s doc comment). Clears any tracked
   * taint on a non-`refuse_resume` outcome; extends it with
   * `reconcile_mismatch` on `refuse_resume`. `async` for the same reason
   * as `createWorktree`: `#requireHandle` throws synchronously and must
   * surface as a rejection, not a synchronous throw at the call site.
   * `options` carries the F8 (A) forward-containment opt-in (`ValidateOptions`).
   */
  async validate(
    assignmentId: AssignmentId,
    checkpointWorktreeState?: WorktreeState,
    options: ValidateOptions = {},
  ): Promise<ValidateWorktreeResult> {
    const handle = this.#requireHandle(assignmentId);
    return this.#mutex
      .runExclusive(this.#primaryRepoRoot, 'other', { assignmentId, worktreePath: handle.worktreePath }, () =>
        validateWorktree({
          worktreePath: handle.worktreePath,
          ...(checkpointWorktreeState !== undefined ? { checkpointWorktreeState } : {}),
          wipCommitMessage: `harness-orchestration: WIP reconciliation (assignment ${String(assignmentId)}, ${this.#clock.nowIso()})`,
          // F8 (A) / BLOCKER-2: the round's published receipt — set ONLY by the
          // interrupted-implementor adoption path. Every other caller keeps the
          // strict any-drift-refuses policy (this manager never decides it for
          // them), and so does that path when no receipt exists.
          ...(options.acceptDriftToCommit !== undefined
            ? { acceptDriftToCommit: options.acceptDriftToCommit }
            : {}),
          // F7 (#1): a WIP/dirty-recovery commit here must EXCLUDE node_modules whenever
          // managed provisioning is ACTIVE — the SAME exclusion the implementor commit
          // uses — so a provisioned, git-ignored toolchain can never enter a §16.3
          // reconciliation commit even if the target repo's ignore rule was removed.
          // Derived from THIS manager's real strategy; `'none'` keeps plain `git add -A`.
          excludeNodeModulesFromWip: this.#provisionStrategy !== 'none',
        }),
      )
      .then((result) => {
        if (result.outcome === 'refuse_resume') {
          this.markTainted(assignmentId, 'reconcile_mismatch');
        } else {
          this.#taints.delete(assignmentId);
        }
        return result;
      });
  }

  /**
   * W2-5 verifier-resume reconciliation (mutex-protected): force the
   * worktree back to EXACTLY `commit`, DISCARDING tracked and untracked
   * divergence, then assert clean. A read-only verifier's evidence dirt is
   * never preserved work — the WIP-commit path (`validate()`) is the
   * IMPLEMENTOR's reconciliation; this is the verifier's. Stale `index.lock`
   * cleanup runs first (safe inside the mutex — see `validate.ts`), ignored
   * files are untouched (`git clean -fd`, no `-x`). Throws
   * `requires_validation` if the tree is somehow still not clean at `commit`
   * afterwards; on success the taint bookkeeping clears — the tree is now a
   * known-exact state, which is the whole point of §16.3 validation.
   */
  async discardToCommit(assignmentId: AssignmentId, commit: GitSha): Promise<{
    readonly lockfileCleanupPerformed: boolean;
  }> {
    const handle = this.#requireHandle(assignmentId);
    return this.#mutex.runExclusive(
      this.#primaryRepoRoot,
      'other',
      { assignmentId, worktreePath: handle.worktreePath },
      async () => {
        const lockfileCleanupPerformed = await removeStaleIndexLock(handle.worktreePath);
        // B3 — the SAME destruction guard the explicit revert applies, at the
        // same place, because this is the other route to `reset --hard` +
        // `clean -fd`. In `worktree` mode the tree is the engine's own and this
        // is a no-op (the boundary is the whole worktree, so nothing dirty can
        // be outside it — byte-for-byte today's behaviour). In `in_place` mode
        // the tree is the USER's, and discarding a path this assignment cannot
        // account for is destroying work the engine did not create. The verifier
        // resume path calls this to drop evidence dirt; evidence dirt inside the
        // scope is still dropped, an unexplained file outside it stops the run.
        if (handle.executionMode === 'in_place') {
          const dirty = await git.statusPorcelainPathsExact(handle.worktreePath);
          const unattributable = pathsOutsideBoundary(
            handle.writeBoundary,
            dirty.map((relative) => path.resolve(handle.worktreePath, relative)),
          );
          if (unattributable.length > 0) {
            throw new WorktreeError(
              'requires_validation',
              `refusing to discard to ${String(commit)} in the in-place checkout ${handle.worktreePath}: ` +
                `${unattributable.length} dirty path(s) fall outside assignment ${String(assignmentId)}'s write ` +
                'scope, so this engine cannot prove it created them. The tree is untouched; resolve them by hand.',
              { detail: unattributable.slice(0, 20).join('\n') },
            );
          }
        }
        await git.hardReset(handle.worktreePath, String(commit));
        await git.cleanUntracked(handle.worktreePath);
        const [head, status] = await Promise.all([
          git.resolveSha(handle.worktreePath, 'HEAD'),
          git.statusPorcelain(handle.worktreePath),
        ]);
        if (head !== String(commit) || status.trim().length !== 0) {
          throw new WorktreeError(
            'requires_validation',
            `discard-to-commit left the worktree at ${head} (wanted ${String(commit)}) with status ${JSON.stringify(status)}`,
          );
        }
        this.#taints.delete(assignmentId);
        return { lockfileCleanupPerformed };
      },
    );
  }

  /**
   * F7 (spec §2.2) — provision `<worktree>/node_modules` for the COMMITTED HEAD
   * at the post-commit / pre-verification boundary. A single COMPOSITE operation
   * held under BOTH the in-process mutex AND the cross-process advisory lease (the
   * exact wrappers `createWorktree`/`removeWorktree` use — codex v2 HIGH-5: one
   * lock around the whole reconcile→provision, never scattered across
   * reattach/reacquire), so a concurrent worktree op on this repo (or a second OS
   * process) can never race the tree swap.
   *
   * Returns a PROVEN outcome (a real git-ignored `node_modules` matching the
   * committed dependency fingerprint, a trivially-true no-dependency skip, or the
   * `none` opt-out) or REJECTS with `WorktreeError{kind:'provisioning_failed'}` —
   * the caller then FAILS CLOSED (no host self-check, no verifier dispatch, no
   * `merge_ready`). Idempotent: a second call for an unchanged fingerprint
   * short-circuits on the marker. Does NOT require the single-writer lease (it
   * writes only the git-ignored `node_modules`, never tracked work), so it runs
   * for the read-only verifier after the lease is released.
   *
   * `async` for the same reason as `createWorktree`: `#requireHandle` throws
   * synchronously and must surface as a rejection at the call site.
   */
  async provisionForVerification(assignmentId: AssignmentId): Promise<ProvisionOutcome> {
    const handle = this.#requireHandle(assignmentId);
    // B3: F7/F9 are structurally moot in-place. There is no clone, no
    // fingerprint, no marker and no install lane, because the tree the commands
    // will run in is the checkout the operator has been using — its
    // `node_modules` is the one they installed. This is a TRIVIALLY-TRUE skip in
    // the F7 sense (`provisioned: true` means "the precondition holds", not "we
    // did work"), and it is the mode's main practical win: the entire F7/F9/F10
    // failure class does not exist on this path. It is deliberately reported as
    // its own `strategy` so the receipt's `provisioningMarker` says in-place
    // rather than impersonating a short-circuited clone.
    if (handle.executionMode === 'in_place') {
      return {
        provisioned: true,
        strategy: 'in_place',
        fingerprint: '',
        repoRoot: this.#primaryRepoRoot,
        worktreePath: handle.worktreePath,
        detail:
          'in-place execution: dependencies are the checkout\'s own; no clone, fingerprint, marker or install lane applies',
      };
    }
    return this.#mutex.runExclusive(
      this.#primaryRepoRoot,
      'other',
      { assignmentId, worktreePath: handle.worktreePath },
      () =>
        this.#advisoryLease.withLease(() =>
          provisionWorktreeDeps({
            assignmentId: String(assignmentId),
            worktreePath: handle.worktreePath,
            primaryRepoRoot: this.#primaryRepoRoot,
            baseDir: this.#baseDir,
            strategy: this.#provisionStrategy,
            runtime: this.#provisionRuntime,
            git: this.#provisionGit,
            ...(this.#provisionWarn !== undefined ? { warn: this.#provisionWarn } : {}),
            ...(this.#provisionTimeoutMs !== undefined ? { commandTimeoutMs: this.#provisionTimeoutMs } : {}),
          }),
        ),
    );
  }

  /**
   * Physically deletes the worktree + branch checkout (final cleanup —
   * post-merge-ready or run-cancelled). Bookkeeping is cleared ONLY on
   * success (including the idempotent "already gone on disk" case) — a
   * genuine removal failure with the directory still present leaves the
   * handle/lease exactly as they were, so this manager never silently
   * "forgets" a worktree that in fact still exists. `async` for the same
   * reason as `createWorktree`: `#requireHandle` throws synchronously and
   * must surface as a rejection, not a synchronous throw at the call site.
   */
  async removeWorktree(assignmentId: AssignmentId, options: RemoveWorktreeOptions = {}): Promise<void> {
    const handle = this.#requireHandle(assignmentId);
    // B3: there is no worktree to remove in-place — `worktreePath` IS the user's
    // checkout, and `git worktree remove --force` on it would be the single most
    // destructive thing this engine could do. The guard reads the HANDLE's mode
    // rather than comparing paths, because a mode is a fact the handle carries
    // while a path comparison is an inference a future refactor can break.
    // `releaseInPlaceWorkspace` is the in-place counterpart.
    if (handle.executionMode === 'in_place') {
      throw new WorktreeError(
        'unsafe_path',
        `assignment ${String(assignmentId)} runs in_place in ${handle.worktreePath} — the primary checkout. ` +
          'There is no worktree to remove; use releaseInPlaceWorkspace (which restores the pre-run HEAD and ' +
          'leaves the assignment branch for a human to merge).',
      );
    }
    return this.#mutex.runExclusive(
      this.#primaryRepoRoot,
      'worktree_remove',
      { assignmentId, worktreePath: handle.worktreePath },
      () =>
        // §16.2 + W3-5: cross-process advisory lease around `git worktree
        // remove/prune` (same `.git/worktrees` corruption hazard as add).
        this.#advisoryLease.withLease(async () => {
          if (fs.existsSync(handle.worktreePath)) {
            await git.worktreeRemove(this.#primaryRepoRoot, handle.worktreePath, options.force ?? true);
          }
          await git.worktreePrune(this.#primaryRepoRoot).catch(() => undefined);
          // F7 (§2.5): GC this assignment's out-of-worktree provisioning stages.
          // Only this manager's own `<baseDir>/.provision/<slug>/` — never the
          // primary checkout's `node_modules` (a COW copy the worktree owned). The
          // worktree is being deleted, so no `old-*` restore applies here.
          gcProvisionStages(this.#baseDir, String(assignmentId), undefined, this.#provisionWarn);
          this.#handles.delete(assignmentId);
          this.#leasedPaths.delete(handle.worktreePath);
          this.#taints.delete(assignmentId);
        }),
    );
  }

  /**
   * B3 — the in-place counterpart of `removeWorktree`: put the operator back on
   * the branch they were on and stop tracking the assignment. The assignment
   * BRANCH and its commits survive, exactly as a worktree's branch does, because
   * the human merges the result and the engine never does (§16).
   *
   * Restoration is best-effort by design: git refuses to switch branches away
   * from a dirty tree, and that refusal is CORRECT — the dirt is either the
   * verifier's evidence or a human's edit, and neither is this method's to
   * discard. A failed restore is reported (`restored: false`) rather than
   * escalated into a destructive cleanup.
   */
  async releaseInPlaceWorkspace(
    assignmentId: AssignmentId,
  ): Promise<{ readonly restored: boolean; readonly headRef?: string; readonly detail?: string }> {
    const handle = this.#requireHandle(assignmentId);
    const checkpoint = this.#inPlaceCheckpoints.get(assignmentId);
    if (handle.executionMode !== 'in_place' || checkpoint === undefined) {
      throw new WorktreeError(
        'not_found',
        `assignment ${String(assignmentId)} has no in-place start checkpoint to release`,
      );
    }
    return this.#mutex.runExclusive(
      this.#primaryRepoRoot,
      'other',
      { assignmentId, worktreePath: handle.worktreePath },
      () =>
        this.#advisoryLease.withLease(async () => {
          let restored = true;
          let detail: string | undefined;
          try {
            await restoreCheckpointHead(checkpoint);
          } catch (error) {
            restored = false;
            detail = error instanceof Error ? error.message : String(error);
          }
          this.#handles.delete(assignmentId);
          this.#inPlaceCheckpoints.delete(assignmentId);
          this.#leasedPaths.delete(handle.worktreePath);
          this.#taints.delete(assignmentId);
          return {
            restored,
            headRef: checkpoint.headRef,
            ...(detail !== undefined ? { detail } : {}),
          };
        }),
    );
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------
  #requireHandle(assignmentId: AssignmentId): WorktreeHandle {
    const handle = this.#handles.get(assignmentId);
    if (!handle) {
      throw new WorktreeError('not_found', `No tracked worktree for assignment: ${String(assignmentId)}`);
    }
    return handle;
  }

  #requireNotTainted(assignmentId: AssignmentId): void {
    if (this.isTainted(assignmentId)) {
      throw new WorktreeError(
        'requires_validation',
        `Worktree for assignment ${String(assignmentId)} is tainted (${this.taintsFor(assignmentId).join(', ')}); run validate() before reacquiring its lease.`,
      );
    }
  }

  async #listWorktreePaths(): Promise<Set<string>> {
    const raw = await git.worktreeListPorcelain(this.#primaryRepoRoot);
    const paths = new Set<string>();
    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) paths.add(path.resolve(line.slice('worktree '.length).trim()));
    }
    return paths;
  }
}
