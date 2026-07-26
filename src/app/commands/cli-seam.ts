/**
 * CLI/test-only capabilities that must never appear on ApplicationCommand
 * (plan §3A.1 bullet 5: `--test-approve` is structurally impossible over HTTP).
 *
 * The synthetic-hash approve path and the wait-policy flags live here, gated
 * by a `CliCommandContext` whose origin is literally `'cli'`.
 *
 * `CliOnlySeam` is an opaque branded capability: only `grantCliOnlySeam` can
 * mint one (module-private unique-symbol brand). A plain object literal is
 * not assignable without an explicit cast, and the CLI port still re-checks
 * the live `CommandContext.origin` before using seam options.
 */
import { err, ok, type Result } from '../../lib/result.js';
import type { ApplicationError, CommandContext } from './types.js';

/** Context that has proven (at the type level) it came from the CLI. */
export type CliCommandContext = CommandContext & { readonly origin: 'cli' };

/**
 * Presentation / test / wait-policy bag that the CLI owns. Never part of
 * ApplicationCommand — only travels through this seam.
 */
export interface CliInvocationOptions {
  readonly json: boolean;
  readonly testApprove?: boolean;
  readonly noWait?: boolean;
  readonly wait?: boolean;
}

/**
 * Module-private brand — not re-exported as a value, not constructible
 * outside this module without an explicit greppable cast.
 */
declare const CLI_ONLY_SEAM_BRAND: unique symbol;

/**
 * Opaque CLI-only capability. Constructible solely via `grantCliOnlySeam`.
 * Callers holding a structural `{ origin: 'cli', options }` are rejected at
 * the type level; the brand is mintable only at the grant site below.
 */
export type CliOnlySeam = {
  readonly [CLI_ONLY_SEAM_BRAND]: true;
  readonly origin: 'cli';
  readonly options: CliInvocationOptions;
};

/**
 * Grant the CLI-only options bag. The parameter type rejects a non-cli origin
 * at compile time; the runtime check is a backstop against a forged cast.
 * This is the sole construction site for the `CliOnlySeam` brand.
 */
export function grantCliOnlySeam(
  context: CliCommandContext,
  options: CliInvocationOptions,
): Result<CliOnlySeam, ApplicationError> {
  // Runtime backstop: a cast can widen the parameter; refuse non-cli origins.
  const origin = (context as CommandContext).origin;
  if (origin !== 'cli') {
    return err({
      code: 'cli_only_capability',
      message:
        'CLI-only capability (e.g. --test-approve) requires origin "cli"; ' +
        `received origin "${origin}"`,
      details: { origin },
    });
  }
  // Sole mint of the opaque brand (explicit cast is greppable; nothing else
  // in-tree constructs a CliOnlySeam).
  return ok({
    origin: 'cli',
    options,
  } as CliOnlySeam);
}
