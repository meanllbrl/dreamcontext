/**
 * Element links on a whiteboard (D3, A9).
 *
 * Excalidraw's fallback for a clicked link is `window.open(…, _self|_blank).location = url`. In
 * the desktop shell that can replace the app window with no way back, so `onLinkOpen` must
 * prevent it first, always, and then route. These tests drive the extracted handler with a
 * fake `window` whose `open` and `location` would record any escape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installExternalLinkHandler } from '../../dashboard/src/lib/externalLinks.js';
import {
  handleLinkOpen, routeElementLink, installHyperlinkGuard, HYPERLINK_SELECTOR,
} from '../../dashboard/src/components/whiteboard/linkRouting.js';

const ORIGIN = 'http://127.0.0.1:4173';

describe('routeElementLink', () => {
  it('dreamcontext:// goes to the in-app handler', () => {
    expect(routeElementLink('dreamcontext://task/fix-login', ORIGIN)).toEqual({ to: 'internal', kind: 'task', id: 'fix-login' });
    expect(routeElementLink('dreamcontext://knowledge/features/whiteboards', ORIGIN))
      .toEqual({ to: 'internal', kind: 'knowledge', id: 'features/whiteboards' });
  });

  it('an absolute http(s)/mailto/tel link to another origin goes to the OS', () => {
    expect(routeElementLink('https://example.com/a?b=1', ORIGIN)).toEqual({ to: 'external', url: 'https://example.com/a?b=1' });
    expect(routeElementLink('mailto:someone@example.com', ORIGIN)).toEqual({ to: 'external', url: 'mailto:someone@example.com' });
  });

  it('relative, same-origin and unsafe-scheme links are dropped', () => {
    expect(routeElementLink('/api/whiteboards/x', ORIGIN)).toEqual({ to: 'drop', reason: 'relative' });
    expect(routeElementLink('api/tasks', ORIGIN)).toEqual({ to: 'drop', reason: 'relative' });
    expect(routeElementLink(`${ORIGIN}/api/whiteboards/x`, ORIGIN)).toEqual({ to: 'drop', reason: 'same-origin' });
    expect(routeElementLink('javascript:alert(1)', ORIGIN)).toEqual({ to: 'drop', reason: 'scheme' });
    expect(routeElementLink('file:///etc/passwd', ORIGIN)).toEqual({ to: 'drop', reason: 'scheme' });
    expect(routeElementLink('dreamcontext://nokind', ORIGIN)).toEqual({ to: 'drop', reason: 'malformed' });
  });
});

describe('handleLinkOpen — location unchanged, window.open never called', () => {
  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;
  let fakeWindow: { open: ReturnType<typeof vi.fn>; location: { href: string } };

  beforeEach(() => {
    saved = g.window;
    fakeWindow = { open: vi.fn(), location: { href: `${ORIGIN}/whiteboards/daily` } };
    g.window = fakeWindow;
  });
  afterEach(() => { g.window = saved; });

  /** The deps the canvas wires, with the OS opener modelled as the web fallback (`window.open`). */
  function deps() {
    return {
      ownOrigin: ORIGIN,
      openExternal: vi.fn((url: string) => { fakeWindow.open(url, '_blank', 'noopener,noreferrer'); }),
      openInternal: vi.fn(),
      toast: vi.fn(),
    };
  }

  for (const link of ['/api/whiteboards/daily', `${ORIGIN}/api/tasks`, `${ORIGIN}/`, 'javascript:alert(1)']) {
    it(`drops ${link} with a toast and leaves the window alone`, () => {
      const d = deps();
      const event = { preventDefault: vi.fn() };
      const route = handleLinkOpen({ link }, event, d);
      expect(route.to).toBe('drop');
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(fakeWindow.open).not.toHaveBeenCalled();
      expect(fakeWindow.location.href).toBe(`${ORIGIN}/whiteboards/daily`);
      expect(d.openExternal).not.toHaveBeenCalled();
      expect(d.openInternal).not.toHaveBeenCalled();
      expect(d.toast).toHaveBeenCalledTimes(1);
    });
  }

  it('prevents the default BEFORE routing, even when reading the link throws', () => {
    const order: string[] = [];
    const d = deps();
    const event = { preventDefault: vi.fn(() => order.push('prevent')) };
    const element = { get link(): string { order.push('read'); throw new Error('boom'); } };
    const route = handleLinkOpen(element, event, d);
    expect(order).toEqual(['prevent', 'read']);
    expect(route).toEqual({ to: 'drop', reason: 'malformed' });
    expect(fakeWindow.open).not.toHaveBeenCalled();
  });

  it('routes dreamcontext:// in-app and https out through the external opener', () => {
    const d = deps();
    handleLinkOpen({ link: 'dreamcontext://task/fix-login' }, { preventDefault: vi.fn() }, d);
    expect(d.openInternal).toHaveBeenCalledWith('task', 'fix-login');
    handleLinkOpen({ link: 'https://example.com/' }, { preventDefault: vi.fn() }, d);
    expect(d.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(fakeWindow.location.href).toBe(`${ORIGIN}/whiteboards/daily`);
  });

  it('the canvas wires onLinkOpen through handleLinkOpen (source pin)', () => {
    const src = readFileSync(
      join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/whiteboard/WhiteboardCanvas.tsx'),
      'utf-8',
    );
    expect(src).toMatch(/onLinkOpen=\{onLinkOpen\}/);
    expect(src).toMatch(/handleLinkOpen\(element, event,/);
    // On WINDOW, capture phase: the only place that runs before main.tsx's document-level
    // external-link handler (the verify run's same-origin window.open).
    expect(src).toMatch(/installHyperlinkGuard\(window, wrap, \(href, event\) => onLinkOpen\(\{ link: href \}, event\)\)/);
  });
});

