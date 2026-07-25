/**
 * Implementor FLOW (PLAN §8 Implementor, §16, §20 P3).
 *
 * The implementor is the ONE role that writes code. This flow plugs into the
 * role-flow seam (`../role-runner.ts`) as a `RoleRunner<ImplementorResult>`
 * and adds the worktree lifecycle around it:
 *
 *  1. **Isolation (§16 items 2-4)**: `runImplementor` acquires a dedicated
 *     branch + worktree OUTSIDE the primary checkout via the
 *     `GitWorktreeManager` (single-writer lease, per-repo mutex), then drives
 *     the role THROUGH `OrchestrationService.runRole` with the worktree path as
 *     `cwd`. The engine spawns the implementor adapter confined to that cwd; the
 *     Codex implementor role is auto-pinned to the workspace-write session mode
 *     (`agent`) by the provider factory's `CODEX_SESSION_MODE_POLICY`, so
 *     in-worktree writes proceed with zero permission traffic and out-of-worktree
 *     writes escalate into `decidePermission`'s default-deny (§10.2). H-1
 *     isolation holds unchanged: this flow never touches `CODEX_HOME` — it goes
 *     through the same `RoleAdapterFactory` the service was built with (production
 *     = `defaultRoleAdapterFactory`, which forwards no user `CODEX_HOME`).
 *
 *  2. **Context injection (§8, §15)**: `run` builds one implementor prompt that
 *     injects the approved immutable spec, the assigned task scope, the active
 *     constraints, the acceptance criteria (context ONLY — the implementor may
 *     not change them), and the coordinator's exploration artifact (injected
 *     into implementor context per §15). The Hard-Rules block encodes the two
 *     host-enforced invariants of §8: writes stay inside the worktree, and the
 *     implementor may NOT change criteria or declare the task complete.
 *
 *  3. **Report assembly (§8)**: after the turn(s) the flow gathers, ITSELF
 *     (never trusting the agent's claims), the git facts — changed files, the
 *     base→HEAD diff, the resulting commit SHA — and runs the spec's declared
 *     verification commands, capturing each command's exit status. A
 *     post-verification `git status` snapshot records any dirt those commands
 *     left AFTER the commit (W1-F4 — such content is in no commit and the §16
 *     readiness gate blocks on it). The agent's
 *     own narrative (where its stated risks live) is captured verbatim as
 *     `agentMessages`; structured extraction of risks/criteria verdicts is
 *     deliberately deferred (PLAN §12.2/§15 defer LLM parsing), so the flow
 *     never fabricates a verdict.
 *
 * The implementor CANNOT mark completion: this flow only produces a report and
 * never feeds a verification/merge transition into the engine. Advancing the
 * workflow phase (approved→implementing→verifying) and deciding merge-readiness
 * belong to the surrounding orchestrator + the verifier flow, not here.
 *
 * W3-1 — VERIFICATION-RUNNER CONFINEMENT (honest scope). The spec's declared
 * verification commands are full command lines executed through the HOST
 * shell in the worktree cwd, and an implementor that edited the scripts those
 * commands invoke therefore gets host execution. Two guards close the two
 * proven vectors:
 *
 *  1. **Minimal env allowlist** (`VERIFICATION_ENV_ALLOWLIST`, extending the
 *     §17.1 transport `CHILD_ENV_ALLOWLIST`): the default runner NEVER
 *     inherits the orchestrator's full environment — only PATH + basic
 *     toolchain vars cross, credential-shaped names are refused even as
 *     explicit per-run config additions, and a blanket inherit does not
 *     exist (`DefaultVerificationRunnerOptions`).
 *  2. **Primary-checkout mutation guard**: the flow snapshots the PRIMARY
 *     repo before the commands and re-checks after; ANY drift produces the
 *     typed `verification_runner_violation` — the round's verification fails
 *     honestly (`verificationPassed:false`); the loop binds that host result
 *     to the exact round/commit, the §16 readiness gate blocks on it, and the
 *     loop driver records the durable
 *     `verification.runner.violation` incident event. The snapshot covers
 *     HEAD, `git status --porcelain --ignored` (so a NEW gitignored file is
 *     drift, not just tracked-tree edits), a content manifest of the primary
 *     `.git/hooks` directory, and a content hash of the primary `.git/config`.
 *     The last two are the SHARED git common-dir a linked worktree reaches via
 *     `git rev-parse --git-common-dir`, so planting `.git/hooks/pre-commit`
 *     (persistent, undetected code execution on the next primary commit) or
 *     rewriting `.git/config` (e.g. `core.pager <payload>`) is now DETECTED —
 *     including from a verification command running in the worktree cwd.
 *
 * DOCUMENTED RESIDUAL (MVP-honest, patterns.ts-style): host-shell
 * verification commands are NOT fully sandboxed in the MVP. There is no
 * network confinement (egress is unrestricted) and no OS-level filesystem
 * confinement — a command can still READ anything the orchestrator user can
 * read and EXFILTRATE it over the network WITHOUT any git mutation, which the
 * checkout guard (a mutation detector) does not see. The guard is also SCOPED
 * to the enumerated dimensions above (HEAD, worktree porcelain incl. ignored,
 * `.git/hooks`, `.git/config`), NOT the whole `.git`: it deliberately covers the
 * EXECUTABLE persistence surfaces (hooks + config) but does not hash the
 * ref/object database or `.git/info/*`, so a non-code-execution primary git
 * mutation (packed/loose refs, a loose object, `.git/info/exclude` or
 * `.git/info/attributes`) can drift undetected — none is a code-execution or
 * persistence vector on its own (an `info/attributes` filter still needs a
 * `.git/config` driver, which IS hashed). The guard also cannot see
 * a repeated write to an ALREADY-dirty porcelain path, and a violation
 * detected right before a crash/pause is durable only once the loop driver
 * appended the incident event. Per-platform OS sandboxing (sandbox-exec /
 * bwrap) is the roadmap item that closes the remaining gap. Additionally, the
 * env-allowlist credential refusal keys off `SECRET_KEY_NAME_RE`, which
 * deliberately EXCLUDES bare `auth`/`key`: names like `SSH_KEY`, `DEPLOY_KEY`,
 * `AUTH`, `BEARER`, `COOKIE`, `SESSION_ID` are NOT credential-shaped to the
 * refusal, so an operator who explicitly opts one into `verification.envAllowlist`
 * would have it cross to the runner — an operator-opt-in heuristic caveat, not a
 * blanket inherit (the full `process.env` is never inherited).
 */
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import type { Clock } from '../../lib/clock.js';
import type { IdFactory } from '../../lib/id-factory.js';
import type { AcceptanceCriterion, AcpStopReason } from '../../domain/entities.js';
import { gitSha, newIdempotencyKey } from '../../domain/ids.js';
import type { AssignmentId, GitSha, RunId, SpecHash } from '../../domain/ids.js';
import { draftEvent, type DomainEvent } from '../../domain/events.js';
import {
  CHILD_ENV_ALLOWLIST,
  type PromptDiagnostics,
  type SessionUpdate,
} from '../../adapters/index.js';
import {
  addAll,
  addAllExceptNodeModules,
  commitAll,
  porcelainPaths,
  resolveSha,
  runGit,
  statusPorcelain,
  WorktreeError,
  type GitWorktreeManager,
  type ProvisioningCause,
  type WorktreeHandle,
} from '../../worktree/index.js';
import { isSecretKeyName, redactText } from '../../redaction/index.js';
import type { AppliedConfigOption, RoleModelSpec } from '../model-resolution.js';
import type { RoleRunner, RoleSession } from '../role-runner.js';
import type { OrchestrationService } from '../service.js';
import { adjudicateImplementorDeliverable } from './deliverable.js';

