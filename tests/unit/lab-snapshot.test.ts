import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot } from '../../src/cli/commands/snapshot.js';
import { createInsight, writeCache } from '../../src/lib/lab/store.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-lab-snapshot-'));
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'core', '0.soul.md'), '# Soul\n', 'utf-8');
  writeFileSync(join(root, 'core', '1.user.md'), '# User\n', 'utf-8');
  writeFileSync(join(root, 'core', '2.memory.md'), '# Memory\n', 'utf-8');
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
    // A soul far over any budget forces the ladder to its deepest rung.
    writeFileSync(join(root, 'core', '0.soul.md'), `# Soul\n${'padding line\n'.repeat(4000)}`, 'utf-8');

    const prev = process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
    process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = '2000';
    try {
      const snapshot = generateSnapshot(root);
      expect(snapshot).toContain('Budget note');           // the ladder really ran…
      expect(snapshot).toContain('lab');                   // …and demoted Lab…
      expect(snapshot).toContain('Monthly Recurring Revenue'); // …but the name survived
      expect(snapshot).toContain('156');                       // …and so did the value
      expect(snapshot).not.toMatch(/- \d+ insight\(s\)/);      // the blinding rung is gone
    } finally {
      if (prev === undefined) delete process.env.DREAMCONTEXT_SNAPSHOT_BUDGET;
      else process.env.DREAMCONTEXT_SNAPSHOT_BUDGET = prev;
    }
  });
});
