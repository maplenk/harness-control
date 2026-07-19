/**
 * Codex spawn-time provider-config isolation (PLAN §17.1, live-gate H-1).
 *
 * WHY (docs/reviews/p2-live-gate.md, Run 2, finding H-1): the spawned codex
 * core resolves its config/credential home via `CODEX_HOME` (falling back to
 * `~/.codex`), and this host's user-global `~/.codex/config.toml` carried
 * `approvals_reviewer = "auto_review"` — which re-routes EVERY approval
 * request (sandbox escapes, network, MCP approvals) to the core's internal
 * Guardian subagent instead of the ACP client. Observed live: an
 * out-of-sandbox `$HOME` write auto-approved and executed under an
 * echo-confirmed `read-only` mode pin, with ZERO `session/request_permission`
 * traffic. PLAN §10.2's "no provider ever gets a global bypass flag" must
 * therefore extend to inherited provider config: every codex spawn gets an
 * ISOLATED `CODEX_HOME` that carries auth material only, plus an
 * orchestrator-owned `config.toml` that routes approvals back to the client.
 *
 * Source verification (all against the LOCKFILE-PINNED packages in this
 * repo's node_modules — never inferred):
 *  - `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`
 *    (core 0.144.5, the binary codex-acp@1.1.4 spawns as `codex app-server`):
 *    embedded schema/doc strings confirm `CODEX_HOME` resolution
 *    ("failed to resolve CODEX_HOME", "$CODEX_HOME/themes/", "failed to read
 *    CODEX_HOME"), `auth.json` as the credential store holding the ChatGPT
 *    access+refresh tokens IN ONE FILE ("ChatGPT auth is missing token data /
 *    an access token / a refresh token / refresh metadata",
 *    `chatgpt_auth_tokens`, `ChatgptAuthTokensRefreshParams` with
 *    `refresh_token`/`client_id`/`grant_type`) — there is NO separate refresh
 *    token file to carry; top-level `ConfigToml` keys `approvals_reviewer`
 *    and `sandbox_mode`; `ApprovalsReviewer` values
 *    `"user" | "auto_review" | "guardian_subagent"` with the doc string
 *    "Configures who approval requests are routed to for review. … Defaults
 *    to `user`. `auto_review` uses a carefully prompted subagent … before
 *    approving or denying the request. The legacy value `guardian_subagent`
 *    is accepted for compatibility."; `SandboxMode` values
 *    `read-only | workspace-write | danger-full-access`.
 *  - `@agentclientprotocol/codex-acp/dist/index.js`: `startCodexConnection()`
 *    spawns the core with `env ?? process.env` — the adapter passes its own
 *    environment through, so `CODEX_HOME` set on OUR child env reaches the
 *    core; codex-acp itself reads NO auth files (zero `auth.json`
 *    references); `checkAuthorization()` → `authRequired()`
 *    (`accountRead({refreshToken:false})` → `requiresOpenaiAuth && !account`)
 *    gates `session/new` — with a ChatGPT login present in the (isolated)
 *    home the gate passes WITHOUT any ACP `authenticate` call.
 *
 * AUTH CARRIAGE = COPY-IN, NOT LINK (refresh tradeoff, documented): the core
 * rewrites `auth.json` in ITS `CODEX_HOME` when it refreshes tokens. Copying
 * the file in means (a) refresh keeps working inside the isolated home, and
 * (b) nothing the child does can ever corrupt or leak back into the user's
 * real `~/.codex` (a hardlink/symlink would re-couple them). The accepted
 * cost: tokens refreshed inside the isolated copy are NOT propagated back —
 * the user's own codex refreshes the real file on their next use, and every
 * new run re-copies fresh material. If the provider ever rotates refresh
 * tokens single-use, an isolated-run refresh could supersede the real file's
 * token; that failure mode surfaces as an auth-classified turn failure
 * (recorded as H-2 evidence) — never as silent home mutation.
 *
 * Credential hygiene: auth material is byte-copied (kernel-side
 * `copyFileSync`) with 0600 perms inside a 0700 per-run temp dir; contents
 * are NEVER read into orchestrator memory, logged, or embedded in errors
 * (paths only). Disposal (`dispose()`) removes the whole dir; the factory
 * wires it to `adapter.close()`.
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';

// ---------------------------------------------------------------------------
// Verified constants (see module header for the exact source citations)
// ---------------------------------------------------------------------------
/** Env var the codex core resolves its config/credential home from. */
export const CODEX_HOME_ENV_VAR = 'CODEX_HOME';
/** The single credential file the core reads/rewrites under CODEX_HOME
 * (ChatGPT access+refresh tokens live INSIDE it — no separate token file). */
