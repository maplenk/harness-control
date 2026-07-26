/**
 * How an agent OPERATION is read — its ACP title shape and its shell grammar —
 * as ONE implementation.
 *
 * Everything here was lifted VERBATIM out of `adapters/grok/command.ts`, where
 * it had grown into the read-only classifier's private scanner. It moved for the
 * reason `lib/path-containment.ts` moved before it: a second consumer appeared
 * (the §3.1 permanent-deny classifier, `lib/permanent-deny.ts`), and a security
 * scanner with two copies is a scanner where fixing one changes nothing. The F11
 * pre-quote character scan already lived in two places once in this repo, and
 * that is exactly what it cost.
 *
 * NOTHING in this module decides policy. It answers only "what did the agent
 * write", and it answers `undefined` — never a guess — when it cannot tell.
 * Policy (what is admissible, what is permanently refused) lives in
 * `permanent-deny.ts` and in the provider classifiers.
 *
 * The quote/expansion rules, and why each is load-bearing, are documented at the
 * function that implements them; they are unchanged from the reviewed originals.
 */

// ---------------------------------------------------------------------------
// ACP operation titles
// ---------------------------------------------------------------------------
const PERMISSION_TITLE_PREFIX = 'Execute `';
const PERMISSION_TITLE_SUFFIX = '`';

/** Mirrors `isWorkspaceWriteOperation`'s title shape (`adapters/acp/session.ts`),
 * capturing the asserted path so a payload can be bound to it. */
const STRUCTURED_FILE_TITLE_RE = /^(?:Write|Edit) `([^`\r\n]+)`$/;

/**
 * What an operation title POSITIVELY is. `unrecognized` is a first-class answer
 * and never means "harmless": a title we cannot read is a title we know nothing
 * about (house rule 2).
 */
export type OperationTitle =
  | { readonly kind: 'shell'; readonly command: string }
  | { readonly kind: 'structured_file'; readonly path: string }
  | { readonly kind: 'unrecognized' };

/**
 * MED-9 — recover the command from an `Execute \`…\`` title STRUCTURALLY, by
 * stripping the fixed prefix and suffix, rather than with a capture that forbade
 * backticks in the interior (`/^Execute \`([^\`\r\n]+)\`$/`).
 *
 * That capture made a literal backtick unclassifiable ANYWHERE, including inside
 * single quotes where the shell treats it as an ordinary byte — so `ls 'x\`y'`
 * could never be approved no matter how obviously read-only it is. Judging
 * interior bytes is the quote-aware scanners' job, not the wrapper's: they still
 * reject an unquoted backtick (command substitution) and every control byte.
 *
 * The prefix/suffix are exact and the interior must be non-empty, so the title
 * shape is as strictly bounded as before.
 */
export function commandFromPermissionTitle(operation: string): string | undefined {
  const trimmed = operation.trim();
  if (!trimmed.startsWith(PERMISSION_TITLE_PREFIX) || !trimmed.endsWith(PERMISSION_TITLE_SUFFIX)) {
    return undefined;
  }
  const command = trimmed.slice(PERMISSION_TITLE_PREFIX.length, trimmed.length - PERMISSION_TITLE_SUFFIX.length);
  // CR/LF never belong in a single-line title; the scanners reject them anyway,
  // but keeping the check here preserves the old wrapper's guarantee exactly.
  if (command.length === 0 || command.includes('\r') || command.includes('\n')) return undefined;
  return command;
}

/** The path a structured `Write`/`Edit` title asserts, or `undefined`. */
export function pathFromStructuredFileTitle(operation: string): string | undefined {
  return STRUCTURED_FILE_TITLE_RE.exec(operation.trim())?.[1];
}

/**
 * The ONE reader of an operation title. Both the Grok payload veto and the
 * permanent-deny classifier route through it, so the two cannot disagree about
 * what a shell request or a structured file write looks like.
 */
export function parseOperationTitle(operation: string | undefined): OperationTitle {
  if (operation === undefined) return { kind: 'unrecognized' };
  const command = commandFromPermissionTitle(operation);
  if (command !== undefined) return { kind: 'shell', command };
  const target = pathFromStructuredFileTitle(operation);
  if (target !== undefined) return { kind: 'structured_file', path: target };
  return { kind: 'unrecognized' };
}

