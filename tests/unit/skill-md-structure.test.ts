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

/** 45 KiB. The skill was 73,517 B before the slimming wave. */
const SKILL_MAX_BYTES = 46_080;
/** A capability row is one line of summary plus a link; its detail lives in a reference. */
const CAPABILITY_ROW_MAX_CHARS = 700;

/** The rule titles other files cite by number (snapshot-budget.ts, core-index.ts, hook.ts, tests). */
const RULE_TITLES = [
  "User's request is king.",
  'Skill triage before action — HARD RULE.',
  'Recall before grep.',
  'Single source of truth — check before creating, update over duplicate.',
  "Work over ~5 minutes needs a task — but don't fork tasks.",
  'Mark checkboxes as you go.',
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
  it(`stays at or under ${SKILL_MAX_BYTES} bytes`, () => {
    expect(Buffer.byteLength(SKILL, 'utf-8')).toBeLessThanOrEqual(SKILL_MAX_BYTES);
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