export const CODEX_AUTH_JSON_BASENAME = 'auth.json';
/** The core's config file under CODEX_HOME. */
export const CODEX_CONFIG_TOML_BASENAME = 'config.toml';
/** The ONLY `approvals_reviewer` value that routes approvals to the ACP
 * client (the core's documented default). Everything else hands approvals to
 * a provider-side reviewer — the exact H-1 bypass. */
export const CODEX_SAFE_APPROVALS_REVIEWER = 'user';
/** Full verified value set (core 0.144.5): `guardian_subagent` is the
 * documented legacy alias of `auto_review`. */
export const CODEX_APPROVALS_REVIEWER_VALUES = ['user', 'auto_review', 'guardian_subagent'] as const;

/** Verified `SandboxMode` config values (core 0.144.5). */
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * The sandbox baseline the orchestrator config pins for a role — the SAME
 * posture the P-1 session-mode pin (`CODEX_SESSION_MODE_POLICY`) asserts over
 * ACP (`read-only` ↔ read-only; `agent` ↔ workspace-write), so the home
 * config and the echo-confirmed session pin agree. `danger-full-access` is
 * never emitted (PLAN §10.2: no provider ever gets a global bypass).
 */
export function codexSandboxModeForRole(role: RoleName | undefined): CodexSandboxMode {
  return role === 'implementor' ? 'workspace-write' : 'read-only';
}

// ---------------------------------------------------------------------------
// Orchestrator-owned config.toml
// ---------------------------------------------------------------------------
/**
 * Renders the MINIMAL orchestrator-owned `config.toml`: client-routed
 * approvals + the per-role sandbox baseline, and NOTHING else — no `notify`
 * hooks, no trusted projects, no profiles, nothing that could re-enable an
 * internal auto-approver. Only source-verified top-level keys are emitted so
 * the core's config parser never rejects the file.
 */
