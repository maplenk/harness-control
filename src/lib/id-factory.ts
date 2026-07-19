import { randomUUID } from 'node:crypto';

/**
 * Injectable id source (determinism rule: no direct Math.random()/UUID calls
 * in domain logic — always take an IdFactory). `kind` is a short slug
 * ("run", "seg", "idem", …); typed wrappers in `src/domain/ids.ts` brand the
 * returned strings.
 */
export interface IdFactory {
  nextId(kind: string): string;
}

/**
 * Deterministic factory for tests: per-kind monotonically increasing counters
 * producing stable ids like `run_000001`, `seg_000001`, `seg_000002`.
 */
export class DeterministicIdFactory implements IdFactory {
  readonly #counters = new Map<string, number>();
  readonly #pad: number;

  constructor(pad = 6) {
    this.#pad = pad;
  }

  nextId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}_${String(next).padStart(this.#pad, '0')}`;
  }

  reset(): void {
    this.#counters.clear();
  }
}

/**
 * Production factory. This class is the ONLY sanctioned direct use of
 * randomness for id generation; everything else receives an `IdFactory`.
 */
export class RandomIdFactory implements IdFactory {
  nextId(kind: string): string {
    return `${kind}_${randomUUID()}`;
  }
}
