/**
 * A trackpad pinch in the desktop app (WKWebView delivers it as `gesturestart` / `gesturechange`
 * / `gestureend`) while a whiteboard is mounted (2026-10-22, the Super Agent's full-screen
 * viewers):
 *
 *  - the boards' capture-phase interceptor (lib/excalidrawPinch.ts) lets a pinch that starts
 *    over a pinch OWNER (a viewer's root, `data-pinch-owner`) through untouched, so the viewer's
 *    own listener runs; the viewer stops it, so it never bubbles to the document where every
 *    Excalidraw editor's own handler sits (a board behind the viewer does not zoom);
 *  - over anything else it still prevents and stops the gesture, exactly as before;
 *  - over a board it still zooms THAT board only.
 *
 * No DOM library is installed, so this builds the smallest tree the interceptor reads: nodes
 * with `closest` / `contains`, and a dispatcher that runs the document's capture listeners, the
 * path's own listeners, then the document's bubble listeners, honouring stopPropagation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isPinchOwnerTarget, registerPinchTarget, type BoardViewport } from '../../dashboard/src/lib/excalidrawPinch.js';
import { gestureScale } from '../../dashboard/src/components/layout/usePanZoom.js';

type Listener = (e: FakeEvent) => void;

class FakeNode {
  parent: FakeNode | null;
  attrs: Record<string, string>;
  listeners = new Map<string, Listener[]>();
  constructor(parent: FakeNode | null, attrs: Record<string, string> = {}) { this.parent = parent; this.attrs = attrs; }
  closest(sel: string): FakeNode | null {
    const attr = sel.replace(/^\[|\]$/g, '');
    for (let n: FakeNode | null = this; n; n = n.parent) if (attr in n.attrs) return n;
    return null;
  }
  contains(node: FakeNode | null): boolean {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
  on(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
}

class FakeEvent {
  type: string; target: FakeNode; scale: number; clientX = 10; clientY = 10;
  defaultPrevented = false; stopped = false;
  constructor(type: string, target: FakeNode, scale = 1) { this.type = type; this.target = target; this.scale = scale; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

const capture = new Map<string, Listener[]>();
const bubble = new Map<string, Listener[]>();
const fakeDocument = {
  addEventListener(type: string, fn: Listener, useCapture?: boolean) {
    const m = useCapture ? capture : bubble;
    m.set(type, [...(m.get(type) ?? []), fn]);
  },
  removeEventListener(type: string, fn: Listener, useCapture?: boolean) {
    const m = useCapture ? capture : bubble;
    m.set(type, (m.get(type) ?? []).filter((f) => f !== fn));
  },
};

function dispatch(e: FakeEvent): void {
  for (const fn of capture.get(e.type) ?? []) { fn(e); }
  if (e.stopped) return;
  for (let n: FakeNode | null = e.target; n && !e.stopped; n = n.parent) for (const fn of n.listeners.get(e.type) ?? []) fn(e);
  if (e.stopped) return;
  for (const fn of bubble.get(e.type) ?? []) fn(e);
}

let saved: unknown;
let unregister: () => void = () => {};
let root: FakeNode;
let boardEl: FakeNode;
let viewport: BoardViewport;
let excalidrawSpy: string[];

beforeEach(() => {
  saved = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = fakeDocument;
  capture.clear();
  bubble.clear();
  root = new FakeNode(null);
  boardEl = new FakeNode(root);
  viewport = { scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0, zoom: { value: 1 } };
  unregister = registerPinchTarget({
    el: boardEl as unknown as HTMLElement,
    getViewport: () => viewport,
    setViewport: (p) => { viewport = { ...viewport, ...p }; },
  } as never);
  // Excalidraw's own per-editor Safari handlers: on the document, bubble phase.
  excalidrawSpy = [];
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) fakeDocument.addEventListener(t, (e) => excalidrawSpy.push(e.type), false);
});
afterEach(() => {
  unregister();
  (globalThis as { document?: unknown }).document = saved;
});

/** A viewer the way usePanZoom wires one: its root is the owner, its stage zooms and STOPS. */
function viewer(): { stage: FakeNode; scale: () => number } {
  const owner = new FakeNode(root, { 'data-pinch-owner': 'true' });
  const stage = new FakeNode(owner);
  let scale = 1;
  let start = 1;
  stage.on('gesturestart', (e) => { e.preventDefault(); e.stopPropagation(); start = scale; });
  stage.on('gesturechange', (e) => {
    e.preventDefault(); e.stopPropagation();
    const next = gestureScale(start, e.scale);
    if (next !== null) scale = next;
  });
  stage.on('gestureend', (e) => { e.preventDefault(); e.stopPropagation(); });
  return { stage, scale: () => scale };
}

