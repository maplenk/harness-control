import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '../lib/result.js';
import { splitFrontmatter } from './frontmatter.js';
import {
  CONFIG_DEFAULT,
  PROFILE_SECTION_SLOTS,
  findSection,
  loadProfileFile,
  parseProfile,
  splitSections,
  validateSections,
  type ProfileSection,
} from './profile.js';

// ---------------------------------------------------------------------------
// splitFrontmatter (dependency-free flat key: "quoted value" parser)
// ---------------------------------------------------------------------------
describe('splitFrontmatter', () => {
  it('parses a minimal valid document', () => {
    const result = splitFrontmatter('---\nname: "X"\n---\nbody text');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.frontmatter).toEqual({ name: 'X' });
      expect(result.value.body).toBe('body text');
    }
  });

  it('decodes JSON-style escapes inside quoted values', () => {
    const result = splitFrontmatter('---\nname: "a \\"quoted\\" word"\n---\nbody');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.frontmatter.name).toBe('a "quoted" word');
  });

  it('rejects a document with no frontmatter delimiters', () => {
    const result = splitFrontmatter('## Role\nNo frontmatter here.');
    expect(isErr(result)).toBe(true);
  });

  it('rejects a malformed field line (unquoted value)', () => {
    const result = splitFrontmatter('---\nname: X\n---\nbody');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.line).toBe(2);
  });

  it('rejects a duplicate frontmatter key', () => {
    const result = splitFrontmatter('---\nname: "X"\nname: "Y"\n---\nbody');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toMatch(/Duplicate/);
  });

  it('tolerates blank lines inside the frontmatter block', () => {
    const result = splitFrontmatter('---\nname: "X"\n\ndescription: "Y"\n---\nbody');
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.frontmatter).toEqual({ name: 'X', description: 'Y' });
  });
});