// ---------------------------------------------------------------------------
// Shell grammar
// ---------------------------------------------------------------------------
export const MAX_SHELL_COMMAND_BYTES = 8_192;
export const MAX_SHELL_SEGMENTS = 24;

/**
 * Redirections that cannot name a file to write.
 *
 * `>/dev/null` and friends discard; `2>&1` and `1>&2` DUPLICATE a file
 * descriptor onto another and touch the filesystem not at all — strictly safer
 * than the `/dev/null` forms already admitted here, which at least name a path.
 *
 * The `&`-forms were missing, and `2>&1` is in essentially every exploratory
 * command an agent writes. Measured on dogfood run `run_c4648778`:
 * `git show --stat <tag> 2>/dev/null` was ADMITTED while the same command with
 * `2>&1` was REFUSED, and because a compound is admitted only when every segment
 * is, one `2>&1` denied the whole request. That ended the implementor turn with
 * nothing written — three times, across the round and two resumes.
 *
 * Deliberately NOT admitted: `2>&3` or any other descriptor number. Only 1 and 2
 * are known to be the pipes the host itself created; a higher descriptor could
 * have been opened onto a file by the caller, and duplicating onto it would
 * write. Refusing those costs an agent a rewrite it can trivially do.
 */
export const SAFE_NULL_REDIRECTIONS: ReadonlySet<string> = new Set([
  '>/dev/null',
  '1>/dev/null',
  '2>/dev/null',
  '&>/dev/null',
  '2>&1',
  '1>&2',
]);

export interface ShellToken {
  readonly value: string;
  /** The token contained AT LEAST ONE quoted span. Never sufficient on its own —
   * see `unquotedRedirect` (BLOCKER-1). */
  readonly quoted: boolean;
  /**
   * BLOCKER-1: the token contains a `>` or `<` that appeared OUTSIDE quotes,
   * i.e. a real shell redirection OPERATOR. Tracked per CHARACTER because a
   * token can mix quoted and unquoted spans with no whitespace between them
   * (`echo '$HOME'>owned.txt` is ONE token), and a single whole-token `quoted`
   * flag let such a token inherit blanket-quoted status — which
   * `stripSafeRedirections` read as "no redirection here", classifying a real
   * WRITE as read-only.
   *
   * This mirrors the shell's own rule exactly: token recognition happens BEFORE
   * quote removal, so an operator is one that appears outside quotes. A `>` the
   * user quoted is an ordinary argument byte and stays admissible.
   */
  readonly unquotedRedirect: boolean;
}

export function splitShellSegments(command: string): readonly string[] | undefined {
  if (Buffer.byteLength(command, 'utf8') > MAX_SHELL_COMMAND_BYTES) return undefined;
  const segments: string[] = [];
  let quote: "'" | '"' | undefined;
  let start = 0;
  const push = (end: number): boolean => {
    const segment = command.slice(start, end).trim();
    if (segment.length === 0) return false;
    segments.push(segment);
    return segments.length <= MAX_SHELL_SEGMENTS;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) return undefined;
    // Control bytes are unacceptable in EVERY context — quoting cannot make a
    // NUL or an embedded newline a legitimate literal.
    if (char === '\0' || char === '\n' || char === '\r') return undefined;
    // F11: quote state FIRST. A POSIX SINGLE-quoted span is expansion-free — the
    // shell performs no parameter/command substitution and no escape processing
    // inside it — so `$`, `\` and a backtick there are ordinary argument bytes,
    // and so are `;`/`|`/`&`/`(`/`<`. Treating the span as an opaque literal is
    // therefore exactly as safe as the old blanket rejection, and it is what
    // makes a quoted regex (`rg -n 'a\.b|c$'`) classifiable at all. The scan
    // still ends the span only at the closing quote, so nothing inside it can
    // introduce a second, unclassified command.
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    // OUTSIDE single quotes — including INSIDE double quotes, where the shell
    // DOES expand — the conservative rejection is unchanged.
    if (char === '`' || char === '$' || char === '\\') return undefined;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '<' || char === '#' || char === '(' || char === ')' || char === '{' || char === '}') {
      return undefined;
    }
    if (char === '&') {
      // An `&` adjacent to a `>` belongs to a REDIRECTION, not to the control
      // grammar: `2>&1` / `1>&2` duplicate a descriptor, `&>` targets both
      // streams. Let those through as ordinary token bytes so the redirection
      // allowlist in `stripSafeRedirections` decides them — it admits only the
      // exact discard/duplicate forms, so `&>out.txt` is still refused there.
      //
      // Without this the bare-`&` rejection below fired FIRST and made every
      // command containing `2>&1` unclassifiable. That is not theoretical: it
      // denied three consecutive implementor turns on run_c4648778, each of
      // which ended with nothing written, while the same commands written with
      // `2>/dev/null` were admitted.
      if (command[index - 1] === '>' || command[index + 1] === '>') continue;
      // A LONE `&` still backgrounds a process, which is outside anything this
      // classifier can reason about. Only `&&` may split a segment.
      if (command[index + 1] !== '&' || !push(index)) return undefined;
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === '|') {
      const width = command[index + 1] === '|' ? 2 : 1;
      if (!push(index)) return undefined;
      index += width - 1;
      start = index + 1;
      continue;
    }
    if (char === ';') {
      if (!push(index)) return undefined;
      start = index + 1;
    }
  }
  if (quote !== undefined || !push(command.length)) return undefined;
  return segments;
}

