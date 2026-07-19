/**
 * Content-addressed artifact store (PLAN.md §12.1, §12.2 atomicity).
 *
 * The ergonomic, async, auto-redacting facade over the CAS: callers hand it
 * `string | Buffer` content and get an `Artifact` record back. The actual
 * on-disk write (layout, fsync-before-rename atomicity) lives in the ONE
 * shared implementation, `./cas-fs.ts` — see that module's doc comment for
 * the full write-path contract and for why `SqliteArtifactRepository`
 * (../persistence/artifact-repository.ts) delegates to the exact same
 * primitive rather than a second, independent one (P1 verifier punch-list
 * item 1: "UNIFY the two CAS implementations").
 *
 * Only after a write resolves does the caller (src/checkpoint/writer.ts, or
 * any caller going through `../persistence/artifact-repository.ts` for
 * quota-checked writes) construct an event carrying the hash, which is what
 * makes "artifact-without-event is invisible to replay and GC'd; event-
 * without-artifact is impossible" true in practice.
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { Clock } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import { artifactHash, type ArtifactHash, type RunId } from '../domain/ids.js';
import type { Artifact, ArtifactKind } from '../domain/entities.js';
import { DEFAULT_REDACTION_CONFIG, redactText, type RedactionConfig } from '../redaction/redact.js';
import { sha256Hex } from './hash.js';
import { objectPath, objectsDir, writeObjectSync } from './cas-fs.js';

const DEFAULT_PREVIEW_CHARS = 512;

export type ArtifactContent = string | Buffer;

export interface PutArtifactInput {
  readonly content: ArtifactContent;
  readonly kind: ArtifactKind;
  readonly runId?: RunId;
  /**
   * Caller attests `content` is already redacted (e.g. the caller ran
   * `redactText`/`redactDeep` itself with an equivalent config, or the
   * content is binary and inherently outside the redactor's reach). When
   * `content` is a string and this is omitted, the store redacts it itself:
   * the store is an enforcement point for §17.1's "redaction before every
   * sink" for the artifact-file sink, not just an optional convenience.
   * Binary (`Buffer`) content REQUIRES this to be `true` — arbitrary bytes
   * cannot be safely text-redacted without risking corruption.
   */
  readonly preRedacted?: boolean;
  /** Bounded preview length kept alongside metadata (§12.1); default 512. Pass 0 to omit the preview entirely. */
  readonly previewChars?: number;
}

export interface ObjectListEntry {
  readonly hash: ArtifactHash;
  readonly filePath: string;
  readonly sizeBytes: number;
}

export interface GcResult {
  readonly scanned: number;
  readonly removed: readonly ArtifactHash[];
  readonly removedBytes: number;
}

/**
 * The minimal write surface flow code depends on: `put` content, get back the
 * immutable `Artifact` record. Satisfied structurally by the bare
 * `ArtifactStore` below AND by quota-aware adapters over the database
 * `ArtifactRepository` (W1-F5: the shipped CLI routes every flow artifact
 * write — spec, exploration, evidence — through §12.1 quota admission instead
 * of this store's unmetered path).
 */
export interface ArtifactSink {
  put(input: PutArtifactInput): Promise<Artifact>;
}

export interface ArtifactStoreOptions {
  readonly rootDir: string;
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly redactionConfig?: RedactionConfig;
}

export class ArtifactStore {
  readonly #rootDir: string;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #redactionConfig: RedactionConfig;