// ---------------------------------------------------------------------------
// Verification command runner (§8 "runs declared verification commands")
// ---------------------------------------------------------------------------
export interface VerificationCommandOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command could not be launched at all (e.g. missing shell). */
  readonly launchFailed: boolean;
}

/** Runs one declared verification command in the worktree; NEVER throws. */
export type VerificationRunner = (command: string, cwd: string) => Promise<VerificationCommandOutcome>;

/**
 * W3-1 layer 1 — the minimal env allowlist the DEFAULT runner inherits from
 * the orchestrator's environment: the §17.1 transport `CHILD_ENV_ALLOWLIST`
 * (PATH + platform basics, no credential-shaped names) plus the minimum
 * toolchain vars typical spec verification commands (`npm test`,
 * `npx vitest run`, `pytest -q`) read. Everything else — API keys, tokens,
 * provider credentials — is INVISIBLE to verification commands; per-run
 * additions must be explicit (`inheritEnvKeys`, config-driven) and are
 * refused when credential-shaped. A blanket `process.env` inherit does not
 * exist.
 */
export const VERIFICATION_ENV_ALLOWLIST: readonly string[] = [
  ...CHILD_ENV_ALLOWLIST,
  'NODE_ENV',
  'CI',
  'NO_COLOR',
];

/**
 * W3-1: a credential-shaped env key was requested for the verification
 * runner (via `inheritEnvKeys` or an explicit `env` entry). Refused LOUDLY
 * at construction — verification commands never see credentials in the MVP
 * (§17.1; the config schema rejects the same names at parse time, this is
 * the programmatic belt).
 */
export class VerificationRunnerEnvError extends Error {
  override readonly name: string = 'VerificationRunnerEnvError';
  readonly refusedKeys: readonly string[];
  constructor(refusedKeys: readonly string[]) {
    super(
      `verification runner: refusing credential-shaped env key(s) ${refusedKeys.join(', ')} — ` +
        'spec verification commands run without credentials in the MVP (§17.1/W3-1; no blanket env inherit exists)',
    );
    this.refusedKeys = refusedKeys;
  }
}

