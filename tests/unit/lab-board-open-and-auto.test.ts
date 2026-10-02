/**
 * Owner feedback on 0.30.0 (2026-10-02), the board half:
 *
 * - a click on a card's plain surface opens its insight, a click on a block's own control
 *   (a button, a tab, a chip, an iframe, anything that LOOKS clickable) does not (`isCardControl`);
 * - an app page drawn in a card is interactive (LabAppFrame no longer sets pointer-events none);
 * - an insight whose manifest says `refresh.auto: false` is never in an automatic job, on the
 *   client (`expiredSlugs`) or the server (the sync-jobs route), and the card says when the next
 *   automatic check is (`nextAutoSync`).
 *
 * Pure functions with tiny element stand-ins (no DOM harness in this repo) plus source checks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCardControl } from '../../dashboard/src/components/lab/board/BoardCard';
import { expiredSlugs, nextAutoSync } from '../../dashboard/src/components/lab/board/boardSync';
import type { InsightSummary } from '../../dashboard/src/hooks/useLab';
import { parseRefresh } from '../../src/lib/lab/store.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const read = (rel: string) => readFileSync(join(import.meta.dirname, '../..', rel), 'utf8');

function summary(slug: string, over: Partial<InsightSummary> = {}): InsightSummary {
  return {
    slug, title: slug, category: null, group: null, render: 'line', size: null, width: null, height: null,
    unit: null, binding: null, latest: 1, fetchedAt: minutesAgo(5), granularity: 'day', error: null, errorAt: null,
    ttlMinutes: 60, staleMinutes: 5, stale: false, checkedAt: null, freshnessNote: null, tweaks: [],
    ...over,
  };
}

/** A minimal element tree: `closest` matches by tag or attribute, `contains` walks parents. */
interface Fake { tag: string; attrs: Record<string, string>; cursor: string; parentElement: Fake | null }
function el(tag: string, parent: Fake | null, attrs: Record<string, string> = {}, cursor = 'auto'): Fake {
  return { tag, attrs, cursor, parentElement: parent };
}
function matches(e: Fake, selector: string): boolean {
  return selector.split(',').some((sel) => {
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (attr) return attr[2] === undefined ? attr[1] in e.attrs : e.attrs[attr[1]] === attr[2];
    if (sel === 'a[href]') return e.tag === 'a' && 'href' in e.attrs;
    return e.tag === sel;
  });
}
function asElement(e: Fake): Element {
  const wrap = (f: Fake | null): Element | null => (f ? asElement(f) : null);
  return {
    get parentElement() { return wrap(e.parentElement); },
    closest(selector: string) {
      for (let c: Fake | null = e; c; c = c.parentElement) if (matches(c, selector)) return asElement(c);
      return null;
    },
    contains(other: Element) {
      for (let c: Element | null = other; c; c = c.parentElement) if ((c as unknown as { __f: Fake }).__f === e) return true;
      return false;
    },
    __f: e,
  } as unknown as Element;
}
const cursorOf = (x: Element) => (x as unknown as { __f: Fake }).__f.cursor;

