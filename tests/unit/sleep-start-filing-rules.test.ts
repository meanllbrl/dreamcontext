import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { filingRulesBrief } from '../../src/cli/commands/sleep.js';
import { setRule, rulesPath } from '../../src/lib/task-filing-rules.js';
import { OBJECTIONS_REL_PATH } from '../../src/lib/task-objection.js';

/**
 * The `sleep start` brief's filing part: the rules learned from objections, and the objections
 * no rule rests on yet. An unreadable rules file or ledger is said out loud (a `!` line, a
 * warning), never read as "no rules".
 */

let ctx: string;

const applied = (id: string) => ({
  id, task: 't', as: 'not-a-task', target: null, note: 'n', by: 'owner', via: 'ui', at: '2026-10-23T10:00:00Z',
  snapshot: { name: 'T', description: '', why: '', filing_basis: null, filed_by: 'sleep', created_at: '' },
  steps: ['decline', 'log', 'cancel'], error: null, applied: { action: 'not-a-task', at: '2026-10-23T10:00:01Z' },
});

beforeEach(() => {
  const raw = join(tmpdir(), `ssfr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(raw, 'state'), { recursive: true });
  ctx = realpathSync(raw);
});

afterEach(() => {
  rmSync(ctx, { recursive: true, force: true });
});

describe('sleep start — filing rules brief', () => {
  it('nothing recorded: no lines, state absent', () => {
    expect(filingRulesBrief(ctx)).toEqual({ lines: [], json: { state: 'absent', rules: [], unlearned: [] } });
  });

  it('prints the rules and the unlearned objections', () => {
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), JSON.stringify([applied('obj_a'), applied('obj_b')]));
    setRule(ctx, { title: 'Steps are criteria', dont: 'file a step', do: 'add a criterion', restsOn: ['obj_a'] }, new Set(['obj_a', 'obj_b']));
    const brief = filingRulesBrief(ctx);
    expect(brief.lines.join('\n')).toContain('R1 · Steps are criteria');
    expect(brief.lines.join('\n')).toContain('Objections to learn from (1)');
    expect(brief.json).toMatchObject({ state: 'ok', unlearned: ['obj_b'] });
  });

  it('an unreadable rules file and a broken ledger are warnings, not silence', () => {
    mkdirSync(join(ctx, 'knowledge', 'patterns'), { recursive: true });
    writeFileSync(rulesPath(ctx), '---\nname: x\n---\n## Not a rule\n', 'utf-8');
    writeFileSync(join(ctx, OBJECTIONS_REL_PATH), '{', 'utf-8');
    const brief = filingRulesBrief(ctx);
    expect(brief.lines.filter((l) => l.startsWith('!'))).toHaveLength(2);
    expect(brief.lines[0]).toMatch(/could NOT be read/);
    expect(brief.json).toMatchObject({ state: 'unreadable' });
  });
});
