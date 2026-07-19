/**
 * Spawn helper for the child-process fake ACP agent (`fake-acp-child.mjs`).
 *
 * The child is a plain `.mjs` (spawnable with `process.execPath`, no compile
 * step) that speaks NDJSON JSON-RPC over stdio and is scripted through ONE
 * scenario JSON file (schema: `FakeAcpScenario` in `./scenario.ts`). This
 * module writes the scenario file and spawns the child for you — the
 * substrate the transport conformance suite (PLAN §19 tests 1–8/21) drives.
 *
 * Note: the `.mjs` is not compiled by tsc, so under a `dist/` build the
 * resolver falls back to the source tree (`src/adapters/fake/`) — the fake is
 * test infrastructure, not a shipped runtime component.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeAcpScenario } from './scenario.js';

const CHILD_BASENAME = 'fake-acp-child.mjs';

/**
 * Absolute path to `fake-acp-child.mjs`. Resolves the sibling of THIS module
 * first (works under vitest/tsx running from `src/`); under a compiled
 * `dist/` layout it falls back to `<repo>/src/adapters/fake/` (tsc neither
 * compiles nor copies `.mjs` assets).
 */
export function fakeAcpChildPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sibling = path.join(here, CHILD_BASENAME);
  if (existsSync(sibling)) return sibling;
  // dist/adapters/fake → ../../.. = repo root → src/adapters/fake.
  const fromDist = path.join(here, '..', '..', '..', 'src', 'adapters', 'fake', CHILD_BASENAME);
  if (existsSync(fromDist)) return fromDist;
  throw new Error(
    `fake-acp-child.mjs not found (looked at ${sibling} and ${fromDist}); ` +
      'the child fake lives in the source tree only',
  );
}

/** Serialize a scenario to `<dir>/scenario.json` (dir created when omitted). */
export async function writeScenarioFile(
  scenario: FakeAcpScenario,
  dir?: string,
): Promise<string> {
  const targetDir = dir ?? (await mkdtemp(path.join(tmpdir(), 'fake-acp-scenario-')));
  const scenarioPath = path.join(targetDir, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');
  return scenarioPath;
}

export interface SpawnFakeAcpOptions {
  /** Extra env for the child (merged over process.env). `HARNESS_SPAWN_ID` is echoed in the initialize result `_meta.spawnId` (§10.1). */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Reuse an existing dir for scenario.json instead of a fresh mkdtemp. */
  readonly scenarioDir?: string;
}

export interface SpawnedFakeAcp {
  readonly child: ChildProcessWithoutNullStreams;
  readonly scenarioPath: string;
  /** SIGKILLs the child (if alive) and removes the mkdtemp'd scenario dir. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Spawn `node fake-acp-child.mjs <scenario.json>` with piped stdio. The
 * caller owns the protocol conversation on `child.stdin`/`child.stdout`;
 * always `await cleanup()` (idempotent) when done.
 */
export async function spawnFakeAcpChild(
  scenario: FakeAcpScenario,
  options: SpawnFakeAcpOptions = {},
): Promise<SpawnedFakeAcp> {
  const ownsScenarioDir = options.scenarioDir === undefined;
  const scenarioPath = await writeScenarioFile(scenario, options.scenarioDir);
  const child = spawn(process.execPath, [fakeAcpChildPath(), scenarioPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
  }) as ChildProcessWithoutNullStreams;

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        // Guard against a process that already exited between the check and kill.
        if (child.exitCode !== null || child.signalCode !== null) resolve();
      });
    }
    if (ownsScenarioDir) {
      await rm(path.dirname(scenarioPath), { recursive: true, force: true });
    }
  };

  return { child, scenarioPath, cleanup };
}
