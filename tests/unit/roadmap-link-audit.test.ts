import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { auditObjectiveLinkLoss, parseBoardLinks } from '../../src/lib/roadmap-link-audit.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { checkObjectives } from '../../src/cli/commands/doctor.js';

/**
 * AC3 (detection half): a task→objective link that VANISHES while the work
 * still exists must be visible. `objectives:` lives in the gitignored `state/`,
 * so the committed, auto-generated `knowledge/roadmap/board.md` is the only
 * record of what the links used to be — this audit turns the lucky recovery of
 * 2026-07-27 into a check.
 */

let root: string;

function writeTask(slug: string, objectives: string[]): void {
  const links = objectives.length > 0
    ? `objectives:\n${objectives.map((o) => `  - ${o}`).join('\n')}\n`
    : '';
  writeFileSync(
    join(root, 'state', `${slug}.md`),
    `---\nid: task_${slug}\nname: ${slug}\nstatus: todo\n${links}---\n\n## Why\n\nx\n`,
    'utf-8',
  );
}

function writeBoard(sections: Array<{ objective: string; tasks: string[] }>): void {
  const lines = [
    '---', 'name: roadmap-board', '---', '', '# Roadmap Board', '',
    '> Auto-generated 2026-08-16 by `dreamcontext roadmap`.', '',
  ];
  for (const s of sections) {
    lines.push(`### ⚪ **${s.objective}** — ${s.objective} · 0/${s.tasks.length} done (0%) · target 2026-09-01`);
    for (const t of s.tasks) lines.push(`  - ${t} (todo) · 0.25.0`);
    lines.push('');
  }
  writeFileSync(join(root, 'knowledge', 'roadmap', 'board.md'), lines.join('\n'), 'utf-8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-linkaudit-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core', 'objectives'), { recursive: true });
  mkdirSync(join(root, 'knowledge', 'roadmap'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseBoardLinks', () => {
  it('reads objective → member task slugs out of a generated board', () => {
    writeBoard([
      { objective: 'ship-v1', tasks: ['alpha-task', 'beta-task'] },
      { objective: 'team-ready', tasks: ['gamma-task'] },
    ]);
    const parsed = parseBoardLinks(readFileSync(join(root, 'knowledge', 'roadmap', 'board.md'), 'utf-8'));
    expect(parsed.get('ship-v1')).toEqual(['alpha-task', 'beta-task']);
    expect(parsed.get('team-ready')).toEqual(['gamma-task']);
  });

  it('does not read the Warnings section as an objective', () => {
    const parsed = parseBoardLinks('### ⚪ **a** — A\n  - t-one (todo)\n\n#### Warnings\n- ⚠ nope\n');
    expect([...parsed.keys()]).toEqual(['a']);
    expect(parsed.get('a')).toEqual(['t-one']);
  });
});

describe('auditObjectiveLinkLoss', () => {
  it('flags an objective whose ENTIRE recorded link set vanished while the tasks live on', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task', 'beta-task'] }]);
    writeTask('alpha-task', []); // links stripped
    writeTask('beta-task', []);

    expect(auditObjectiveLinkLoss(root)).toEqual([
      { objective: 'ship-v1', tasks: ['alpha-task', 'beta-task'] },
    ]);
  });

  it('is silent when the links are intact', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task'] }]);
    writeTask('alpha-task', ['ship-v1']);
    expect(auditObjectiveLinkLoss(root)).toEqual([]);
  });

  it('is silent when only SOME links went (a PO unlinking work is legitimate)', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task', 'beta-task'] }]);
    writeTask('alpha-task', ['ship-v1']);
    writeTask('beta-task', []);
    expect(auditObjectiveLinkLoss(root)).toEqual([]);
  });

  it('is silent when the TASKS are gone too (a deletion, not a link loss)', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task'] }]);
    expect(auditObjectiveLinkLoss(root)).toEqual([]);
  });

  it('is silent when the OBJECTIVE is gone (delete self-heals task links)', () => {
    writeBoard([{ objective: 'retired', tasks: ['alpha-task'] }]);
    writeTask('alpha-task', []);
    expect(auditObjectiveLinkLoss(root)).toEqual([]);
  });

  it('is silent with no board at all', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeTask('alpha-task', []);
    expect(auditObjectiveLinkLoss(root)).toEqual([]);
  });
});

describe('doctor surfaces vanished links', () => {
  it('warns, names the tasks, and prints the re-link command', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task', 'beta-task'] }]);
    writeTask('alpha-task', []);
    writeTask('beta-task', []);

    const hit = checkObjectives(root).find((r) => r.code === 'doctor/objective-links-vanished');
    expect(hit).toBeDefined();
    expect(hit!.status).toBe('warn');
    expect(hit!.message).toContain('ship-v1');
    expect(hit!.message).toContain('alpha-task');
    expect(hit!.message).toContain('dreamcontext tasks objectives');
    expect(hit!.evidence).toEqual({ tasks: ['alpha-task', 'beta-task'] });
  });

  it('stays quiet on a healthy brain', () => {
    createObjective(root, { slug: 'ship-v1', title: 'Ship v1' });
    writeBoard([{ objective: 'ship-v1', tasks: ['alpha-task'] }]);
    writeTask('alpha-task', ['ship-v1']);
    expect(checkObjectives(root).some((r) => r.code === 'doctor/objective-links-vanished')).toBe(false);
  });
});