export function tokenizeShellSegment(segment: string): readonly ShellToken[] | undefined {
  const tokens: ShellToken[] = [];
  let quote: "'" | '"' | undefined;
  let value = '';
  let quoted = false;
  // BLOCKER-1: per-CHARACTER provenance. Set only by a `>`/`<` seen while NOT
  // inside quotes, so a token that mixes spans (`'$HOME'>owned.txt`) can never
  // launder its operator through the whole-token `quoted` flag.
  let unquotedRedirect = false;
  const push = (): void => {
    if (value.length === 0 && !quoted) return;
    tokens.push({ value, quoted, unquotedRedirect });
    value = '';
    quoted = false;
    unquotedRedirect = false;
  };

  for (const char of segment) {
    // Same ordering as `splitShellSegments` (F11), for the same reason: control
    // bytes are always fatal, a SINGLE-quoted span is an opaque literal, and
    // everywhere else (including inside double quotes) expansion characters are
    // still refused. The literal bytes land in the token VALUE, so the
    // downstream checks — `stripSafeRedirections` (which only treats an
    // UNQUOTED `>`/`<` as a redirection) and `escapesWorktree` (which
    // inspects the resolved value, so `cat '/etc/passwd'` is still caught) —
    // see exactly what the shell will pass to the program.
    if (char === '\0' || char === '\n' || char === '\r') return undefined;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else value += char;
      quoted = true;
      continue;
    }
    if (char === '`' || char === '$' || char === '\\') return undefined;
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else value += char;
      quoted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      push();
      continue;
    }
    // Unquoted (we are past every in-quote branch above): a redirection
    // character here is a real OPERATOR, whatever else the token contains.
    if (char === '>' || char === '<') unquotedRedirect = true;
    value += char;
  }
  if (quote !== undefined) return undefined;
  push();
  return tokens.length > 0 ? tokens : undefined;
}

/**
 * Drop the STANDALONE safe null redirections and refuse every other redirection.
 *
 * BLOCKER-1: the decision is driven by `token.unquotedRedirect` — per-character
 * provenance — not by the whole-token `quoted` flag. A token is dropped as a
 * safe null redirection only when it is STRUCTURALLY standalone: entirely
 * unquoted AND exactly one of the allowlisted forms. `echo x'2>/dev/nul'l` is a
 * mixed token that merely resembles one, and is refused. A `>`/`<` that appeared
 * INSIDE quotes never sets the flag, so `rg -n '>' src` keeps passing it through
 * as the ordinary argument the shell will pass to the program.
 */
export function stripSafeRedirections(tokens: readonly ShellToken[]): readonly string[] | undefined {
  const argv: string[] = [];
  for (const token of tokens) {
    // Q26: only a token that CARRIES a redirection operator is a candidate for
    // being dropped. A hypothetical redirection-free allowlist entry must reach
    // `argv` as the ordinary argument it is, never be silently stripped.
    if (token.unquotedRedirect) {
      if (!token.quoted && SAFE_NULL_REDIRECTIONS.has(token.value)) continue;
      return undefined;
    }
    argv.push(token.value);
  }
  return argv.length > 0 ? argv : undefined;
}

