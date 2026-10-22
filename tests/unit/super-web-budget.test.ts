/**
 * The web containers' iframe budget (plan-r7 D10, AC12): at most TWO live iframes; the least
 * recently focused drops to a title + Load placeholder; nothing off screen holds one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_LIVE_IFRAMES, dropFromLru, liveWebIds, touchLru } from '../../dashboard/src/components/sleepy/super/webBudget.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

describe('webBudget', () => {
  it('the budget is two', () => {
    expect(MAX_LIVE_IFRAMES).toBe(2);
  });

  it('never more than two live, however many web containers are on screen', () => {
    expect(liveWebIds([], ['a', 'b', 'c', 'd']).size).toBe(2);
  });

  it('the most recently focused keep their frames; the least recently focused drops', () => {
    let lru: string[] = [];
    lru = touchLru(lru, 'a');
    lru = touchLru(lru, 'b');
    lru = touchLru(lru, 'c');
    expect([...liveWebIds(lru, ['a', 'b', 'c'])].sort()).toEqual(['b', 'c']);
    // Load on the dropped one makes it the most recent: another gives its frame up.
    lru = touchLru(lru, 'a');
    expect([...liveWebIds(lru, ['a', 'b', 'c'])].sort()).toEqual(['a', 'c']);
  });

  it('a never-focused container counts as least recent; on-screen order breaks the tie', () => {
    expect([...liveWebIds(['c'], ['a', 'b', 'c'])].sort()).toEqual(['a', 'c']);
  });

  it('nothing off screen holds a frame (collapsed overlay, hidden window: no candidates)', () => {
    expect(liveWebIds(['a', 'b'], []).size).toBe(0);
    expect([...liveWebIds(['a', 'b', 'c'], ['c'])]).toEqual(['c']);
  });

  it('a closed container leaves the recency list; touching moves an id to the front once', () => {
    expect(dropFromLru(['a', 'b'], 'a')).toEqual(['b']);
    expect(touchLru(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(touchLru(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('the surface asks the budget only for what is on screen, and only while visible', () => {
    const src = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/SuperSurface.tsx'), 'utf-8');
    expect(src).toMatch(/const webOnScreen = props\.visible/);
    expect(src).toMatch(/liveWebIds\(lru, webOnScreen\)/);
    // On screen = drawn on the stage: a web card in Others holds no frame, nor one open full screen.
    expect(src).toMatch(/cp\.where === 'others' \|\| full\?\.id === c\.id\) return false/);
    // …and a floating tile (2026-10-20): a page is live side by side or presented, and since
    // 2026-10-22 in a large or wide floating card; a small or medium tile shows its title.
    expect(src).toMatch(/return cp\.where !== 'float' \|\| cp\.size === 'large' \|\| cp\.size === 'wide'/);
    const container = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/super/SuperContainer.tsx'), 'utf-8');
    // Past the budget a web container is a title + Load placeholder, never an iframe.
    expect(container).toMatch(/p\.webLive\s*\?\s*<div className="super-card-view super-card-view--web"><WebWidget/);
    expect(container).toMatch(/: <WebPlaceholder/);
  });
});
