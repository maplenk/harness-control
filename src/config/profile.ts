/**
 * Role-profile loader (PLAN.md §3.4, §8).
 *
 * Parses `profiles/*.md` — frontmatter `{name, description, harness, model,
 * roleReminder}` + a body of `## `-level sections — and validates it against
 * the Augment-derived template shape §8 requires:
 *   Role → Hard Rules (numbered, first) → Workflow (FOLLOW IN ORDER) →
 *   Spec Format | Output Format → Tools → Completion.
 *
 * Presence AND relative order of the six required sections are both
 * validated (order matters: it's the same "read this top-to-bottom" contract
 * the coordinator/implementor/verifier prompts themselves must follow), plus
 * a light structural check that Hard Rules and Workflow are numbered lists
 * (matching every Augment precedent, `~/.augment/specialists/*.md`).
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { err, isErr, ok, type Result } from '../lib/result.js';
import { splitFrontmatter } from './frontmatter.js';

// ---------------------------------------------------------------------------
// Frontmatter shape (PLAN §8 intro: "{name, description, harness, model,
// roleReminder}")
// ---------------------------------------------------------------------------
const profileFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    /** Harness/adapter default for this role; see profiles/*.md for the
     * 'config-default' sentinel convention (no hard-coded default, §18/D3). */
    harness: z.string().min(1),
    model: z.string().min(1),
    /** Re-injected every turn per §8 (called out explicitly for Coordinator;
     * applied uniformly here since all three profiles share one template). */
    roleReminder: z.string().min(1),
  })
  .strict()
  .readonly();

export type ProfileFrontmatter = z.infer<typeof profileFrontmatterSchema>;

/** Sentinel `harness`/`model` value meaning "resolved by src/config at run
 * time, per PLAN §18: profile required by config; no hard-coded default
 * model" — never a concrete harness/model literal baked into the prompt. */
export const CONFIG_DEFAULT = 'config-default';

// ---------------------------------------------------------------------------
// Required body sections (PLAN §8 intro), in order.
// ---------------------------------------------------------------------------
export type ProfileSectionSlot = 'role' | 'hardRules' | 'workflow' | 'format' | 'tools' | 'completion';

interface SlotSpec {
  readonly slot: ProfileSectionSlot;
  readonly label: string;
  readonly matches: (normalizedHeading: string) => boolean;
}

/** Ordered per §8: Role → Hard Rules → Workflow → Format → Tools → Completion. */
export const PROFILE_SECTION_SLOTS: readonly SlotSpec[] = [
  { slot: 'role', label: 'Role', matches: (h) => h === 'role' },
  { slot: 'hardRules', label: 'Hard Rules', matches: (h) => h === 'hard rules' },
  { slot: 'workflow', label: 'Workflow', matches: (h) => h === 'workflow' },
  {
    slot: 'format',
    label: 'Spec Format (coordinator) or Output Format (implementor/verifier)',
    matches: (h) => h === 'spec format' || h === 'output format',
  },
  { slot: 'tools', label: 'Tools', matches: (h) => h === 'tools' },
  { slot: 'completion', label: 'Completion', matches: (h) => h === 'completion' },
];

export interface ProfileSection {
  readonly heading: string;
  /** Heading lowercased with a trailing "(...)" annotation stripped, e.g.
   * "Workflow (FOLLOW IN ORDER)" → "workflow". */
  readonly normalized: string;
  readonly body: string;
  /** 1-based line number of the `## ` heading within the body text. */
  readonly line: number;
}

const SECTION_HEADING = /^## (.+?)\s*$/;

function normalizeHeading(heading: string): string {
  return heading
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim()
    .toLowerCase();
}