export interface DefaultVerificationRunnerOptions {
  /** Per-command wall-clock cap (default 10min). */
  readonly timeoutMs?: number;
  /** Max captured bytes per stream before the OS buffer errors (default 16MiB). */
  readonly maxBufferBytes?: number;
  /**
   * W4-7: grace between the SIGTERM and the forced SIGKILL when a timed-out
   * command's process GROUP is torn down (default 2s — mirrors the ACP
   * transport's `terminateGraceMs`, §10.2). Injected small in tests.
   */
  readonly terminateGraceMs?: number;
  /**
   * W3-1: EXTRA env keys inherited from the orchestrator's environment
   * beyond `VERIFICATION_ENV_ALLOWLIST` — the per-run explicit allowlist
   * additions (config `verification.envAllowlist`). Credential-shaped names
   * throw `VerificationRunnerEnvError`; there is deliberately NO option that
   * inherits the full `process.env`.
   */
  readonly inheritEnvKeys?: readonly string[];
  /**
   * Explicit values layered OVER the allowlisted inheritance (mirrors
   * `AcpSpawnSpec.env`). Credential-shaped keys throw
   * `VerificationRunnerEnvError`.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * W4-7: default grace between the SIGTERM and the forced SIGKILL when a
 * timed-out verification command's process group is reaped — mirrors the ACP
 * transport's `terminateGraceMs` (§10.2).
 */
const DEFAULT_VERIFICATION_TERMINATE_GRACE_MS = 2000;

/**
 * Default runner: executes the command line through the platform shell in the
 * worktree cwd (verification commands are full command lines — `npm test`,
 * `pytest -q`, `a && b` — and come from the human-APPROVED spec, §7) under
 * the W3-1 minimal env allowlist (see `VERIFICATION_ENV_ALLOWLIST`; the
 * orchestrator's environment is never inherited wholesale). A non-zero exit
 * is a normal, captured outcome (`passed:false`), never a throw; a timeout
 * is reported as exit 124, an un-launchable command as `launchFailed`.
 * Credential-shaped `inheritEnvKeys`/`env` keys are refused at construction
 * (`VerificationRunnerEnvError`).
 *
 * W4-7 — PROCESS-GROUP SUPERVISION. The command is `spawn`ed `detached:true`
 * so the shell becomes the leader of its OWN process group. `exec()`'s
 * built-in timeout only signals the immediate shell, so a verification command
 * that starts a background server/watcher would ORPHAN that descendant and let
 * it survive the reported timeout. Instead this runner arms its own timer and,
 * on expiry, drives the SAME graceful-then-forced termination ladder the ACP
 * transport uses (§10.2): SIGTERM the whole GROUP (negative pid) → `grace` →
 * SIGKILL the group. A final SIGKILL sweep of the group also runs the moment
 * the leader exits, so a detached descendant that outlives the shell is reaped
 * rather than leaked (no survivors). The env-allowlist confinement (W3-1) is
 * unchanged — the spawn env is built from `VERIFICATION_ENV_ALLOWLIST` exactly
 * as before.
 */
export function defaultVerificationRunner(
  options: DefaultVerificationRunnerOptions = {},
): VerificationRunner {
  const timeout = options.timeoutMs ?? 10 * 60 * 1000;
  const maxBuffer = options.maxBufferBytes ?? 16 * 1024 * 1024;
  const grace = options.terminateGraceMs ?? DEFAULT_VERIFICATION_TERMINATE_GRACE_MS;
  const inheritEnvKeys = options.inheritEnvKeys ?? [];
  const explicitEnv = options.env ?? {};
  const refused = [...inheritEnvKeys, ...Object.keys(explicitEnv)].filter((key) =>
    isSecretKeyName(key),
  );
  if (refused.length > 0) throw new VerificationRunnerEnvError(refused);
  return (command, cwd) =>
    new Promise<VerificationCommandOutcome>((resolve) => {
      // Built per call so the allowlisted view always reflects the CURRENT
      // orchestrator env (same construction as the transport's spawn env).
      const env: Record<string, string> = {};
      for (const key of [...VERIFICATION_ENV_ALLOWLIST, ...inheritEnvKeys]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      Object.assign(env, explicitEnv);

      const child = spawn(command, {
        cwd,
        env,
        shell: true, // full command lines (`a && b`, `npm test`) run through /bin/sh -c
        detached: true, // own process GROUP so a timeout can reap the WHOLE tree (W4-7)
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const pid = child.pid;

      /**
       * Signal the whole process GROUP (negative pid), mirroring the transport
       * `#killGroup`: a detached descendant a verification command spawned
       * shares the leader's group and dies with it. ESRCH (group already gone)
       * is swallowed — reaping is idempotent.
       */
      const killGroup = (signal: NodeJS.Signals): void => {
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch {
          /* ESRCH: group already gone */
        }
      };

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflow = false;
      let timedOut = false;
      let settled = false;
      let exitCode: number | null = null;
      let graceTimer: NodeJS.Timeout | undefined;

      const timer = setTimeout(() => {
        timedOut = true;
        // Termination ladder (§10.2): SIGTERM the group → grace → SIGKILL group.
        killGroup('SIGTERM');
        graceTimer = setTimeout(() => killGroup('SIGKILL'), grace);
        graceTimer.unref?.();
      }, timeout);
      timer.unref?.();

      const settle = (outcome: VerificationCommandOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        // Final sweep: reap any straggler still sharing the group (a detached
        // grandchild survives the leader on POSIX) so nothing is leaked.
        killGroup('SIGKILL');
        resolve(outcome);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes < maxBuffer) {
          stdout += chunk.toString('utf8');
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxBuffer) {
            overflow = true;
            killGroup('SIGKILL');
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < maxBuffer) {
          stderr += chunk.toString('utf8');
          stderrBytes += chunk.byteLength;
          if (stderrBytes > maxBuffer) {
            overflow = true;
            killGroup('SIGKILL');
          }
        }
      });

      // A failed spawn (e.g. no shell) — un-launchable, mirrors the old
      // `launchFailed` path. `close` may still follow; `settle` is idempotent.
      child.once('error', (cause: Error) => {
        settle({ exitCode: 127, stdout, stderr: stderr || String(cause), launchFailed: true });
      });

      // The leader exited: reap any straggler sharing the group NOW so the
      // inherited stdio pipes close and `close` can fire (a detached child
      // holding the pipe would otherwise stall it — and it is exactly the
      // survivor W4-7 must not leak).
      child.once('exit', (code) => {
        exitCode = code;
        killGroup('SIGKILL');
      });

      // `close` fires after all stdio EOF — every byte captured.
      child.once('close', () => {
        if (timedOut || overflow) {
          settle({ exitCode: 124, stdout, stderr, launchFailed: false });
        } else if (typeof exitCode === 'number') {
          settle({ exitCode, stdout, stderr, launchFailed: false });
        } else {
          // Killed by a signal we did not send (no numeric code) — report as a
          // termination, not a clean pass.
          settle({ exitCode: 124, stdout, stderr, launchFailed: false });
        }
      });
    });
}

// ---------------------------------------------------------------------------
// W3-1 layer 2 — primary-checkout mutation guard
// ---------------------------------------------------------------------------
/**
 * Typed record of a verification-runner confinement violation: the PRIMARY
 * checkout's git state drifted across the implementor round's host-run
 * verification commands — proof they wrote (or committed) outside the
 * worktree. Drift covers HEAD, `git status --porcelain --ignored` (so a NEW
 * gitignored file counts), the primary `.git/hooks` manifest, and the primary
 * `.git/config` — the shared common-dir a linked worktree also reaches, so
 * this closes the worktree→primary hook-planting persistence vector. The round's verification fails
 * honestly, the §16 readiness gate blocks on it, and the loop driver appends
 * the durable `verification.runner.violation` incident event.
 */
export interface VerificationRunnerViolation {
  readonly kind: 'verification_runner_violation';
  /** The PRIMARY checkout root whose state drifted. */
  readonly repoRoot: string;
  readonly headBefore: GitSha;
  /** Absent when the primary checkout became UNREADABLE after the commands. */
  readonly headAfter?: GitSha;
  /** Porcelain paths whose status changed across the commands (bounded). */
  readonly changedPaths: readonly string[];
  /** Human-readable summary (redacted — it feeds durable sinks). */
  readonly detail: string;
}

/** Cap on the recorded changed-path list of a runner violation. */
const MAX_VIOLATION_CHANGED_PATHS = 20;

export interface PrimaryCheckoutState {
  readonly head: string;
  readonly porcelain: string;
  /** Content manifest of the primary `.git/hooks` directory (name:hash lines). */
  readonly hooks: string;
  /** Content hash of the primary `.git/config`. */
  readonly config: string;
}

/**
 * Resolve the primary checkout's SHARED git common-dir. A linked worktree's
 * `git rev-parse --git-common-dir` resolves to this SAME primary `.git`, so
 * hashing THIS directory's `hooks/` + `config` closes the worktree→primary
 * persistence vector (a verification command running in the worktree cwd that
 * plants `.git/hooks/pre-commit` or rewrites `.git/config` reaches exactly here).
 * `--git-common-dir` may print a path relative to `repoRoot`; resolve it.
 */
async function resolvePrimaryCommonDir(repoRoot: string): Promise<string> {
  const raw = (await runGit(['rev-parse', '--git-common-dir'], repoRoot)).stdout.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

/** sha256 of a file's bytes; a stable sentinel when the path is unreadable/absent. */
async function hashFileBytes(filePath: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
  } catch {
    return 'absent';
  }
}

/**
 * Manifest of the `.git/hooks` directory: one sorted `name:hash` line per
 * entry (directories tagged `:dir`). A newly planted hook (e.g. `pre-commit`)
 * adds a line; a modified hook changes its hash — either way the before/after
 * comparison sees drift. Cheap: the hooks dir holds a handful of small files,
 * NOT a recursive tree walk of the repo. Missing dir → the `absent` sentinel.
 */
async function snapshotGitHooksManifest(hooksDir: string): Promise<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(hooksDir, { withFileTypes: true });
  } catch {
    return 'absent';
  }
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isDirectory()) {
      lines.push(`${entry.name}:dir`);
    } else {
      lines.push(`${entry.name}:${await hashFileBytes(path.join(hooksDir, entry.name))}`);
    }
  }
  return lines.join('\n');
}

export async function snapshotPrimaryCheckoutState(repoRoot: string): Promise<PrimaryCheckoutState> {
  const commonDir = await resolvePrimaryCommonDir(repoRoot);
  return {
    head: await resolveSha(repoRoot, 'HEAD'),
    // `--ignored` so a NEW gitignored file (invisible to plain porcelain) also
    // registers as primary drift. Git collapses whole ignored directories to a
    // single `!! dir/` entry, so this stays cheap even with node_modules ignored.
    porcelain: (await runGit(['status', '--porcelain', '--ignored'], repoRoot)).stdout,
    hooks: await snapshotGitHooksManifest(path.join(commonDir, 'hooks')),
    config: await hashFileBytes(path.join(commonDir, 'config')),
  };
}

/** Porcelain paths present in exactly one of the two snapshots (state changed). */
function porcelainChangedPaths(before: string, after: string): string[] {
  const lines = (status: string): string[] =>
    status.split('\n').filter((line) => line.trim().length > 0);
  const beforeLines = new Set(lines(before));
  const afterLines = new Set(lines(after));
  const changed: string[] = [];
  for (const line of afterLines) {
    if (!beforeLines.has(line)) changed.push(...porcelainPaths(line));
  }
  for (const line of beforeLines) {
    if (!afterLines.has(line)) changed.push(...porcelainPaths(line));
  }
  return [...new Set(changed)];
}

/**
 * Re-check the primary checkout against the pre-command snapshot. Returns the
 * typed violation on ANY drift (HEAD moved, porcelain changed, or the primary
 * became unreadable — the catastrophic drift case); `undefined` when clean.
 */
