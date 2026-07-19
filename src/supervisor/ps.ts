/**
 * `ps`-backed process inspection (PLAN.md §14): the OS-facing layer both
 * `watchdog.ts` (full-process-tree RSS) and `registry.ts` (single-process
 * identity) sample through. Isolated in its own module so both can depend on
 * the small `PsClient` interface and tests can inject a fake instead of
 * shelling out.
 *
 * Targets BSD/macOS `ps` (`-g <pgid>` selects a process group; `=`-suffixed
 * `-o` fields suppress the header) per the task framing "ps -o pid,pgid,rss
 * -g <pgid> on darwin" — this repo's tests run on Darwin (see env). A Linux
 * implementation would need different flags (`--pgid`/`-o pid,pgid,rss`
 * without `-g`, which means something else to GNU ps) and is out of scope
 * here.
 *
 * Identity fields are read as TWO separate `ps` invocations rather than one
 * multi-column query: `lstart` (process start time) is itself a
 * multi-token, space-separated string ("Sat Jul 18 14:36:07 2026"), which
 * makes fixed-column whitespace-splitting ambiguous when another field
 * follows it on the same line. Splitting the query in two sidesteps that
 * ambiguity entirely rather than relying on a fragile column-count
 * assumption. `startedAt` is kept as an OPAQUE STRING — compared for exact
 * equality only, never parsed into a `Date` — so locale/timezone rendering
 * quirks can never cause a false identity mismatch (or worse, a false
 * match): the same instant rendered twice by the same `ps`/locale always
 * produces the same string, which is all identity comparison needs.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Clock, IsoTimestamp } from '../lib/clock.js';

export interface ProcessTreeSample {
  readonly pgid: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly pids: readonly number[];
  readonly sampledAt: IsoTimestamp;
}

export interface ProcessIdentitySample {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Opaque `ps lstart` token (§14 "process start-time") — see module doc. */
  readonly startedAt: string;
  /** `ps comm` (= argv[0] as the kernel recorded it; a full path when the
   * process was spawned with an absolute executable path). */
  readonly executablePath: string;
}

export interface PsClient {
  /** Sums RSS across every process in `pgid`'s group; `undefined` when the group has no live members (process tree is gone). */
  sampleProcessTree(pgid: number): ProcessTreeSample | undefined;
  /** `undefined` when `pid` no longer resolves to any process. */
  sampleIdentity(pid: number): ProcessIdentitySample | undefined;
  /** Best-effort liveness probe (signal-0), independent of identity. */
  isAlive(pid: number): boolean;
}

type PsRunResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false };

