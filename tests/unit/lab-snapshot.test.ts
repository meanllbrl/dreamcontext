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
});
