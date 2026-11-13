import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as gitMock from '../../src/lib/git-sync/git.js';
import { classifyPath, mergeRulesJson, resolveConflicts } from '../../src/lib/git-sync/semantic-merge.js';
import { deriveRule, mergeRulesStores, newEventId, type RuleEvent, type RuleRecord, type RulesStoreFile } from '../../src/lib/rules-store.js';

vi.mock('../../src/lib/git-sync/git.js', () => {
  const fixtures = new Map<string, { base: string; ours: string; theirs: string }>();
  const added: string[] = [];
  return {
    __setFixture: (path: string, v: { base: string; ours: string; theirs: string }) => fixtures.set(path, v),
    __added: added,
    readOursTheirsBase: (_cwd: string, path: string) => fixtures.get(path) ?? { base: '', ours: '', theirs: '' },
    addPath: (_cwd: string, p: string) => { added.push(p); },
    unmergedStages: () => [1, 2, 3],
    takeSide: () => {},
    readGitIdentity: () => ({ name: null, email: null }),
  };
});

const setFixture = (gitMock as unknown as { __setFixture: (p: string, v: { base: string; ours: string; theirs: string }) => void }).__setFixture;
const added = (gitMock as unknown as { __added: string[] }).__added;

const T = (d: number): string => `2026-11-${String(d).padStart(2, '0')}T09:00:00.000Z`;

function ev(over: Partial<RuleEvent>): RuleEvent {
  return { eid: newEventId(), at: T(2), op: 'create', by: 'agent', conversation: 'c', ...over };
}

function rule(id: string, quoteOcc = 'o1'): RuleRecord {
  return {
    id,
    scope: 'project',
    created: { at: T(2), by: 'agent', person: '' },
    events: [ev({ status: 'active', headline: `Rule ${id}`, text: `Rule ${id} text`, quotes: [{ text: 'his words here', turn: `t-${id}`, via: 'composer', occasion: quoteOcc }] })],
  };
}

