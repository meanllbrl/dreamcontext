/**
 * The always-loaded SKILL.md is paid for by every session that loads the skill,
 * so its SHAPE is a contract: a size cap, one line per capability, rule numbers
 * other files cite, and an index that reaches every reference. Detail belongs in
 * `skill/references/*.md`, which load on demand. These assertions fail the moment
 * the file drifts back toward the 73 KB it was, or an index entry goes missing.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PICKER_MODES } from '../../src/server/chat-modes.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8');
const SKILL = read('skill/SKILL.md');

/**
 * The cap on SKILL.md WITHOUT its frontmatter `hooks:` block: that block is settings Claude Code
 * parses (it mirrors install-skill.ts's hookCommand), not text the model reads, so a longer hook
 * command must not eat the prose budget. Name, description and the rest of the frontmatter count.
 * The skill was 73,517 B before the slimming wave.
 */
const SKILL_MAX_BYTES = 45_071; // 46,080 total at ff9bb0bd minus its 1,009-byte hooks: block

/**
 * SKILL.md with the frontmatter `hooks:` block taken out: from the `hooks:` line up to the next
 * top-level frontmatter key or the closing `---`. `block` is what was removed ('' if none).
 */
function withoutHooksBlock(text: string): { measured: string; block: string } {
  const close = text.indexOf('\n---\n', 4);
  const front = close < 0 ? '' : text.slice(0, close + 1);
  const start = front.search(/^hooks:[ \t]*\n/m);
  if (start < 0) return { measured: text, block: '' };
  const after = start + 'hooks:'.length;
  const next = front.slice(after).search(/\n(?=[A-Za-z_][\w-]*:)/);
  const end = next < 0 ? front.length : after + next + 1;
  return { measured: text.slice(0, start) + text.slice(end), block: text.slice(start, end) };
}
const { measured: SKILL_MEASURED, block: HOOKS_BLOCK } = withoutHooksBlock(SKILL);
/** A capability row is one line of summary plus a link; its detail lives in a reference. */
const CAPABILITY_ROW_MAX_CHARS = 700;

/** The rule titles other files cite by number (snapshot-budget.ts, core-index.ts, hook.ts, tests). */
const RULE_TITLES = [
  "User's request is king.",
  'Skill triage before action — HARD RULE.',
  'Recall before grep.',
  'Single source of truth — check before creating, update over duplicate.',
  "Work over ~5 minutes needs a task — but don't fork tasks.",
  'Tick criteria with evidence as you go.',
  'Log every session',
  'Reuse before create.',
  'Features are sleep-only.',
  'Use `dreamcontext-explore`, not `Explore`.',
  'Tag before you create.',
  'Be surgical.',
  'Insights before external fetch — the READ path, not just the create path.',
  'You can reach connected projects.',
];

function section(heading: string): string {
  const start = SKILL.indexOf(heading);
  expect(start, `${heading} not found in SKILL.md`).toBeGreaterThan(-1);
  const end = SKILL.indexOf('\n## ', start + heading.length);
  return SKILL.slice(start, end < 0 ? undefined : end);
}

describe('skill/SKILL.md size and shape', () => {
  it(`stays at or under ${SKILL_MAX_BYTES} bytes, measured without the frontmatter hooks: block`, () => {
    // The strip found the block and took only it: a bad strip cannot pass by deleting everything.
    expect(HOOKS_BLOCK.startsWith('hooks:\n'), 'the frontmatter hooks: block was found').toBe(true);
    expect(SKILL_MEASURED.startsWith('---\n')).toBe(true);
    const front = SKILL_MEASURED.slice(0, SKILL_MEASURED.indexOf('\n---\n', 4) + 1);
    expect(front).toMatch(/^name: /m);
    expect(front).toMatch(/^description: /m);
    expect(front).not.toMatch(/^hooks:/m);
    expect(SKILL_MEASURED.length + HOOKS_BLOCK.length).toBe(SKILL.length);
    expect(Buffer.byteLength(SKILL_MEASURED, 'utf-8')).toBeLessThanOrEqual(SKILL_MAX_BYTES);
  });

  it(`keeps every capability row at or under ${CAPABILITY_ROW_MAX_CHARS} chars`, () => {
    const rows = section('## Capabilities at a Glance').split('\n').filter((l) => l.startsWith('| **'));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const over = rows.filter((r) => r.length > CAPABILITY_ROW_MAX_CHARS).map((r) => `${r.length}: ${r.slice(0, 60)}`);
    expect(over).toEqual([]);
  });

  it('keeps Operational Rules 1-14 numbered with their titles', () => {
    const rules = section('## Operational Rules');
    const found = [...rules.matchAll(/^(\d+)\. \*\*(.+?)\*\*/gm)].map((m) => [Number(m[1]), m[2]]);
    expect(found).toEqual(RULE_TITLES.map((title, i) => [i + 1, title]));
  });
});

describe('skill/SKILL.md reference index', () => {
  const index = section('## Reference Index');
  const linked = [...index.matchAll(/\]\(references\/([a-z0-9-]+\.md)\)/g)].map((m) => m[1]);

  it('links every file in skill/references/', () => {
    const shipped = readdirSync(join(repoRoot, 'skill', 'references')).filter((f) => f.endsWith('.md'));
    const missing = shipped.filter((f) => !linked.includes(f));
    expect(missing).toEqual([]);
  });

  it('links only files that exist', () => {
    const dangling = linked.filter((f) => !existsSync(join(repoRoot, 'skill', 'references', f)));
    expect(dangling).toEqual([]);
  });
});

describe('skill/SKILL.md Chat modes row', () => {
  it('names every mode the composer picker offers, by its display name', () => {
    const mirror = read('dashboard/src/lib/chatModes.ts');
    const names = new Map([...mirror.matchAll(/\{ id: '([a-z]+)', name: '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const row = SKILL.split('\n').find((l) => l.startsWith('| **Chat modes'));
    expect(row, 'Chat modes capability row not found').toBeDefined();
    for (const mode of PICKER_MODES) {
      const name = names.get(mode);
      expect(name, `no display name for picker mode ${mode} in dashboard/src/lib/chatModes.ts`).toBeDefined();
      expect(row).toContain(name);
    }
  });

  it('marks Train Me as ALPHA and places the Assistant outside the picker', () => {
    const row = SKILL.split('\n').find((l) => l.startsWith('| **Chat modes')) ?? '';
    expect(row).toMatch(/Train Me\*\* \(ALPHA/);
    expect(row).toMatch(/Assistant\*\* has its own mode in the notch, never in the picker/);
  });
});
