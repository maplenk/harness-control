#!/usr/bin/env node
/**
 * `harness` CLI entry (PLAN §18: "stable `--json` everywhere; all transitions
 * live in the application service; CLI is a client").
 *
 * This module is the thin RUNTIME: parse argv (`./args.ts`), then either answer
 * a stateless command (help/usage/`doctor`) or open the run store, construct the
 * one `OrchestrationService`, and hand a parsed command to `executeCommand`
 * (`./commands.ts`), which owns the engine wiring and the stable `--json`/text
 * output. Everything state-changing goes through the service — the CLI keeps no
 * state of its own.
 *
 * The run store is a single SQLite DB under `HARNESS_HOME` (default
 * `~/.harness`), so a run created by `start` is visible to a later `approve` /
 * `run` / `status` in a fresh process.
 *
 * W1-F5 config durability: `start` resolves the engine config (`--config` or
 * defaults) and `createRun` persists it per-run; every LATER run-scoped
 * command reloads that persisted config (bootstrap read below) so
 * bounds/budget/quotas are the ones the run was created under. The effective
 * config's quotas are threaded into `openDatabase`, and every flow artifact
 * write goes through the quota-aware database artifact repository.
 *
 * Exit codes: 0 ok, 1 engine-level failure/rejection or doctor FAIL, 2 usage /
 * policy-guard (bad args, missing `--spec-hash`, refused `--test-approve`),
 * 4 `integration_blocked` (W2-2: criteria verified but user-actionable §16
 * blockers remain — resolve them, then `harness recheck`).
 * `process.exitCode` is set (never `process.exit()`) so stdout flushes fully —
 * required for `--json` piping.
 */
import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OrchestrationService, RUN_META_PROJECTION, loadRunConfig } from '../app/index.js';
import { CoordinatorRunner } from '../app/flows/coordinator.js';
import { artifactStoreEvidenceRecorder } from '../app/flows/verifier.js';
import { defaultVerificationRunner } from '../app/flows/implementor.js';
import type { ArtifactSink } from '../artifacts/store.js';
import { redactText } from '../redaction/redact.js';
import { GitWorktreeManager } from '../worktree/index.js';
import {
  openDatabase,
  type ArtifactAdmissionRejected,
  type Database,
} from '../persistence/index.js';
import { DEFAULT_ENGINE_CONFIG, loadEngineConfigFromFile } from '../config/loader.js';
import { loadProfileFile } from '../config/profile.js';
import type { EngineConfig } from '../config/schema.js';
import { RandomIdFactory } from '../lib/id-factory.js';
import { isErr } from '../lib/result.js';
import { runDoctor, renderDoctorText, type DoctorOptions } from './doctor.js';
import { CLI_USAGE, parseCliArgs, type ParsedCliCommand, type RunCommand } from './args.js';
import { executeCommand, type CliFlowDeps } from './commands.js';

// Keep the historical entry-point surface importable from `./index.js` (the
// arg parser + usage string are unit-tested there).
export { CLI_USAGE, parseCliArgs };
export type { ParsedCliCommand, RunCommand };
export { executeCommand } from './commands.js';
export type { CommandOutput, CommandDeps } from './commands.js';

