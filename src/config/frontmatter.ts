/**
 * Minimal frontmatter parser for role-profile documents (PLAN.md §3.4, §8).
 *
 * Deliberately NOT a general YAML parser: profile frontmatter is always a
 * flat block of `key: "quoted value"` lines — every field the Augment-derived
 * template uses (`name`, `description`, `harness`, `model`, `roleReminder`,
 * PLAN §22 `~/.augment/specialists/*.md`) is a single-line string. That keeps
 * this dependency-free and fully deterministic; anything more structured
 * than a flat string map is out of scope for role-profile frontmatter.
 */
import { err, ok, type Result } from '../lib/result.js';

export interface FrontmatterIssue {
  /** 1-based line number in the original document, when known. */
  readonly line?: number;
  readonly message: string;
}

export interface ParsedDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

const DOCUMENT_PATTERN = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?(?<body>[\s\S]*)$/;
const FIELD_PATTERN = /^([A-Za-z][A-Za-z0-9_]*):\s*"((?:[^"\\]|\\.)*)"\s*$/;

/**
 * Split a profile document into its frontmatter map and markdown body. Every
 * frontmatter value must be a double-quoted single-line JSON-escaped string.
 */
export function splitFrontmatter(source: string): Result<ParsedDocument, FrontmatterIssue> {
  const match = DOCUMENT_PATTERN.exec(source);
  if (!match?.groups) {
    return err({
      line: 1,
      message: 'Document must start with a frontmatter block delimited by --- lines.',
    });
  }

  const frontmatterBlock = match.groups.frontmatter ?? '';
  const body = match.groups.body ?? '';
  const frontmatter: Record<string, string> = {};

  const lines = frontmatterBlock.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const fieldMatch = FIELD_PATTERN.exec(line);
    if (!fieldMatch) {
      return err({
        line: index + 2, // +1 for the opening '---' line, +1 to make it 1-based
        message: `Malformed frontmatter line (expected key: "quoted value"): ${JSON.stringify(line)}`,
      });
    }
    const [, key, rawValue] = fieldMatch;
    if (key === undefined || rawValue === undefined) {
      return err({ line: index + 2, message: `Malformed frontmatter line: ${JSON.stringify(line)}` });
    }
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return err({ line: index + 2, message: `Duplicate frontmatter key '${key}'` });
    }
    try {
      frontmatter[key] = JSON.parse(`"${rawValue}"`) as string;
    } catch {
      return err({ line: index + 2, message: `Malformed quoted value for key '${key}'` });
    }
  }

  return ok({ frontmatter, body });
}