export async function detectPrimaryCheckoutDrift(
  repoRoot: string,
  before: PrimaryCheckoutState,
): Promise<VerificationRunnerViolation | undefined> {
  let after: PrimaryCheckoutState;
  try {
    after = await snapshotPrimaryCheckoutState(repoRoot);
  } catch (error) {
    return {
      kind: 'verification_runner_violation',
      repoRoot,
      headBefore: gitSha(before.head),
      changedPaths: [],
      detail: redactText(
        `the primary checkout at ${repoRoot} became unreadable after the verification commands: ${String(error)}`,
      ),
    };
  }
  if (
    after.head === before.head &&
    after.porcelain === before.porcelain &&
    after.hooks === before.hooks &&
    after.config === before.config
  ) {
    return undefined;
  }
  const changedPaths = porcelainChangedPaths(before.porcelain, after.porcelain).slice(
    0,
    MAX_VIOLATION_CHANGED_PATHS,
  );
  const parts: string[] = [];
  if (after.head !== before.head) {
    parts.push(`HEAD moved ${before.head} -> ${after.head}`);
  }
  if (after.porcelain !== before.porcelain) {
    parts.push(
      `porcelain status changed for ${changedPaths.length} path(s): ${
        changedPaths.length > 0 ? changedPaths.join(', ') : '(unlisted)'
      }`,
    );
  }
  if (after.hooks !== before.hooks) {
    parts.push('primary .git/hooks manifest changed (a git hook was planted or modified)');
  }
  if (after.config !== before.config) {
    parts.push('primary .git/config changed');
  }
  return {
    kind: 'verification_runner_violation',
    repoRoot,
    headBefore: gitSha(before.head),
    headAfter: gitSha(after.head),
    changedPaths,
    detail: redactText(`primary checkout mutated during the verification commands: ${parts.join('; ')}`),
  };
}

/**
 * F7 (spec §2.4): the post-commit dependency provisioning could not PROVE a real,
 * git-ignored `node_modules` for the committed manifests, so the round FAILS
 * CLOSED — the host self-check runner is skipped (no `tsc`/`vitest` inherited from
 * a global PATH could green it) and the loop driver halts before verifier dispatch
 * with the terminal `provisioning_failed` outcome. The detail is operator-actionable
 * (which repo, which failure) and redacted (it feeds durable sinks / stderr).
 */
export interface ProvisioningFailure {
  readonly kind: 'provisioning_failed';
  /** The primary checkout root whose worktree could not be provisioned. */
  readonly repoRoot: string;
  readonly worktreePath: string;
  /** Redacted, operator-actionable summary (ignore-rule / clone-vs-install / install failure). */
  readonly detail: string;
  /** F9: the machine-readable refusal cause, when provisioning supplied one. The
   * CLI turns it into a SPECIFIC next step — the pre-F9 generic hint sent the two
   * commonest cases (a dep-adding implementor commit, a stale primary tree) in
   * circles. Absent for the pre-F9 refusals, which keep their prose detail. */
  readonly cause?: ProvisioningCause;
  /** F7 (M9): the loop round that failed (the loop driver fills this in). */
  readonly round?: number;
  /** F7 (M9): the actual committed HEAD at the point of failure (host-read; the
   * loop driver fills this in so reporting is never stale). */
  readonly implementationCommit?: GitSha;
}

export interface RunnerViolationEventInput {
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  readonly violation: VerificationRunnerViolation;
  readonly ids: IdFactory;
  readonly clock: Clock;
}

/**
 * The durable W3-1 incident fact (`verification.runner.violation`, a plain
 * supporting event) — appended by the loop driver (orchestrate.ts) the moment
 * an implementor round reports the violation, BEFORE the verifier round runs.
 * Callers that drive `ImplementorFlow`/`runImplementor` directly own this
 * append themselves (the flow has no engine access by design).
 */
export function verificationRunnerViolationEvent(input: RunnerViolationEventInput): DomainEvent {
  const { violation } = input;
  return draftEvent({
    type: 'verification.runner.violation',
    runId: input.runId,
    payload: {
      assignmentId: input.assignmentId,
      repoRoot: violation.repoRoot,
      headBefore: violation.headBefore,
      ...(violation.headAfter !== undefined ? { headAfter: violation.headAfter } : {}),
      changedPaths: violation.changedPaths,
      detail: violation.detail,
    },
    idempotencyKey: newIdempotencyKey(input.ids),
    occurredAt: input.clock.nowIso(),
  }) as DomainEvent;
}

// ---------------------------------------------------------------------------
// Flow inputs / outputs
// ---------------------------------------------------------------------------
/**
 * The context injected into the implementor (§8, §15). Everything here is
 * read-only for the implementor — the acceptance criteria in particular are
 * shown for context and are NOT the implementor's to change.
 */
export interface ImplementorContext {
  readonly goal: string;
  /** Hash of the approved immutable SpecVersion (§6.3: approval binds it). */
  readonly specHash: SpecHash;
  /** The approved structured spec document, serialized for injection (§7). */
  readonly specDocument: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly constraints?: readonly string[];
  /** The bounded task scope assigned to this implementor (§8). */
  readonly taskScope: string;
  /**
   * The coordinator's exploration artifact, bound to its source commit and
   * injected into implementor context (§15). Untrusted index — never evidence.
   */
  readonly explorationArtifact?: string;
  /**
   * The spec's declared verification commands (§7). When omitted, the flow
   * derives them from the acceptance criteria's `verificationCommands`.
   */
  readonly verificationCommands?: readonly string[];
}

export interface ImplementorFlowOptions {
  /** Commit message for the implementor's work commit. */
  readonly commitMessage?: string;
  /** Author/committer identity for the commit (never relies on ambient config). */
  readonly commitEnv?: Readonly<Record<string, string>>;
  /**
   * Bounded continuation prompts issued after the initial task prompt (each is
   * one more turn). Default: none — a single implementation turn. Kept explicit
   * (not a "loop until done" heuristic) because the implementor may not declare
   * completion, so the caller owns any continuation cadence deterministically.
   */
  readonly followUpPrompts?: readonly string[];
  /** Max stored bytes per verification stdout/stderr preview (default 64KiB). */
  readonly maxOutputBytes?: number;
  /** Max stored bytes for the diff (default 1MiB; the commit SHA is authoritative). */
  readonly maxDiffBytes?: number;
  /** Pass-through streaming observer (updates are collected first, then forwarded). */
  readonly onUpdate?: (update: SessionUpdate) => void;
  /**
   * F7 (spec §2.1): provision `node_modules` at the post-commit boundary, invoked
   * AFTER the implementor commit and BEFORE the host self-check runner (the
   * declared verification commands). Idempotent + composite (the manager's
   * `provisionForVerification`, mutex + advisory-lease held). When it REJECTS the
   * flow FAILS CLOSED: the self-check runner is skipped and the result carries
   * `provisioningFailed` for the loop driver to halt on. Absent → legacy behavior
   * (no provisioning), so pre-F7 callers/tests are unchanged.
   */
  readonly provisionForVerification?: () => Promise<unknown>;
  /**
   * F7 (round-2 #3): whether managed dependency provisioning is ACTIVE for this
   * worktree (config `worktree.provision !== 'none'`). When active, the §8 commit
   * EXCLUDES `node_modules` (`addAllExceptNodeModules`) — a provisioned,
   * git-ignored toolchain must never enter HEAD even if the target repo's ignore
   * rule is missing. When INACTIVE (`'none'`, the operator owns node_modules), the
   * commit keeps normal `git add -A` semantics so a repo that legitimately tracks
   * node_modules changes still commits them. Defaults to `true` (exclude) —
   * matching the F7 default strategy; the loop driver / `runImplementor` pass the
   * manager's real strategy so only `'none'` opts out.
   */
  readonly provisionActive?: boolean;
}

