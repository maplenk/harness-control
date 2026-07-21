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
 *     honestly (`verificationPassed:false`), the §16 readiness gate blocks
 *     on it (verifier flow), and the loop driver records the durable
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
import { CHILD_ENV_ALLOWLIST, type SessionUpdate } from '../../adapters/index.js';
import {
  addAll,
  commitAll,
  porcelainPaths,
  resolveSha,
  runGit,
  statusPorcelain,
  type GitWorktreeManager,
  type WorktreeHandle,
} from '../../worktree/index.js';
import { isSecretKeyName, redactText } from '../../redaction/index.js';
import type { AppliedConfigOption, RoleModelSpec } from '../model-resolution.js';
import type { RoleRunner, RoleSession } from '../role-runner.js';
import type { OrchestrationService } from '../service.js';

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

interface PrimaryCheckoutState {
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

async function snapshotPrimaryCheckoutState(repoRoot: string): Promise<PrimaryCheckoutState> {
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
async function detectPrimaryCheckoutDrift(
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
  /** Defaults to `defaultVerificationRunner()`. Injected in tests. */
  readonly runVerification?: VerificationRunner;
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
  /** Per-command results of the spec's declared verification commands (§8). */
  readonly verification: readonly VerificationCommandResult[];
  /** True iff every declared verification command passed (vacuously true if
   * none) AND the W3-1 primary-checkout guard saw no drift. */
  readonly verificationPassed: boolean;
  /** W3-1: the primary checkout mutated across the verification commands —
   * typed proof of a confinement violation. Forces `verificationPassed:false`;
   * the loop driver records the durable incident event and the §16 readiness
   * gate blocks on it. */
  readonly runnerViolation?: VerificationRunnerViolation;
  /** W1-F4: the verification commands left the worktree dirty AFTER the
   * recorded commit — that content is in NO commit, so the §16 readiness
   * gate blocks merge on it. */
  readonly postVerificationDirty: boolean;
  /** Bounded dirty-path list (`git status --porcelain`) when dirty; else empty. */
  readonly postVerificationDirtyFiles: readonly string[];
  readonly committed: boolean;
  readonly commitSha?: GitSha;
  /** Stop reason of the last driven turn. */
  readonly stopReason: AcpStopReason;
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
    'You implement the approved, immutable specification inside your assigned git worktree, then self-check it with the declared verification commands.',
    '',
    '## Hard Rules (read first)',
    `- You may create, modify, or delete files ONLY inside your assigned worktree: ${cwd}. Never write outside it.`,
    '- The acceptance criteria below are FIXED and shown for context only. You MUST NOT add, remove, or change any acceptance criterion.',
    '- You MUST NOT declare the task complete, verified, or passing. An independent verifier decides that — just do the work and report honestly.',
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
    '## Declared verification commands (run these to self-check; the host also runs them independently)',
    commandsBlock,
    '',
    '## Workflow',
    '1. Read the spec and the assigned task scope.',
    '2. Implement the change entirely within the worktree.',
    '3. Run the declared verification commands and fix what you can within scope.',
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
export class ImplementorFlow implements RoleRunner<ImplementorResult> {
  readonly role = 'implementor' as const;
  readonly #handle: WorktreeHandle;
  readonly #context: ImplementorContext;
  readonly #options: ImplementorFlowOptions;

  constructor(handle: WorktreeHandle, context: ImplementorContext, options: ImplementorFlowOptions = {}) {
    this.#handle = handle;
    this.#context = context;
    this.#options = options;
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
    for (const prompt of prompts) {
      turnMessage = '';
      const result = await session.prompt({ prompt, onUpdate });
      if (turnMessage.length > 0) agentMessages.push(turnMessage);
      stopReason = result.stopReason;
      // A non-`end_turn` stop (refusal / cancelled / token or request cap) ends
      // the drive early — there is no point issuing follow-ups after it.
      if (stopReason !== 'end_turn') break;
    }

    // --- §8 report: commit the work, then gather the git facts OURSELVES ----
    const baseSha = String(handle.baseSha);
    const commitEnv = this.#options.commitEnv ?? IMPLEMENTOR_COMMIT_ENV;
    const commitMessage = this.#options.commitMessage ?? defaultCommitMessage(handle, this.#context);

    await addAll(cwd);
    const commit = await commitAll(cwd, commitMessage, commitEnv);

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

    // --- Run the spec's declared verification commands (§8) -----------------
    const runVerification = this.#options.runVerification ?? defaultVerificationRunner();
    const maxOutputBytes = this.#options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const commands = resolveVerificationCommands(this.#context);
    // W3-1 layer 2: snapshot the PRIMARY checkout (HEAD + porcelain) BEFORE
    // the commands run — drift across them is a confinement violation. A
    // failing snapshot here propagates: a pre-existing broken primary is an
    // environment problem, not the runner's doing.
    const primaryBefore =
      commands.length > 0 ? await snapshotPrimaryCheckoutState(handle.repoRoot) : undefined;
    const verification: VerificationCommandResult[] = [];
    for (const command of commands) {
      let outcome: VerificationCommandOutcome;
      try {
        outcome = await runVerification(command, cwd);
      } catch (error) {
        // A misbehaving runner must not lose the (already committed) work.
        outcome = { exitCode: 127, stdout: '', stderr: String(error), launchFailed: true };
      }
      verification.push({
        command,
        exitCode: outcome.exitCode,
        // §17.1 REDACT BEFORE TRUNCATE (same invariant as the diff above).
        stdout: boundText(redactText(outcome.stdout), maxOutputBytes).text,
        stderr: boundText(redactText(outcome.stderr), maxOutputBytes).text,
        passed: outcome.exitCode === 0 && !outcome.launchFailed,
        launchFailed: outcome.launchFailed,
      });
    }

    // W3-1 layer 2: re-check the PRIMARY checkout against the pre-command
    // snapshot. Any drift (HEAD moved, porcelain changed, primary unreadable)
    // is the typed violation: verification fails honestly below and the
    // caller records the durable incident + blocks §16 readiness.
    const runnerViolation =
      primaryBefore !== undefined
        ? await detectPrimaryCheckoutDrift(handle.repoRoot, primaryBefore)
        : undefined;

    // W1-F4: the commit-then-verify order is deliberate (the recorded diff
    // must never be polluted by a verification build), so a command that
    // MUTATES the tree leaves content behind that is in NO commit. Snapshot
    // the worktree status now — the §16 readiness gate blocks on exactly
    // this dirt, and the report names it honestly.
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
      // W3-1: a runner violation fails verification even when every command
      // exited 0 — a poisoned round must never read as self-check-passed.
      verificationPassed: verification.every((v) => v.passed) && runnerViolation === undefined,
      ...(runnerViolation !== undefined ? { runnerViolation } : {}),
      postVerificationDirty: postStatus.trim().length > 0,
      postVerificationDirtyFiles,
      committed: commit.committed,
      ...(commit.sha !== undefined ? { commitSha: gitSha(commit.sha) } : {}),
      stopReason,
      configApplied: session.configApplied,
      agentMessages,
      toolCalls: [...toolCalls.values()],
      permissionRequests,
    };
  }
}

// ---------------------------------------------------------------------------
// Entry point: worktree lifecycle around the engine-driven role
// ---------------------------------------------------------------------------
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
  /** F5: the run's PINNED base commit (start-time HEAD) — takes precedence over
   * `baseRef` so the standalone entry never branches from a drifted live HEAD. */
  readonly baseCommit?: GitSha;
  /** Ref to branch the worktree from; defaults to `'HEAD'` → immutable base SHA
   * (§16 item 1). Legacy/test fallback ONLY — a pinned `baseCommit` wins. */
  readonly baseRef?: string;
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
  // F5: the pinned base commit wins over `baseRef` (never a drifted live HEAD).
  const pinnedBase = input.baseCommit !== undefined ? String(input.baseCommit) : input.baseRef;
  const handle = await deps.worktrees.createWorktree({
    assignmentId: input.assignmentId,
    ...(pinnedBase !== undefined ? { baseRef: pinnedBase } : {}),
  });
  const flow = new ImplementorFlow(handle, input.context, input.options ?? {});
  try {
    return await deps.service.runRole(input.runId, flow, input.implementor, handle.worktreePath);
  } finally {
    deps.worktrees.releaseLease(input.assignmentId);
  }
}