// ---------------------------------------------------------------------------
// splitSections
// ---------------------------------------------------------------------------
describe('splitSections', () => {
  it('splits on H2 (## ) boundaries only, ignoring H3 and unheaded lines', () => {
    const sections = splitSections('intro text dropped\n## Role\nfirst para\n### Not a boundary\nmore\n## Tools\nlast');
    expect(sections.map((s) => s.heading)).toEqual(['Role', 'Tools']);
    expect(sections[0]?.body).toBe('first para\n### Not a boundary\nmore');
    expect(sections[1]?.body).toBe('last');
  });

  it('normalizes a trailing parenthetical off the heading for matching, keeping the raw heading intact', () => {
    const sections = splitSections('## Workflow (FOLLOW IN ORDER)\n1. step');
    expect(sections[0]?.heading).toBe('Workflow (FOLLOW IN ORDER)');
    expect(sections[0]?.normalized).toBe('workflow');
  });

  it('returns an empty list for a body with no H2 headings', () => {
    expect(splitSections('just some prose, no headings')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateSections — presence, order, and numbered-list shape (PLAN §8)
// ---------------------------------------------------------------------------
const VALID_FRONTMATTER =
  '---\nname: "Test"\ndescription: "d"\nharness: "config-default"\nmodel: "config-default"\nroleReminder: "r"\n---\n';

interface BodyParts {
  role: string;
  hardRules: string;
  workflow: string;
  format: string;
  tools: string;
  completion: string;
}

const DEFAULT_PARTS: BodyParts = {
  role: '## Role\n\nYou are a test role.\n',
  hardRules: '## Hard Rules\n\n1. Rule one.\n2. Rule two.\n',
  workflow: '## Workflow (FOLLOW IN ORDER)\n\n1. Step one.\n2. Step two.\n',
  format: '## Output Format\n\n- Field one\n- Field two\n',
  tools: '## Tools\n\nSome tools.\n',
  completion: '## Completion\n\nReport contract.\n',
};

function buildBody(order: readonly (keyof BodyParts)[], overrides: Partial<BodyParts> = {}): string {
  const parts = { ...DEFAULT_PARTS, ...overrides };
  return order.map((key) => parts[key]).join('\n');
}

const CANONICAL_ORDER: readonly (keyof BodyParts)[] = [
  'role',
  'hardRules',
  'workflow',
  'format',
  'tools',
  'completion',
];

describe('validateSections', () => {
  it('reports no issues for a well-formed, fully-ordered document', () => {
    const sections = splitSections(buildBody(CANONICAL_ORDER));
    expect(validateSections(sections)).toEqual([]);
  });

  it('accepts either Spec Format or Output Format for the format slot', () => {
    const specFormatBody = buildBody(CANONICAL_ORDER, { format: '## Spec Format\n\n- Goal\n' });
    expect(validateSections(splitSections(specFormatBody))).toEqual([]);
  });

  it('reports a missing section by slot', () => {
    const missingTools = CANONICAL_ORDER.filter((k) => k !== 'tools');
    const issues = validateSections(splitSections(buildBody(missingTools)));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_section', slot: 'tools' }),
    );
  });

  it('reports a section that appears earlier than the canonical order allows', () => {
    // workflow placed before hard rules violates Role -> Hard Rules -> Workflow -> ...
    const swapped: readonly (keyof BodyParts)[] = ['role', 'workflow', 'hardRules', 'format', 'tools', 'completion'];
    const issues = validateSections(splitSections(buildBody(swapped)));
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'section_out_of_order', slot: 'workflow' }),
    );
  });

  it('requires the Hard Rules section to be a numbered list', () => {
    const issues = validateSections(
      splitSections(buildBody(CANONICAL_ORDER, { hardRules: '## Hard Rules\n\n- not numbered\n- still not\n' })),
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'hard_rules_not_numbered' }));
  });

  it('requires the Workflow section to be a numbered list', () => {
    const issues = validateSections(
      splitSections(buildBody(CANONICAL_ORDER, { workflow: '## Workflow (FOLLOW IN ORDER)\n\n- not numbered\n' })),
    );
    expect(issues).toContainEqual(expect.objectContaining({ code: 'workflow_not_numbered' }));
  });

  it('lists PROFILE_SECTION_SLOTS in the normative §8 order', () => {
    expect(PROFILE_SECTION_SLOTS.map((s) => s.slot)).toEqual([
      'role',
      'hardRules',
      'workflow',
      'format',
      'tools',
      'completion',
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseProfile / loadProfileFile — end to end
// ---------------------------------------------------------------------------
describe('parseProfile', () => {
  it('accepts a well-formed synthetic profile document', () => {
    const result = parseProfile(VALID_FRONTMATTER + buildBody(CANONICAL_ORDER));
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.frontmatter.name).toBe('Test');
      expect(result.value.sections).toHaveLength(6);
    }
  });

  it('freezes the parsed frontmatter (readonly at runtime, not just in types)', () => {
    const profile = unwrap(parseProfile(VALID_FRONTMATTER + buildBody(CANONICAL_ORDER)));
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      profile.frontmatter.name = 'Mutated';
    }).toThrow();
  });

  it('rejects a document with no frontmatter block', () => {
    const result = parseProfile('## Role\nNo frontmatter.');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.code).toBe('frontmatter_invalid');
  });

  it('rejects frontmatter missing a required field', () => {
    const badFrontmatter = '---\nname: "Test"\ndescription: "d"\nharness: "h"\nmodel: "m"\n---\n';
    const result = parseProfile(badFrontmatter + buildBody(CANONICAL_ORDER));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.some((i) => i.code === 'frontmatter_invalid')).toBe(true);
      expect(result.error.some((i) => i.message.includes('roleReminder'))).toBe(true);
    }
  });

  it('rejects frontmatter with an empty required value', () => {
    const badFrontmatter =
      '---\nname: ""\ndescription: "d"\nharness: "h"\nmodel: "m"\nroleReminder: "r"\n---\n';
    const result = parseProfile(badFrontmatter + buildBody(CANONICAL_ORDER));
    expect(isErr(result)).toBe(true);
  });

  it('rejects frontmatter with an unrecognized key (strict)', () => {
    const badFrontmatter =
      '---\nname: "Test"\ndescription: "d"\nharness: "h"\nmodel: "m"\nroleReminder: "r"\nextra: "nope"\n---\n';
    const result = parseProfile(badFrontmatter + buildBody(CANONICAL_ORDER));
    expect(isErr(result)).toBe(true);
  });

  it('rejects an empty body', () => {
    const result = parseProfile(VALID_FRONTMATTER);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.code).toBe('empty_body');
  });

  it('propagates section validation issues', () => {
    const missingTools = CANONICAL_ORDER.filter((k) => k !== 'tools');
    const result = parseProfile(VALID_FRONTMATTER + buildBody(missingTools));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.some((i) => i.code === 'missing_section')).toBe(true);
  });
});

