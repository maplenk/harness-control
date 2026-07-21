/**
 * `harness` CLI argument parser (PLAN §18) — the full command surface, parsed
 * into a discriminated `ParsedCliCommand` with NO I/O, engine, or spawn. The
 * parser is total (every argv yields exactly one command variant, including
 * `help`/`usage_error`), so the whole surface is unit-testable in isolation;
 * `src/cli/index.ts` and `src/cli/commands.ts` turn a parsed command into the
 * engine calls and the stable `--json` / text output.
 *
 * Parsing is hand-rolled on purpose (PLAN's dependency-minimalism). Every
 * command accepts `--json`; value flags accept `--flag value` and
 * `--flag=value`; a value that looks like a flag (`--x`) or a missing value is
 * a usage error; any `--help`/`-h` anywhere short-circuits to help.
 */
import {
  runId as toRunId,
  specHash as toSpecHash,
  specVersionId as toSpecVersionId,
  type RunId,
  type SpecHash,
  type SpecVersionId,
} from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import type { RoleModelSpec } from '../app/index.js';
import { err, isErr, ok, type Result } from '../lib/result.js';
import { parseRoleProfile, parseSwitchTarget } from './profile.js';

/** The three host-enforced roles (§8). `satisfies` keeps this in lockstep with
 * the domain `RoleName` union without importing a value the domain never exports. */
export const ROLE_NAMES = ['coordinator', 'implementor', 'verifier'] as const satisfies readonly RoleName[];

export const CLI_USAGE = `usage: harness <command> [options]   (stable --json on every command, PLAN §18)

commands:
  doctor [--json] [--config FILE]
      environment diagnosis: adapter binaries + versions, auth (4-state),
      host provider-config safety, ACP handshake (fake), git, sqlite, quotas.

  start --workspace PATH --goal TEXT --coordinator PROFILE [--model ID] [--effort E] [--config FILE] [--enable-chat] [--no-wait]
      create a run (phase=created) with the coordinator profile pinned (§11.2).
      --enable-chat opens an Agent Room for peer/human discussion during planning;
      the coordinator synthesizes the same validated spec before approval.

  spec revise RUN_ID --feedback TEXT [--no-wait]   T2: coordinator re-drafts; back to approval
  approve RUN_ID --spec-version ID [--spec-hash HASH]
      T1: explicit human approval binding the drafted SpecVersion hash
      (omitted --spec-hash binds the draft's; a mismatching one is refused).
      --test-approve  automated-acceptance seam; REFUSED unless HARNESS_TEST_MODE=1.
  run RUN_ID [--implementor PROFILE] [--verifier PROFILE] [--no-wait]
      resolve the implementor/verifier plan for the approved spec.
      On a provider usage-limit pause the default policy WAITS in-process
      (schedule loop, §13); --no-wait exits code 3 with resume instructions.
  recheck RUN_ID             W2-2: re-probe §16 readiness for an integration_blocked run
      (run stays in verifying; T24 ingested once the user-actionable blockers clear).
  status RUN_ID [--json]     phase, suspension, ETA|unknown, vitals (rss/context/cost), checkpoints;
      while paused on a limit the limit block reports incident/probes/policy honestly (W2-5).
  resume RUN_ID [--wait]     T9/T12: crash-recovery AND limit/user resume
      (eligibility-checked re-entry, W2-5; --wait runs the probe schedule loop instead).
  pause RUN_ID               T11 -> paused_user
  breaker reset RUN_ID       T15
  switch-model RUN_ID --role ROLE --model ID [--harness ID] [--effort E]   T19 (§11.2)
  set-budget RUN_ID --role ROLE --memory-budget-mb N [--resume]
      F3: audited per-run RSS memory-budget override to recover a
      resource_exhausted run at a higher budget (the ONE sanctioned exception to
      config immutability). --resume also re-enters the run after raising it.
  cancel RUN_ID              T18: idempotent, one terminal result

profiles (§18): '--coordinator claude --model opus --effort low' or a packed
  token '--implementor codex:gpt-5.6-terra'. OpenCode uses the exact dynamic
  provider/model id, e.g. '--verifier opencode:openai/gpt-4.1:high'
  and first-party Grok Build uses e.g. '--implementor grok:grok-build:high'
  (harness[:model[:effort]]).

global options:
  -h, --help                 show this help
`;

