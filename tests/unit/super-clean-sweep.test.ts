import { describe, expect, it } from 'vitest';
import {
  OTHERS_IDLE_MS, OTHERS_MAX, TIDY_IDLE_MS, _resetTidy, applyOthersClose, endPresent, planOthersClose, presentSpent, tidyOnce,
} from '../../src/lib/super/tidy.js';
import { closeAnswered, padAbout, padNotice, withoutTwins } from '../../src/lib/super/pad.js';
import { PAD_STALE_MS, normalizeGroups, type SuperContainer, type SuperPadItem, type SuperState } from '../../src/lib/super/types.js';

const NOW = 100 * OTHERS_IDLE_MS;
const old = NOW - OTHERS_IDLE_MS;
const idle = () => false;
const card = (id: string, o: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'image', ref: `${id}.png`, shape: 'tall', place: 'others', ...o }) as SuperContainer;
const state = (o: Partial<SuperState>): SuperState =>
  ({ enabled: true, containers: [], groups: [], queue: [], team: [], children: {}, view: { mode: 'float' }, pad: [], ...o }) as unknown as SuperState;
const plan = (s: SuperState, at = old) => planOthersClose(s, () => at, NOW, 0, idle);

describe('Others closes by itself', () => {
  it('closes an old card with no job, never one touched inside the bar', () => {
    const s = state({ containers: [card('a')] });
    expect(plan(s)).toEqual(['a']);
    expect(plan(s, old + 1)).toEqual([]);
  });

  it('starts no clock before this server did: nothing goes at boot', () => {
    const s = state({ containers: [card('a')] });
    expect(planOthersClose(s, () => old, NOW, NOW - 1000, idle)).toEqual([]);
  });

  it('keeps what the owner placed, sized or took back, and a card he holds', () => {
    const s = state({ containers: [
      card('a', { pos: { x: 0.1, y: 0.1 } }), card('b', { sizeBy: 'owner' }), card('c', { keptBy: 'owner' }),
      card('d', { kind: 'chat', ref: 's1', heldAt: 1 }),
    ] });
    expect(plan(s)).toEqual([]);
  });

  it('keeps a live job, an open item and a done child the retire clock still owns', () => {
    const child = (row: string) => ({ row, startedAt: 1, brief: 'x' });
    const s = state({
      containers: [card('a', { kind: 'chat', ref: 's1' }), card('b', { kind: 'chat', ref: 's2' }), card('c', { kind: 'chat', ref: 's3' }), card('d', { kind: 'chat', ref: 's4' })],
      children: { s1: child('working'), s2: child('done'), s3: child('gone'), s4: child('gone') } as never,
      queue: [{ id: 'q', sessionId: 's4', kind: 'question', state: 'pending', createdAt: 1 }] as never,
    });
    expect(plan(s)).toEqual(['c']);
  });

  it('keeps an open team job and a question\'s pictures, and an unseen result of a gone child', () => {
    const s = state({
      containers: [card('a', { kind: 'team', ref: 'team-1' }), card('b'), card('c', { kind: 'chat', ref: 's1' })],
      team: [{ id: 'team-1' }] as never, askShows: [{ item: 'q', cards: ['b'], opened: [], via: 'show' }] as never,
      children: { s1: { row: 'gone', finishedAt: 5, startedAt: 1, brief: 'x' } } as never,
    });
    expect(plan(s)).toEqual([]);
  });

  it('a card whose stage life was long waits its full time in Others', async () => {
    const root = '/tmp/sweep-entry';
    _resetTidy();
    let rec = state({ containers: [card('a', { place: 'float' })] });
    const io = { read: async () => structuredClone(rec), write: async (_r: string, fn: (d: SuperState) => void) => { const d = structuredClone(rec); fn(d); rec = d; } };
    const t0 = Date.now() + 1000;
    await tidyOnce(root, io, t0);
    await tidyOnce(root, io, t0 + OTHERS_IDLE_MS);
    expect(rec.containers[0].place).toBe('others');
    await tidyOnce(root, io, t0 + OTHERS_IDLE_MS + 1000);
    expect(rec.containers).toHaveLength(1);
    await tidyOnce(root, io, t0 + 2 * OTHERS_IDLE_MS + 2000);
    expect(rec.containers).toHaveLength(0);
    _resetTidy();
  });

  it('a group in Others closes through the real clock', async () => {
    _resetTidy();
    let rec = state({ containers: [card('a', { place: 'float' }), card('b', { place: 'float' })], groups: [{ id: 'grp-1', name: 'g', cards: ['a', 'b'], place: 'others' }] });
    const io = { read: async () => structuredClone(rec), write: async (_r: string, fn: (d: SuperState) => void) => { const d = structuredClone(rec); fn(d); rec = d; } };
    const t0 = Date.now() + 1000;
    await tidyOnce('/tmp/sweep-group', io, t0);
    await tidyOnce('/tmp/sweep-group', io, t0 + OTHERS_IDLE_MS + 1000);
    expect(rec.groups).toHaveLength(0);
    expect(rec.containers).toHaveLength(0);
    _resetTidy();
  });

  it('a group he took back keeps its mark through the store', () => {
    const c = [card('a'), card('b')];
    const out = normalizeGroups(c as never, [{ id: 'grp-1', name: 'g', cards: ['a', 'b'], place: 'others', keptBy: 'owner' }] as never);
    expect(out.groups[0].keptBy).toBe('owner');
  });

  it('closes a group only whole', () => {
    const s = state({
      containers: [card('a'), card('b', { sizeBy: 'owner' }), card('c'), card('d')],
      groups: [{ id: 'grp-1', name: 'g', cards: ['a', 'b'], place: 'others' }, { id: 'grp-2', name: 'h', cards: ['c', 'd'], place: 'others' }],
    });
    expect(plan(s)).toEqual(['grp-2']);
    applyOthersClose(s, ['grp-2']);
    expect(s.containers.map((c) => c.id)).toEqual(['a', 'b']);
    expect(s.groups.map((g) => g.id)).toEqual(['grp-1']);
  });

  it('over the cap, closes the oldest past the stage bar, and only those', () => {
    const n = OTHERS_MAX + 2;
    const s = state({ containers: Array.from({ length: n }, (_, i) => card(`c${i}`)) });
    const at = (id: string) => (id === 'c0' ? NOW - 2 * TIDY_IDLE_MS : id === 'c1' ? NOW - TIDY_IDLE_MS : NOW - 1000);
    expect(planOthersClose(s, at, NOW, 0, idle)).toEqual(['c0', 'c1']);
  });
});