export function renderOrchestratorCodexConfigToml(sandboxMode: CodexSandboxMode): string {
  return [
    '# Orchestrator-owned Codex config (harness-orchestration; PLAN §17.1, live-gate H-1).',
    '# Written fresh into an ISOLATED CODEX_HOME for one spawned child. Never copied',
    '# from — and never written back to — the user\'s real ~/.codex.',
    '',
    '# Route ALL approval requests (sandbox escapes, network, MCP approvals) to the',
    '# ACP CLIENT — the core\'s documented default; `auto_review`/`guardian_subagent`',
    '# would hand them to an internal reviewer subagent (the H-1 permission bypass).',
    `approvals_reviewer = "${CODEX_SAFE_APPROVALS_REVIEWER}"`,
    '',
    '# Baseline sandbox = the same posture the per-role ACP mode pin asserts and',
    '# echo-confirms at session setup (P-1). Never danger-full-access.',
    `sandbox_mode = "${sandboxMode}"`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-run isolated home
// ---------------------------------------------------------------------------
export interface PrepareCodexHomeOptions {
  /** The REAL provider home to carry auth material FROM (presence-checked +
   * byte-copied only; never parsed, never mutated). Default: `~/.codex`.
   * Tests MUST point this at a fixture — never the developer's real home. */
  readonly realCodexHome?: string;
  /** Where the per-run isolated home dir is created. Default: `os.tmpdir()`. */
  readonly tempRoot?: string;
  /** Role whose sandbox baseline the config pins (§8; default read-only). */
  readonly role?: RoleName;
}

/** What auth material the isolated home carries (names only — never contents). */
export type CodexAuthMaterial = 'auth_json' | 'none';

export interface PreparedCodexHome {
  /** The isolated CODEX_HOME (0700). */
  readonly dir: string;
  /** The orchestrator-owned config.toml inside it (0600). */
  readonly configPath: string;
  /** Env to layer onto the child: `{ CODEX_HOME: dir }`. */
  readonly env: Readonly<Record<string, string>>;
  readonly authMaterial: CodexAuthMaterial;
  readonly sandboxMode: CodexSandboxMode;
  /** Removes the isolated home (incl. copied auth material). Idempotent. */
  readonly dispose: () => void;
}

/**
 * Builds the per-run isolated `CODEX_HOME` (H-1):
 * 1. fresh 0700 temp dir (`mkdtemp` under `tempRoot`);
 * 2. orchestrator-owned `config.toml` (0600) — see
 *    `renderOrchestratorCodexConfigToml`;
 * 3. if `<realCodexHome>/auth.json` exists, byte-copy it in with 0600 (the
 *    inherited ChatGPT/Codex subscription login — the real auth path on this
 *    machine; PLAN D2's API-key env path still forwards independently via the
 *    factory's credential env vars).
 * Failures after the dir exists dispose it before rethrowing (no leaked
 * credential copies). Synchronous by design: the factory composes adapters
 * synchronously and the env must exist before `initialize()` spawns.
 */
export function prepareCodexHomeIsolation(options: PrepareCodexHomeOptions = {}): PreparedCodexHome {
  const realCodexHome = options.realCodexHome ?? path.join(homedir(), '.codex');
  const tempRoot = options.tempRoot ?? tmpdir();
  const sandboxMode = codexSandboxModeForRole(options.role);
  const dir = mkdtempSync(path.join(tempRoot, 'harness-codex-home-'));
  try {
    chmodSync(dir, 0o700);
    const configPath = path.join(dir, CODEX_CONFIG_TOML_BASENAME);
    writeFileSync(configPath, renderOrchestratorCodexConfigToml(sandboxMode), {
      encoding: 'utf8',
      mode: 0o600,
    });

    let authMaterial: CodexAuthMaterial = 'none';
    const realAuthJson = path.join(realCodexHome, CODEX_AUTH_JSON_BASENAME);
    if (existsSync(realAuthJson)) {
      const isolatedAuthJson = path.join(dir, CODEX_AUTH_JSON_BASENAME);
      // COPY-IN, never link (see module header for the refresh tradeoff);
      // kernel-side byte copy — contents never enter orchestrator memory.
      copyFileSync(realAuthJson, isolatedAuthJson);
      chmodSync(isolatedAuthJson, 0o600);
      authMaterial = 'auth_json';
    }

    let disposed = false;
    return {
      dir,
      configPath,
      env: Object.freeze({ [CODEX_HOME_ENV_VAR]: dir }),
      authMaterial,
      sandboxMode,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Host-config safety check (doctor; READ-ONLY — never mutates ~/.codex)
// ---------------------------------------------------------------------------
/**
 * Extracts every top-level-shaped `approvals_reviewer = "…"` assignment from
 * a config.toml text (line-based; comments tolerated). Deliberately scans
 * ALL lines including `[profiles.*]` sections — a profile-scoped
 * auto-approver is exactly as dangerous when that profile activates, and for
 * a warn-only doctor check over-flagging is the safe direction.
 */
export function parseApprovalsReviewerValues(tomlText: string): readonly string[] {
  const values: string[] = [];
  const lineRe = /^\s*approvals_reviewer\s*=\s*"([^"]*)"\s*(?:#.*)?$/;
  for (const line of tomlText.split(/\r?\n/)) {
    const match = lineRe.exec(line);
    if (match !== null && match[1] !== undefined) values.push(match[1]);
  }
  return values;
}

export interface CodexHostConfigCheck {
  readonly configPath: string;
  readonly exists: boolean;
  /** Every `approvals_reviewer` value found (document order); empty when the
   * file is absent or carries no assignment (core default `user` applies). */
  readonly approvalsReviewers: readonly string[];
  /** true iff every routing signal is client-routing (`user`, incl. the
   * absent-key default). Unreadable file → false (cannot attest safety). */
  readonly safe: boolean;
  readonly issues: readonly string[];
}

/**
 * H-1 doctor check: flags a host `~/.codex/config.toml` whose
 * `approvals_reviewer` is anything but the safe client-routing value.
 * READ-ONLY (the file is read, never written; auth.json is never touched)
 * and warn-only — spawn-time isolation (`prepareCodexHomeIsolation`) is the
 * enforcement; this check exists so a dangerous host posture is VISIBLE, and
 * so any non-isolated codex use (other tools, manual runs) is flagged.
 */
export function checkCodexHostApprovalsConfig(realCodexHome?: string): CodexHostConfigCheck {
  const home = realCodexHome ?? path.join(homedir(), '.codex');
  const configPath = path.join(home, CODEX_CONFIG_TOML_BASENAME);
  if (!existsSync(configPath)) {
    // No host config → the core's documented default `user` (client-routing).
    return { configPath, exists: false, approvalsReviewers: [], safe: true, issues: [] };
  }
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (error) {
    return {
      configPath,
      exists: true,
      approvalsReviewers: [],
      safe: false,
      issues: [
        `could not read ${configPath} (${error instanceof Error ? error.message : String(error)}) — ` +
          'approval routing cannot be attested; treat as unsafe for any non-isolated codex spawn',
      ],
    };
  }
  const approvalsReviewers = parseApprovalsReviewerValues(text);
  const unsafeValues = approvalsReviewers.filter((value) => value !== CODEX_SAFE_APPROVALS_REVIEWER);
  const issues = unsafeValues.map(
    (value) =>
      `approvals_reviewer = "${value}" routes approval requests (sandbox escapes, network, MCP) to a ` +
      'provider-side reviewer instead of the ACP client — the live-gate H-1 permission bypass. ' +
      `Safe value: "${CODEX_SAFE_APPROVALS_REVIEWER}" (the core default). Orchestrator spawns are protected by ` +
      'CODEX_HOME isolation; any NON-isolated codex use on this host is not. (Read-only check; nothing was modified.)',
  );
  return {
    configPath,
    exists: true,
    approvalsReviewers,
    safe: unsafeValues.length === 0,
    issues,
  };
}
