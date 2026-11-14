/**
 * The agenda's pure model (task ajanda-gunluk, plan C3, C4, C8) and the render rule that no row
 * draws an action `rowActions` did not return:
 *  - groups by who acts next, every Waiting row kind kept; his open lines in Added by you; lines
 *    opened before today in "From earlier days";
 *  - newest update first in each group (a job's newer state lifts its line), untimed rows below;
 *    the order holds while the pointer is over the list;
 *  - today's Done merge: route only, both, push only, each once, the push winning;
 *  - a past day's two lists; "X of Y done";
 *  - rowActions row by row (live open, live Done, archived today and earlier, question, owed,
 *    approval, task, recall, sync) and the phone's read-only answer;
 *  - the five-status mirror equals the server's padStatus.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { padStatus } from '../../src/lib/super/pad.js';
import type { SuperPadItem } from '../../dashboard/src/lib/superTypes.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({ useApi: () => ({}), useVaultId: () => ({ vault: 'acme' }) }));

const G = await import('../../dashboard/src/components/sleepy/super/agendaGroups.js');
const { superNotepad, superUnanswered, padStatusOf } = await import('../../dashboard/src/components/sleepy/super/superHandover.js');
const { SuperAgenda } = await import('../../dashboard/src/components/sleepy/super/SuperAgenda.js');

const NOW = new Date(2026, 10, 14, 15, 0).getTime();
const at = (h: number, m = 0, day = 14) => new Date(2026, 10, day, h, m).getTime();
const look = { live: () => null, titleFor: (s: string) => `job ${s}`, superTitle: 'Super' };

const pad: SuperPadItem[] = [
  { id: 'n1', section: 'now', text: 'Super running', at: at(10), bornAt: at(9), for: 'c1' },
  { id: 'n2', section: 'now', text: 'Super almost', at: at(11), bornAt: at(9), stage: 'almost' },
  { id: 'n3', section: 'waiting', text: 'Super waits on you', at: at(12), bornAt: at(9) },
  { id: 'n4', section: 'now', text: 'His own line', at: at(13), bornAt: at(13), stage: 'todo', author: 'owner', by: 'owner' },
  { id: 'n5', section: 'waiting', text: 'Left from Friday', at: at(16, 0, 13), bornAt: at(16, 0, 13) },
  { id: 'n6', section: 'done', text: 'Finished today', at: at(14), bornAt: at(9) },
  { id: 'n7', section: 'done', text: 'Finished today, opened Thursday', at: at(9, 30), bornAt: at(10, 0, 12) },
];
const queue = [{ id: 'q1', sessionId: 'S', kind: 'ask', state: 'escalated', ownerText: 'Ship it?', createdAt: at(14, 30) }];
const owed = [{ id: 'o1', kind: 'msg', ref: 'abc', seq: 1, at: at(8), gist: 'Your message about pricing', nudges: 2 }];
const children = { c1: { sessionId: 'c1', brief: 'x', startedAt: 1, rowAt: at(14, 45), mode: 'develop' } };

const input = (extra: Partial<Parameters<typeof G.todayGroups>[0]> = {}) => {
  const state = { queue, pad, owed } as never;
  return {
    notepad: superNotepad(state, look, NOW), unanswered: superUnanswered(state, NOW), pad, children: children as never, now: NOW, ...extra,
  };
};
const keys = (es: { key: string }[]) => es.map((e) => e.key);

describe('groups by who acts next (criterion 3)', () => {
  it('every row lands in its group; his open line in Added by you; an earlier day above them', () => {
    const g = G.todayGroups(input({
      approvals: [{ key: 'agent:turing', kind: 'agent', slug: 'turing', title: 'Turing', memberTitle: 'Turing', member: 'turing', changed: false }] as never,
      taskRows: [{ id: 't1', kind: 'task-review', ref: 'task-a', agent: null, title: 'Review task a', actions: [], createdAt: new Date(at(7)).toISOString() }] as never,
      recallRows: [{ id: 'r1', kind: 'recall-index-stopped', ref: '', agent: null, title: 'Index', actions: [], createdAt: new Date(at(6)).toISOString() }] as never,
      syncRows: [{ id: 's1', kind: 'brain-sync-paused', ref: '', agent: null, title: 'Sync', actions: [], createdAt: 'not a date' }] as never,
    }));
    expect(keys(g.earlier)).toEqual(['n:n5']);
    expect(g.earlier[0].fromDay).toBe('2026-11-13');
    expect(keys(g.super)).toEqual(['n:n1', 'n:n2']); // n1's job moved at 14:45: it is the newest
    expect(keys(g.mine)).toEqual(['n:n4']);
    expect(keys(g.done)).toEqual(['n:n6', 'n:n7']);
    expect(g.done[1].fromDay).toBe('2026-11-12');
    // Waiting: question 14:30, Super's waiting line 12:00, owed 08:00, task 07:00, recall 06:00, then the untimed rows.
    expect(keys(g.waiting)).toEqual(['q:q1', 'n:n3', 'o:o1', 't1', 'r1', 'agent:turing', 's1']);
    expect(g.waiting.map((e) => e.kind)).toEqual(['question', 'line', 'owed', 'task', 'recall', 'approval', 'sync']);
  });

  it('a status change (stage only included) moves a line up', () => {
    const moved = pad.map((p) => (p.id === 'n2' ? { ...p, stage: undefined, at: at(14, 50) } : p));
    const state = { queue, pad: moved, owed } as never;
    const g = G.todayGroups({ notepad: superNotepad(state, look, NOW), unanswered: [], pad: moved, children: children as never, now: NOW });
    expect(keys(g.super)).toEqual(['n:n2', 'n:n1']);
  });

  it('progress counts the view and the leftovers; questions count in Y', () => {
    const p = G.agendaProgress(G.todayGroups(input()));
    expect(p).toEqual({ done: 2, total: 9, working: 2, waiting: 3 });
  });
});

describe('the order holds while the pointer is over the list (C3)', () => {
  it('drawn rows keep their order, a new one goes on top', () => {
    const e = (key: string, t: number) => ({ key, kind: 'line' as const, group: 'super' as const, at: t, live: true });
    const held = ['a', 'b', 'c'];
    expect(keys(G.holdOrder([e('c', 9), e('new', 10), e('a', 1), e('b', 5)], held))).toEqual(['new', 'a', 'b', 'c']);
    expect(keys(G.holdOrder([e('c', 9), e('a', 1)], null))).toEqual(['c', 'a']);
  });
});

describe("today's Done merge (C4)", () => {
  const today = '2026-11-14';
  const live = (id: string, t: number, section: SuperPadItem['section'] = 'done'): SuperPadItem => ({ id, section, text: id, at: t });
  it('only in the route, in both, only in the push: each once, the push winning', () => {
    const merged = G.mergeTodayDone([live('p', at(9)), live('both', at(10))], [live('both', at(8)), live('r', at(7)), live('r', at(7, 30))], today);
    expect(merged.map((m) => [m.item.id, m.live, m.item.at])).toEqual([['p', true, at(9)], ['both', true, at(10)], ['r', false, at(7, 30)]]);
  });
  it('a reopened line is not Done any more, whatever the file says', () => {
    expect(G.mergeTodayDone([live('x', at(11), 'now')], [live('x', at(9))], today)).toEqual([]);
  });
  it('an evicted line of today shows in Done and counts', () => {
    const g = G.todayGroups(input({ routeDone: [{ id: 'n99', section: 'done', text: 'Evicted', at: at(12) }] }));
    expect(g.done.find((e) => e.key === 'n:n99')?.live).toBe(false);
    expect(G.agendaProgress(g).done).toBe(3);
  });
});

describe('a past day (C4)', () => {
  it('Done that day from the route (archived unless live), started that day and still open from the pad', () => {
    const d = G.dayGroups('2026-11-13', pad, [
      { id: 'old', section: 'done', text: 'closed Friday', at: at(10, 0, 13), bornAt: at(10, 0, 11) },
    ]);
    expect(d.dayDone.map((e) => [e.key, e.live, e.fromDay])).toEqual([['n:old', false, '2026-11-11']]);
    expect(keys(d.dayOpen)).toEqual(['n:n5']);
  });
});

describe('rowActions (C8): the one source of what a row may do', () => {
  const ent = (kind: string, live: boolean, row: Record<string, unknown> = {}) => ({ kind, live, row } as never);
  it('row by row', () => {
    expect(G.rowActions(ent('line', true, { section: 'now', status: 'in-progress' }))).toEqual({ mark: 'status', menu: true, press: 'detail', hover: ['done', 'ask'], detail: 'full', remove: false });
    expect(G.rowActions(ent('line', true, { section: 'now', author: 'owner' })).remove).toBe(true);
    expect(G.rowActions(ent('line', true, { section: 'done', author: 'owner' }))).toEqual({ mark: 'status', menu: true, press: 'detail', hover: ['ask'], detail: 'full', remove: false });
    // An archived line, today's or a past day's: check, Ask, read-only detail, never the menu.
    expect(G.rowActions(ent('line', false, { section: 'done' }))).toEqual({ mark: 'check', menu: false, press: 'detail', hover: ['ask'], detail: 'readonly', remove: false });
    expect(G.rowActions(ent('question', false))).toEqual({ mark: 'icon', menu: false, press: 'legacy', hover: ['ask'], detail: 'none', remove: false });
    expect(G.rowActions(ent('owed', false)).hover).toEqual(['notNeeded', 'ask']);
    for (const k of ['approval', 'task', 'recall', 'sync']) {
      expect(G.rowActions(ent(k, false)), k).toEqual({ mark: 'icon', menu: false, press: 'legacy', hover: [], detail: 'none', remove: false });
    }
  });
  it('the phone is read only: no hover action, no menu, no detail', () => {
    for (const [k, live] of [['line', true], ['line', false], ['question', false], ['owed', false], ['task', false]] as const) {
      const a = G.rowActions(ent(k, live, { section: 'now' }), { readOnly: true });
      expect(a.hover, k).toEqual([]);
      expect(a.menu).toBe(false);
      expect(a.detail).toBe('none');
      expect(a.remove).toBe(false);
    }
  });
});

describe('placement', () => {
  const view = { width: 1440, height: 900 };
  it('beside the card on the side with room, never over the centre chat when a side allows', () => {
    const card = { x: 900, y: 100, width: 344, height: 344 };
    expect(G.placeBeside(card, 320, 400, view)).toEqual({ x: 900 - 8 - 320, y: 100 }); // no room right
    const left = { x: 40, y: 100, width: 160, height: 160 };
    expect(G.placeBeside(left, 320, 400, view, { x: 208, y: 0, width: 600, height: 900 }).x).toBe(208);
  });
  it('a menu flips above when there is no room below', () => {
    expect(G.placeBelow({ x: 10, y: 880, width: 16, height: 16 }, 176, 180, view).y).toBe(880 - 4 - 180);
  });
});

describe('the five statuses', () => {
  it('the dashboard mirror equals the server', () => {
    for (const section of ['now', 'waiting', 'done'] as const) {
      for (const stage of [undefined, 'todo', 'almost'] as const) {
        expect(padStatusOf({ section, stage }), `${section}/${stage}`).toBe(padStatus({ section, stage }));
      }
    }
  });
});

describe('no row draws an action rowActions did not return', () => {
  it('at every size, with every handler present', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    for (const size of ['small', 'medium', 'large', 'wide', 'full'] as const) {
      const html = renderToStaticMarkup(createElement(SuperAgenda, {
        state: { queue: queue as never, pad, owed: owed as never, children: children as never }, look, size,
        canShowChild: () => true, onShowChild: () => {}, onShowQuestion: () => {}, onWriteAbout: () => {},
        onPadStatus: async () => {}, onPadAdd: async () => {}, onPadRemove: async () => {}, onDropOwed: () => {},
      }));
      const rows = [...html.matchAll(/<div class="super-agenda-row"([^>]*)>([\s\S]*?)(?=<div class="super-agenda-row"|<\/section>|<\/details>|<\/div><\/div>)/g)];
      expect(rows.length, size).toBeGreaterThan(0);
      for (const [, attrs, inner] of rows) {
        const kind = /data-kind="([^"]+)"/.exec(attrs)![1];
        const live = /data-live="true"/.test(attrs);
        const k = kind === 'note' ? 'line' : kind;
        const want = G.rowActions({ kind: k, live, row: { section: /data-state="([^"]+)"/.exec(attrs)![1] } } as never);
        expect(/data-testid="super-agenda-status"/.test(inner), `${size} ${attrs}`).toBe(want.menu);
        expect(/data-testid="super-agenda-done"/.test(inner), `${size} ${attrs}`).toBe(want.hover.includes('done'));
        expect(/data-testid="super-agenda-about"/.test(inner), `${size} ${attrs}`).toBe(want.hover.includes('ask'));
      }
    }
    vi.useRealTimers();
  });

  it('read only (the phone): no +, Done, Ask or status menu', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const html = renderToStaticMarkup(createElement(SuperAgenda, {
      state: { queue: queue as never, pad, owed: owed as never }, look, size: 'large', readOnly: true,
      canShowChild: () => false, onShowChild: () => {}, onShowQuestion: () => {}, onWriteAbout: () => {},
    }));
    for (const id of ['super-agenda-plus', 'super-agenda-add', 'super-agenda-done', 'super-agenda-about', 'super-agenda-status', 'super-agenda-day-prev']) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
    expect(html).toContain('data-testid="super-agenda-section-waiting"');
    vi.useRealTimers();
  });
});
