// The agent surface's roster against a hands-free Return (AC5): the PUT names its base
// generation, a 409 roster_stale re-hydrates instead of re-sending, coming home re-hydrates,
// and a re-hydrate merges the stored roster in (phone sessions added, titles adopted, laptop
// tabs kept, no duplicates). The pure decisions AgentSurface.tsx calls.
import { describe, it, expect } from 'vitest';
import {
  generationOf, mergeStoredRoster, putOutcome, rehydrateOnPhase, withBaseGeneration,
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

describe('the home edge', () => {
  it('re-hydrates on away/returning -> home only', () => {
    expect(rehydrateOnPhase('away', 'home')).toBe(true);
    expect(rehydrateOnPhase('returning', 'home')).toBe(true);
    expect(rehydrateOnPhase(null, 'home')).toBe(false);
    expect(rehydrateOnPhase('home', 'home')).toBe(false);
    expect(rehydrateOnPhase('going', 'home')).toBe(false);
    expect(rehydrateOnPhase('home', 'away')).toBe(false);
  });
});