const json = (s: RulesStoreFile): string => JSON.stringify(s);
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-rules-merge-home-')); added.length = 0; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('rules-json merge (C2, criterion 2)', () => {
  it('classifies the store and its view, with or without the in-tree prefix', () => {
    expect(classifyPath('core/RULES.json')).toBe('rules-json');
    expect(classifyPath('_dream_context/core/RULES.json')).toBe('rules-json');
    expect(classifyPath('knowledge/patterns/learned-rules.md')).toBe('learned-rules-view');
    expect(classifyPath('_dream_context/knowledge/patterns/learned-rules.md')).toBe('learned-rules-view');
    expect(classifyPath('knowledge/patterns/other.md')).toBe('knowledge-md');
  });

  it('two divergent sides merge to the union of records and of events', () => {
    const shared = rule('aaaaaaaaaa');
    const ours: RulesStoreFile = { version: 1, rules: [clone(shared), rule('bbbbbbbbbb')] };
    const theirs: RulesStoreFile = { version: 1, rules: [clone(shared), rule('cccccccccc')] };
    ours.rules[0]!.events.push(ev({ at: T(3), op: 'edit', headline: 'Edited here' }));
    theirs.rules[0]!.events.push(ev({ at: T(4), op: 'same', quotes: [{ text: 'again', turn: 't-x', via: 'telegram', occasion: 'o2' }] }));
    const merged = mergeRulesStores([json(ours), json(theirs)])!;
    expect(merged.rules.map((r) => r.id).sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
    const a = merged.rules.find((r) => r.id === 'aaaaaaaaaa')!;
    expect(a.events).toHaveLength(3);
    const v = deriveRule(a);
    expect(v.headline).toBe('Edited here');
    expect(v.repeats).toBe(1);
  });

  it('an undo on one side and a later same on the other: undone, with the new saying', () => {
    const base = rule('dddddddddd');
    const ours = clone(base);
    const theirs = clone(base);
    ours.events.push(ev({ at: T(3), op: 'undo', by: 'owner' }));
    theirs.events.push(ev({ at: T(4), op: 'same', status: 'active', quotes: [{ text: 'said later', turn: 't-later', via: 'composer', occasion: 'o5' }] }));
    const merged = mergeRulesStores([json({ version: 1, rules: [ours] }), json({ version: 1, rules: [theirs] })])!;
    const v = deriveRule(merged.rules[0]!);
    expect(v.status).toBe('undone');
    expect(v.sayings.map((s) => s.text)).toContain('said later');
  });

  it('repeats after a merge equal the distinct occasions in the unioned sayings', () => {
    const base = rule('eeeeeeeeee', 'o1');
    const ours = clone(base);
    const theirs = clone(base);
    ours.events.push(ev({ at: T(3), op: 'same', quotes: [{ text: 'a', turn: 't2', via: 'composer', occasion: 'o2' }] }));
    theirs.events.push(ev({ at: T(4), op: 'same', quotes: [{ text: 'b', turn: 't3', via: 'composer', occasion: 'o2' }] }));
    theirs.events.push(ev({ at: T(5), op: 'same', quotes: [{ text: 'c', turn: 't4', via: 'telegram', occasion: 'o3' }] }));
    const merged = mergeRulesStores([json({ version: 1, rules: [ours] }), json({ version: 1, rules: [theirs] })])!;
    expect(deriveRule(merged.rules[0]!).repeats).toBe(2);
  });

  it('a side that does not parse is never merged as empty', () => {
    expect(mergeRulesStores(['{"rules": [', json({ version: 1, rules: [] })])).toBeNull();
    expect(mergeRulesJson('', '<<<<<<< ours', json({ version: 1, rules: [] })).merged).toBeNull();
  });

  it('resolveConflicts writes the merged store, regenerates the view from it and stages both', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dc-rules-merge-'));
    mkdirSync(join(cwd, '_dream_context', 'core'), { recursive: true });
    mkdirSync(join(cwd, '_dream_context', 'knowledge', 'patterns'), { recursive: true });
    const ours = json({ version: 1, rules: [rule('ffffffffff')] });
    const theirs = json({ version: 1, rules: [rule('gggggggggg')] });
    writeFileSync(join(cwd, '_dream_context', 'core', 'RULES.json'), `<<<<<<< ours\n${ours}\n=======\n${theirs}\n>>>>>>> theirs\n`);
    writeFileSync(join(cwd, '_dream_context', 'knowledge', 'patterns', 'learned-rules.md'), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
    setFixture('_dream_context/core/RULES.json', { base: '', ours, theirs });
    setFixture('_dream_context/knowledge/patterns/learned-rules.md', { base: '', ours: 'x', theirs: 'y' });
    const r = resolveConflicts(cwd, ['_dream_context/knowledge/patterns/learned-rules.md', '_dream_context/core/RULES.json'], { home });
    expect(r.resolved.sort()).toEqual(['_dream_context/core/RULES.json', '_dream_context/knowledge/patterns/learned-rules.md']);
    expect(r.deferredToAgent).toEqual([]);
    const store = JSON.parse(readFileSync(join(cwd, '_dream_context', 'core', 'RULES.json'), 'utf-8')) as RulesStoreFile;
    expect(store.rules.map((x) => x.id).sort()).toEqual(['ffffffffff', 'gggggggggg']);
    const view = readFileSync(join(cwd, '_dream_context', 'knowledge', 'patterns', 'learned-rules.md'), 'utf-8');
    expect(view).toContain('generated: true');
    expect(view).toContain('Rule ffffffffff');
    expect(view).toContain('Rule gggggggggg');
    expect(view).not.toContain('<<<<<<<');
    expect(added).toContain('_dream_context/knowledge/patterns/learned-rules.md');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('an unparsable side goes to the human, never merged as empty', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dc-rules-merge-bad-'));
    mkdirSync(join(cwd, 'core'), { recursive: true });
    setFixture('core/RULES.json', { base: '', ours: '{"rules": [', theirs: json({ version: 1, rules: [] }) });
    const r = resolveConflicts(cwd, ['core/RULES.json'], { home });
    expect(r.deferredToHuman).toEqual([{ path: 'core/RULES.json', class: 'rules-json' }]);
    rmSync(cwd, { recursive: true, force: true });
  });
});