export interface VerificationCommandResult {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** exitCode === 0 and the command actually launched. */
  readonly passed: boolean;
  readonly launchFailed: boolean;
}

export interface ImplementorToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly status?: string;
}

/** One §10.2 permission request observed while driving the implementor. */
export interface ImplementorPermissionObservation {
  readonly description: string;
  readonly toolTitle?: string;
}

export interface ImplementorResult {
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: GitSha;
  /** Files changed relative to the base commit (host-gathered, never trusted from the agent). */
  readonly changedFiles: readonly string[];
  /** base→HEAD unified diff (bounded to `maxDiffBytes`). */
  readonly diff: string;
  readonly diffTruncated: boolean;
  /** Always EMPTY: the declared commands run at the verify boundary, where the
   * evidence receipts record each execution. Kept so the round report's shape
   * is stable for consumers that still read it. */
  readonly verification: readonly VerificationCommandResult[];
  /** True iff the host preconditions THIS boundary can attest hold — i.e.
   * post-commit provisioning succeeded. Per-command truth belongs to the F13
   * receipts at the verify boundary; the §16 gate requires both. */
  readonly verificationPassed: boolean;
  /** F7 (spec §2.4): post-commit dependency provisioning failed — no host
   * command may run for this round, and the loop driver halts before verifier
   * dispatch with the terminal `provisioning_failed` outcome. Forces
   * `verificationPassed:false`. */
  readonly provisioningFailed?: ProvisioningFailure;
  /** W1-F4: the round left the worktree dirty AFTER the recorded commit — that
   * content is in NO commit, so the §16 readiness gate blocks merge on it.
   * Command-created dirt is caught by that gate instead, which probes after
   * the receipts have run. */
  readonly postVerificationDirty: boolean;
  /** Bounded dirty-path list (`git status --porcelain`) when dirty; else empty. */
  readonly postVerificationDirtyFiles: readonly string[];
  /** F8 (C): whether the §12.2 `pre_verify_handoff` checkpoint carrying the
   * COMMITTED head was actually recorded. `false` means the write was refused
   * (a §12.1 quota rejection) or failed — reported honestly rather than
   * assumed, since the round proceeds either way (the commit is already
   * durable, and F8 (A) accepts the forward drift on resume without it). */
  readonly verifyHandoffCheckpointed: boolean;
  readonly committed: boolean;
  readonly commitSha?: GitSha;
  /** Stop reason of the last driven turn. */
  readonly stopReason: AcpStopReason;
  /** Redacted/bounded transport evidence captured at an abnormal turn stop. */
  readonly promptDiagnostics?: PromptDiagnostics;
  /** §11.2 model/effort pins the engine applied to the implementor session. */
  readonly configApplied: readonly AppliedConfigOption[];
  /** The implementor agent's own narrative per turn — its stated risks/unknowns
   * live here (§8). Structured extraction is deferred; nothing is fabricated. */
  readonly agentMessages: readonly string[];
  readonly toolCalls: readonly ImplementorToolCall[];
  readonly permissionRequests: readonly ImplementorPermissionObservation[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
/** §17.1-style: never rely on the target repo's ambient git identity. */
export const IMPLEMENTOR_COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'harness-orchestration-implementor',
  GIT_AUTHOR_EMAIL: 'implementor@harness-orchestration.localhost',
  GIT_COMMITTER_NAME: 'harness-orchestration-implementor',
  GIT_COMMITTER_EMAIL: 'implementor@harness-orchestration.localhost',
};

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;
/** W1-F4: cap on the recorded post-verification dirty-path list. */
const MAX_POST_VERIFICATION_DIRTY_FILES = 20;

function boundText(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.byteLength - half).toString('utf8');
  return {
    text: `${head}\n…[truncated ${buf.byteLength - maxBytes} of ${buf.byteLength} bytes]…\n${tail}`,
    truncated: true,
  };
}

function resolveVerificationCommands(context: ImplementorContext): readonly string[] {
  if (context.verificationCommands !== undefined) return context.verificationCommands;
  const commands: string[] = [];
  for (const criterion of context.criteria) {
    for (const command of criterion.verificationCommands) {
      if (!commands.includes(command)) commands.push(command);
    }
  }
  return commands;
}

function defaultCommitMessage(handle: WorktreeHandle, context: ImplementorContext): string {
  return `harness-orchestration: implementor work for assignment ${String(handle.assignmentId)}\n\nGoal: ${context.goal}\nSpec: ${String(context.specHash)}`;
}

/**
 * Builds the implementor prompt (§8 template order: Role → Hard Rules first →
 * Workflow → Format → Completion report), injecting the approved spec, task
 * scope, constraints, criteria (context only), and the coordinator exploration
 * artifact.
 */