describe('a card click opens the insight only from its plain surface', () => {
  const card = el('article', null);
  const body = el('div', card);
  const cardEl = asElement(card);

  it('opens from a chart, a number or the title (no control on the way up)', () => {
    const svgText = el('text', el('svg', el('div', body)));
    expect(isCardControl(asElement(svgText), cardEl, cursorOf)).toBe(false);
    expect(isCardControl(asElement(el('h3', el('header', card))), cardEl, cursorOf)).toBe(false);
  });

  it('leaves a block control alone: a button, a tab, an iframe, a toolbar', () => {
    expect(isCardControl(asElement(el('span', el('button', body))), cardEl, cursorOf)).toBe(true);
    expect(isCardControl(asElement(el('div', body, { role: 'tab' })), cardEl, cursorOf)).toBe(true);
    expect(isCardControl(asElement(el('iframe', body)), cardEl, cursorOf)).toBe(true);
    expect(isCardControl(asElement(el('span', el('div', body, { role: 'toolbar' }))), cardEl, cursorOf)).toBe(true);
  });

  it('leaves alone what LOOKS clickable (a funnel step row with cursor: pointer)', () => {
    const step = el('div', body, {}, 'pointer');
    expect(isCardControl(asElement(el('span', step, {}, 'pointer')), cardEl, cursorOf)).toBe(true);
  });

  it('treats a target outside the card as not the card', () => {
    expect(isCardControl(asElement(el('div', null)), cardEl, cursorOf)).toBe(true);
    expect(isCardControl(null, cardEl, cursorOf)).toBe(true);
  });

  it('is wired: the page passes onOpen (the menu\'s Open detail), the card never uses cursor: pointer', () => {
    expect(read('dashboard/src/components/lab/board/BoardPage.tsx')).toMatch(/onOpen=\{card\.insight && primary && !missing \? \(\) => openInsight\(/);
    const css = read('dashboard/src/components/lab/board/board.css');
    const openable = css.slice(css.indexOf('.board-card--openable {'), css.indexOf('}', css.indexOf('.board-card--openable {')));
    expect(openable).not.toContain('cursor');
  });
});

describe('an app page in a card is interactive', () => {
  it('LabAppFrame no longer turns pointer events off in card mode', () => {
    expect(read('dashboard/src/components/lab/LabAppFrame.tsx')).not.toMatch(/pointerEvents:\s*mode === 'card' \? 'none'/);
  });
});

describe('refresh.auto: false keeps an insight out of automatic jobs', () => {
  it('parses only an explicit false', () => {
    expect(parseRefresh({ ttl_minutes: 30, auto: false }).auto).toBe(false);
    expect(parseRefresh({ ttl_minutes: 30 }).auto).toBeUndefined();
    expect(parseRefresh({ ttl_minutes: 30, auto: 'no' }).auto).toBeUndefined();
  });

  it('an expired manual-only insight is never asked for automatically; the others still are', () => {
    const board = {
      a: summary('a', { fetchedAt: minutesAgo(120) }),
      b: summary('b', { fetchedAt: minutesAgo(120), autoSync: false }),
    };
    expect(expiredSlugs(board, NOW)).toEqual(['a']);
  });

  it('the server route drops manual-only slugs from an automatic job and never from a forced one', () => {
    const src = read('src/server/routes/lab.ts');
    expect(src).toMatch(/if \(!force && slugs\) \{\s*slugs = slugs\.filter\(\(s\) => getInsight\(contextRoot, s\)\?\.refresh\.auto !== false\)/);
    expect(src).toContain('autoSync: m.refresh.auto !== false');
  });
});

describe('the card says when the next automatic check is', () => {
  it('off, due, at the TTL end, or after the error backoff', () => {
    expect(nextAutoSync(summary('a', { autoSync: false }), NOW)).toEqual({ kind: 'off' });
    expect(nextAutoSync(summary('a', { fetchedAt: null }), NOW)).toEqual({ kind: 'due' });
    expect(nextAutoSync(summary('a', { fetchedAt: minutesAgo(120) }), NOW)).toEqual({ kind: 'due' });
    expect(nextAutoSync(summary('a', { fetchedAt: minutesAgo(10) }), NOW)).toEqual({ kind: 'at', at: NOW + 50 * 60_000 });
    // A recent "upstream unchanged" check restarts the clock.
    expect(nextAutoSync(summary('a', { fetchedAt: minutesAgo(100), checkedAt: minutesAgo(5) }), NOW))
      .toEqual({ kind: 'at', at: NOW + 55 * 60_000 });
    // Failed 5 min ago with a 60 min TTL: left alone until 60 min after the failure.
    expect(nextAutoSync(summary('a', { fetchedAt: minutesAgo(120), errorAt: minutesAgo(5) }), NOW))
      .toEqual({ kind: 'backoff', at: NOW + 55 * 60_000 });
  });
});
