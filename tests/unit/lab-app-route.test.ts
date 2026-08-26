/**
 * T5's pure, browser-free route helpers for the `app/v1` bridge:
 * `sanitizeAppParams` (S2 — the cap on `lab.navigate()`'s untrusted params
 * before they can reach the real, shareable URL), `labAppPath`, and
 * `readAppParams` (the READ-side twin — sanitizes a URL's `p.*` params on
 * the way IN too, since a URL can arrive hand-typed, bookmarked, or shared,
 * never touching the write-side `pushLabAppPath`). `pushLabAppPath`/`commit`
 * touch `window.location`/`window.history` and this repo runs no DOM harness
 * (see lab-reports-ui.test.ts), so — matching that file's existing
 * convention — only the window-free half is covered directly here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  labAppPath,
  readAppParams,
  sanitizeAppParams,
} from '../../dashboard/src/components/lab/funnel/labRoute.js';

describe('labAppPath', () => {
  it('bare slug when pageId is null, /p/<id> otherwise, both encoded', () => {
    expect(labAppPath('wau', null)).toBe('/lab/wau');
    expect(labAppPath('wau', 'steps')).toBe('/lab/wau/p/steps');
    expect(labAppPath('a b', 'c d')).toBe('/lab/a%20b/p/c%20d');
  });
});

describe('readAppParams', () => {
  it('strips the p. namespace and ignores everything else', () => {
    const params = new URLSearchParams('vault=proj&p.tab=steps&p.sort=desc&fs=1');
    expect(readAppParams(params)).toEqual({ params: { tab: 'steps', sort: 'desc' }, dropped: [] });
  });

  it('empty when nothing is namespaced', () => {
    expect(readAppParams(new URLSearchParams('vault=proj&fs=1'))).toEqual({ params: {}, dropped: [] });
  });

  // MAJOR fix: sanitizeAppParams originally ran ONLY on the write path
  // (pushLabAppPath). A URL that arrives hand-typed, bookmarked, or shared —
  // never touching pushLabAppPath — reached LabAppFrame's `params` prop (and
  // window.__LAB_APP__, and Copy-link via currentDeepLink) uncapped. The cap
  // must be a property of what reaches the app, not of one code path.
  describe('sanitizes on READ too (not just on write)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('drops a p.* value over the 64-char cap — never truncates it', () => {
      const params = new URLSearchParams(`p.leak=${'v'.repeat(65)}`);
      const { params: out, dropped } = readAppParams(params);
      expect(out).toEqual({});
      expect(dropped).toEqual(['leak']);
    });

    it('caps a hand-crafted URL at 8 params, keyed deterministically', () => {
      const search = ['j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
        .map((k) => `p.${k}=${k}`).join('&');
      const { params: out, dropped } = readAppParams(new URLSearchParams(search));
      expect(Object.keys(out).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      expect(dropped.sort()).toEqual(['i', 'j']);
    });

    it('drops a p.* key outside the allowed charset, warning by name', () => {
      // URLSearchParams itself won't carry "!" unencoded, so encode it — this
      // is exactly what a hand-typed or shared link would produce.
      const params = new URLSearchParams('p.bad%21key=x&p.ok=y');
      const { params: out, dropped } = readAppParams(params);
      expect(out).toEqual({ ok: 'y' });
      expect(dropped).toEqual(['bad!key']);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('a URL that never went through pushLabAppPath still comes out capped', () => {
      // Simulates a bookmarked/shared link with 10 oversized params — nothing
      // in this codebase wrote it via pushLabAppPath.
      const bits = Array.from({ length: 10 }, (_, i) => `p.k${i}=${'x'.repeat(80)}`);
      const { params: out, dropped } = readAppParams(new URLSearchParams(bits.join('&')));
      expect(Object.keys(out).length).toBe(0); // every value is over the 64-char cap
      expect(dropped.length).toBe(10);
    });
  });
});

describe('sanitizeAppParams (S2 — the cap on lab.navigate() params)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('passes through valid params untouched, no warnings', () => {
    const { params, dropped } = sanitizeAppParams({ tab: 'steps', sort: 'desc' });
    expect(params).toEqual({ tab: 'steps', sort: 'desc' });
    expect(dropped).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('non-object input yields empty params, never throws', () => {
    expect(sanitizeAppParams(null)).toEqual({ params: {}, dropped: [] });
    expect(sanitizeAppParams(undefined)).toEqual({ params: {}, dropped: [] });
    expect(sanitizeAppParams('steps')).toEqual({ params: {}, dropped: [] });
    expect(sanitizeAppParams(['a', 'b'])).toEqual({ params: {}, dropped: [] });
    expect(sanitizeAppParams(42)).toEqual({ params: {}, dropped: [] });
  });

  it('drops a key outside [a-z0-9_-]{1,24} — one console.warn naming it', () => {
    const { params, dropped } = sanitizeAppParams({ 'bad key!': 'x', ok: 'y' });
    expect(params).toEqual({ ok: 'y' });
    expect(dropped).toEqual(['bad key!']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('bad key!');
  });

  it('drops a key longer than 24 chars (charset cap covers length too)', () => {
    const longKey = 'x'.repeat(25);
    const { params, dropped } = sanitizeAppParams({ [longKey]: 'y' });
    expect(params).toEqual({});
    expect(dropped).toEqual([longKey]);
  });

  it('DROPS an over-64-char value — never truncates it', () => {
    const longValue = 'v'.repeat(65);
    const { params, dropped } = sanitizeAppParams({ leak: longValue });
    expect(params).toEqual({});
    expect(dropped).toEqual(['leak']);
    // Provably absent, not silently shortened to a still-wrong 64-char slice.
    expect(Object.values(params).some((v) => v.startsWith('v'))).toBe(false);
  });

  it('keeps a value at exactly the 64-char boundary', () => {
    const value = 'v'.repeat(64);
    const { params, dropped } = sanitizeAppParams({ k: value });
    expect(params).toEqual({ k: value });
    expect(dropped).toEqual([]);
  });

  it('coerces a non-string value via String() before length-checking it', () => {
    const { params } = sanitizeAppParams({ n: 42, b: true });
    expect(params).toEqual({ n: '42', b: 'true' });
  });

  it('caps at 8 params, keeping the first 8 in key-sorted order deterministically', () => {
    const raw: Record<string, string> = {};
    // Insert in REVERSE alphabetical order — the sort, not insertion order,
    // must decide survivors.
    for (const k of ['j', 'i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']) raw[k] = k;
    const { params, dropped } = sanitizeAppParams(raw);
    expect(Object.keys(params).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(dropped.sort()).toEqual(['i', 'j']);
  });

  it('a malicious payload attempting to smuggle bulk data is capped, not round-tripped', () => {
    // Mirrors the covert-channel scenario the cap exists for: a navigated body
    // trying to push a large dataset out through shareable navigate params.
    const raw: Record<string, string> = { a: '1', b: '2', c: '3', d: '4', e: '5', f: '6', g: '7', h: '8' };
    raw.leak = JSON.stringify({ big: 'x'.repeat(500) }); // > 64 chars — dropped on sight
    const { params, dropped } = sanitizeAppParams(raw);
    expect(dropped).toContain('leak');
    expect(JSON.stringify(params).length).toBeLessThanOrEqual(300); // well under any real URL budget
  });

  it('trims from the end of the sorted, count-capped list when the total exceeds 256 chars', () => {
    const raw: Record<string, string> = {
      a: 'v'.repeat(60),
      b: 'v'.repeat(60),
      c: 'v'.repeat(60),
      d: 'v'.repeat(60),
      e: 'v'.repeat(60), // total so far: 5 * 61 = 305 > 256
    };
    const { params, dropped } = sanitizeAppParams(raw);
    // Sorted order is a,b,c,d,e — trimming from the end means 'e' (and maybe
    // more) goes, 'a' survives.
    expect(params.a).toBeDefined();
    expect(dropped).toContain('e');
    const total = Object.entries(params).reduce((sum, [k, v]) => sum + k.length + v.length, 0);
    expect(total).toBeLessThanOrEqual(256);
  });

  it('every drop reason names the exact key, never a generic message', () => {
    sanitizeAppParams({ 'bad!key': 'x' });
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining('"bad!key"'));
  });
});