/** The run store lives under `HARNESS_HOME` (default `~/.harness`). */
export function resolveHarnessHome(env: NodeJS.ProcessEnv): string {
  const configured = env['HARNESS_HOME'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  return path.join(homedir(), '.harness');
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  switch (parsed.kind) {
    case 'help':
      process.stdout.write(CLI_USAGE);
      return 0;
    case 'usage_error':
      process.stderr.write(`harness: ${parsed.message}\n\n${CLI_USAGE}`);
      return 2;
    case 'doctor': {
      const options: DoctorOptions =
        parsed.configPath !== undefined ? { configPath: parsed.configPath } : {};
      const report = await runDoctor(options);
      process.stdout.write(
        parsed.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderDoctorText(report)}\n`,
      );
      return report.overall === 'fail' ? 1 : 0;
    }
    default:
      return runEngineCommand(parsed, process.env);
  }
}

/**
 * Open the run store, construct the service, and execute a run-oriented
 * command. The effective `EngineConfig` is resolved FIRST (W1-F5): `start`
 * binds it from `--config`/defaults and `createRun` persists it; every other
 * run-scoped command loads the run's persisted config via a short bootstrap
 * open — quotas are constructor-bound inside the artifact repository, so the
 * real open must already know them. A run with no persisted config (created
 * before config durability) falls back to defaults with a stderr warning.
 */
async function runEngineCommand(command: RunCommand, env: NodeJS.ProcessEnv): Promise<number> {
  const home = resolveHarnessHome(env);
  await mkdir(home, { recursive: true });
  const casRoot = path.join(home, 'artifacts');
  const filename = path.join(home, 'harness.db');

  let config: EngineConfig;
  if (command.kind === 'start') {
    if (command.configPath !== undefined) {
      const loaded = loadEngineConfigFromFile(command.configPath);
      if (isErr(loaded)) {
        process.stderr.write(
          `harness: invalid config '${command.configPath}':\n${loaded.error
            .map((issue) => `  - ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
            .join('\n')}\n`,
        );
        return 2;
      }
      config = loaded.value;
    } else {
      config = DEFAULT_ENGINE_CONFIG;
    }
  } else {
    const boot = await openDatabase({ filename, casRoot });
    let persisted: EngineConfig | undefined;
    let runKnown = false;
    try {
      runKnown = boot.projections.get(command.runId, RUN_META_PROJECTION) !== undefined;
      persisted = loadRunConfig(boot, command.runId);
    } finally {
      boot.close();
    }
    if (persisted === undefined && runKnown) {
      process.stderr.write(
        `harness: run ${command.runId} has no persisted engine config (created before config ` +
          'durability); using defaults\n',
      );
    }
    config = persisted ?? DEFAULT_ENGINE_CONFIG;
  }

  const db = await openDatabase({
    filename,
    casRoot,
    // W1-F5: the effective config's §12.1 artifact quotas govern admission.
    quotas: { perRunBytes: config.quotas.perRunBytes, globalBytes: config.quotas.globalBytes },
  });
  try {
    const service = new OrchestrationService({ db, config });
    const flows = buildCliFlows(db, config);
    const output = await executeCommand(service, db, command, env, { ids: flows.ids, flows });
    process.stdout.write(command.json ? `${JSON.stringify(output.json, null, 2)}\n` : `${output.text}\n`);
    return output.exitCode;
  } finally {
    db.close();
  }
}

/**
 * W1-F5: an artifact write the quota-aware repository REFUSED (§12.1
 * admission). The rejection itself is already durably recorded (audit row +
 * per-run event) by the repository; this error surfaces the refusal to the
 * command layer, which reports it as a clean exit-1 failure.
 */
export class ArtifactAdmissionError extends Error {
  override readonly name: string = 'ArtifactAdmissionError';
  readonly rejection: ArtifactAdmissionRejected;
  constructor(rejection: ArtifactAdmissionRejected) {
    super(
      `artifact admission rejected (${rejection.scope} quota, §12.1): +${rejection.attemptedSizeBytes} ` +
        `bytes would exceed the ${rejection.limitBytes}-byte limit (current usage ${rejection.currentUsageBytes})`,
    );
    this.rejection = rejection;
  }
}

/**
 * Route CLI flow artifact writes (spec, exploration, evidence) through the
 * QUOTA-AWARE database artifact repository — §12.1 admission under the
 * effective config's quotas plus the durable rejection audit trail — instead
 * of a bare `ArtifactStore` that meters nothing (W1-F5). Redaction still
 * precedes the sink (§17.1): string content is redacted here exactly as
 * `ArtifactStore.put` would before the `redacted:true` attestation; binary
 * content requires the caller's own `preRedacted` attestation (same contract
 * as the store — no CLI flow writes binary today).
 */
function quotaAwareArtifactSink(db: Database): ArtifactSink {
  return {
    async put(input) {
      let bytes: Buffer;
      if (typeof input.content === 'string') {
        bytes = Buffer.from(input.preRedacted === true ? input.content : redactText(input.content), 'utf8');
      } else {
        if (input.preRedacted !== true) {
          throw new Error(
            'artifact sink: binary content requires preRedacted:true — binary bytes cannot be safely text-redacted',
          );
        }
        bytes = input.content;
      }
      const written = db.artifacts.write({
        bytes,
        kind: input.kind,
        redacted: true,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
      });
      if (isErr(written)) throw new ArtifactAdmissionError(written.error);
      return written.value;
    },
  };
}

/**
 * Construct the P3 flow runtime the shipped CLI drives `start`/`spec revise`/
 * `run` with: the coordinator profile + the quota-aware CAS sink, a git
 * worktree manager over the workspace, and the verifier evidence sink (same
 * quota-aware sink). Exported so acceptance tests can exercise the EXACT
 * shipped wiring against a test database. H-1 isolation is untouched — every
 * spawn still goes through the service's production `defaultRoleAdapterFactory`,
 * which forwards no user `CODEX_HOME`; nothing here reads or forwards it.
 *
 * W3-1: `config` (the run's persisted `EngineConfig`) supplies the ONLY env
 * additions the verification runner may inherit beyond its minimal allowlist
 * (`verification.envAllowlist` — explicit keys, credential-shaped names
 * rejected at config parse). No blanket env inherit exists.
 */
export function buildCliFlows(db: Database, config: EngineConfig = DEFAULT_ENGINE_CONFIG): CliFlowDeps {
  const ids = new RandomIdFactory();
  const artifacts = quotaAwareArtifactSink(db);
  const coordinatorProfilePath = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));
  return {
    ids,
    clock: db.clock,
    buildCoordinatorRunner: ({ goal, revise }) => {
      const profile = loadProfileFile(coordinatorProfilePath);
      if (isErr(profile)) {
        throw new Error(
          `coordinator profile failed to load (${coordinatorProfilePath}): ${JSON.stringify(profile.error)}`,
        );
      }
      return new CoordinatorRunner({
        goal,
        profile: profile.value,
        artifactStore: artifacts,
        ids,
        clock: db.clock,
        ...(revise !== undefined ? { revise } : {}),
      });
    },
    openWorktrees: (workspacePath) => GitWorktreeManager.open({ primaryRepoRoot: workspacePath, clock: db.clock }),
    evidence: artifactStoreEvidenceRecorder(artifacts),
    runVerification: defaultVerificationRunner({ inheritEnvKeys: config.verification.envAllowlist }),
  };
}

/**
 * §17.1 sink belt for the LAST-resort fatal path: whatever rejected out of
 * `main` may be a provider failure whose message/stack embeds untrusted
 * provider text (a stack's first line repeats the message), so the rendered
 * string is redacted at the sink. Exported for the redaction test.
 */
export function renderFatalError(error: unknown): string {
  return redactText(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

// Invoked directly (tsx src/cli/index.ts …, or the built dist/cli/index.js bin —
// realpath handles npm's bin symlink): run. Imported as a module (tests,
// barrel): exports only, no side effects.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`harness: ${renderFatalError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