export function buildImplementorPrompt(context: ImplementorContext, cwd: string): string {
  const commands = resolveVerificationCommands(context);
  const criteriaBlock =
    context.criteria.length > 0
      ? context.criteria
          .map((c) => {
            const verify = c.verificationCommands.length > 0 ? c.verificationCommands.join(' && ') : '(none declared)';
            return `- [${String(c.id)}] ${c.description}\n  verification: ${verify}`;
          })
          .join('\n')
      : '(no acceptance criteria supplied)';
  const constraintsBlock =
    context.constraints !== undefined && context.constraints.length > 0
      ? context.constraints.map((c) => `- ${c}`).join('\n')
      : '(none)';
  const commandsBlock = commands.length > 0 ? commands.map((c) => `- ${c}`).join('\n') : '(none declared)';
  const explorationBlock =
    context.explorationArtifact !== undefined && context.explorationArtifact.trim().length > 0
      ? context.explorationArtifact
      : '(no exploration artifact supplied)';

  return [
    '# Role: Implementor',
    '',
    'You implement the approved, immutable specification inside your assigned git worktree. An INDEPENDENT verifier runs the verification commands afterward — you do NOT run them yourself. Your job is to make the code changes; the host commits your worktree and the verifier validates it.',
    '',
    '## Hard Rules (read first)',
    `- You may create, modify, or delete files ONLY inside your assigned worktree: ${cwd}. Never write outside it.`,
    '- Use structured repository tools (Read, Grep/Glob, Write, and Edit) for inspection and file changes. Structured Write can create missing parent directories.',
    // MERGE COHERENCE: this rule used to also grant "and the exact declared
    // verification commands below", which directly contradicts main's separate
    // rule forbidding the implementor from running verification itself (the host
    // runs those independently). A prompt that both grants and forbids the same
    // act is worse than either rule alone — the agent obeys whichever it reads
    // last. The clause is removed: shell is read-only INSPECTION only, and the
    // merged rule set carries exactly one statement about executing verification
    // commands. `buildImplementorPrompt`'s test asserts that invariant.
    '- Shell access is limited to read-only repository inspection. Do NOT use shell commands such as mkdir, cp, mv, rm, touch, network clients, executable preprocessors, or output redirection to scaffold or change files. If structured tools cannot perform a needed action, report that blocker instead of requesting broader shell access.',
    // F11: the read-only shell classifier can only reason about a command whose
    // expansion-bearing bytes are inside SINGLE quotes (where the shell performs
    // none). Telling the agent the rule up front turns a would-be permission
    // denial — which kills the turn — into a command it can simply write
    // correctly. Deliberately scoped to repository INSPECTION only: the rule
    // above already forbids using the shell to change files or self-verify, and
    // this line must not read as widening that.
    '- When inspecting the repository with the shell, single-quote pattern/regex arguments and avoid $, backslashes, backticks, and parentheses outside single quotes — such commands cannot be classified read-only and will be denied.',
    // F14: the classifier admits an absolute path that resolves inside the
    // worktree, so this is guidance, not a rule the agent can break — a relative
    // path is simply the form that cannot be got wrong (it needs no realpath
    // agreement between the path the agent typed and the root the engine holds).
    // Scoped to INSPECTION, like the quoting line above: the rule before it
    // already forbids using the shell to change files or self-verify, and this
    // must not read as widening that.
    '- When inspecting the repository with the shell, prefer relative paths from the worktree root (`ls -la .`, `head -n 5 docs/plan.md`). An absolute path is accepted only when it resolves inside your assigned worktree; any path outside it is denied.',
    '- The acceptance criteria below are FIXED and shown for context only. You MUST NOT add, remove, or change any acceptance criterion.',
    '- You MUST NOT declare the task complete, verified, or passing. An independent verifier decides that — just do the work and report honestly.',
    '- Do NOT run the verification/build/test commands yourself (e.g. `npm`, `npx`, `node`, typecheck, test) and do NOT try to locate them (no `which`/`find`/PATH probing for node or npm). The host runs them independently AFTER you finish. Such a shell request is likely to be denied, and a denied request ends your turn before your work is committed. Implement with the structured Write/Edit tools, then stop and report.',
    '- If you cannot satisfy a criterion, state it plainly as a risk in your completion report; never paper over it.',
    '',
    '## Goal',
    context.goal,
    '',
    '## Assigned task scope',
    context.taskScope,
    '',
    `## Approved specification (immutable, hash ${String(context.specHash)})`,
    context.specDocument,
    '',
    '## Acceptance criteria (context only — not yours to change)',
    criteriaBlock,
    '',
    '## Active constraints',
    constraintsBlock,
    '',
    '## Coordinator exploration notes (context — an untrusted index bound to its source commit; NOT evidence)',
    explorationBlock,
    '',
    '## Declared verification commands (the HOST runs these independently — you do NOT run them)',
    commandsBlock,
    '',
    '## Workflow',
    '1. Read the spec and the assigned task scope.',
    '2. Implement the change entirely within the worktree using the structured Write/Edit tools.',
    '3. Do NOT run the verification/build/test commands — the host runs them for you. When your implementation is complete, stop.',
    '4. Write a completion report: what you changed, notable risks/unknowns, and anything left unproven.',
    '',
    '## Completion report',
    'Return a short summary of your changes and the risks/unknowns. Do NOT claim completion or mark any criterion verified.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The RoleRunner
// ---------------------------------------------------------------------------
/**
 * `RoleRunner<ImplementorResult>` driven by the engine's `runRole` (spawn →
 * init → session → §11.2 model/effort pin → mediation §10.2 → cost §17.2 →
 * `run` → dispose). Constructed against an ALREADY-created worktree handle;
 * `runImplementor` is the entry point that creates the worktree and wires the
 * engine to this runner with the worktree path as `cwd`.
 */
export class ImplementorFlow {
  readonly role = 'implementor' as const;
  /** Exact approved commands Grok may request through ACP while self-checking. */
  readonly allowedShellCommands: readonly string[];
  readonly #handle: WorktreeHandle;
  readonly #context: ImplementorContext;
  readonly #options: ImplementorFlowOptions;

  constructor(handle: WorktreeHandle, context: ImplementorContext, options: ImplementorFlowOptions = {}) {
    this.#handle = handle;
    this.#context = context;
    this.#options = options;
    this.allowedShellCommands = resolveVerificationCommands(context);
  }

  async run(session: RoleSession): Promise<ImplementorResult> {
    const handle = this.#handle;
    const cwd = handle.worktreePath;

    // §16 item 4 confinement: the engine MUST have spawned this role at the
    // worktree cwd. If it did not, refuse — writes would escape isolation.
    if (session.role !== 'implementor') {
      throw new Error(`ImplementorFlow expects role 'implementor', got '${session.role}'`);
    }
    if (path.resolve(session.cwd) !== path.resolve(cwd)) {
      throw new Error(
        `ImplementorFlow confinement violated: session cwd ${session.cwd} != worktree ${cwd}`,
      );
    }

    // --- Drive the turn(s), collecting the agent's own output ---------------
    const agentMessages: string[] = [];
    const toolCalls = new Map<string, ImplementorToolCall>();
    const permissionRequests: ImplementorPermissionObservation[] = [];
    let turnMessage = '';

    const onUpdate = (update: SessionUpdate): void => {
      switch (update.kind) {
        case 'agent_message_chunk':
          turnMessage += update.text;
          break;
        case 'tool_call':
          toolCalls.set(update.toolCallId, {
            toolCallId: update.toolCallId,
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.status !== undefined ? { status: update.status } : {}),
          });
          break;
        case 'tool_call_update': {
          const existing = toolCalls.get(update.toolCallId) ?? { toolCallId: update.toolCallId };
          toolCalls.set(update.toolCallId, {
            ...existing,
            ...(update.status !== undefined ? { status: update.status } : {}),
          });
          break;
        }
        case 'permission_request':
          permissionRequests.push({
            description: update.request.description,
            ...(update.request.toolTitle !== undefined ? { toolTitle: update.request.toolTitle } : {}),
          });
          break;
        default:
          break;
      }
      this.#options.onUpdate?.(update);
    };

    const prompts = [
      buildImplementorPrompt(this.#context, cwd),
      ...(this.#options.followUpPrompts ?? []),
    ];
    let stopReason: AcpStopReason = 'end_turn';
    let promptDiagnostics: PromptDiagnostics | undefined;
    for (const prompt of prompts) {
      turnMessage = '';
      const result = await session.prompt({ prompt, onUpdate });
      if (turnMessage.length > 0) agentMessages.push(turnMessage);
      stopReason = result.stopReason;
      promptDiagnostics = result.diagnostics;
      // A non-`end_turn` stop (refusal / cancelled / token or request cap) ends
      // the drive early — there is no point issuing follow-ups after it.
      if (stopReason !== 'end_turn') break;
    }

    // --- §8 report: commit the work, then gather the git facts OURSELVES ----
    const baseSha = String(handle.baseSha);
    const commitEnv = this.#options.commitEnv ?? IMPLEMENTOR_COMMIT_ENV;
    const commitMessage = this.#options.commitMessage ?? defaultCommitMessage(handle, this.#context);

    // F7 (B1): while provisioning is ACTIVE, stage everything EXCEPT node_modules —
    // a provisioned (git-ignored) toolchain must never enter the commit, even if the
    // target repo's ignore rule is missing or was removed. Provisioning independently
    // fails closed on an unignored/tracked node_modules; this keeps it out of HEAD
    // regardless. Round-2 #3: under `worktree.provision='none'` (provisioning
    // inactive, the operator owns node_modules) keep normal `git add -A` semantics so
    // a repo that legitimately tracks node_modules changes still commits them.
    const provisionActive = this.#options.provisionActive ?? true;
    if (provisionActive) {
      // F10: ONE helper now owns the whole guarantee — it stages `-A`, unstages
      // every node_modules path in the index at any depth (round-4 #3's
      // already-staged case included), and FAILS CLOSED if any survives. The
      // separate pre-unstage call this used to make is folded into it.
      await addAllExceptNodeModules(cwd);
    } else {
      await addAll(cwd);
    }
    const commit = await commitAll(cwd, commitMessage, commitEnv);

    // --- F8 (C, §12.2): the `pre_verify_handoff` safe-boundary checkpoint ----
    // IMMEDIATELY after the commit, before the provisioning boundary and the
    // verify handoff, so a §12.2 checkpoint exists carrying the COMMITTED head.
    // Every checkpoint taken DURING the round is a prompt-turn-boundary one
    // (cadence/pause) recording the PRE-commit head, because the commit happens
    // after the turn loop above — so without this, a crash anywhere in the
    // commit→next-checkpoint window left the round's own commit looking like
    // tamper to §16.3 and made it permanently unresumable. It also closes the
    // flow-to-loop window in which the commit exists but the loop driver has
    // not yet recorded `lastImplementationCommit`.
    //
    // BLOCKER-2: this checkpoint is the round's RECEIPT — resume will not adopt
    // a drifted worktree without it, because ancestry alone proves reachability
    // rather than authorship. The seam therefore REJECTS on a failed or
    // quota-rejected write and the round fails honestly here, rather than
    // continuing unreceipted and becoming silently unresumable. The commit above
    // is already durable in the worktree; only auto-resume is withheld.
    const handoffCheckpoint = await session.checkpointVerifyHandoff();

    // Capture the base→HEAD delta from the now-clean committed tree, BEFORE
    // verification runs (a verification build must not pollute the recorded
    // diff). `git diff <base>` over a clean tree is exactly base→HEAD.
    const nameOnly = (await runGit(['diff', '--name-only', baseSha], cwd)).stdout;
    const changedFiles = nameOnly
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const rawDiff = (await runGit(['diff', baseSha], cwd)).stdout;
    // §17.1 REDACT BEFORE TRUNCATE: boundText's head/tail cut could otherwise
    // un-terminate a quoted secret before downstream sink redaction sees it;
    // cutting an already-redacted marker is harmless.
    const bounded = boundText(redactText(rawDiff), this.#options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES);

    // --- F7 (§2.1): provision node_modules at the post-commit boundary, BEFORE
    // any host command. Idempotent + composite (manager `provisionForVerification`,
    // mutex + advisory-lease held). A rejection FAILS CLOSED: skip the self-check
    // runner entirely (a global `tsc`/`vitest` on PATH must never green a round
    // whose local provisioning did not happen) and carry the typed failure so the
    // loop driver halts before verifier dispatch. --------------------------------
    let provisioningFailed: ProvisioningFailure | undefined;
    if (this.#options.provisionForVerification !== undefined) {
      try {
        await this.#options.provisionForVerification();
      } catch (error) {
        provisioningFailed = {
          kind: 'provisioning_failed',
          repoRoot: handle.repoRoot,
          worktreePath: cwd,
          // F9: the cause is a CLOSED vocabulary constant, never free text — it
          // needs no redaction and never carries a path or secret.
          ...(error instanceof WorktreeError && error.provisioningCause !== undefined
            ? { cause: error.provisioningCause }
            : {}),
          // ROUND 8 (LOW): prefer the operator-facing MESSAGE for a provisioning
          // refusal. `.detail` is the terse machine hint ("2 package(s) diverging"),
          // so preferring it threw away the evidence the message carries — which
          // package, installed version, lockfile version. Other WorktreeError kinds
          // keep `.detail` first, where it holds raw git stdout/stderr.
          detail: redactText(
            error instanceof WorktreeError
              ? error.kind === 'provisioning_failed'
                ? error.message
                : (error.detail ?? error.message)
              : error instanceof Error
                ? error.message
                : String(error),
          ),
        };
      }
    }

    // --- The spec's declared verification commands do NOT run here ----------
    // F13: the per-command EVIDENCE RECEIPTS are the authoritative execution
    // proof, and they run at the VERIFY boundary — after that boundary's own
    // provisioning, bound to the adjudicated implementation commit, and on the
    // paths this flow never reaches (forced verifier re-entry, verify-only
    // resume). Running the same commands here as well executed every declared
    // command TWICE per round: double wall-clock and cost, NON-IDEMPOTENT
    // commands (migrations, port binders, quota-consuming calls) run twice, and
    // the waste compounding across remediation rounds.
    //
    // The W3-1 primary-checkout confinement guard MOVED WITH THE EXECUTION —
    // it now wraps the receipts (`executeEvidenceReceiptsUnderConfinement`),
    // because a guard has to observe the commands it confines. It is NOT
    // retained here as an inert leftover.
    const verification: VerificationCommandResult[] = [];

    // W1-F4: the recorded diff must never be polluted by a verification build,
    // so this snapshot is taken after the commit and after provisioning. It no
    // longer sees command-created dirt (the commands run at the verify
    // boundary now) — what it still catches is dirt the IMPLEMENTOR's own turn
    // or the provisioning step left uncommitted. Command-created dirt is caught
    // by the §16 readiness gate, which probes after the receipts have run.
    const postStatus = await statusPorcelain(cwd);
    const postVerificationDirtyFiles = porcelainPaths(postStatus).slice(
      0,
      MAX_POST_VERIFICATION_DIRTY_FILES,
    );

    return {
      runId: session.runId,
      assignmentId: handle.assignmentId,
      worktreePath: cwd,
      branch: handle.branch,
      baseSha: handle.baseSha,
      changedFiles,
      diff: bounded.text,
      diffTruncated: bounded.truncated,
      verification,
      // F13: this boolean is now exactly what THIS boundary can attest — that
      // the host preconditions for the round are sound. Per-command truth is
      // the receipts' job at the verify boundary (`#hostReceiptIssue` requires
      // a current, zero-exit receipt per declared command on top of this), so
      // this no longer folds in command exit codes it did not observe. F7: a
      // provisioning failure never reads as passed.
      verificationPassed: provisioningFailed === undefined,
      ...(provisioningFailed !== undefined ? { provisioningFailed } : {}),
      postVerificationDirty: postStatus.trim().length > 0,
      postVerificationDirtyFiles,
      verifyHandoffCheckpointed: handoffCheckpoint.written,
      committed: commit.committed,
      ...(commit.sha !== undefined ? { commitSha: gitSha(commit.sha) } : {}),
      stopReason,
      ...(promptDiagnostics !== undefined ? { promptDiagnostics } : {}),
      configApplied: session.configApplied,
      agentMessages,
      toolCalls: [...toolCalls.values()],
      permissionRequests,
    };
  }
}

/**
 * Bounded, sink-safe abnormal-turn summary persisted with a no-deliverable
 * round. Even when the provider wrote no stderr, the stop reason and observed
 * permission/tool activity distinguish a policy cancellation from a crash.
 */
export function describeImplementorRoundDiagnostic(
  result: ImplementorResult,
): string | undefined {
  if (result.stopReason === 'end_turn') return undefined;
  const lines = [
    `stopReason=${result.stopReason}`,
    `agentMessageChars=${result.agentMessages.reduce((sum, message) => sum + message.length, 0)}`,
    `toolCalls=${result.toolCalls.length}`,
    `permissionRequests=${result.permissionRequests.length}`,
  ];
  if (result.permissionRequests.length > 0) {
    lines.push(
      `permissionTitles=${result.permissionRequests
        .map((request) => request.toolTitle ?? '<untitled>')
        .join(' | ')}`,
    );
  }
  const diagnostics = result.promptDiagnostics;
  if (diagnostics?.childExit !== undefined) {
    lines.push(
      `childExit=code:${String(diagnostics.childExit.code)},signal:${String(diagnostics.childExit.signal)}`,
    );
  }
  if (diagnostics?.stderr !== undefined) {
    const stderr = diagnostics.stderr;
    const captured =
      stderr.head === stderr.tail ? stderr.head : `${stderr.head}\n…[stderr tail]…\n${stderr.tail}`;
    lines.push(
      `providerStderrBytes=${stderr.totalBytes}${stderr.truncated ? ',truncated' : ''}`,
      `providerStderr=${captured}`,
    );
  } else {
    lines.push('providerStderr=(empty)');
  }
  return boundText(redactText(lines.join('\n')), DEFAULT_MAX_OUTPUT_BYTES).text;
}

// ---------------------------------------------------------------------------
// Entry point: worktree lifecycle around the engine-driven role
// ---------------------------------------------------------------------------
/**
 * ROUND 10 (LOW) — the ONE wording for a receipt disagreement, shared by the loop
 * driver and the standalone entry point so the same failure never reads two ways.
 */
export function describeReceiptMismatch(hostHead: GitSha, receipt: GitSha): string {
  return (
    `the round's worktree HEAD (${String(hostHead)}) does not match the pre_verify_handoff receipt it published ` +
    `(${String(receipt)}). A declared VERIFICATION COMMAND that creates a commit causes this — verification ` +
    'commands must observe, never author. Fix the spec so no verification command commits, then re-run.'
  );
}

export interface ImplementorFlowDeps {
  readonly service: OrchestrationService;
  readonly worktrees: GitWorktreeManager;
}

export interface RunImplementorInput {
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  /** The implementor's resolved harness/model/effort (§7 spec proposal → run default). */
  readonly implementor: RoleModelSpec;
  readonly context: ImplementorContext;
  /** F5: the run's exact, immutable start-time base commit. */
  readonly baseCommit: GitSha;
  readonly options?: ImplementorFlowOptions;
}

/**
 * §16 items 1-5: create a dedicated branch + worktree outside the primary
 * checkout (single-writer lease, per-repo mutex), drive the implementor role
 * confined to it via `OrchestrationService.runRole`, then release the lease.
 *
 * The worktree is deliberately NOT deleted here: the verifier inspects the
 * exact implementation commit read-only (§16 items 6-7) and merge-readiness is
 * computed against it. Final cleanup (`removeWorktree`) is the surrounding
 * orchestrator's job at merge-ready/cancel. On any error the lease is still
 * released (the worktree stays on disk for recovery/inspection); taint +
 * validation on abnormal kill paths (§16.3) are owned by the supervisor, not
 * this happy-path flow.
 */
export async function runImplementor(
  deps: ImplementorFlowDeps,
  input: RunImplementorInput,
): Promise<ImplementorResult> {
  // F5: this standalone entry point is a fresh-worktree boundary too. Check
  // the primary checkout before creating anything, audit-pin only a persisted
  // legacy run, and bind the caller's base to that durable run pin. The
  // worktree manager can prove that a supplied SHA resolves, but it cannot
  // know whether that SHA belongs to this run.
  if (typeof input.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(input.baseCommit)) {
    throw new WorktreeError(
      'invalid_base_commit',
      `runImplementor requires baseCommit to be an exact 40-character lowercase commit SHA; got ${JSON.stringify(input.baseCommit)}`,
    );
  }
  // F7 (#6): the commit's node_modules exclusion MUST match the manager's ACTUAL
  // provisioning strategy — an active-provisioning run can never commit with
  // unrestricted `git add -A` (it would stage the provisioned, git-ignored toolchain
  // into HEAD, even though this standalone path also installs the manager's default
  // provisioning callback below). Derive the flag from the manager and REJECT a
  // caller override that CONTRADICTS it (the main loop threads this correctly; this
  // public standalone path must not let an override silently re-open the hole).
  const managerProvisionActive = deps.worktrees.provisionStrategy !== 'none';
  const overrideProvisionActive = input.options?.provisionActive;
  if (overrideProvisionActive !== undefined && overrideProvisionActive !== managerProvisionActive) {
    throw new WorktreeError(
      'provisioning_failed',
      `runImplementor: provisionActive override (${overrideProvisionActive}) contradicts the manager's ` +
        `provisioning strategy '${deps.worktrees.provisionStrategy}' (active=${managerProvisionActive}); refusing — ` +
        'an active-provisioning run must exclude node_modules from the implementor commit (never unrestricted `git add -A`).',
    );
  }
  const pinnedWorkspace = await deps.service.assertOrPinLegacyCleanWorkspace(input.runId);
  if (String(input.baseCommit) !== String(pinnedWorkspace.pinnedSha)) {
    throw new WorktreeError(
      'invalid_base_commit',
      `runImplementor baseCommit ${input.baseCommit} does not match run ${input.runId} pinned base ${pinnedWorkspace.pinnedSha}`,
    );
  }
  const handle = await deps.worktrees.createWorktree({
    assignmentId: input.assignmentId,
    baseCommit: input.baseCommit,
  });
  // F7 (§2.1): provision deps at the post-commit boundary (fail closed on failure).
  // An explicit caller-supplied callback wins; otherwise default to the manager's
  // composite `provisionForVerification` for this assignment.
  const flow = new ImplementorFlow(handle, input.context, {
    ...(input.options ?? {}),
    // Round-2 #3 / #6: the commit excludes node_modules exactly when the manager's
    // provisioning is ACTIVE; `'none'` keeps normal `git add -A`. DERIVED from the
    // manager (a contradicting caller override was already rejected above), so this
    // standalone path can never commit a provisioned tree into HEAD.
    provisionActive: managerProvisionActive,
    provisionForVerification:
      input.options?.provisionForVerification ??
      (() => deps.worktrees.provisionForVerification(input.assignmentId)),
  });
  // ROUND 10 (LOW): the standalone path explains a receipt disagreement in the
  // SAME words as the loop path — it is the identical failure and deserves the
  // identical message, not the generic "no deliverable adjudicated".
  let receiptMismatch: string | undefined;
  const runner: RoleRunner<ImplementorResult> = {
    role: 'implementor',
    allowedShellCommands: flow.allowedShellCommands,
    run: (session) => flow.run(session),
    diagnoseRoundOutcome: (result) => receiptMismatch ?? describeImplementorRoundDiagnostic(result),
    adjudicateRoundOutcome: async (result) => {
      const hostHead = gitSha(await resolveSha(handle.worktreePath, 'HEAD'));
      // ROUND 8 (Blocker 1a): the standalone path binds to the receipt too.
      const receipt = deps.service.resolveRoundReceiptHead(input.runId, 1, input.assignmentId);
      if (receipt !== undefined && String(hostHead) !== String(receipt)) {
        receiptMismatch = describeReceiptMismatch(hostHead, receipt);
      }
      return adjudicateImplementorDeliverable(result, 1, hostHead, receipt);
    },
  };
  try {
    return await deps.service.runRole(input.runId, runner, input.implementor, handle.worktreePath, {
      round: 1,
      assignmentId: input.assignmentId,
      baseCommit: input.baseCommit,
      specHash: input.context.specHash,
    });
  } finally {
    deps.worktrees.releaseLease(input.assignmentId);
  }
}