describe('findSection', () => {
  it('finds a section by slot using the same matching rules as validateSections', () => {
    const profile = unwrap(parseProfile(VALID_FRONTMATTER + buildBody(CANONICAL_ORDER)));
    const role = findSection(profile, 'role');
    expect(role?.heading).toBe('Role');
    const format = findSection(profile, 'format');
    expect(format?.heading).toBe('Output Format');
  });
});

// ---------------------------------------------------------------------------
// The three real, shipped role profiles (profiles/*.md)
// ---------------------------------------------------------------------------
const PROFILES_DIR = fileURLToPath(new URL('../../profiles/', import.meta.url));

describe('shipped role profiles (profiles/*.md)', () => {
  const cases: ReadonlyArray<{ file: string; expectedName: string; expectedFormatHeading: string }> = [
    { file: 'coordinator.md', expectedName: 'Coordinator', expectedFormatHeading: 'Spec Format' },
    { file: 'implementor.md', expectedName: 'Implementor', expectedFormatHeading: 'Output Format' },
    { file: 'verifier.md', expectedName: 'Verifier', expectedFormatHeading: 'Output Format' },
  ];

  for (const { file, expectedName, expectedFormatHeading } of cases) {
    describe(file, () => {
      it('parses and validates with no issues', () => {
        const result = loadProfileFile(`${PROFILES_DIR}${file}`);
        expect(isOk(result)).toBe(true);
      });

      it('has the expected frontmatter identity and config-resolved harness/model', () => {
        const profile = unwrap(loadProfileFile(`${PROFILES_DIR}${file}`));
        expect(profile.frontmatter.name).toBe(expectedName);
        expect(profile.frontmatter.harness).toBe(CONFIG_DEFAULT);
        expect(profile.frontmatter.model).toBe(CONFIG_DEFAULT);
        expect(profile.frontmatter.description.length).toBeGreaterThan(0);
        expect(profile.frontmatter.roleReminder.length).toBeGreaterThan(0);
      });

      it('has every required §8 section, in order, with the role-appropriate format heading', () => {
        const profile = unwrap(loadProfileFile(`${PROFILES_DIR}${file}`));
        const bySlot = new Map<string, ProfileSection>();
        for (const slot of PROFILE_SECTION_SLOTS) {
          const section = findSection(profile, slot.slot);
          expect(section, `missing section for slot '${slot.slot}'`).toBeDefined();
          if (section) bySlot.set(slot.slot, section);
        }
        expect(bySlot.get('format')?.heading).toBe(expectedFormatHeading);

        // order: each slot's index in the parsed section list is strictly increasing
        const indices = PROFILE_SECTION_SLOTS.map((slot) => profile.sections.indexOf(bySlot.get(slot.slot)!));
        for (let i = 1; i < indices.length; i += 1) {
          expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
        }
      });
    });
  }

  it('a missing file is reported as an Err, not thrown', () => {
    const result = loadProfileFile(`${PROFILES_DIR}does-not-exist.md`);
    expect(isErr(result)).toBe(true);
  });
});
