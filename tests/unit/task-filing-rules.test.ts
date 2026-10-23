import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_RULES_CHARS,
  RULES_REL_PATH,
  mergeRule,
  readRules,
  revertRule,
  ruleFor,
  rulesPath,
  setRule,
  unlearnedIds,
} from '../../src/lib/task-filing-rules.js';

/**
 * The task-filing rules learned from objections (lib/task-filing-rules.ts): one pattern file,
 * written only through set/merge/revert; `rests_on` is the one place an objection becomes a rule;
 * a broken or oversized file is refused, never overwritten.
 */

let ctx: string;
const applied = new Set(['obj_a', 'obj_b', 'obj_c']);

beforeEach(() => {
  const raw = join(tmpdir(), `rules-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  ctx = realpathSync(raw);
});

afterEach(() => {
  rmSync(ctx, { recursive: true, force: true });
});

const rule = { title: 'Steps are criteria', dont: 'Open a task for a step of a planned task.', do: 'Add it as a criterion.', restsOn: ['obj_a'] };

describe('task filing rules', () => {
  it('absent reads as no rules; set writes a parseable pattern file', () => {
    expect(readRules(ctx)).toMatchObject({ state: 'absent', doc: { rules: [] } });
    const r = setRule(ctx, rule, applied);
    expect(r).toMatchObject({ ok: true, rule: { id: 'R1', rests_on: ['obj_a'] } });
    const text = readFileSync(rulesPath(ctx), 'utf-8');
    expect(text).toContain('name: patterns/task-filing-rules');
    expect(text).toContain('## R1 · Steps are criteria');
    expect(text).toContain("- **Don't:** Open a task for a step of a planned task.");
    const read = readRules(ctx);
    expect(read.state).toBe('ok');
    if (read.state === 'ok') expect(read.doc.rules[0]).toEqual({ id: 'R1', title: rule.title, dont: rule.dont, do: rule.do, rests_on: ['obj_a'] });
  });

  it('rests_on must name applied objections', () => {
    expect(setRule(ctx, { ...rule, restsOn: ['obj_zzz'] }, applied)).toMatchObject({ ok: false });
    expect(setRule(ctx, { ...rule, restsOn: [] }, applied)).toMatchObject({ ok: false });
  });

  it('a similar title is refused with a merge hint; merge adds objections', () => {
    setRule(ctx, rule, applied);
    const dup = setRule(ctx, { ...rule, title: 'steps ARE criteria!', restsOn: ['obj_b'] }, applied);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.message).toContain('tasks rules merge R1');
    const merged = mergeRule(ctx, 'R1', { restsOn: ['obj_b'], do: 'Insert it as an acceptance criterion.' }, applied);
    expect(merged).toMatchObject({ ok: true, rule: { rests_on: ['obj_a', 'obj_b'], do: 'Insert it as an acceptance criterion.' } });
  });

  it('revert drops the rule and dismisses its objections; unlearned skips learned and dismissed', () => {
    setRule(ctx, rule, applied);
    setRule(ctx, { ...rule, title: 'Other projects', restsOn: ['obj_b'] }, applied);
    let read = readRules(ctx);
    if (read.state !== 'ok') throw new Error('unreadable');
    expect(unlearnedIds(read.doc, ['obj_a', 'obj_b', 'obj_c'])).toEqual(['obj_c']);
    expect(ruleFor(read.doc, 'obj_b')?.id).toBe('R2');
    expect(revertRule(ctx, 'R1')).toMatchObject({ ok: true });
    read = readRules(ctx);
    if (read.state !== 'ok') throw new Error('unreadable');
    expect(read.doc.dismissed).toEqual(['obj_a']);
    expect(unlearnedIds(read.doc, ['obj_a', 'obj_b', 'obj_c'])).toEqual(['obj_c']);
    // the next rule gets a fresh number, never a reused one
    expect(setRule(ctx, { ...rule, title: 'Third', restsOn: ['obj_c'] }, applied)).toMatchObject({ ok: true, rule: { id: 'R3' } });
  });

  it('a rule deleted by hand makes its objection unlearned again', () => {
    setRule(ctx, rule, applied);
    const text = readFileSync(rulesPath(ctx), 'utf-8');
    writeFileSync(rulesPath(ctx), text.replace(/## R1[\s\S]*$/, ''), 'utf-8');
    const read = readRules(ctx);
    expect(read.state).toBe('ok');
    if (read.state === 'ok') expect(unlearnedIds(read.doc, ['obj_a'])).toEqual(['obj_a']);
  });

  it('a file that does not parse is refused by every write and left untouched', () => {
    setRule(ctx, rule, applied);
    const broken = readFileSync(rulesPath(ctx), 'utf-8').replace(/<!-- rule: .* -->/, '<!-- rule: {broken -->');
    writeFileSync(rulesPath(ctx), broken, 'utf-8');
    expect(readRules(ctx)).toMatchObject({ state: 'unreadable' });
    expect(setRule(ctx, { ...rule, title: 'New', restsOn: ['obj_b'] }, applied)).toMatchObject({ ok: false });
    expect(mergeRule(ctx, 'R1', { restsOn: ['obj_b'] }, applied)).toMatchObject({ ok: false });
    expect(revertRule(ctx, 'R1')).toMatchObject({ ok: false });
    expect(readFileSync(rulesPath(ctx), 'utf-8')).toBe(broken);
  });

  it(`the file stays under ${MAX_RULES_CHARS} characters`, () => {
    const long = 'x'.repeat(3000);
    expect(setRule(ctx, { ...rule, dont: long, do: long }, applied)).toMatchObject({ ok: true });
    const r = setRule(ctx, { ...rule, title: 'Another', dont: long, do: long, restsOn: ['obj_b'] }, applied);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/limit/);
    writeFileSync(rulesPath(ctx), 'y'.repeat(MAX_RULES_CHARS + 1), 'utf-8');
    expect(readRules(ctx)).toMatchObject({ state: 'unreadable' });
  });

  it('lives at the pattern path', () => {
    expect(RULES_REL_PATH).toBe('knowledge/patterns/task-filing-rules.md');
  });
});
