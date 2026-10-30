/**
 * The new shell's chat drawer as data (task codex-tarzi-yeni-kabuk W2-A, AC 7/8b/9/10): row
 * order, the Super Agent row always first, only team members with work, mounted vs fan-out
 * sources, the intent rule at the ceiling, reordering, and the History fan-out merge.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildDrawerRows, dropInOrder, intentLands, moveInOrder, teamRowsOf, type DrawerProjectInput,
} from '../../dashboard/src/components/layout/newshell/drawerModel.js';
import { fanOutHistory, HISTORY_PARALLEL, HISTORY_PER_VAULT } from '../../dashboard/src/components/layout/newshell/historyFanout.js';
import { chill, oldestEvictable } from '../../dashboard/src/components/layout/instanceCeiling.js';

const rollup = (o: Partial<Record<string, number>> = {}) => ({
  worst: 'idle', live: 0, waiting: 0, asking: 0, working: 0, idle: 0, flagged: 0, alive: 0, ...o,
}) as any;

const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});

const team = (slug: string, status: string, extra: Record<string, unknown> = {}) => ({
  slug, title: slug, hasPhoto: false, status, readOnly: false, ...extra,
}) as any;

describe('drawer rows', () => {
  it('keeps the picker order and expands several projects at once', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex'), project('initech')],
      activeVault: 'acme',
      expanded: ['acme', 'initech'],
      facts: {},
      fanout: {},
    });
    expect(rows.map((r) => r.name)).toEqual(['acme', 'globex', 'initech']);
    expect(rows.map((r) => r.expanded)).toEqual([true, false, true]);
    expect(rows[1].children).toEqual([]);
  });

  it('puts the Super Agent row first under every expanded project, even before anything is read', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex')],
      activeVault: 'acme', expanded: ['acme', 'globex'], facts: {}, fanout: {},
    });
    for (const r of rows) {
      expect(r.children[0].kind).toBe('super');
      expect(r.children[r.children.length - 1].kind).toBe('window');
    }
    expect(rows[1].source).toBe('none');
  });

  it('lists only members with work, those that want the owner first', () => {
    const listed = teamRowsOf([
      team('idle-one', 'idle'), team('runner', 'working'), team('asker', 'needs'),
      team('paused-one', 'paused'), team('review', 'approval'), team('theirs', 'needs', { readOnly: true }),
    ]);
    expect(listed.map((m) => m.slug)).toEqual(['asker', 'review', 'runner']);
  });

  it('takes a mounted project from its facts and rollup, a far one from the fan-out', () => {
    const rows = buildDrawerRows({
      projects: [
        project('acme', { mounted: true, rollup: rollup({ live: 4, working: 2, asking: 1, idle: 1, flagged: 1 }) }),
        project('globex'),
      ],
      activeVault: 'acme',
      expanded: ['acme', 'globex'],
      facts: { acme: { superOn: true, superSelected: false, chatOpen: true, team: [{ slug: 'digest', title: 'Digest', hasPhoto: false, status: 'working' }] } },
      fanout: { globex: { tabs: 3, superOn: false, team: [] } },
    });
    expect(rows[0].source).toBe('mounted');
    expect(rows[0].children).toEqual([
      { kind: 'super', on: true, selected: false },
      { kind: 'member', slug: 'digest', title: 'Digest', hasPhoto: false, status: 'working' },
      { kind: 'window', id: 'main', working: 2, asking: 1, flagged: 1, other: 1, selected: true },
    ]);
    expect(rows[1].source).toBe('fanout');
    // No ring for a project that is not mounted: nothing runs there.
    expect(rows[1].children[1]).toMatchObject({ kind: 'window', working: 0, other: 3, selected: false });
  });

  it('marks the Super row selected (not the window) while the stage is on screen, only for the active project', () => {
    const facts = { superOn: true, superSelected: true, chatOpen: true, team: [] };
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true, rollup: rollup() }), project('globex', { mounted: true, rollup: rollup() })],
      activeVault: 'acme', expanded: ['acme', 'globex'], facts: { acme: facts, globex: facts }, fanout: {},
    });
    expect(rows[0].children[0]).toMatchObject({ kind: 'super', selected: true });
    expect(rows[0].children.at(-1)).toMatchObject({ kind: 'window', selected: false });
    expect(rows[1].children[0]).toMatchObject({ kind: 'super', selected: false });
  });

  it('says which rows this window holds, which sleep and which live in another window', () => {
    const rows = buildDrawerRows({
      projects: [project('acme', { mounted: true }), project('globex', { asleep: true }), project('initech', { otherWindow: true }), project('umbrella')],
      activeVault: 'acme', expanded: [], facts: {}, fanout: {},
    });
    expect(rows.map((r) => [r.held, r.asleep, r.otherWindow])).toEqual([
      [true, false, false], [true, true, false], [false, false, true], [false, false, false],
    ]);
  });
});

describe('drawer intents', () => {
  it('travel only to a project this window now shows mounted', () => {
    expect(intentLands('added', true)).toBe(true);
    expect(intentLands('focused-tab', true)).toBe(true);
    // Another OS window holds it: that window comes forward and nothing is queued here.
    expect(intentLands('focused-window', false)).toBe(false);
    // All six busy: refused with the notice.
    expect(intentLands('refused-ceiling', false)).toBe(false);
    // A cold chip the ceiling would not wake.
    expect(intentLands('focused-tab', false)).toBe(false);
  });

  it('a pick at the ceiling puts the oldest idle project to sleep, never one with a live chat', () => {
    const open = [
      { vault: 'a', cold: false, rollup: rollup({ alive: 1 }) },
      { vault: 'b', cold: false, rollup: rollup({ alive: 0 }) },
      { vault: 'c', cold: false, rollup: null },
    ] as any[];
    const victim = oldestEvictable(open, ['c']);
    expect(victim?.vault).toBe('b');
    expect(chill(open, 'b').find((p: any) => p.vault === 'b').cold).toBe(true);
  });
});

describe('drawer order', () => {
  it('moves a project one step, an end stays put', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  });

  it('drops a dragged project before the row under the pointer', () => {
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropInOrder(['a', 'b', 'c', 'd'], 'b', 4)).toEqual(['a', 'c', 'd', 'b']);
  });
});

describe('the drawer and History, wired', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/${rel}`, import.meta.url)), 'utf-8');
  it('classic History renders no extra box (byte-identical markup)', () => {
    const picker = src('components/sleepy/ChatHistoryPicker.tsx');
    expect(picker).toMatch(/return on \? <div className="chp-body">\{children\}<\/div> : <>\{children\}<\/>;/);
    expect(picker).toMatch(/<BodyWrap on=\{cross\}>/);
  });
  it('a project row is two sibling buttons, never a button inside a button', () => {
    const drawer = src('components/layout/newshell/ChatDrawer.tsx');
    expect(drawer).not.toMatch(/role="button"/);
    expect(drawer).toMatch(/<button type="button" className="ns-dr-toggle" aria-expanded=\{row\.expanded\}/);
  });
  it('History names the projects it could not read', () => {
    expect(src('components/sleepy/ChatHistoryPicker.tsx')).toMatch(/setFailedVaults\(r\.failed\)/);
  });
});

describe('History across projects', () => {
  it('asks every project, at most three at once, the first 30 each, newest first, each row with its project', async () => {
    let inFlight = 0;
    let peak = 0;
    const read = async (vault: string) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const sessions = Array.from({ length: 40 }, (_, i) => ({ id: `${vault}-${i}`, updatedAt: vault.length * 1000 + (40 - i) }));
      return { sessions, total: 40, agentRuns: 1 };
    };
    const r = await fanOutHistory(['a', 'bb', 'ccc', 'dddd', 'eeeee'], read, () => true);
    expect(peak).toBeLessThanOrEqual(HISTORY_PARALLEL);
    expect(r.sessions).toHaveLength(5 * HISTORY_PER_VAULT);
    expect(r.sessions[0]).toMatchObject({ id: 'eeeee-0', vault: 'eeeee' });
    expect(r.total).toBe(200);
    for (const s of r.sessions) expect(s.id.startsWith(s.vault)).toBe(true);
  });

  it('a newer query stops this one starting more requests; a failed project is named', async () => {
    const asked: string[] = [];
    let live = true;
    const read = async (vault: string) => {
      asked.push(vault);
      if (vault === 'b') throw new Error('down');
      await new Promise((r) => setTimeout(r, 5));
      live = false;
      return { sessions: [] };
    };
    const r = await fanOutHistory(['a', 'b', 'c', 'd', 'e', 'f'], read, () => live);
    expect(asked.length).toBeLessThan(6);
    expect(r.failed).toContain('b');
  });
});
