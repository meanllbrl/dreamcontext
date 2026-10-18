// The agent surface's roster against a hands-free Return (AC5): the PUT names its base
// generation, a 409 roster_stale re-hydrates instead of re-sending, coming home re-hydrates,
// and a re-hydrate merges the stored roster in (phone sessions added, titles adopted, laptop
// tabs kept, no duplicates). The pure decisions AgentSurface.tsx calls.
import { describe, it, expect } from 'vitest';
import {
  carriedUnrestored, generationOf, mergeStoredRoster, phoneRestorable, putOutcome, withBaseGeneration,
} from '../../dashboard/src/components/handsfree/rosterRehydrate.js';

const tab = (claudeId: string, title: string, id = `s-${claudeId}`) => ({ id, claudeId, title });
const saved = (sessionId: string | undefined, title: string) => ({ sessionId, title, kind: 'chat' as const });

describe('mergeStoredRoster', () => {
  const open = [tab('A', 'Laptop A'), tab('L', 'Laptop only')];
  const stored = [saved('A', 'Renamed on the phone'), saved('P', 'Started on the phone'), saved('P', 'Started on the phone (dup)'), saved(undefined, 'Legacy dormant')];

  it('adds the phone-only sessions once each (no duplicate ids) and never a tab already open', () => {
    const { fresh } = mergeStoredRoster(open, stored, { adoptTitles: false });
    expect(fresh.map((m) => m.sessionId)).toEqual(['P', undefined]);
    expect(fresh[0].title).toBe('Started on the phone');
    const ids = fresh.map((m) => m.sessionId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a re-hydrate adopts the stored titles and keeps every laptop-only tab', () => {
    const { open: next } = mergeStoredRoster(open, stored, { adoptTitles: true });
    expect(next).toEqual([tab('A', 'Renamed on the phone'), tab('L', 'Laptop only')]);
  });

  it('nothing to adopt answers null (the caller keeps its state object)', () => {
    expect(mergeStoredRoster([tab('A', 'Same')], [saved('A', 'Same')], { adoptTitles: true }).open).toBeNull();
    expect(mergeStoredRoster(open, stored, { adoptTitles: false }).open).toBeNull();
  });

  it('restored + already-open never holds a conversation twice', () => {
    const { fresh, open: next } = mergeStoredRoster(open, stored, { adoptTitles: true });
    const all = [...(next ?? open).map((m) => m.claudeId), ...fresh.map((m) => m.sessionId).filter(Boolean)];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('PUT generation and the stale answer', () => {
  it('every PUT names the generation of the last GET; none before the first GET', () => {
    expect(withBaseGeneration({ sessions: [] }, 3)).toEqual({ sessions: [], baseGeneration: 3 });
    expect(withBaseGeneration({ sessions: [] }, undefined)).toEqual({ sessions: [] });
    expect(generationOf({ generation: 2 })).toBe(2);
    expect(generationOf({})).toBeUndefined();
    expect(generationOf({ generation: -1 })).toBeUndefined();
  });

  it('putOutcome: 200 adopts the generation; 409 roster_stale re-hydrates; anything else is ignored', () => {
    expect(putOutcome({ ok: true, body: { ok: true, generation: 4 } })).toEqual({ kind: 'adopt', generation: 4 });
    expect(putOutcome({ ok: false, status: 409, code: 'roster_stale' })).toEqual({ kind: 'rehydrate' });
    expect(putOutcome({ ok: false, status: 423, code: 'handsfree_away' })).toEqual({ kind: 'ignore' });
    expect(putOutcome({ ok: false, status: 409, code: 'other' })).toEqual({ kind: 'ignore' });
  });

  it('a stale 409 never re-sends the old body: the next PUT is built from the re-hydrated roster and its generation', async () => {
    // A server whose roster a Return merged (generation 0 -> 1, the phone's session P added).
    let stored = { generation: 1, sessions: [saved('A', 'Laptop A'), saved('P', 'Phone P')] };
    const puts: Array<Record<string, unknown>> = [];
    const put = (body: Record<string, unknown>) => {
      puts.push(body);
      if (body.baseGeneration !== stored.generation) return { ok: false as const, status: 409, code: 'roster_stale' };
      stored = { ...stored, sessions: body.sessions as typeof stored.sessions };
      return { ok: true as const, body: { ok: true, generation: stored.generation } };
    };
    // The tab loaded generation 0 before the trip.
    let generation: number | undefined = 0;
    let onScreen = [tab('A', 'Laptop A')];
    const stale = { sessions: onScreen.map((m) => saved(m.claudeId, m.title)) };
    const first = putOutcome(put(withBaseGeneration(stale, generation)));
    expect(first).toEqual({ kind: 'rehydrate' });
    // Re-hydrate: GET, adopt its generation, merge the stored roster in.
    generation = generationOf(stored);
    const { fresh, open } = mergeStoredRoster(onScreen, stored.sessions, { adoptTitles: true });
    onScreen = [...(open ?? onScreen), ...fresh.map((m) => tab(m.sessionId as string, m.title))];
    const next = { sessions: onScreen.map((m) => saved(m.claudeId, m.title)) };
    expect(putOutcome(put(withBaseGeneration(next, generation)))).toEqual({ kind: 'adopt', generation: 1 });
    expect(puts).toHaveLength(2);
    expect(puts[1]).not.toEqual(puts[0]);
    expect(puts[1]).toMatchObject({ baseGeneration: 1 });
    expect((puts[1].sessions as Array<{ sessionId: string }>).map((m) => m.sessionId)).toEqual(['A', 'P']);
  });
});


// The owner, 2026-10-17, from the phone: "mac'te açık olmayan sessionları da açık gibi gösteriyor".
// Opening the phone resumed all six of its stored tabs on the Mac and listed them under Açık.
describe('phoneRestorable', () => {
  const stored = [saved('RUNNING', 'Desktop chat the phone also had'), saved('OLD', 'Yesterday on the phone'), saved('DRAIN', 'Finishing'), saved(undefined, 'Legacy dormant')];
  const live = { chats: [{ conversationId: 'RUNNING' }, { conversationId: 'DRAIN' }, { conversationId: 'NOT-STORED' }], draining: ['DRAIN'] };

  it('keeps only the stored tabs the Mac runs right now', () => {
    expect(phoneRestorable(stored, live).map((m) => m.sessionId)).toEqual(['RUNNING']);
  });

  it('a stored tab with no running chat is never restored, so nothing is spawned for it', () => {
    expect(phoneRestorable(stored, { chats: [], draining: [] })).toEqual([]);
  });

  it('restores nothing when the Mac did not answer', () => {
    expect(phoneRestorable(stored, null)).toEqual([]);
  });

  it('keeps the stored entry itself (title, mode) for what it restores', () => {
    const withMode = [{ ...saved('RUNNING', 'Renamed here'), mode: 'develop' }];
    expect(phoneRestorable(withMode, live)).toEqual(withMode);
  });
});

// Review r1 (edge-cases): a passing 502 on live-chats restored nothing, and the next save then
// wrote only what was on screen, deleting the stored tabs of chats the Mac was still running.
describe('carriedUnrestored', () => {
  const stored = [
    { ...saved('A', 'Running on the Mac'), mode: 'develop', pane: 1, active: true, bound: true },
    saved('B', 'Opened again on this phone'),
    saved('A', 'A duplicate'),
    saved(undefined, 'Legacy dormant'),
  ];

  it('keeps every unjudged stored tab, once, with its title and mode but not its placement', () => {
    expect(carriedUnrestored(stored, new Set())).toEqual([
      { ...saved('A', 'Running on the Mac'), mode: 'develop' },
      saved('B', 'Opened again on this phone'),
    ]);
  });

  it('leaves a tab now on screen to the screen', () => {
    expect(carriedUnrestored(stored, new Set(['B'])).map((m) => m.sessionId)).toEqual(['A']);
  });

  it('carries nothing after a restore that could judge (the surface empties the list)', () => {
    expect(carriedUnrestored([], new Set())).toEqual([]);
  });
});