/** Split a markdown body into its top-level (`## `) sections, in document order. */
export function splitSections(markdownBody: string): readonly ProfileSection[] {
  const lines = markdownBody.split(/\r?\n/);
  const sections: ProfileSection[] = [];
  let current: { heading: string; normalized: string; line: number; bodyLines: string[] } | undefined;

  const flush = (): void => {
    if (!current) return;
    sections.push({
      heading: current.heading,
      normalized: current.normalized,
      body: current.bodyLines.join('\n').trim(),
      line: current.line,
    });
  };

  for (const [index, line] of lines.entries()) {
    const headingMatch = SECTION_HEADING.exec(line);
    const heading = headingMatch?.[1];
    if (headingMatch && heading !== undefined) {
      flush();
      current = { heading, normalized: normalizeHeading(heading), line: index + 1, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  flush();

  return sections;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export interface ProfileIssue {
  readonly code:
    | 'frontmatter_invalid'
    | 'empty_body'
    | 'missing_section'
    | 'section_out_of_order'
    | 'hard_rules_not_numbered'
    | 'workflow_not_numbered';
  readonly message: string;
  readonly slot?: ProfileSectionSlot;
}

const NUMBERED_LIST_ITEM = /^\s*\d+\.\s+\S/m;

/** Presence + order of the six §8 slots, plus numbered-list shape for the
 * two slots PLAN §8 calls out explicitly ("Hard Rules (numbered, first)",
 * "Workflow (FOLLOW IN ORDER)"). */
export function validateSections(sections: readonly ProfileSection[]): readonly ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const foundAt = new Map<ProfileSectionSlot, number>();
  let searchFrom = 0;

  for (const spec of PROFILE_SECTION_SLOTS) {
    const foundIndex = sections.findIndex((s, i) => i >= searchFrom && spec.matches(s.normalized));
    if (foundIndex === -1) {
      const anywhereIndex = sections.findIndex((s) => spec.matches(s.normalized));
      if (anywhereIndex === -1) {
        issues.push({
          code: 'missing_section',
          slot: spec.slot,
          message: `Missing required section: ${spec.label}`,
        });
      } else {
        issues.push({
          code: 'section_out_of_order',
          slot: spec.slot,
          message: `Section '${spec.label}' is out of order (must follow every earlier §8 section)`,
        });
      }
      continue;
    }
    foundAt.set(spec.slot, foundIndex);
    searchFrom = foundIndex + 1;
  }

  const hardRulesIndex = foundAt.get('hardRules');
  const hardRulesSection = hardRulesIndex !== undefined ? sections[hardRulesIndex] : undefined;
  if (hardRulesSection !== undefined && !NUMBERED_LIST_ITEM.test(hardRulesSection.body)) {
    issues.push({
      code: 'hard_rules_not_numbered',
      slot: 'hardRules',
      message: "Hard Rules section must be a numbered list (e.g. '1. ...')",
    });
  }

  const workflowIndex = foundAt.get('workflow');
  const workflowSection = workflowIndex !== undefined ? sections[workflowIndex] : undefined;
  if (workflowSection !== undefined && !NUMBERED_LIST_ITEM.test(workflowSection.body)) {
    issues.push({
      code: 'workflow_not_numbered',
      slot: 'workflow',
      message: "Workflow section must be numbered steps (FOLLOW IN ORDER)",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export interface Profile {
  readonly frontmatter: ProfileFrontmatter;
  readonly sections: readonly ProfileSection[];
  readonly body: string;
  readonly sourcePath?: string;
}

/** Find a required §8 section by slot (e.g. the resolved 'format' slot is
 * "Spec Format" for coordinator, "Output Format" for implementor/verifier). */
export function findSection(profile: Profile, slot: ProfileSectionSlot): ProfileSection | undefined {
  const spec = PROFILE_SECTION_SLOTS.find((s) => s.slot === slot);
  if (!spec) return undefined;
  return profile.sections.find((s) => spec.matches(s.normalized));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse + validate a profile document's full text. Never throws. */
export function parseProfile(source: string, sourcePath?: string): Result<Profile, readonly ProfileIssue[]> {
  const splitResult = splitFrontmatter(source);
  if (isErr(splitResult)) {
    const { line, message } = splitResult.error;
    return err([
      {
        code: 'frontmatter_invalid',
        message: line !== undefined ? `${message} (line ${line})` : message,
      },
    ]);
  }
  const { frontmatter: rawFrontmatter, body } = splitResult.value;

  const frontmatterResult = profileFrontmatterSchema.safeParse(rawFrontmatter);
  if (!frontmatterResult.success) {
    return err(
      frontmatterResult.error.issues.map((issue) => ({
        code: 'frontmatter_invalid' as const,
        message: `frontmatter.${issue.path.join('.')}: ${issue.message}`,
      })),
    );
  }

  if (body.trim().length === 0) {
    return err([{ code: 'empty_body', message: 'Profile body is empty; expected the required §8 sections.' }]);
  }

  const sections = splitSections(body);
  const sectionIssues = validateSections(sections);
  if (sectionIssues.length > 0) {
    return err(sectionIssues);
  }

  return ok({
    frontmatter: frontmatterResult.data,
    sections,
    body,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  });
}

/** Read + parse + validate a profile file from disk. Never throws. */
export function loadProfileFile(filePath: string): Result<Profile, readonly ProfileIssue[]> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    return err([
      { code: 'frontmatter_invalid', message: `Cannot read profile file '${filePath}': ${errorMessage(error)}` },
    ]);
  }
  return parseProfile(raw, filePath);
}