describe('a spent presentation closes', () => {
  const seen = { row: 'done', finishedAt: 10, seenAt: 10, seenMarkedAt: 20, startedAt: 1, brief: 'x' };
  const shown = (o: Partial<SuperState> = {}) => state({
    containers: [card('a', { place: 'float', forChild: 's1', forAt: 5 } as never), card('b', { place: 'float' })],
    children: { s1: seen } as never, view: { mode: 'present', cards: ['a', 'b'] }, ...o,
  });
  const quiet = () => NOW - TIDY_IDLE_MS;

  it('ends when the job is over, seen and nothing touched it; the cards go to Others', () => {
    const s = shown();
    expect(presentSpent(s, quiet, NOW, idle)).toBe(true);
    endPresent(s);
    expect(s.view.mode).toBe('float');
    expect(s.containers.every((c) => c.place === 'others')).toBe(true);
  });

  it('stays while he has not seen the result, the job lives, or inside the bar', () => {
    expect(presentSpent(shown({ children: { s1: { ...seen, seenAt: 5 } } as never }), quiet, NOW, idle)).toBe(false);
    expect(presentSpent(shown({ children: { s1: { ...seen, row: 'working' } } as never }), quiet, NOW, idle)).toBe(false);
    expect(presentSpent(shown(), () => NOW - 1, NOW, idle)).toBe(false);
  });

  it('leaves a group he placed; the agenda never moves off the stage', () => {
    const grouped = shown({ groups: [{ id: 'grp-1', name: 'g', cards: ['a', 'b'], place: 'float', pos: { x: 0.1, y: 0.1 } }] });
    expect(presentSpent(grouped, quiet, NOW, idle)).toBe(false);
    const s = shown({ containers: [card('a', { place: 'float', forChild: 's1', forAt: 5 } as never), card('g', { kind: 'agenda', place: 'float' })], view: { mode: 'present', cards: ['a', 'g'] } });
    endPresent(s);
    expect(s.containers.map((c) => c.place)).toEqual(['others', 'float']);
    const mixed = shown({ containers: [card('a', { place: 'float' }), card('g', { kind: 'agenda', place: 'float' })], view: { mode: 'present', cards: ['a', 'g'] }, groups: [{ id: 'grp-1', name: 'g', cards: ['a', 'g'], place: 'float' }] });
    endPresent(mixed);
    expect(mixed.groups[0].place).toBe('float');
    expect(presentSpent(shown({ containers: [card('a', { place: 'float', forChild: 's1', forAt: 5 } as never), card('w', { place: 'float', by: 'auto' })], view: { mode: 'present', cards: ['a', 'w'] } }), quiet, NOW, idle)).toBe(false);
  });

  it('stays when it is his, or nothing says what it was for', () => {
    expect(presentSpent(shown({ view: { mode: 'present', cards: ['a'], by: 'owner' } }), quiet, NOW, idle)).toBe(false);
    expect(presentSpent(shown({ view: { mode: 'present', cards: ['a'], layoutBy: 'owner' } as never }), quiet, NOW, idle)).toBe(false);
    expect(presentSpent(shown({ view: { mode: 'present', cards: ['b'] } }), quiet, NOW, idle)).toBe(false);
  });
});