describe('a pinch over a full-screen viewer while a board is mounted', () => {
  it('reaches the viewer, zooms it, and never reaches the editors\' document handlers; the board does not zoom', () => {
    const v = viewer();
    const target = new FakeNode(v.stage);
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 2], ['gestureend', 2]] as const) dispatch(new FakeEvent(type, target, scale));
    expect(v.scale()).toBe(2);
    expect(excalidrawSpy).toEqual([]);
    expect(viewport.zoom.value).toBe(1);
  });

  it('a stale board gesture (its gestureend missed) does not steer the board from over the viewer', () => {
    dispatch(new FakeEvent('gesturestart', new FakeNode(boardEl), 1));
    const v = viewer();
    const target = new FakeNode(v.stage);
    dispatch(new FakeEvent('gesturestart', target, 1));
    dispatch(new FakeEvent('gesturechange', target, 3));
    expect(viewport.zoom.value).toBe(1);
    expect(v.scale()).toBe(3);
  });
});

describe('everything else is as before', () => {
  it('over a plain element (no owner, no board): prevented and stopped, no editor handler runs', () => {
    const plain = new FakeNode(root);
    const e = new FakeEvent('gesturechange', plain, 2);
    dispatch(new FakeEvent('gesturestart', plain, 1));
    dispatch(e);
    expect(e.defaultPrevented).toBe(true);
    expect(e.stopped).toBe(true);
    expect(excalidrawSpy).toEqual([]);
    expect(viewport.zoom.value).toBe(1);
  });

  it('over a board: that board zooms, the gesture is stopped', () => {
    const inBoard = new FakeNode(boardEl);
    dispatch(new FakeEvent('gesturestart', inBoard, 1));
    const e = new FakeEvent('gesturechange', inBoard, 2);
    dispatch(e);
    expect(viewport.zoom.value).toBe(2);
    expect(e.stopped).toBe(true);
    expect(excalidrawSpy).toEqual([]);
  });

  it('a board inside an owner is still the board\'s', () => {
    const owner = new FakeNode(root, { 'data-pinch-owner': 'true' });
    const nested = new FakeNode(owner);
    const un = registerPinchTarget({ el: nested as unknown as HTMLElement, getViewport: () => viewport, setViewport: (p) => { viewport = { ...viewport, ...p }; } } as never);
    try {
      dispatch(new FakeEvent('gesturestart', new FakeNode(nested), 1));
      dispatch(new FakeEvent('gesturechange', new FakeNode(nested), 1.5));
      expect(viewport.zoom.value).toBe(1.5);
    } finally { un(); }
  });

  it('isPinchOwnerTarget reads the nearest owner, and nothing for null', () => {
    const owner = new FakeNode(root, { 'data-pinch-owner': 'true' });
    expect(isPinchOwnerTarget(new FakeNode(owner) as unknown as Node)).toBe(true);
    expect(isPinchOwnerTarget(new FakeNode(root) as unknown as Node)).toBe(false);
    expect(isPinchOwnerTarget(null)).toBe(false);
  });
});
