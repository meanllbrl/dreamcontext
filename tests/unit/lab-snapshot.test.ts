import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot, measureSnapshot } from '../../src/cli/commands/snapshot.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';
import { writePeople } from '../../src/lib/people-store.js';

/**
 * A soul the demotion ladder cannot shrink, built ONLY from heading lines —
 * `compressMarkdownBlock` passes headings through verbatim at every rung, so this
 * forces the ladder to every floor without any opt-in feature or config.
 */
function incompressibleSoul(rules: number): string {
  const body = Array.from({ length: rules }, (_, i) => `## Rule ${i} — ${'x'.repeat(40)}`).join('\n');
  return `---\nname: Big\ntype: soul\n---\n\n${body}\n`;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-snapshot-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'core', '0.soul.md'), '# Soul\n', 'utf-8');
  writeFileSync(join(root, 'core', '2.memory.md'), '# Memory\n', 'utf-8');
  // The people-first layout. A SOLO roster resolves without any machine state
  // (the vault's only person is trivially the active one), so nothing here
  // depends on the developer's git identity.
  writePeople(root, { ada: { name: 'Ada', emails: ['ada@lab.invalid'] } });
  writeFileSync(join(root, 'people', 'ada.md'), '---\nname: ada\ntype: person\n---\n\n# Person\n', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('SessionStart snapshot — Lab section (AC15)', () => {
  it('renders title / latest+unit / staleness / group for each insight', () => {
    createInsight(root, { slug: 'wau', title: 'Weekly Active Users', unit: 'users', group: 'Engagement' });
    writeCache(root, 'wau', {
      slug: 'wau', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: 'users', series: [{ name: 'default', points: [{ t: '2026-07-01', v: 420 }] }],
      latest: 420, error: null, errorAt: null, scriptHash: null,
    });

    const snapshot = generateSnapshot(root);
    expect(snapshot).toContain('Lab (Analytics Insights)');
    expect(snapshot).toContain('Weekly Active Users');
    expect(snapshot).toContain('420');
    expect(snapshot).toContain('Engagement');
  });

  it('is absent (no section, no crash) when lab/insights/ does not exist', () => {
    expect(() => generateSnapshot(root)).not.toThrow();
    const snapshot = generateSnapshot(root);
    expect(snapshot).not.toContain('Lab (Analytics Insights)');
  });

  it('never crashes on a malformed manifest', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(join(root, 'lab', 'insights', 'broken.md'), '---\ntitle: [unterminated\n---\nbody', 'utf-8');
    expect(() => generateSnapshot(root)).not.toThrow();
  });

  // The budget ladder used to demote Lab to a bare `- N insight(s)` line on
  // both live vaults, which is precisely what makes an agent fetch a metric it
  // already has (SKILL.md Operational Rule 13). The floor makes that
  // unreachable: under pressure Lab shrinks, but never below name + value.
  it('keeps every metric name + latest value under extreme budget pressure', () => {
    createInsight(root, { slug: 'mrr', title: 'Monthly Recurring Revenue', unit: 'USD', group: 'Revenue' });
    writeCache(root, 'mrr', {
      slug: 'mrr', fetchedAt: new Date().toISOString(), tweaks: {}, granularity: 'daily',
      unit: 'USD', series: [{ name: 'default', points: [{ t: '2026-07-01', v: 156 }] }],
      latest: 156, error: null, errorAt: null, scriptHash: null,
    });
    // A soul the ladder CANNOT compress forces it to every floor. Padding prose
    // would not: the soul is demotable now, so the ladder would shrink it, the
    // snapshot would fit, and this test would pass without ever pressuring Lab.
    writeFileSync(join(root, 'core', '0.soul.md'), incompressibleSoul(500), 'utf-8');

    const prev = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = '2000';
    try {
      const { text, budget } = measureSnapshot(root);
      // Lab has NO rungs at all now (owner decision 2026-07-30): name + latest
      // value at every budget is the section's whole purpose (Rule 13).
      expect(budget.demoted.map((d) => d.id)).not.toContain('lab');
      expect(text).toContain('Budget note');                 // the ladder really ran…
      expect(text).toContain('Monthly Recurring Revenue');   // …but the name survived
      expect(text).toContain('156');                         // …and so did the value
      expect(text).not.toMatch(/- \d+ insight\(s\)/);        // the blinding rung is gone
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
      else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = prev;
    }
  });
});