  constructor(options: ArtifactStoreOptions) {
    this.#rootDir = options.rootDir;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#redactionConfig = options.redactionConfig ?? DEFAULT_REDACTION_CONFIG;
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  /** Delegates to the ONE canonical CAS path shape (./cas-fs.ts). */
  pathForHash(hash: string): string {
    return objectPath(this.#rootDir, hash);
  }

  async has(hash: ArtifactHash): Promise<boolean> {
    return fileExists(this.pathForHash(String(hash)));
  }

  async get(hash: ArtifactHash): Promise<Buffer> {
    const target = this.pathForHash(String(hash));
    try {
      return await readFile(target);
    } catch (error) {
      throw new Error(`ArtifactStore.get: no object for hash ${String(hash)} (${(error as Error).message})`);
    }
  }

  async getText(hash: ArtifactHash): Promise<string> {
    return (await this.get(hash)).toString('utf8');
  }

  /**
   * Write content-addressed bytes durably, then return the Artifact record
   * describing them. The returned `hash` is available to the caller only
   * AFTER the fsync+rename below has completed — callers that need the
   * "fsync happens before the referencing event is even constructible"
   * ordering (§12.2) get it for free by `await`-ing this call before
   * building that event (see src/checkpoint/writer.ts).
   */
  async put(input: PutArtifactInput): Promise<Artifact> {
    let bytes: Buffer;
    let previewSource: string | undefined;

    if (typeof input.content === 'string') {
      const text = input.preRedacted === true ? input.content : redactText(input.content, this.#redactionConfig);
      bytes = Buffer.from(text, 'utf8');
      previewSource = text;
    } else {
      if (input.preRedacted !== true) {
        throw new Error(
          'ArtifactStore.put: binary content requires preRedacted:true — binary bytes cannot be safely text-redacted',
        );
      }
      bytes = input.content;
      previewSource = undefined;
    }

    const hash = sha256Hex(bytes);
    await this.#writeContentAddressed(hash, bytes);

    const previewChars = input.previewChars ?? DEFAULT_PREVIEW_CHARS;
    // §17.1 REDACT BEFORE TRUNCATE invariant (audited): `previewSource` is
    // the POST-redaction text, so this slice can cut a `[REDACTED:...]`
    // marker but never un-terminate a quote ahead of redaction.
    const preview =
      previewSource !== undefined && previewChars > 0 ? previewSource.slice(0, previewChars) : undefined;

    return {
      hash: artifactHash(hash),
      kind: input.kind,
      sizeBytes: bytes.byteLength,
      redacted: true,
      createdAt: this.#clock.nowIso(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(preview !== undefined ? { preview } : {}),
    };
  }

  /**
   * Delegates the actual byte-durability step to the shared synchronous
   * primitive (./cas-fs.ts) — the SAME one `SqliteArtifactRepository` uses.
   * Wrapped in `async` only for API stability (existing callers `await`
   * `put()`); no genuine async I/O happens here anymore.
   */
  async #writeContentAddressed(hash: string, bytes: Buffer): Promise<void> {
    writeObjectSync(this.#rootDir, hash, bytes, this.#ids.nextId('artifact-tmp'));
  }

  /** Enumerate every object currently durable in the store (used by GC and tests). */
  async *listHashes(): AsyncGenerator<ObjectListEntry> {
    const root = objectsDir(this.#rootDir);
    const shard1 = await safeReaddir(root);
    for (const s1 of shard1) {
      const dir1 = path.join(root, s1);
      const shard2 = await safeReaddir(dir1);
      for (const s2 of shard2) {
        const dir2 = path.join(dir1, s2);
        const files = await safeReaddir(dir2);
        for (const file of files) {
          const filePath = path.join(dir2, file);
          const info = await stat(filePath);
          if (info.isFile()) {
            yield { hash: artifactHash(file), filePath, sizeBytes: info.size };
          }
        }
      }
    }
  }

  /**
   * Reference-aware GC sweep (§12.1): remove every stored object whose hash
   * is NOT in `liveHashes`. Callers compute `liveHashes` from committed
   * events/entities only — e.g. `collectReferencedArtifactHashes` in
   * gc.ts run over the ACTUALLY-committed event log. An artifact whose
   * referencing event never committed (crash between artifact write and
   * event append, §12.2) is therefore absent from `liveHashes` and gets
   * swept here — "orphan artifact invisible+GC'd".
   */
  async gcSweep(liveHashes: ReadonlySet<ArtifactHash>): Promise<GcResult> {
    const removed: ArtifactHash[] = [];
    let removedBytes = 0;
    let scanned = 0;
    for await (const entry of this.listHashes()) {
      scanned++;
      if (!liveHashes.has(entry.hash)) {
        await rm(entry.filePath, { force: true });
        removed.push(entry.hash);
        removedBytes += entry.sizeBytes;
      }
    }
    return { scanned, removed, removedBytes };
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
