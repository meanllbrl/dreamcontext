/**
 * Closing cards straight from Others (owner 2026-10-28: "sağ aşağıdaki others içinde de çarpılara
 * basarak kapatabilmemiz lazım"): every tile in the Others panel carries the stage card's ×, and
 * it runs the stage's OWN close for that kind, never a new one.
 *
 *  - `panelCloseOf`: what the × does per kind (a plain card at once, a child chat asks "end it",
 *    a group asks "close its cards", a group of running jobs only says why, the agenda has none);
 *  - `runPanelClose`: each decision lands on its stage path (close the card, end the child,
 *    the group's close-all) and nothing else;
 *  - `PanelItemClose` / `GroupPanel`: the × and its question as drawn;
 *  - the wiring in SuperSurface: Others only, never on a remote screen, through the stage's paths.
 * Fictional names throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { panelCloseOf, panelCols, panelRect, runPanelClose, type PanelClose } from '../../dashboard/src/components/sleepy/super/GroupPanel.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (f: string) => readFileSync(join(ROOT, f), 'utf-8');

const paths = () => ({ closeCard: vi.fn(), endChat: vi.fn(), closeGroup: vi.fn() });

describe('what a tile\'s × does (panelCloseOf)', () => {
  it('closes an image, a page, a PDF, a clip, a task or an insight at once', () => {
    for (const kind of ['image', 'web', 'pdf', 'video', 'task', 'insight', 'browser', 'file'] as const) {
      expect(panelCloseOf({ kind })).toEqual({ kind: 'now' });
    }
  });

  it('asks first for a child chat, as its stage card does: end it, or end it when its turn is done', () => {
    expect(panelCloseOf({ kind: 'chat' })).toEqual({ kind: 'end', whenDone: false });
    expect(panelCloseOf({ kind: 'chat', busy: true })).toEqual({ kind: 'end', whenDone: true });
    // An end already asked for, or refused by the server: the tile says so.
    expect(panelCloseOf({ kind: 'chat', ending: 'failed' })).toEqual({ kind: 'end', whenDone: false, ending: 'failed' });
  });

  it('asks first for a group, with the count its close-all would close; a group of running jobs only says why', () => {
    expect(panelCloseOf({ kind: 'group', closable: 3 })).toEqual({ kind: 'group', n: 3 });
    expect(panelCloseOf({ kind: 'group', closable: 0 })).toEqual({ kind: 'kept' });
    expect(panelCloseOf({ kind: 'group' })).toEqual({ kind: 'kept' });
  });

  it('never closes the agenda', () => {
    expect(panelCloseOf({ kind: 'agenda' })).toBeNull();
  });
});

describe('the close from Others (runPanelClose) runs the stage\'s own path', () => {
  it('a single card: closes that card only', () => {
    const p = paths();
    expect(runPanelClose('img-cake', { kind: 'now' }, p)).toBe(true);
    expect(p.closeCard).toHaveBeenCalledExactlyOnceWith('img-cake');
    expect(p.endChat).not.toHaveBeenCalled();
    expect(p.closeGroup).not.toHaveBeenCalled();
  });

  it('a chat card: ends the child, when done if it is still in its turn', () => {
    const p = paths();
    runPanelClose('chat-1', { kind: 'end', whenDone: false }, p);
    runPanelClose('chat-2', { kind: 'end', whenDone: true, ending: 'pending' }, p);
    expect(p.endChat.mock.calls).toEqual([['chat-1', false], ['chat-2', true]]);
    expect(p.closeCard).not.toHaveBeenCalled();
    expect(p.closeGroup).not.toHaveBeenCalled();
  });

  it('a group: the group\'s close-all, for that group only', () => {
    const p = paths();
    runPanelClose('grp-menu', { kind: 'group', n: 2 }, p);
    expect(p.closeGroup).toHaveBeenCalledExactlyOnceWith('grp-menu');
    expect(p.closeCard).not.toHaveBeenCalled();
    expect(p.endChat).not.toHaveBeenCalled();
  });

  it('a group of running jobs: nothing happens', () => {
    const p = paths();
    expect(runPanelClose('grp-live', { kind: 'kept' }, p)).toBe(false);
    expect(p.closeCard).not.toHaveBeenCalled();
    expect(p.endChat).not.toHaveBeenCalled();
    expect(p.closeGroup).not.toHaveBeenCalled();
  });
});

describe('the × as drawn', () => {
  const load = async () => {
    const { createElement } = await import('../../dashboard/node_modules/react/index.js');
    const { renderToStaticMarkup } = await import('../../dashboard/node_modules/react-dom/server.node.js');
    const { I18nProvider } = await import('../../dashboard/src/context/I18nContext.js');
    const { PanelItemClose, GroupPanel } = await import('../../dashboard/src/components/sleepy/super/GroupPanel.js');
    const item = (close: PanelClose, asking = false) => renderToStaticMarkup(createElement(I18nProvider, null,
      createElement(PanelItemClose as never, { closeOf: () => close, asking, onToggle: () => {}, onConfirm: () => {} })));
    return { createElement, renderToStaticMarkup, I18nProvider, GroupPanel, item };
  };

  it('is a labelled button, top right; a plain card has no question', async () => {
    const { item } = await load();
    const now = item({ kind: 'now' });
    expect(now).toContain('class="super-panel-close"');
    expect(now).toMatch(/<button type="button" class="super-icon-btn" data-testid="super-panel-item-close" aria-label="Close this card" title="Close this card">/);
    expect(now).not.toContain('aria-expanded');
    expect(item({ kind: 'now' }, true)).not.toContain('super-panel-close-choice');
  });

  it('asks the stage card\'s question for a chat and a group, and only says why for running jobs', async () => {
    const { item } = await load();
    const chat = item({ kind: 'end', whenDone: false }, true);
    expect(chat).toContain('aria-expanded="true"');
    expect(chat).toContain('This chat?');
    expect(chat).toMatch(/data-testid="super-panel-close-end">End session</);
    expect(item({ kind: 'end', whenDone: true }, true)).toMatch(/data-testid="super-panel-close-end">End when done</);
    const group = item({ kind: 'group', n: 3 }, true);
    expect(group).toContain('Close its cards? Running jobs stay');
    expect(group).toMatch(/data-testid="super-panel-close-end">Close 3 cards</);
    const kept = item({ kind: 'kept' }, true);
    expect(kept).toContain('Its jobs are running: nothing to close');
    expect(kept).not.toContain('super-panel-close-end');
    // Closed: no question drawn.
    expect(item({ kind: 'group', n: 3 })).not.toContain('super-panel-close-choice');
  });

  it('says when a chat ends when done, and when its end was refused', async () => {
    const { item } = await load();
    expect(item({ kind: 'end', whenDone: true, ending: 'pending' })).toMatch(/data-testid="super-panel-close-pending">Ends when done</);
    expect(item({ kind: 'end', whenDone: false, ending: 'failed' })).toMatch(/role="alert" data-testid="super-panel-close-failed">Not ended: still running\. Try again</);
  });

  it('is on every tile that has a close, on none without one, and not on a panel that closes nothing', async () => {
    const { createElement, renderToStaticMarkup, I18nProvider, GroupPanel } = await load();
    const panel = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(I18nProvider, null, createElement(GroupPanel as never, {
      title: 'Others', ids: ['chat-1', 'img-cake', 'grp-menu', 'agenda'], anchor: { x: 900, y: 600, width: 160, height: 40 }, stage: { width: 1200, height: 800 },
      system: true, onClose: () => {}, onOpenItem: () => {}, onPressItem: () => {}, renderItem: (id: string) => createElement('span', null, id),
      itemTestId: 'super-others-item', returnFocus: () => {}, ...extra,
    })));
    const closes: Record<string, PanelClose | null> = { 'chat-1': { kind: 'end', whenDone: false }, 'img-cake': { kind: 'now' }, 'grp-menu': { kind: 'group', n: 2 }, agenda: null };
    const on = panel({ closeOf: (id: string) => closes[id], onCloseItem: () => {} });
    expect(on.match(/data-testid="super-panel-item-close"/g)).toHaveLength(3);
    expect(panel({ closeOf: (id: string) => closes[id] })).not.toContain('super-panel-item-close');
    expect(panel({})).not.toContain('super-panel-item-close');
  });

  it('reads a chat tile\'s close at every render and again at the press, never a copy drawn earlier', () => {
    const src = read('dashboard/src/components/sleepy/super/GroupPanel.tsx');
    // The tile follows its child's status, as the stage card does (frameKeyOf), and draws the close it reads now.
    expect(src).toMatch(/useLiveSession\(session, \(\) => frameKeyOf\(session\)\);\s*const close = closeOf\(\);/);
    expect(src).toContain('<PanelItemClose closeOf={() => closeOf(id)} session={sessionOf?.(id)}');
    // The press reads it again: a child that started working since is ended when done.
    expect(src).toMatch(/const closeItem = \(id: string\) => \{[\s\S]*?const close = closeOf\?\.\(id\);[\s\S]*?onCloseItem\(id, close\);/);
    expect(read('dashboard/src/components/sleepy/super/SuperSurface.tsx')).toContain('sessionOf={system || moreOpen ? panelSessionOf : undefined}');
  });

  it('shows on hover or focus, and always on a touch screen', () => {
    const css = read('dashboard/src/components/sleepy/super/SuperSurface.css');
    expect(css).toMatch(/\.super-panel-item:hover \.super-panel-close,\s*\.super-panel-item:focus-within \.super-panel-close,/);
    expect(css).toMatch(/@media \(hover: none\) \{ \.super-panel-close \{ opacity: 1; pointer-events: auto; \} \}/);
  });
});

describe('the panel on a phone-width stage', () => {
  it('holds as many columns as the stage fits (up to 4), so no tile and no × is cut off', () => {
    expect(panelCols(7, 1440)).toBe(4);
    expect(panelCols(2, 1440)).toBe(2);
    expect(panelCols(7, 560)).toBe(2);
    expect(panelCols(7, 334)).toBe(1);
    expect(panelCols(7, 100)).toBe(1);
    const stage = { width: 334, height: 788 };
    const r = panelRect({ x: 180, y: 730, width: 140, height: 40 }, 7, stage, true);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(stage.width);
  });
});

describe('the wiring in SuperSurface', () => {
  const src = read('dashboard/src/components/sleepy/super/SuperSurface.tsx');

  it('gives the × to Others only', () => {
    expect(src).toContain('closeOf={system ? panelCloseFor : undefined}');
    expect(src).toContain('onCloseItem={system ? closeFromPanel : undefined}');
  });

  it('runs the stage\'s close, the child\'s end and the group\'s close-all, never on a remote screen', () => {
    const body = src.slice(src.indexOf('const panelCloseFor = '), src.indexOf('const othersGroupIds = '));
    expect(body).toMatch(/if \(remote\) return null;/);
    expect(body).toMatch(/const closeFromPanel = \(id: string, close: PanelClose\) => \{\s*if \(remote\) return;/);
    expect(body).toContain('closeCard: (cid) => closeCards([cid])');
    expect(body).toContain("if (c?.kind === 'chat') props.onEndChild(c.ref, whenDone)");
    expect(body).toContain('closeGroup: (gid) => closeGroups([gid], true)');
    // The group's count is the close-all's own (running jobs stay).
    expect(body).toContain("panelCloseOf({ kind: 'group', closable: closableIn([id]).length })");
    // The stage card's close and the group close-all go through the same closeCards.
    expect(src).toMatch(/onClose: \(id: string\) => \{[\s\S]*?closeCards\(\[id\]\); focusAfter\(id\);/);
    expect(src).toMatch(/if \(plain\.length\) closeCards\(plain\);/);
  });
});
