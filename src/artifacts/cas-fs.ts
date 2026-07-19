/**
 * Synchronous, fsync-before-rename content-addressed filesystem primitive
 * (PLAN.md §12.2 "artifact fsync first"; P1 verifier punch-list item 1:
 * "UNIFY the two CAS implementations").
 *
 * This is the ONE place in the codebase that actually touches bytes on disk
 * for a content-addressed artifact. `ArtifactStore` (./store.ts — ergonomic
 * async facade with auto-redaction, no quota tracking) and
 * `SqliteArtifactRepository` (../persistence/artifact-repository.ts — sync
 * facade with SQL-tracked quota admission) both delegate their actual
 * byte-durability step to `writeObjectSync` below, so a hash written
 * through either surface — pointed at the same `rootDir` — is readable
 * through the other. There is exactly one physical CAS layout per root
 * directory, not two independently-shaped ones.
 *
 * Layout: `<rootDir>/objects/<hash[0:2]>/<hash[2:4]>/<hash>` (git-style
 * sharding, keeps any single directory from growing unbounded) plus
 * `<rootDir>/tmp/` staging — deliberately a SIBLING of `objects/` under the
 * same `rootDir`, never elsewhere, so the rename below is guaranteed to
 * stay on one filesystem (POSIX `rename()` is only atomic within one
 * device; a staging dir elsewhere risks EXDEV or a silent non-atomic copy
 * fallback).
 *
 * Write path: write the full content to a uniquely-named temp file, fsync
 * the file descriptor, close it, THEN rename into the final content-
 * addressed path. A crash at any point before the rename leaves at most an
 * orphaned temp file — NEVER a partially written object at the addressed
 * path — so a reader either sees the complete object or nothing, never a
 * torn write.
 *
 * Deliberately synchronous (not `node:fs/promises`): `SqliteArtifactRepository`
 * calls this from inside a synchronous `SqlDriver.transaction()` callback so
 * the quota check and the byte write compose with the rest of that
 * repository's logic without an async/sync boundary (see ../persistence/
 * driver.ts's doc comment on why both drivers are synchronous,
 * single-connection). `ArtifactStore.put()` stays `async` at its public
 * surface (existing callers/tests `await` it and rely on synchronous throws
 * being wrapped into promise rejections) but performs no genuine async I/O
 * internally anymore — it calls straight through to the same synchronous
 * primitive.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SHARD_LEN = 2;

export function objectsDir(rootDir: string): string {
  return path.join(rootDir, 'objects');
}

export function tmpStagingDir(rootDir: string): string {
  return path.join(rootDir, 'tmp');
}

/** `<rootDir>/objects/<hash[0:2]>/<hash[2:4]>/<hash>` — the ONE canonical CAS path shape. */
export function objectPath(rootDir: string, hash: string): string {
  return path.join(objectsDir(rootDir), hash.slice(0, SHARD_LEN), hash.slice(SHARD_LEN, SHARD_LEN * 2), hash);
}

export function objectExistsSync(rootDir: string, hash: string): boolean {
  return fs.existsSync(objectPath(rootDir, hash));
}

export function readObjectSync(rootDir: string, hash: string): Buffer {
  return fs.readFileSync(objectPath(rootDir, hash));
}

export interface WriteObjectResult {
  readonly path: string;
  /** True when the object was already durable (CAS dedup: no bytes were written this call). */
  readonly alreadyExisted: boolean;
}

/** Loops on `fs.writeSync` until every byte lands — a single call CAN return short. */
function writeFullySync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
  }
}

/**
 * Durably write `bytes` at `objectPath(rootDir, hash)` (§12.2 "artifact
 * fsync first"). `uniqueTag` disambiguates concurrent writers' temp
 * filenames (an injected id, a random uuid, ...) — a collision there would
 * only ever risk two writers stepping on each other's staging file, never a
 * corrupt final object, since the rename target is only ever reached after
 * each writer's own fsync completes. Idempotent: a hash that already exists
 * on disk short-circuits before any write (CAS dedup — this is also what
 * keeps quota accounting honest: callers that gate this behind an admission
 * check should skip the byte write entirely on rejection rather than rely
 * on this function alone).
 */
export function writeObjectSync(rootDir: string, hash: string, bytes: Buffer, uniqueTag: string): WriteObjectResult {
  const finalPath = objectPath(rootDir, hash);
  if (fs.existsSync(finalPath)) return { path: finalPath, alreadyExisted: true }; // CAS dedup

  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const stagingDir = tmpStagingDir(rootDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  const tmpPath = path.join(stagingDir, `${hash}.${uniqueTag}.tmp`);

  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    writeFullySync(fd, bytes);
    fs.fsyncSync(fd); // fsync BEFORE rename (§12.2 "artifact fsync first")
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    if (fs.existsSync(finalPath)) {
      // Lost a race with a concurrent writer of identical content — fine,
      // the object is durable either way; clean up our own staging file.
      fs.rmSync(tmpPath, { force: true });
      return { path: finalPath, alreadyExisted: true };
    }
    throw error;
  }
  return { path: finalPath, alreadyExisted: false };
}
