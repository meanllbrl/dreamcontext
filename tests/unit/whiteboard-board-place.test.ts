/**
 * Where the owner was on the Whiteboard page (boardPlace.ts: last board, each board's viewport,
 * the agent panel) and which home agent the panel shows (agentPanelState.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});

const place = await import('../../dashboard/src/components/whiteboard/boardPlace.js');
const { homeAgentsOf, panelAgentOf } = await import('../../dashboard/src/components/whiteboard/agentPanelState.js');

beforeEach(() => store.clear());

describe('boardPlace', () => {
  it('remembers the last board per project and refuses a non-slug', () => {
    expect(place.readLastBoard('acme')).toBeNull();
    place.writeLastBoard('acme', 'q3-plan');
    expect(place.readLastBoard('acme')).toBe('q3-plan');
    expect(place.readLastBoard('globex')).toBeNull();
    place.writeLastBoard('acme', '../etc');
    expect(place.readLastBoard('acme')).toBe('q3-plan');
    store.set('dc.wbLastBoard.acme', 'Not A Slug');
    expect(place.readLastBoard('acme')).toBeNull();
  });

  it('keeps a viewport per board; a bad or out-of-range one reads as nothing saved', () => {
    place.writeViewport('acme', 'q3-plan', { scrollX: -120.5, scrollY: 40, zoom: 1.25 });
    expect(place.readViewport('acme', 'q3-plan')).toEqual({ scrollX: -120.5, scrollY: 40, zoom: 1.25 });
    expect(place.readViewport('acme', 'growth')).toBeNull();

    expect(place.parseViewport(null)).toBeNull();
    expect(place.parseViewport({ scrollX: 0, scrollY: 0 })).toBeNull();
    expect(place.parseViewport({ scrollX: Number.NaN, scrollY: 0, zoom: 1 })).toBeNull();
    expect(place.parseViewport({ scrollX: 0, scrollY: 0, zoom: 0 })).toBeNull();
    expect(place.parseViewport({ scrollX: 0, scrollY: 0, zoom: 31 })).toBeNull();
    expect(place.parseViewport({ scrollX: '0', scrollY: 0, zoom: 1 })).toBeNull();

    place.writeViewport('acme', 'q3-plan', { scrollX: 0, scrollY: 0, zoom: 99 });
    expect(place.readViewport('acme', 'q3-plan')?.zoom).toBe(1.25);
    store.set('dc.wbViewport.acme.q3-plan', '{not json');
    expect(place.readViewport('acme', 'q3-plan')).toBeNull();
  });

  it('remembers whether the agent panel was open, closed by default', () => {
    expect(place.readPanelOpen('acme')).toBe(false);
    place.writePanelOpen('acme', true);
    expect(place.readPanelOpen('acme')).toBe(true);
    place.writePanelOpen('acme', false);
    expect(place.readPanelOpen('acme')).toBe(false);
  });
});

describe('viewportShowsAny', () => {
  const vp = { scrollX: 0, scrollY: 0, zoom: 1 };
  it('restores a view that still shows something; falls back to the fit when it shows nothing', () => {
    expect(place.viewportShowsAny(vp, 800, 600, [{ x: 100, y: 100, width: 50, height: 50 }])).toBe(true);
    expect(place.viewportShowsAny(vp, 800, 600, [{ x: 5000, y: 5000, width: 50, height: 50 }])).toBe(false);
    // Scrolled to it: scene x 5000 shows at scrollX -4900.
    expect(place.viewportShowsAny({ scrollX: -4900, scrollY: -4900, zoom: 1 }, 800, 600, [{ x: 5000, y: 5000, width: 50, height: 50 }])).toBe(true);
    // Zoomed out far enough, it is on screen again.
    expect(place.viewportShowsAny({ scrollX: 0, scrollY: 0, zoom: 0.1 }, 800, 600, [{ x: 5000, y: 5000, width: 50, height: 50 }])).toBe(true);
  });
  it('a line drawn leftwards (negative width) still counts; an empty board or unknown size restores', () => {
    expect(place.viewportShowsAny(vp, 800, 600, [{ x: 900, y: 10, width: -200, height: 0 }])).toBe(true);
    expect(place.viewportShowsAny(vp, 800, 600, [])).toBe(true);
    expect(place.viewportShowsAny(vp, 0, 0, [{ x: 5000, y: 5000, width: 1, height: 1 }])).toBe(true);
  });
});

describe('the panel’s home agent', () => {
  const agent = (slug: string, title: string, whiteboard?: string) => ({ slug, title, whiteboard }) as never;
  const all = [agent('z', 'Zed', 'q3-plan'), agent('a', 'Ada', 'q3-plan'), agent('o', 'Other', 'growth'), agent('n', 'None')];

  it('home agents are the ones whose manifest names the board, by title', () => {
    expect(homeAgentsOf(all, 'q3-plan').map((a: { slug: string }) => a.slug)).toEqual(['a', 'z']);
    expect(homeAgentsOf(undefined, 'q3-plan')).toEqual([]);
    expect(homeAgentsOf(all, 'empty')).toEqual([]);
  });

  it('shows the picked one, else the first; a pick from another board falls back', () => {
    const homes = homeAgentsOf(all, 'q3-plan');
    expect(panelAgentOf(homes, null)?.slug).toBe('a');
    expect(panelAgentOf(homes, 'z')?.slug).toBe('z');
    expect(panelAgentOf(homes, 'o')?.slug).toBe('a');
    expect(panelAgentOf([], 'z')).toBeNull();
  });
});