/**
 * The verify failure this pins (A9, real server): a same-origin absolute link on the popup was
 * opened with window.open. Cause: main.tsx's `installExternalLinkHandler` listens on DOCUMENT in
 * the capture phase and hands any absolute http(s) href to the OS, and it runs before React's
 * onClick on Excalidraw's anchor, so `onLinkOpen` never got a say. The guard therefore sits on
 * WINDOW, capture phase. These tests replay the real propagation order (window capture, then
 * document capture) against the real app-global handler.
 */
describe('installHyperlinkGuard vs the app-global external-link handler', () => {
  type L = (e: Event) => void;
  class Target {
    capture: Record<string, L[]> = {};
    addEventListener(type: string, fn: L, capture?: unknown) { if (capture === true) (this.capture[type] ??= []).push(fn); }
    removeEventListener(type: string, fn: L, capture?: unknown) {
      if (capture === true) this.capture[type] = (this.capture[type] ?? []).filter((f) => f !== fn);
    }
  }

  const g = globalThis as unknown as { window?: unknown };
  let saved: unknown;
  let win: Target & { open: ReturnType<typeof vi.fn>; location: { href: string; origin: string } };
  let doc: Target;
  let removeGlobal: () => void;

  beforeEach(() => {
    saved = g.window;
    win = Object.assign(new Target(), { open: vi.fn(), location: { href: `${ORIGIN}/whiteboards/daily`, origin: ORIGIN } });
    g.window = win; // openExternalUrl's web fallback is window.open on this object
    doc = new Target();
    removeGlobal = installExternalLinkHandler(doc as unknown as Document);
  });
  afterEach(() => { removeGlobal(); g.window = saved; });

  const board = { inside: new Set<unknown>(), contains(node: unknown) { return this.inside.has(node); } };

  function popupAnchor(href: string) {
    const anchor = { getAttribute: (n: string) => (n === 'href' ? href : null), closest: (sel: string) => (sel === HYPERLINK_SELECTOR || sel === 'a[href]' ? anchor : null) };
    board.inside.add(anchor);
    return anchor;
  }

  function click(target: unknown, type: 'click' | 'auxclick' = 'click') {
    const e = {
      type, button: type === 'click' ? 0 : 1, target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    // Window capture first, then document capture: the DOM's own order.
    for (const t of [win, doc]) {
      for (const fn of [...(t.capture[type] ?? [])]) fn(e as unknown as Event);
      if (e.stopped) break;
    }
    return e;
  }

  function routeVia(deps: Parameters<typeof handleLinkOpen>[2]) {
    return installHyperlinkGuard(win, board, (href, event) => handleLinkOpen({ link: href }, event, deps));
  }

  it('without the guard the same-origin link reaches window.open (the reproduced verify failure)', async () => {
    click(popupAnchor(`${ORIGIN}/api/whiteboards`));
    await Promise.resolve();
    expect(win.open).toHaveBeenCalledWith(`${ORIGIN}/api/whiteboards`, '_blank', 'noopener,noreferrer');
  });

  for (const href of [`${ORIGIN}/api/whiteboards`, '/api/whiteboards', `${ORIGIN}/`]) {
    it(`with the guard, ${href} is dropped with a toast: window.open never called, location unchanged`, async () => {
      const toast = vi.fn();
      const openExternal = vi.fn();
      const off = routeVia({ ownOrigin: ORIGIN, openExternal, openInternal: vi.fn(), toast });
      const e = click(popupAnchor(href));
      await Promise.resolve();
      expect(e.defaultPrevented).toBe(true);
      expect(e.stopped).toBe(true);
      expect(win.open).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledTimes(1);
      expect(win.location.href).toBe(`${ORIGIN}/whiteboards/daily`);
      off();
    });
  }

  it('a middle-click on the popup is cancelled and opens nothing', async () => {
    const onClick = vi.fn();
    installHyperlinkGuard(win, board, onClick);
    const e = click(popupAnchor(`${ORIGIN}/api/whiteboards`), 'auxclick');
    await Promise.resolve();
    expect(e.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(win.open).not.toHaveBeenCalled();
  });

  it('routes an external and a dreamcontext:// popup link through handleLinkOpen', () => {
    const openExternal = vi.fn();
    const openInternal = vi.fn();
    routeVia({ ownOrigin: ORIGIN, openExternal, openInternal, toast: vi.fn() });
    click(popupAnchor('https://example.com/'));
    click(popupAnchor('dreamcontext://task/fix-login'));
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(openInternal).toHaveBeenCalledWith('task', 'fix-login');
  });

  it('leaves a popup outside this board, and ordinary links, to the app', async () => {
    const onClick = vi.fn();
    installHyperlinkGuard(win, board, onClick);
    const foreign = { getAttribute: () => 'https://example.com/', closest: (s: string) => (s === HYPERLINK_SELECTOR || s === 'a[href]' ? foreign : null) };
    const e = click(foreign);
    await Promise.resolve();
    expect(onClick).not.toHaveBeenCalled();
    expect(e.stopped).toBe(false);
    expect(win.open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  it('uninstalls both listeners', () => {
    const off = installHyperlinkGuard(win, board, vi.fn());
    expect(win.capture.click).toHaveLength(1);
    expect(win.capture.auxclick).toHaveLength(1);
    off();
    expect(win.capture.click).toHaveLength(0);
    expect(win.capture.auxclick).toHaveLength(0);
  });
});

/**
 * A18: a selection of widgets only hides Excalidraw's link popup (the raw `dreamcontext://`
 * URL) and its properties panel. The hiding must stay scoped to that selection state, so a
 * free drawing's link popup, and the guard acting on it, are never affected.
 */
describe('widget-only selection hides the popup, not the guard', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const css = readFileSync(join(root, 'dashboard/src/components/whiteboard/WhiteboardCanvas.css'), 'utf-8');
  const src = readFileSync(join(root, 'dashboard/src/components/whiteboard/WhiteboardCanvas.tsx'), 'utf-8');

  it('every rule that touches the popup or the panel is scoped to the widgets-selected class', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((r) => r.split('{')[0]);
    const touching = rules.filter((sel) => /hyperlinkContainer|selected-shape-actions|App-menu__left|data-testid="hyperlink"/.test(sel));
    expect(touching.length).toBeGreaterThan(0);
    for (const sel of touching) {
      for (const part of sel.split(',')) expect(part.trim()).toMatch(/^\.wb-canvas-wrap--widgets-selected /);
    }
  });

  it('the class is set from selectionIsOnlyWidgets, and the guard is installed regardless', () => {
    expect(src).toMatch(/selectionIsOnlyWidgets\(elements, appState\.selectedElementIds\)/);
    expect(src).toMatch(/widgetsOnly \? 'wb-canvas-wrap wb-canvas-wrap--widgets-selected' : 'wb-canvas-wrap'/);
    expect(src).not.toMatch(/if \([^)]*widgetsOnly[^)]*\)[^\n]*installHyperlinkGuard/);
  });

  it('the guard still routes a non-widget popup link inside the board', () => {
    const listeners: Record<string, (e: Event) => void> = {};
    const win = { addEventListener: (t: string, fn: (e: Event) => void) => { listeners[t] = fn; }, removeEventListener: () => {} };
    const anchor = { getAttribute: () => 'https://example.com' };
    const target = { closest: (s: string) => (s === HYPERLINK_SELECTOR ? anchor : null) };
    const onClick = vi.fn();
    installHyperlinkGuard(win as unknown as EventTarget, { contains: () => true }, onClick);
    const event = { type: 'click', target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listeners.click(event as unknown as Event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith('https://example.com', event);
  });
});
