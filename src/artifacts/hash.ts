import { createHash } from 'node:crypto';

/**
 * sha256 hex digest of a UTF-8 string or raw bytes.
 *
 * Pure and deterministic: content hashing is NOT the kind of non-determinism
 * the "no Math.random()/Date.now() in domain logic" rule targets — it is a
 * deterministic function of the bytes, always injective-in-practice for CAS
 * purposes, with no clock/id/random dependency to inject.
 */
export function sha256Hex(content: string | Buffer): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(bytes).digest('hex');
}
