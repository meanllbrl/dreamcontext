/**
 * An AI Team member's side-menu row leaves red the moment the owner answers (owner 2026-11-14:
 * "sorusuna cevap vermeme rağmen bu kırmızı kalıyor ... çok geç dönüyor"). The row's `asking`
 * came from a member summary READ on a 15 s poll (60-120 s off focus or in light mode), so the
 * closed item stayed red until the next tick. Now a change of the project's live Super records
 * (`ekipPulseKey`) pokes the read (`startPulsedPoll`), for every card kind.
 * Fictional members and sessions (synthetic-fixtures pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ekipPulseKey } from '../../dashboard/src/components/aiteam/teamModel.js';
import { startPulsedPoll } from '../../dashboard/src/lib/pulsedPoll.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const src = (rel: string) => readFileSync(join(here, '../../dashboard/src', rel), 'utf8');

type Q = { id: string; state: string; kind?: string };
const rec = (superId: string, queue: Q[], children: Record<string, { row?: string; finishedAt?: number; seenAt?: number }> = {}) =>
  ({ superId, record: { queue, children } });

describe('the live records change when the owner answers, whatever the card', () => {
  // Each kind the owner answers: the member's own question, a child's secret, checklist and run
  // cards, a permission, a direct question; each mirrored as a `member` item in main's record.
  const kinds = ['ask', 'owner:secret', 'owner:checklist', 'owner:run', 'permission', 'question'];
  for (const kind of kinds) {
    it(`a ${kind} answered moves the key (member record and main mirror)`, () => {
      const before = [
        rec('main', [{ id: 'mirror-1', state: 'escalated', kind: 'member' }]),
        rec('m:turing', [{ id: 'item-1', state: 'escalated', kind }], { 'child-a': { row: 'waiting' } }),
      ];
      const memberClosed = [before[0], rec('m:turing', [{ id: 'item-1', state: 'done', kind }], { 'child-a': { row: 'working' } })];
      const mirrorClosed = [rec('main', [{ id: 'mirror-1', state: 'done', kind: 'member' }]), memberClosed[1]];
      expect(ekipPulseKey(memberClosed)).not.toBe(ekipPulseKey(before));
      expect(ekipPulseKey(mirrorClosed)).not.toBe(ekipPulseKey(memberClosed));
    });
  }

  it('the same facts give the same key (no read on a push that changed nothing it reads)', () => {
    const a = [rec('main', [{ id: 'x', state: 'pending' }, { id: 'y', state: 'done' }]), rec('m:turing', [], { c: { row: 'idle', finishedAt: 5 } })];
    const b = [rec('m:turing', [], { c: { row: 'idle', finishedAt: 5 } }), rec('main', [{ id: 'y', state: 'done' }, { id: 'x', state: 'pending' }])];
    expect(ekipPulseKey(b)).toBe(ekipPulseKey(a));
    // A seen job (unread drops) is a change.
    const seen = [a[0], rec('m:turing', [], { c: { row: 'idle', finishedAt: 5, seenAt: 6 } })];
    expect(ekipPulseKey(seen)).not.toBe(ekipPulseKey(a));
  });

  it('a record still loading (null) is skipped', () => {
    expect(ekipPulseKey([{ superId: 'main', record: null }])).toBe('');
  });
});

describe('a poke reads at once, never at the next tick', () => {
  const fakeTimers = () => {
    const pending: Array<{ fn: () => void; ms: number; id: number }> = [];
    let next = 0;
    return {
      pending,
      timers: {
        set: (fn: () => void, ms: number) => { const id = ++next; pending.push({ fn, ms, id }); return id; },
        clear: (t: unknown) => { const i = pending.findIndex((p) => p.id === t); if (i >= 0) pending.splice(i, 1); },
      },
    };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('reads on start, again on poke with no timer fired, and keeps ONE tick', async () => {
    const { pending, timers } = fakeTimers();
    let reads = 0;
    const p = startPulsedPoll(async () => { reads += 1; }, () => 15_000, timers);
    await flush();
    expect(reads).toBe(1);
    expect(pending).toHaveLength(1);
    p.poke();
    await flush();
    expect(reads).toBe(2);
    // The old tick was dropped, the read scheduled one new one: the loop never doubles.
    expect(pending).toHaveLength(1);
    p.stop();
    expect(pending).toHaveLength(0);
  });

  it('an older read landing after a newer one never paints over it', async () => {
    const { timers } = fakeTimers();
    const resolvers: Array<(v: string) => void> = [];
    let shown = '';
    const p = startPulsedPoll(
      (current) => new Promise<string>((r) => resolvers.push(r)).then((v) => { if (current()) shown = v; }),
      () => 15_000, timers,
    );
    await flush();
    p.poke();
    await flush();
    resolvers[1]('answered');
    await flush();
    resolvers[0]('still asking');
    await flush();
    expect(shown).toBe('answered');
    p.stop();
  });

  it('no next tick when delay is null (drawer hidden), a poke still reads', async () => {
    const { pending, timers } = fakeTimers();
    let reads = 0;
    const p = startPulsedPoll(async () => { reads += 1; }, () => null, timers);
    await flush();
    expect(pending).toHaveLength(0);
    p.poke();
    await flush();
    expect(reads).toBe(2);
    p.stop();
  });
});

describe('both side menus poke their read from the live records', () => {
  for (const file of ['components/layout/newshell/DrawerFactsBridge.tsx', 'components/layout/SidebarTeam.tsx']) {
    it(file, () => {
      const s = src(file);
      expect(s).toMatch(/useVaultSuperRecords\((vault|vaultId)\)/);
      expect(s).toContain('ekipPulseKey(records)');
      expect(s).toMatch(/startPulsedPoll\(/);
      expect(s).toMatch(/poller\.current\?\.poke\(\);\s*\}, \[pulse\]\);/);
    });
  }
});