/** Commands that need the engine (everything but help/usage_error/doctor). */
export type RunCommand =
  | { readonly kind: 'start'; readonly json: boolean; readonly workspace: string; readonly goal: string; readonly coordinator: RoleModelSpec; readonly configPath?: string; readonly enableChat?: boolean; readonly noWait?: boolean }
  | { readonly kind: 'spec_revise'; readonly json: boolean; readonly runId: RunId; readonly feedback: string; readonly noWait?: boolean }
  | {
      readonly kind: 'approve';
      readonly json: boolean;
      readonly runId: RunId;
      readonly specVersionId: SpecVersionId;
      readonly specHash?: SpecHash;
      readonly testApprove: boolean;
    }
  | {
      readonly kind: 'run';
      readonly json: boolean;
      readonly runId: RunId;
      readonly implementor?: RoleModelSpec;
      readonly verifier?: RoleModelSpec;
      /** W2-5: on a limit pause, exit code 3 with resume instructions instead
       * of the default in-process schedule-loop wait. */
      readonly noWait?: boolean;
    }
  | { readonly kind: 'recheck'; readonly json: boolean; readonly runId: RunId }
  | { readonly kind: 'status'; readonly json: boolean; readonly runId: RunId }
  | {
      readonly kind: 'resume';
      readonly json: boolean;
      readonly runId: RunId;
      /** W2-5: run the probe schedule loop instead of an immediate re-entry. */
      readonly wait?: boolean;
    }
  | { readonly kind: 'pause'; readonly json: boolean; readonly runId: RunId }
  | { readonly kind: 'breaker_reset'; readonly json: boolean; readonly runId: RunId }
  | {
      readonly kind: 'switch_model';
      readonly json: boolean;
      readonly runId: RunId;
      readonly role: RoleName;
      readonly target: RoleModelSpec;
    }
  | {
      // F3 (§review dogfood): the audited per-run RSS memory-budget override —
      // the ONE sanctioned exception to config immutability, to recover a
      // `resource_exhausted` run at a higher budget.
      readonly kind: 'set_budget';
      readonly json: boolean;
      readonly runId: RunId;
      readonly role: RoleName;
      readonly budgetMb: number;
      /** Also resume the run after raising the budget (raise → resume). */
      readonly resume?: boolean;
    }
  | { readonly kind: 'cancel'; readonly json: boolean; readonly runId: RunId };

export type ParsedCliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'usage_error'; readonly message: string }
  | { readonly kind: 'doctor'; readonly json: boolean; readonly configPath?: string }
  | RunCommand;

/** The single simple RUN_ID + `--json` commands, keyed by their command kind. */
type SimpleRunKind = 'status' | 'pause' | 'cancel' | 'recheck';

