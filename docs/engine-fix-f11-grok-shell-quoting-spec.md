# Engine Fix — Grok Read-Only Classifier: Quote-Aware Character Scan (F11) — v1

**Status:** spec v1 — codex spec-review with F8/F9/F10, then implementation → codex diff-review → land
**Severity:** HIGH — a single backslash inside a quoted regex costs the entire run. One unclassifiable command → permission denied → turn cancelled → `no_deliverable` → the run dies before producing anything.
**Surfaced by:** slice-1a run, round 1, live 2026-07-25.
**Diagnostic provenance:** the `NoDeliverableError` abnormal-turn block gave the denied command verbatim — 30-second triage, entirely thanks to the F1–F6 diagnostics.

> **This supersedes an earlier wrong diagnosis.** The first read was "the classifier can't approve compound commands". That is **false**: `splitShellSegments` already admits compounds (`&&`, `||`, `|`, `;`) up to 24 segments / 8 KB, and every command grok actually used (`git show`, `rg`, `ls`, `head`, `2>/dev/null`) is on the read-only allowlist. Do not implement against the old story.

---

## 1. Problem

`src/adapters/grok/command.ts` classifies a shell command as read-only before the permission layer may auto-approve it. The classifier's character scan rejects `$`, backslash and backtick **anywhere in the string**, and it runs **before** quote state is consulted:

```ts
for (let index = 0; index < command.length; index += 1) {
  const char = command[index];
  if (char === undefined) return undefined;
  if (char === '\0' || char === '\n' || char === '\r' || char === '`' || char === '$' || char === '\\') {
    return undefined;                      // ← command.ts:130, BEFORE the quote check
  }
  if (quote !== undefined) { … }           // ← command.ts:133, too late
```

Grok's line contained `rg -n "3A\.1|…"` — one backslash inside a **quoted regex**. Unclassifiable → not read-only → permission denied → turn cancelled → no commit → `no_deliverable`.

This is a false negative in the safest possible direction, which is why it survived review: nothing unsafe was ever approved. But the cost is a dead run, and escaping inside quoted regex arguments is the single most natural thing a code-reading agent types.

**The same scan is duplicated in `tokenizeShellSegment` (`command.ts:179-181`), also before its own quote tracking (`:182`).** Fixing only the splitter changes nothing — the tokenizer rejects the command a few lines later. Both must change together.

---

## 2. Contract

### 2.1 Track quote state FIRST

In **both** `splitShellSegments` and `tokenizeShellSegment`, evaluate quote state before the character-rejection scan.

### 2.2 Single-quoted spans are opaque literals

Inside a POSIX single-quoted span there is **no expansion of any kind** — `$`, `\` and `` ` `` are inert characters, not shell metacharacters. Admit them there. This is not a relaxation of the safety property; it is the correct model of the shell the host actually runs.

### 2.3 Everything else stays exactly as conservative as today

- **Outside quotes:** `$`, `\`, `` ` `` → unclassifiable (unchanged).
- **Inside DOUBLE quotes:** `$`, `\`, `` ` `` → unclassifiable (unchanged). Double quotes *do* expand; treating them like single quotes would be a real weakening. The originally-denied double-quoted command must **still** be refused.
- **Everywhere, including inside single quotes:** `\0`, `\n`, `\r` → unclassifiable. Control characters are segment-structure and log-injection risks independent of expansion.
- Unterminated quotes → unclassifiable (already true, `command.ts:162` and `:202`).
- `<`, `#`, `(`, `)`, `{`, `}` outside quotes → unclassifiable (unchanged).
- Segment/byte caps (24 / 8192), the allowlists, `stripSafeRedirections`, and the `token.quoted` distinction that keeps a quoted `'>'` a literal → all unchanged.

### 2.4 Prompt companion (not engine behavior)

One line in the implementor prompt: prefer structured file tools over shelling out; when shelling, **single-quote pattern arguments** and avoid `$`, backslash, backtick and parentheses. The engine fix removes the trap; the prompt keeps agents out of the remaining corners.

---

## 3. Acceptance criteria (machine-checkable)

- **AC-1 the exact denied command, single-quoted** — grok's real line with the regex in single quotes classifies **read-only**.
- **AC-2 the exact denied command, as originally typed** — double-quoted with the backslash → **still refused**.
- **AC-3 unquoted metacharacters** — bare `$VAR`, bare backslash, bare backtick → **still refused**.
- **AC-4 single-quoted metacharacters are literal** — `rg -n 'a\.b'`, `grep 'costs $5'`, ``ls 'x`y'`` → classify read-only; a subsequent argv check still applies (a single-quoted *command name* off the allowlist is still refused).
- **AC-5 control characters** — `\n`, `\r`, `\0` inside single quotes → **still refused**.
- **AC-6 both functions fixed** — a command that passes the splitter must not be rejected by the tokenizer for the same reason. Assert through the public classifier, not the private helpers.
- **AC-7 no allowlist drift** — the safe-command and safe-git-subcommand sets are byte-identical before and after; a write command wrapped in single quotes is still refused.
- **AC-8 regression discipline** — AC-1 demonstrably FAILS on pre-F11 code.

---

## 4. Codex diff-review focus

1. **Escaped quotes.** `'\''` (the POSIX close-escape-reopen idiom) and `"\""` — does the quote-state machine agree with `/bin/sh` on where each span ends? A disagreement here is the only way this change could widen what gets approved.
2. **The two functions cannot drift.** Prefer one shared scanner over two parallel edits.
3. **Nested-quote confusion:** `'` inside a double-quoted span and `"` inside a single-quoted span must both be literal content.
4. **Interaction with `stripSafeRedirections`** — a single-quoted `'2>/dev/null'` must remain an argument, not a redirection.