describe('the agenda settles itself', () => {
  const line = (o: Partial<SuperPadItem>): SuperPadItem => ({ id: 'n1', section: 'now', text: 'x', at: 1, ...o });

  it('tells a stale line once, then leaves it folded', () => {
    const now = 3 * PAD_STALE_MS;
    const s = { pad: [line({ text: 'bayat' })] };
    expect(padNotice(s, now).ids).toEqual(['n1']);
    expect(padNotice({ pad: [line({ text: 'bayat', toldAt: 2 })] }, now).ids).toEqual([]);
  });

  it('matches the same subject, never two lines that share a word or two', () => {
    expect(padAbout('Hafıza toparlama (uyku): not borcu 61', 'Hafıza toparlama (uyku) şimdi başlatılsın mı?')).toBe(true);
    expect(padAbout('Hafıza toparlama bitti', 'Sahne kartları toparlama')).toBe(false);
  });

  it('a job line replaces its unlinked twin; the owner\'s and a job\'s lines stay', () => {
    const text = 'Çentik Super oturumları gösterecek';
    const pad = [
      line({ id: 'n1', text, at: 90 }), line({ id: 'n2', text, by: 'owner', at: 90 }), line({ id: 'n3', text, for: 's', at: 90 }),
      line({ id: 'n4', text: 'Başka', at: 90 }), line({ id: 'n5', text, section: 'waiting', at: 90 }), line({ id: 'n6', text, at: 1 }),
    ];
    expect(withoutTwins(pad, text, 100 + PAD_STALE_MS - 95).map((p) => p.id)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
    expect(withoutTwins([pad[5]], text, 2 + PAD_STALE_MS).map((p) => p.id)).toEqual(['n6']);
  });

  it('an answered question moves its Waiting line to Done, nothing else', () => {
    const s = state({ pad: [
      line({ id: 'n1', section: 'waiting', text: 'Hafıza toparlama (uyku) sende' }),
      line({ id: 'n2', section: 'waiting', text: 'Tilki araç çubuğu' }),
    ] });
    closeAnswered(s, 'Hafıza toparlama (uyku) şimdi başlatılsın mı?', 50);
    expect(s.pad!.map((p) => p.section)).toEqual(['done', 'waiting']);
    expect(padNotice(s, 60).lines.join('\n')).toContain('he answered');
  });
});