/** Forces a stable, parseable locale regardless of the host's configured one. */
const PS_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function runPs(args: readonly string[]): PsRunResult {
  try {
    // Explicit `pipe` for stderr: `ps` writes a one-line diagnostic to
    // stderr for the "no matches" case this module treats as a normal,
    // expected outcome (see the catch below) — without this, that line
    // would otherwise leak straight to this process's own stderr on every
    // such (routine, non-error) probe.
    const out = execFileSync('ps', args as string[], {
      encoding: 'utf8',
      env: PS_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { ok: true, lines };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    // BSD ps exits 1 both for "no processes matched" and for an out-of-range
    // group id ("process group too large") — both mean "nothing there,"
    // which is exactly the fail-safe "not found" outcome callers want; any
    // OTHER failure (e.g. `ps` missing entirely) is a real infra error and
    // is allowed to propagate rather than being silently swallowed.
    if (status === 1) return { ok: false };
    throw error;
  }
}

function toFiniteNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
}

export function createPsClient(clock: Clock): PsClient {
  return {
    sampleProcessTree(pgid: number): ProcessTreeSample | undefined {
      const result = runPs(['-o', 'pid=,pgid=,rss=', '-g', String(pgid)]);
      if (!result.ok || result.lines.length === 0) return undefined;

      const pids: number[] = [];
      let rssKb = 0;
      for (const line of result.lines) {
        const parts = line.split(/\s+/);
        const pid = toFiniteNumber(parts[0]);
        const rss = toFiniteNumber(parts[2]);
        if (pid === undefined || rss === undefined) continue;
        pids.push(pid);
        rssKb += rss;
      }
      if (pids.length === 0) return undefined;
      return {
        pgid,
        rssBytes: rssKb * 1024,
        processCount: pids.length,
        pids,
        sampledAt: clock.nowIso(),
      };
    },

    sampleIdentity(pid: number): ProcessIdentitySample | undefined {
      const main = runPs(['-o', 'pid=,ppid=,pgid=,comm=', '-p', String(pid)]);
      if (!main.ok || main.lines.length === 0) return undefined;
      const parts = main.lines[0]!.split(/\s+/);
      const rowPid = toFiniteNumber(parts[0]);
      const ppid = toFiniteNumber(parts[1]);
      const pgid = toFiniteNumber(parts[2]);
      const executablePath = parts.slice(3).join(' ');
      if (rowPid === undefined || ppid === undefined || pgid === undefined || executablePath.length === 0) {
        return undefined;
      }

      const lstart = runPs(['-o', 'lstart=', '-p', String(pid)]);
      const startedAt = lstart.ok && lstart.lines.length > 0 ? lstart.lines[0]! : '';

      return { pid: rowPid, ppid, pgid, startedAt, executablePath };
    },

    isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// §14 spawn-nonce re-verification (P4a W2-6): best-effort child-env reading
// ---------------------------------------------------------------------------
/** The identity-nonce env var every transport spawn stamps (§10.1). */
export const HARNESS_SPAWN_ID_ENV = 'HARNESS_SPAWN_ID';

/**
 * Outcome of re-reading a live process's `HARNESS_SPAWN_ID` from its
 * environment:
 *  - `match`       — the env was readable and carries EXACTLY the expected nonce;
 *  - `mismatch`    — the env was readable but carries a DIFFERENT nonce (the
 *                    pid demonstrably belongs to some other spawn);
 *  - `unavailable` — the env could not be read (unsupported platform,
 *                    permissions, or no nonce token visible at all — which is
 *                    indistinguishable from "not readable" and must never be
 *                    treated as evidence either way).
 */
export type EnvNonceVerdict = 'match' | 'mismatch' | 'unavailable';

/**
 * §14/W2-6 startup-reaping extension: re-verify the `HARNESS_SPAWN_ID` nonce
 * by reading the CHILD's environment, where the platform allows it. Only
 * `match` is positive evidence; `mismatch` and `unavailable` both mean the
 * reaper must WITHHOLD the signal and surface the §14 alert — never kill on
 * ambiguity (see `ProcessRegistry.reapOrphans`).
 */
export interface EnvNonceVerifier {
  verifyNonce(pid: number, expectedNonce: string): EnvNonceVerdict;
}

/** Extract a `HARNESS_SPAWN_ID=<value>` token from env-ish text. */
function nonceFromText(text: string): string | undefined {
  const match = new RegExp(`${HARNESS_SPAWN_ID_ENV}=([^\\s\\0]+)`).exec(text);
  return match?.[1];
}

function toVerdict(observed: string | undefined, expected: string): EnvNonceVerdict {
  if (observed === undefined) return 'unavailable';
  return observed === expected ? 'match' : 'mismatch';
}

/**
 * Best-effort real reader (darwin/linux, per the W2-6 spec):
 *  - darwin: `ps eww -o command= -p <pid>` — BSD `ps e` appends the process's
 *    environment strings to the command column for processes the caller may
 *    inspect (our own children always are: same user). Verified live on this
 *    repo's darwin env.
 *  - linux: `/proc/<pid>/environ` (NUL-separated), readable for same-user
 *    processes.
 *  - anything else (other platforms, permission errors, no visible token):
 *    `unavailable` — the caller withholds and alerts (§14), never guesses.
 */
export function createEnvNonceVerifier(platform: NodeJS.Platform = process.platform): EnvNonceVerifier {
  return {
    verifyNonce(pid: number, expectedNonce: string): EnvNonceVerdict {
      if (platform === 'linux') {
        try {
          const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
          return toVerdict(nonceFromText(environ), expectedNonce);
        } catch {
          return 'unavailable';
        }
      }
      if (platform === 'darwin') {
        try {
          const out = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], {
            encoding: 'utf8',
            env: PS_ENV,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return toVerdict(nonceFromText(out), expectedNonce);
        } catch {
          return 'unavailable';
        }
      }
      return 'unavailable';
    },
  };
}