// ---------------------------------------------------------------------------
// Option collection
// ---------------------------------------------------------------------------
interface Collected {
  readonly values: ReadonlyMap<string, string>;
  readonly bools: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

interface OptionSpec {
  readonly booleans?: readonly string[];
  readonly values?: readonly string[];
}

/**
 * Tokenize a command's remaining argv into boolean flags, value flags, and
 * positionals against a per-command allow-list. Unknown flags, missing values,
 * and `--bool=value` are rejected — so each command validates its own surface.
 */
function collectOptions(rest: readonly string[], spec: OptionSpec): Result<Collected, string> {
  const booleans = new Set(spec.booleans ?? []);
  const valueFlags = new Set(spec.values ?? []);
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      if (booleans.has(name)) {
        if (inline !== undefined) return err(`--${name} takes no value`);
        bools.add(name);
      } else if (valueFlags.has(name)) {
        if (inline !== undefined) {
          if (inline === '') return err(`--${name} requires an argument`);
          values.set(name, inline);
        } else {
          const next = rest[i + 1];
          if (next === undefined || next.startsWith('--')) return err(`--${name} requires an argument`);
          values.set(name, next);
          i += 1;
        }
      } else {
        return err(`unknown option: --${name}`);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      return err(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return ok({ values, bools, positionals });
}

function usage(message: string): ParsedCliCommand {
  return { kind: 'usage_error', message };
}

/**
 * W1-F5: engine config binds at `start` (persisted per-run, reloaded by every
 * later command) — accepting `--config` on a later run-scoped command would
 * silently resolve the run under different bounds/budget/quotas than it was
 * created with, so it is explicit misuse with a says-why message.
 */
const CONFIG_BINDS_AT_START =
  'config binds at start: --config is only accepted by `start` (and `doctor`); ' +
  'later run-scoped commands load the config persisted for the run';

/** Require exactly one positional and read it as the RUN_ID. */
function requireRunId(positionals: readonly string[], command: string): Result<RunId, string> {
  if (positionals.length === 0) return err(`${command} requires a RUN_ID`);
  if (positionals.length > 1) return err(`${command}: unexpected extra argument '${positionals[1]}'`);
  return ok(toRunId(positionals[0] as string));
}

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------
/** Pure argv parser (argv = everything AFTER the script path). */
export function parseCliArgs(argv: readonly string[]): ParsedCliCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    return { kind: 'help' };
  }
  if (rest.includes('--help') || rest.includes('-h')) return { kind: 'help' };

  switch (command) {
    case 'doctor':
      return parseDoctor(rest);
    case 'start':
      return parseStart(rest);
    case 'spec':
      return parseSpec(rest);
    case 'approve':
      return parseApprove(rest);
    case 'run':
      return parseRun(rest);
    case 'recheck':
      return parseSimple('recheck', rest);
    case 'status':
      return parseSimple('status', rest);
    case 'resume':
      return parseResume(rest);
    case 'pause':
      return parseSimple('pause', rest);
    case 'cancel':
      return parseSimple('cancel', rest);
    case 'breaker':
      return parseBreaker(rest);
    case 'switch-model':
      return parseSwitchModel(rest);
    case 'set-budget':
      return parseSetBudget(rest);
    default:
      return usage(`unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Per-command parsers
// ---------------------------------------------------------------------------
function parseDoctor(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, { booleans: ['json'], values: ['config'] });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (positionals.length > 0) return usage(`doctor: unexpected argument '${positionals[0]}'`);
  const configPath = values.get('config');
  return { kind: 'doctor', json: bools.has('json'), ...(configPath !== undefined ? { configPath } : {}) };
}

function parseStart(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, {
    booleans: ['json', 'no-wait', 'enable-chat'],
    values: ['workspace', 'goal', 'coordinator', 'model', 'effort', 'config'],
  });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (positionals.length > 0) return usage(`start: unexpected argument '${positionals[0]}'`);

  const workspace = values.get('workspace');
  const goal = values.get('goal');
  const coordinator = values.get('coordinator');
  if (workspace === undefined) return usage('start requires --workspace PATH');
  if (goal === undefined) return usage('start requires --goal TEXT');
  if (coordinator === undefined) return usage('start requires --coordinator PROFILE');

  const model = values.get('model');
  const effort = values.get('effort');
  const spec = parseRoleProfile({
    profile: coordinator,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });
  if (isErr(spec)) return usage(`--coordinator: ${spec.error}`);
  const configPath = values.get('config');
  return {
    kind: 'start',
    json: bools.has('json'),
    workspace,
    goal,
    coordinator: spec.value,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(bools.has('enable-chat') ? { enableChat: true } : {}),
    ...(bools.has('no-wait') ? { noWait: true } : {}),
  };
}

function parseSpec(rest: readonly string[]): ParsedCliCommand {
  const [sub, ...tail] = rest;
  if (sub !== 'revise') {
    return usage(sub === undefined ? "spec requires a subcommand ('revise')" : `unknown spec subcommand: ${sub}`);
  }
  const collected = collectOptions(tail, { booleans: ['json', 'no-wait'], values: ['feedback', 'config'] });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'spec revise');
  if (isErr(runId)) return usage(runId.error);
  const feedback = values.get('feedback');
  if (feedback === undefined) return usage('spec revise requires --feedback TEXT');
  return {
    kind: 'spec_revise',
    json: bools.has('json'),
    runId: runId.value,
    feedback,
    ...(bools.has('no-wait') ? { noWait: true } : {}),
  };
}

function parseApprove(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, {
    booleans: ['json', 'test-approve'],
    values: ['spec-version', 'spec-hash', 'config'],
  });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'approve');
  if (isErr(runId)) return usage(runId.error);
  const specVersion = values.get('spec-version');
  if (specVersion === undefined) return usage('approve requires --spec-version ID');
  const specHash = values.get('spec-hash');
  return {
    kind: 'approve',
    json: bools.has('json'),
    runId: runId.value,
    specVersionId: toSpecVersionId(specVersion),
    ...(specHash !== undefined ? { specHash: toSpecHash(specHash) } : {}),
    testApprove: bools.has('test-approve'),
  };
}

function parseRun(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, {
    booleans: ['json', 'no-wait'],
    values: ['implementor', 'verifier', 'config'],
  });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'run');
  if (isErr(runId)) return usage(runId.error);

  let implementor: RoleModelSpec | undefined;
  const implementorArg = values.get('implementor');
  if (implementorArg !== undefined) {
    const parsed = parseRoleProfile({ profile: implementorArg });
    if (isErr(parsed)) return usage(`--implementor: ${parsed.error}`);
    implementor = parsed.value;
  }
  let verifier: RoleModelSpec | undefined;
  const verifierArg = values.get('verifier');
  if (verifierArg !== undefined) {
    const parsed = parseRoleProfile({ profile: verifierArg });
    if (isErr(parsed)) return usage(`--verifier: ${parsed.error}`);
    verifier = parsed.value;
  }
  return {
    kind: 'run',
    json: bools.has('json'),
    runId: runId.value,
    ...(implementor !== undefined ? { implementor } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
    ...(bools.has('no-wait') ? { noWait: true } : {}),
  };
}

function parseResume(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, { booleans: ['json', 'wait'], values: ['config'] });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'resume');
  if (isErr(runId)) return usage(runId.error);
  return {
    kind: 'resume',
    json: bools.has('json'),
    runId: runId.value,
    ...(bools.has('wait') ? { wait: true } : {}),
  };
}

function parseBreaker(rest: readonly string[]): ParsedCliCommand {
  const [sub, ...tail] = rest;
  if (sub !== 'reset') {
    return usage(sub === undefined ? "breaker requires a subcommand ('reset')" : `unknown breaker subcommand: ${sub}`);
  }
  const collected = collectOptions(tail, { booleans: ['json'], values: ['config'] });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'breaker reset');
  if (isErr(runId)) return usage(runId.error);
  return { kind: 'breaker_reset', json: bools.has('json'), runId: runId.value };
}

function parseSwitchModel(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, {
    booleans: ['json'],
    values: ['role', 'model', 'harness', 'effort', 'config'],
  });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'switch-model');
  if (isErr(runId)) return usage(runId.error);

  const roleArg = values.get('role');
  if (roleArg === undefined) return usage('switch-model requires --role ROLE');
  if (!(ROLE_NAMES as readonly string[]).includes(roleArg)) {
    return usage(`switch-model: unknown --role '${roleArg}' (expected one of ${ROLE_NAMES.join(', ')})`);
  }
  const model = values.get('model');
  if (model === undefined) return usage('switch-model requires --model ID');
  const harness = values.get('harness');
  const effort = values.get('effort');
  const target = parseSwitchTarget({
    model,
    ...(harness !== undefined ? { harness } : {}),
    ...(effort !== undefined ? { effort } : {}),
  });
  if (isErr(target)) return usage(`switch-model: ${target.error}`);
  return {
    kind: 'switch_model',
    json: bools.has('json'),
    runId: runId.value,
    role: roleArg as RoleName,
    target: target.value,
  };
}

function parseSetBudget(rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, {
    booleans: ['json', 'resume'],
    values: ['role', 'memory-budget-mb', 'config'],
  });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, 'set-budget');
  if (isErr(runId)) return usage(runId.error);
  const roleArg = values.get('role');
  if (roleArg === undefined) return usage('set-budget requires --role ROLE');
  if (!(ROLE_NAMES as readonly string[]).includes(roleArg)) {
    return usage(`set-budget: unknown --role '${roleArg}' (expected one of ${ROLE_NAMES.join(', ')})`);
  }
  const mbArg = values.get('memory-budget-mb');
  if (mbArg === undefined) return usage('set-budget requires --memory-budget-mb N');
  const budgetMb = Number(mbArg);
  if (!Number.isInteger(budgetMb) || budgetMb <= 0) {
    return usage(`set-budget: --memory-budget-mb must be a positive integer (got '${mbArg}')`);
  }
  return {
    kind: 'set_budget',
    json: bools.has('json'),
    runId: runId.value,
    role: roleArg as RoleName,
    budgetMb,
    ...(bools.has('resume') ? { resume: true } : {}),
  };
}

function parseSimple(kind: SimpleRunKind, rest: readonly string[]): ParsedCliCommand {
  const collected = collectOptions(rest, { booleans: ['json'], values: ['config'] });
  if (isErr(collected)) return usage(collected.error);
  const { values, bools, positionals } = collected.value;
  if (values.has('config')) return usage(CONFIG_BINDS_AT_START);
  const runId = requireRunId(positionals, kind);
  if (isErr(runId)) return usage(runId.error);
  return { kind, json: bools.has('json'), runId: runId.value };
}
