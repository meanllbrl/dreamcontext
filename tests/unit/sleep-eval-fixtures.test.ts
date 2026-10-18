import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  boardAt,
  buildEvalSet,
  compactTranscript,
  filingsInTranscript,
  listRoundCandidates,
  parseTaskCreate,
  readRound,
  roundId,
  selectRounds,
  shellWords,
  addEvalSource,
  type RoundCandidate,
} from '../../src/lib/sleep-eval/fixtures.js';
import { deckOrder, labelQueue, readLabels, recordLabel, LabelError } from '../../src/lib/sleep-eval/labels.js';
import {
  buildCandidatePrompt,
  extractRoundCandidates,
  parseCandidates,
  roundOwnerTurns,
} from '../../src/lib/sleep-eval/candidates.js';
import type { FixtureRound, LabelItem } from '../../src/lib/sleep-eval/types.js';

// Fictional project throughout (synthetic-fixtures pattern): "Larkspur", a recipe app.

const line = (o: unknown) => JSON.stringify(o);
const user = (ts: string, text: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const assistant = (ts: string, text: string) =>
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const bashUse = (ts: string, id: string, command: string, cwd?: string) =>
  line({ type: 'assistant', timestamp: ts, ...(cwd ? { cwd } : {}), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResult = (ts: string, id: string, text: string) =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, toolUseResult: { stdout: text } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sleep-eval-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('roundId', () => {
  it('turns a consolidation time into a stable short id', () => {
    expect(roundId('2026-10-14T21:21:30.476Z')).toBe('r-20261014-2121');
  });
});

describe('parseTaskCreate', () => {
  it('reads name, why and the sleep signature out of a chained command', () => {
    const cmd = `cd /x && dreamcontext tasks create "Recipe import drops the photo" --status in_progress -p medium --by sleep -w 'Owners re-attach every photo by hand'`;
    expect(parseTaskCreate(cmd)).toEqual({
      name: 'Recipe import drops the photo',
      why: 'Owners re-attach every photo by hand',
      parent: null,
      bySleep: true,
    });
  });
  it('a quoted ; or && inside a value does not cut the command', () => {
    const cmd = `dreamcontext tasks create "Pantry view" -t "topic:a,kind:bug" --description "Sorts by date (abc1); fixes && more" --by sleep -w "Owners lose food; it costs money" 2>&1 | tail -3`;
    expect(parseTaskCreate(cmd)).toMatchObject({ name: 'Pantry view', why: 'Owners lose food; it costs money', bySleep: true });
  });
  it('is not a sleep filing without --by sleep', () => {
    expect(parseTaskCreate('dreamcontext tasks create "Add a pantry view" -w "x"')?.bySleep).toBe(false);
  });
  it('returns null for something that is not a create', () => {
    expect(parseTaskCreate('dreamcontext tasks create --help')).toBeNull();
    expect(parseTaskCreate('dreamcontext tasks list')).toBeNull();
  });
  it('shellWords keeps escaped quotes inside double quotes', () => {
    expect(shellWords(`a "b \\"c\\"" 'd e'`)).toEqual(['a', 'b "c"', 'd e']);
  });
});

describe('filingsInTranscript', () => {
  it('counts a create only when its result printed a slug', () => {
    const p = join(dir, 'agent-x.jsonl');
    writeFileSync(p, [
      bashUse('2026-05-01T10:00:00Z', 't1', 'dreamcontext tasks create "Recipe import drops the photo" --by sleep -w "Owners re-attach photos"'),
      toolResult('2026-05-01T10:00:01Z', 't1', '✓ Task created: recipe-import-drops-the-photo.md'),
      bashUse('2026-05-01T10:01:00Z', 't2', 'dreamcontext tasks create "Pantry twin" --by sleep -w "dup"'),
      toolResult('2026-05-01T10:01:01Z', 't2', '`pantry-view` already covers this (cosine 0.97)'),
    ].join('\n'));
    const filings = filingsInTranscript(p);
    expect(filings).toHaveLength(1);
    expect(filings[0].cwd).toBeUndefined();
    expect(filings[0]).toMatchObject({ slug: 'recipe-import-drops-the-photo', at: '2026-05-01T10:00:00Z', name: 'Recipe import drops the photo' });
  });
});

describe('compactTranscript', () => {
  it('cuts at the round time, keeps only message records and trims tool output', () => {
    const src = join(dir, 'in.jsonl');
    const big = 'x'.repeat(5000);
    writeFileSync(src, [
      line({ type: 'file-history-snapshot', snapshot: {} }),
      user('2026-05-01T09:00:00Z', 'please make the pantry view'),
      toolResult('2026-05-01T09:00:05Z', 'a', big),
      assistant('2026-05-01T09:01:00Z', 'Done, pantry view added.'),
      user('2026-05-01T12:00:00Z', 'after the sleep, never seen'),
    ].join('\n'));
    const out = join(dir, 'out', 'c.jsonl');
    const stats = compactTranscript(src, out, '2026-05-01T10:00:00Z');
    const kept = readFileSync(out, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(kept).toHaveLength(3);
    expect(kept.some((r) => JSON.stringify(r).includes('never seen'))).toBe(false);
    expect(kept[1].toolUseResult).toBeUndefined();
    expect(kept[1].message.content[0].content.length).toBe(300);
    expect(stats.lastAssistantMessage).toBe('Done, pantry view added.');
    expect(stats.lastTimestamp).toBe('2026-05-01T09:01:00Z');
  });
});

describe('selectRounds', () => {
  const cand = (id: string, n: number, at: string): RoundCandidate => ({
    id, consolidatedAt: at, previousAt: null, summary: '', sessionIds: Array.from({ length: n }, (_, i) => `${id}-${i}`), transcripts: new Map(),
  });
  it('keeps every round that filed something, then the lightest rounds, in time order', () => {
    const rounds = [cand('a', 30, '2026-05-01'), cand('b', 2, '2026-05-02'), cand('c', 5, '2026-05-03'), cand('d', 40, '2026-05-04')];
    const picked = selectRounds(rounds, new Map([['d', 1]]), 3);
    expect(picked.map((r) => r.id)).toEqual(['b', 'c', 'd']);
  });
  it('takes more than min when more rounds filed', () => {
    const rounds = [cand('a', 3, '2026-05-01'), cand('b', 3, '2026-05-02')];
    expect(selectRounds(rounds, new Map([['a', 1], ['b', 2]]), 1)).toHaveLength(2);
  });
});

describe('boardAt', () => {
  it('keeps earlier tasks and same-day tasks born before the sleep, never what sleep opened from here on', () => {
    const at = '2026-05-03T20:00:00.000Z';
    const tasks = [
      { slug: 'old', createdAt: '2026-05-01', bornMs: 0 },
      { slug: 'same-day-before', createdAt: '2026-05-03', bornMs: Date.parse('2026-05-03T10:00:00Z') },
      { slug: 'same-day-after', createdAt: '2026-05-03', bornMs: Date.parse('2026-05-03T21:00:00Z') },
      { slug: 'future', createdAt: '2026-05-04', bornMs: 0 },
      { slug: 'sleep-filed', createdAt: '2026-05-02', bornMs: 0 },
    ];
    expect(boardAt(tasks, at, new Set(['sleep-filed']))).toEqual(['old', 'same-day-before']);
  });
});

// ─── End to end on a fake brain + fake HOME ─────────────────────────────────

function task(slug: string, created: string, extra = ''): string {
  return `---\nname: ${slug}\nstatus: todo\ncreated_at: '${created}'\n${extra}---\n\n## Why\n\nx\n`;
}

function fakeBrain(): { ctx: string; home: string } {
  const ctx = join(dir, 'brain', '_dream_context');
  const home = join(dir, 'home');
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'state', 'pantry-view.md'), task('pantry-view', '2026-04-01'));
  writeFileSync(join(ctx, 'state', 'recipe-import-drops-the-photo.md'), task('recipe-import-drops-the-photo', '2026-05-02', 'parent_task: pantry-view\n'));
  writeFileSync(join(ctx, 'state', '.sleep-history.json'), JSON.stringify([
    { consolidated_at: '2026-05-02T20:00:00.000Z', summary: 'second', session_ids: ['s2'] },
    { consolidated_at: '2026-05-01T20:00:00.000Z', summary: 'first', session_ids: ['s1'] },
    { consolidated_at: '2026-04-01T20:00:00.000Z', summary: 'gone', session_ids: ['lost'] },
  ]));
  const proj = join(home, '.claude', 'projects', '-larkspur');
  mkdirSync(join(proj, 'sleeper', 'subagents'), { recursive: true });
  writeFileSync(join(proj, 's1.jsonl'), [user('2026-05-01T09:00:00Z', 'please add a pantry view for the recipes'), assistant('2026-05-01T09:05:00Z', 'Added.')].join('\n'));
  writeFileSync(join(proj, 's2.jsonl'), [user('2026-05-02T09:00:00Z', 'the recipe import drops the photo, track that please'), assistant('2026-05-02T09:05:00Z', 'Noted.')].join('\n'));
  const sub = join(proj, 'sleeper', 'subagents', 'agent-a1.jsonl');
  writeFileSync(sub, [
    bashUse('2026-05-02T19:50:00Z', 'u1', 'dreamcontext tasks create "Recipe import drops the photo" --by sleep -w "Owners re-attach photos by hand"'),
    toolResult('2026-05-02T19:50:01Z', 'u1', '✓ Task created: recipe-import-drops-the-photo.md'),
  ].join('\n'));
  // A sub-agent transcript older than the oldest window is skipped by mtime.
  utimesSync(sub, new Date('2026-05-02T19:51:00Z'), new Date('2026-05-02T19:51:00Z'));
  return { ctx, home };
}

describe('buildEvalSet', () => {
  it('lists only rounds whose transcripts are all on disk', () => {
    const { ctx, home } = fakeBrain();
    const rounds = listRoundCandidates(ctx, home);
    expect(rounds.map((r) => r.id)).toEqual(['r-20260502-2000', 'r-20260501-2000']);
    expect(rounds[1].previousAt).toBe('2026-04-01T20:00:00.000Z');
  });

  it('freezes rounds with their sessions, board cut and what the real sleep opened', () => {
    const { ctx, home } = fakeBrain();
    const set = buildEvalSet(ctx, { home, min: 2 });
    expect(set.rounds).toEqual(['r-20260501-2000', 'r-20260502-2000']);
    const r2 = readRound(ctx, 'r-20260502-2000')!;
    expect(r2.sessions.map((s) => s.session_id)).toEqual(['s2']);
    expect(r2.board).toEqual(['pantry-view']);
    expect(r2.opened).toHaveLength(1);
    expect(r2.opened[0]).toMatchObject({ id: 'r-20260502-2000:opened:1', slug: 'recipe-import-drops-the-photo', parent: 'pantry-view' });
    const r1 = readRound(ctx, 'r-20260501-2000')!;
    expect(r1.opened).toHaveLength(0);
    expect(r1.board).toEqual(['pantry-view']);
    // The set is frozen: a second build without force returns it untouched.
    expect(buildEvalSet(ctx, { home, min: 2 }).createdAt).toBe(set.createdAt);
  });

  it('candidates + labels: extract, queue, record with the reason rule', async () => {
    const { ctx, home } = fakeBrain();
    buildEvalSet(ctx, { home, min: 2 });
    let promptSeen = '';
    await extractRoundCandidates(ctx, 'r-20260502-2000', async (p) => {
      promptSeen = p;
      return 'Here: [{"category":"explicit-ask","name":"Track the dropped photo","why":"asked","quote":"track that please","message":1,"parent":null},' +
        '{"category":"sub-detail","name":"x","why":"y","quote":"z","message":1,"parent":"not-on-board"}]';
    });
    expect(promptSeen).toContain('pantry-view — pantry-view');
    expect(promptSeen).toContain('track that please');
    const r2 = readRound(ctx, 'r-20260502-2000')!;
    expect(r2.candidates.map((c) => c.id)).toEqual(['r-20260502-2000:explicit-ask:1']);
    expect(r2.candidates[0].session).toBe('s2');

    expect(labelQueue(ctx)).toMatchObject({ total: 2, labelled: 0 });
    expect(() => recordLabel(ctx, { id: 'r-20260502-2000:opened:1', verdict: 'reject' })).toThrow(LabelError);
    expect(() => recordLabel(ctx, { id: 'r-20260502-2000:opened:1', verdict: 'reject', reason: 'nope' })).toThrow(LabelError);
    recordLabel(ctx, { id: 'r-20260502-2000:opened:1', verdict: 'reject', reason: 'already-exists', note: 'part of pantry' });
    recordLabel(ctx, { id: 'r-20260502-2000:explicit-ask:1', verdict: 'keep', name: 'Recipe import keeps the photo' });
    // Re-labelling replaces, never duplicates.
    recordLabel(ctx, { id: 'r-20260502-2000:opened:1', verdict: 'keep' });
    const labels = readLabels(ctx);
    expect(labels).toHaveLength(2);
    expect(labels.find((l) => l.id.endsWith('opened:1'))).toMatchObject({ verdict: 'keep', reason: null, source: 'sleep-eval' });
    expect(labels.find((l) => l.id.endsWith('explicit-ask:1'))?.diff?.name).toEqual({ from: 'Track the dropped photo', to: 'Recipe import keeps the photo' });
    expect(labelQueue(ctx)).toMatchObject({ total: 2, labelled: 2, pending: [] });
    // A forced re-run never reuses an id: the old label stays on the old card, the new card waits.
    await extractRoundCandidates(ctx, 'r-20260502-2000', async () => '[{"category":"explicit-ask","name":"Something else","quote":"q","message":1}]', { force: true });
    expect(readRound(ctx, 'r-20260502-2000')!.candidates.map((c) => c.id)).toEqual(['r-20260502-2000:explicit-ask:2']);
    expect(labelQueue(ctx).pending.map((p) => p.id)).toEqual(['r-20260502-2000:explicit-ask:2']);
  });
});

describe('addEvalSource', () => {
  it('adds rounds from another brain under their own name, board and history; a rebuild keeps them', () => {
    const { ctx, home } = fakeBrain();
    buildEvalSet(ctx, { home, min: 1 });
    // A second fictional brain ("Quill", a note app) with one round on disk.
    const other = join(dir, 'quill', '_dream_context');
    mkdirSync(join(other, 'state'), { recursive: true });
    writeFileSync(join(other, 'state', 'note-sync.md'), task('note-sync', '2026-04-01'));
    writeFileSync(join(other, 'state', '.config.json'), JSON.stringify({ taskBackend: 'clickup', clickup: { list: 'x' } }));
    writeFileSync(join(other, 'state', '.sleep-history.json'), JSON.stringify([{ consolidated_at: '2026-05-05T20:00:00.000Z', summary: 'q', session_ids: ['q1'] }]));
    writeFileSync(join(home, '.claude', 'projects', '-larkspur', 'q1.jsonl'), user('2026-05-05T09:00:00Z', 'please make notes sync offline'));
    const set = addEvalSource(ctx, other, 'Quill', { home, min: 1 });
    expect(set.rounds).toContain('quill-r-20260505-2000');
    const r = readRound(ctx, 'quill-r-20260505-2000')!;
    expect(r.source).toEqual({ name: 'Quill', ctx: other });
    expect(r.board).toEqual(['note-sync']);
    expect(existsSync(join(ctx, 'tmp', 'sleep-eval', 'sources', 'Quill', 'board', 'note-sync.md'))).toBe(true);
    // Rebuilding this brain's part keeps the other brain's rounds.
    expect(buildEvalSet(ctx, { home, min: 1, force: true }).rounds).toContain('quill-r-20260505-2000');
    expect(() => addEvalSource(ctx, other, '../bad', { home })).toThrow();
  });

  it('counts a filing whose task was since renamed away when the sleep ran inside the source project', () => {
    const { ctx, home } = fakeBrain();
    buildEvalSet(ctx, { home, min: 1 });
    const other = join(dir, 'quill', '_dream_context');
    mkdirSync(join(other, 'state'), { recursive: true });
    writeFileSync(join(other, 'state', '.sleep-history.json'), JSON.stringify([{ consolidated_at: '2026-05-05T20:00:00.000Z', summary: 'q', session_ids: ['q1'] }]));
    writeFileSync(join(home, '.claude', 'projects', '-larkspur', 'q1.jsonl'), user('2026-05-05T09:00:00Z', 'notes must sync offline'));
    const sub = join(home, '.claude', 'projects', '-quill', 'qsleep', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-q.jsonl'), [
      bashUse('2026-05-05T19:50:00Z', 'v1', 'dreamcontext tasks create "Notes sync offline" --by sleep -w "Writers lose drafts"', join(dir, 'quill')),
      toolResult('2026-05-05T19:50:01Z', 'v1', '✓ Task created: notes-sync-offline.md'),
      bashUse('2026-05-05T19:51:00Z', 'v2', 'dreamcontext tasks create "Elsewhere" --by sleep -w "x"', join(dir, 'quill-other')),
      toolResult('2026-05-05T19:51:01Z', 'v2', '✓ Task created: elsewhere.md'),
    ].join('\n'));
    addEvalSource(ctx, other, 'Quill', { home, min: 1 });
    expect(readRound(ctx, 'quill-r-20260505-2000')!.opened.map((o) => o.slug)).toEqual(['notes-sync-offline']);
  });
});

describe('deckOrder', () => {
  it('asks every opened task first, then candidates round-robin across rounds', () => {
    const it2 = (round: string, category: LabelItem['category'], n: number): LabelItem => ({ id: `${round}:${category}:${n}`, round, category, name: '', why: '', quote: '', basis: 'unknown' });
    const items = [it2('a', 'explicit-ask', 1), it2('a', 'sub-detail', 1), it2('a', 'opened', 1), it2('b', 'abandoned', 1), it2('b', 'opened', 1), it2('c', 'explicit-ask', 1)];
    expect(deckOrder(items).map((i) => i.id)).toEqual(['a:opened:1', 'b:opened:1', 'a:explicit-ask:1', 'b:abandoned:1', 'c:explicit-ask:1', 'a:sub-detail:1']);
  });
});

describe('candidates', () => {
  const round = (over: Partial<FixtureRound> = {}): FixtureRound => ({
    id: 'r-x', consolidatedAt: '2026-05-02T20:00:00Z', previousAt: '2026-05-01T20:00:00Z', summary: '', sessions: [], board: ['pantry-view'], opened: [], candidates: [], ...over,
  });
  it('parseCandidates drops malformed items and a sub-detail with no board parent', () => {
    const items = parseCandidates('[{"category":"opened","name":"a"},{"category":"style-correction","name":"Say it in plain words","why":"w","quote":"q"},{"category":"sub-detail","name":"s","parent":"pantry-view","message":1},{"category":"bogus","name":"b"}]',
      round(), [{ session: 's9', at: '', text: 't' }], new Set(['pantry-view']));
    expect(items.map((i) => [i.id, i.basis, i.parent])).toEqual([
      ['r-x:style-correction:1', 'discussion', null],
      ['r-x:sub-detail:1', 'ask', 'pantry-view'],
    ]);
    expect(parseCandidates('no json here', round(), [], new Set())).toEqual([]);
  });
  it('a focus pass keeps only its kinds and numbers after the existing items', () => {
    const existing = [{ id: 'r-x:abandoned:2', round: 'r-x', category: 'abandoned' as const, name: 'a', why: '', quote: '', basis: 'discussion' as const }];
    const items = parseCandidates('[{"category":"abandoned","name":"Meal planner"},{"category":"explicit-ask","name":"x"},{"category":"other-project","name":"Bakery invoices"}]',
      round(), [], new Set(), { only: ['abandoned', 'other-project'], existing });
    expect(items.map((i) => i.id)).toEqual(['r-x:abandoned:3', 'r-x:other-project:1']);
    expect(buildCandidatePrompt([], [], ['other-project'])).toContain('FOCUS FOR THIS PASS');
  });
  it('roundOwnerTurns keeps only owner text inside the round window', () => {
    const ctx = join(dir, 'b', '_dream_context');
    const fdir = join(ctx, 'tmp', 'sleep-eval', 'fixtures', 'r-x', 'sessions');
    mkdirSync(fdir, { recursive: true });
    writeFileSync(join(fdir, 's.jsonl'), [
      user('2026-05-01T10:00:00Z', 'an older message the previous round already saw'),
      user('2026-05-02T10:00:00Z', 'ok'),
      line({ type: 'user', timestamp: '2026-05-02T10:01:00Z', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x' } }),
      user('2026-05-02T10:02:00Z', 'please keep the photo when a recipe is imported'),
    ].join('\n'));
    const turns = roundOwnerTurns(ctx, round({ sessions: [{ session_id: 's', file: 'sessions/s.jsonl', stopped_at: '', last_assistant_message: '', subagents: [] }] }));
    expect(turns.map((t) => t.text)).toEqual(['please keep the photo when a recipe is imported']);
    expect(buildCandidatePrompt(turns, [])).toContain('[1] (2026-05-02T10:02');
  });
});