/**
 * The whole command as a list of per-segment argv vectors, or `undefined` when
 * ANY part of it could not be read. One entry per `&&`/`||`/`;`/`|` segment.
 *
 * `undefined` means EXACTLY "I could not determine what this runs" — never "it
 * runs nothing dangerous". Every caller must treat it as an unknown, not a pass.
 */
export function parseShellCommandArgv(command: string): readonly (readonly string[])[] | undefined {
  const segments = parseShellCommandSegments(command);
  if (segments === undefined) return undefined;
  const parsed: (readonly string[])[] = [];
  for (const segment of segments) {
    if (segment.kind !== 'argv') return undefined;
    parsed.push(segment.argv);
  }
  return parsed;
}

/** One `&&`/`||`/`;`/`|` segment, read or honestly not read. */
export type ShellSegmentParse =
  | { readonly kind: 'argv'; readonly argv: readonly string[] }
  | { readonly kind: 'unreadable'; readonly text: string };

/**
 * The same parse, but PER SEGMENT — an unreadable segment does not erase the
 * readable ones.
 *
 * `parseShellCommandArgv` is atomic on purpose: the read-only classifier admits
 * a compound only when EVERY segment is provably read-only, so one unreadable
 * segment is the end of the question. The permanent-deny classifier asks the
 * opposite question — "is anything here on the never-allowed list" — and for
 * that, discarding the segments we CAN read is a real loss: `ls > out.txt && rm
 * -rf src` would be reported as merely unknown, and unknown is the verdict §2.4
 * routes to operator review, while `rm -rf` must be permanently refused.
 *
 * `undefined` still means the command could not even be SPLIT into segments,
 * which is a whole-command unknown.
 */
export function parseShellCommandSegments(command: string): readonly ShellSegmentParse[] | undefined {
  const segments = splitShellSegments(command);
  if (segments === undefined) return undefined;
  return segments.map((segment) => {
    const tokens = tokenizeShellSegment(segment);
    if (tokens === undefined) return { kind: 'unreadable', text: segment } as const;
    const argv = stripSafeRedirections(tokens);
    return argv === undefined
      ? ({ kind: 'unreadable', text: segment } as const)
      : ({ kind: 'argv', argv } as const);
  });
}

/**
 * POSITIVELY-identified shell metasyntax that evaluates something this engine
 * cannot see: command substitution, parameter expansion, heredocs.
 *
 * This exists as a SEPARATE, earlier answer than "the tokenizer refused it",
 * because the two mean different things and §2.4 treats them differently. A
 * heredoc or a `$(…)` is on the permanent-deny list — never grantable, in any
 * tier. A command the tokenizer merely could not read is UNPROVABLE: a future
 * operator review may still look at it. Collapsing the two would either make
 * every unreadable command permanently ungrantable, or make a real substitution
 * merely "unknown".
 *
 * Quote-aware in exactly the way the tokenizer is: a single-quoted span is an
 * opaque literal (the shell expands nothing inside it), so `rg 'cost: $5'` is
 * not a substitution, while `"$HOME"` is.
 *
 * A LONE `$` (as in the anchored regex `rg 'x$'` written unquoted) is NOT an
 * expansion and is deliberately not matched here: it falls through to the
 * tokenizer, which refuses it, and it stays unprovable rather than permanently
 * denied.
 */
export function detectOpaqueEvaluatorSyntax(command: string): string | undefined {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) return undefined;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      // fall through: a `$` INSIDE double quotes still expands.
    } else if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '`') return 'command substitution (backtick)';
    if (char === '<' && command[index + 1] === '<') return 'heredoc';
    if (char === '$') {
      const next = command[index + 1];
      if (next === '(') return 'command substitution ($(...))';
      if (next === '{') return 'parameter expansion (${...})';
      if (next !== undefined && /[A-Za-z0-9_@*?#!$-]/u.test(next)) return 'parameter expansion ($NAME)';
    }
  }
  return undefined;
}
