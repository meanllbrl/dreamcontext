/**
 * html/v1 hybrid — the `{ data, html? }` envelope (C1), the `cache.html` write
 * (C2), and the sandboxed iframe's security posture (C5's unit half; the
 * runtime beacon proof lives in scripts/verify/lab-board.mjs).
 *
 * The contract under test: `data` is MANDATORY and behaves exactly as a bare
 * return (latest/series/matrix semantics unchanged); `html` is optional, capped
 * at 300KB with a LOUD failure, cached alongside the data, and drawn inside an
 * iframe that can execute but can never reach the network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInsight, readCache } from '../../src/lib/lab/store.js';
import { syncInsight } from '../../src/lib/lab/sync.js';
import { MAX_HTML_BYTES, isRawPayloadEnvelope } from '../../src/lib/lab/types.js';
import {
  buildSrcdoc,
  HTML_KIT_CSP,
  HTML_KIT_SANDBOX,
  HTML_KIT_ALLOW,
  LAB_HTML_KIT_CSS,
  HTML_HEIGHT_BRIDGE,
  HTML_HEIGHT_MESSAGE_KEY,
  HTML_HEIGHT_REQUEST_KEY,
  readHtmlHeightMessage,
} from '../../dashboard/src/components/lab/labHtmlKit.js';

const DASH = join(import.meta.dirname, '../../dashboard/src/components/lab');

describe('the { data, html? } envelope (engine)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-lab-html-'));
    mkdirSync(join(root, 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeScript(slug: string, body: string): void {
    mkdirSync(join(root, 'lab', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'lab', 'scripts', `${slug}.mjs`), body, 'utf-8');
  }

  it('detects envelopes without stealing typed payloads or legacy arrays', () => {
    expect(isRawPayloadEnvelope({ data: [], html: '<b>x</b>' })).toBe(true);
    expect(isRawPayloadEnvelope({ data: [] })).toBe(true);
    expect(isRawPayloadEnvelope([{ name: 'a', points: [] }])).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'matrix/v1', dims: [], rows: [] })).toBe(false);
    expect(isRawPayloadEnvelope({ kind: 'funnel-set/v1', funnels: [] })).toBe(false);
  });

  it('caches html ALONGSIDE the data — latest/series semantics unchanged', async () => {
    createInsight(root, { slug: 'hybrid', title: 'Hybrid', render: 'number', adapter: 'script' });
    writeScript('hybrid', `export default async () => ({
      data: [{ name: 'metric', points: [{ t: '2026-08-24', v: 10 }, { t: '2026-08-25', v: 42 }] }],
      html: '<div class="lk-value">42</div>',
    });`);

    const result = await syncInsight(root, 'hybrid', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBe(42); // from data, exactly as a bare return

    const cache = readCache(root, 'hybrid')!;
    expect(cache.html).toBe('<div class="lk-value">42</div>');
    expect(cache.series).toHaveLength(1);
    expect(cache.latest).toBe(42);
  });

  it('wraps a matrix payload too — cache.matrix AND cache.html', async () => {
    createInsight(root, { slug: 'mx', title: 'MX', render: 'breakdown', adapter: 'script' });
    writeScript('mx', `export default async () => ({
      data: { kind: 'matrix/v1', dims: [{ key: 'x' }], rows: [{ d: { x: 'a' }, v: 5 }], total: { v: 5 } },
      html: '<div class="lk-stat">5</div>',
    });`);
    const result = await syncInsight(root, 'mx', { force: true });
    expect(result.status).toBe('ok');
    const cache = readCache(root, 'mx')!;
    expect(cache.matrix?.set.rows).toHaveLength(1);
    expect(cache.html).toBe('<div class="lk-stat">5</div>');
    expect(cache.latest).toBe(5);
  });

  it('REJECTS { html } without data — html never replaces the numbers', async () => {
    createInsight(root, { slug: 'no-data', title: 'ND', render: 'number', adapter: 'script' });
    writeScript('no-data', `export default async () => ({ html: '<b>pretty</b>' });`);
    const result = await syncInsight(root, 'no-data', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/data is mandatory/);
  });

  it('rejects an over-cap html body LOUDLY (no truncation)', async () => {
    createInsight(root, { slug: 'fat', title: 'Fat', render: 'number', adapter: 'script' });
    writeScript('fat', `export default async () => ({
      data: [{ name: 'm', points: [{ t: '2026-08-25', v: 1 }] }],
      html: 'x'.repeat(${MAX_HTML_BYTES + 1}),
    });`);
    const result = await syncInsight(root, 'fat', { force: true });
    expect(result.status).toBe('failed');
    expect(result.error).toContain(`${MAX_HTML_BYTES}-byte cap`);
    // The data was fine but the run failed whole — a silent half-write would
    // hide the contract violation from the author.
    expect(readCache(root, 'fat')!.html).toBeUndefined();
  });

  it('a failed sync preserves the prior html; a clean run without html clears it', async () => {
    createInsight(root, { slug: 'cycle', title: 'Cycle', render: 'number', adapter: 'script' });
    writeScript('cycle', `export default async () => ({
      data: [{ name: 'm', points: [{ t: '2026-08-25', v: 1 }] }],
      html: '<i>v1</i>',
    });`);
    await syncInsight(root, 'cycle', { force: true });

    writeScript('cycle', `export default async () => { throw new Error('boom'); };`);
    await syncInsight(root, 'cycle', { force: true });
    expect(readCache(root, 'cycle')!.html).toBe('<i>v1</i>'); // keep-prior contract

    writeScript('cycle', `export default async () => ([{ name: 'm', points: [{ t: '2026-08-25', v: 2 }] }]);`);
    const result = await syncInsight(root, 'cycle', { force: true });
    expect(result.status).toBe('ok');
    expect(readCache(root, 'cycle')!.html).toBeUndefined(); // stale presentation is worse than none
  });

  it('bare RawSeries[] scripts keep working untouched (no envelope, no html)', async () => {
    createInsight(root, { slug: 'legacy', title: 'Legacy', render: 'number', adapter: 'script' });
    writeScript('legacy', `export default async () => ([{ name: 'm', points: [{ t: '2026-08-25', v: 7 }] }]);`);
    const result = await syncInsight(root, 'legacy', { force: true });
    expect(result.status).toBe('ok');
    expect(result.latest).toBe(7);
    expect(readCache(root, 'legacy')!.html).toBeUndefined();
  });
});

describe('the sandboxed iframe (security pins — C5 unit half)', () => {
  it('the sandbox grant allows scripts and NEVER same-origin', () => {
    expect(HTML_KIT_SANDBOX).toBe('allow-scripts');
    expect(HTML_KIT_SANDBOX).not.toContain('allow-same-origin');
  });

  it('the permissions allow-list is EMPTY — no microphone, camera or geolocation', () => {
    // Why the Lab's copy of this pin matters MORE than Chat's, not less: a Chat block is
    // drawn in reply to something the owner just asked for, while an insight body renders
    // itself on load, every session, with no attention-drawing moment. Script output is the
    // same "a teammate can sync it into the repo" trust class as any other authored markup.
    expect(HTML_KIT_ALLOW).toBe('');
    expect(HTML_KIT_ALLOW).not.toMatch(/microphone|camera|geolocation|display-capture/);
  });

  it('the srcdoc CSP blocks every network fetch class', () => {
    expect(HTML_KIT_CSP).toContain("default-src 'none'");
    expect(HTML_KIT_CSP).toContain("style-src 'unsafe-inline'");
    expect(HTML_KIT_CSP).toContain("script-src 'unsafe-inline'");
    // No connect-src / img-src grant may ever creep in — 'none' must stay total.
    expect(HTML_KIT_CSP).not.toMatch(/connect-src|img-src|https?:/);
  });

  it('the embedded kit string IS lab-html-kit.css, byte for byte (mirror drift guard)', () => {
    // The TS export is what ships (vitest stubs `.css?raw`, so the kit cannot
    // live behind that import); the .css file is the reference copy authors
    // read. Same text, or one of them is lying.
    const file = readFileSync(join(DASH, 'lab-html-kit.css'), 'utf-8');
    expect(LAB_HTML_KIT_CSS).toBe(file);
  });

  it('buildSrcdoc puts the CSP meta FIRST and embeds tokens + kit + body', () => {
    const doc = buildSrcdoc('<div class="lk-value">42</div>', { '--chart-1': '#123456', '--color-text': 'black' });
    const cspAt = doc.indexOf('Content-Security-Policy');
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(doc.indexOf('<style>'));
    expect(doc).toContain('--chart-1: #123456;');
    expect(doc).toContain('.lk-table'); // the kit css really is embedded
    expect(doc).toContain('<div class="lk-value">42</div>');
  });

  it('buildSrcdoc declares the embedding theme as the document color-scheme', () => {
    // A scheme MISMATCH makes Chromium paint an opaque white canvas behind the
    // transparent body — under the dark theme that is a white slab with
    // near-white text. The srcdoc must say which scheme it belongs to.
    expect(buildSrcdoc('<b>x</b>', {}, 'dark')).toContain('color-scheme: dark;');
    expect(buildSrcdoc('<b>x</b>', {})).toContain('color-scheme: light;'); // safe default
  });

  it('HtmlInsightBody mounts the iframe with exactly the pinned grant', () => {
    const source = readFileSync(join(DASH, 'HtmlInsightBody.tsx'), 'utf-8');
    // The sandbox attribute must be the pinned constant — a literal here could
    // quietly widen the grant. (Prose may MENTION allow-same-origin; the
    // constant itself is asserted never to carry it, above.)
    expect(source).toContain('sandbox={HTML_KIT_SANDBOX}');
    expect(source).toContain('srcDoc={srcdoc}');
    expect(source).not.toMatch(/sandbox=["'][^"']*allow-same-origin/);
  });

  it('HtmlInsightBody mounts the EMPTY permissions list too', () => {
    const source = readFileSync(join(DASH, 'HtmlInsightBody.tsx'), 'utf-8');
    expect(source).toContain('allow={HTML_KIT_ALLOW}');
    expect(source).not.toMatch(/allow=["'][^"']*(microphone|camera|geolocation)/);
  });

  it('LabAppFrame — the THIRD site — mounts both pinned constants', () => {
    // The app frame imports from lib/sandboxHtml directly rather than through this kit, so
    // it is the site most easily missed when the other two are updated together.
    const source = readFileSync(join(DASH, 'LabAppFrame.tsx'), 'utf-8');
    expect(source).toContain('sandbox={SANDBOX_GRANT}');
    expect(source).toContain('allow={SANDBOX_ALLOW}');
    expect(source).not.toMatch(/allow=["'][^"']*(microphone|camera|geolocation)/);
  });

  it('the card swaps to the html body; the detail panel keeps the typed TWIN', () => {
    const card = readFileSync(join(DASH, 'InsightCard.tsx'), 'utf-8');
    expect(card).toContain('cache?.html ?');
    expect(card).toContain('<HtmlInsightBody');

    const panel = readFileSync(join(DASH, 'InsightDetailPanel.tsx'), 'utf-8');
    expect(panel).toContain('<HtmlInsightBody');
    // The twin: the typed DetailBody must render UNCONDITIONALLY, html or not.
    const htmlAt = panel.indexOf('<HtmlInsightBody');
    const typedAt = panel.indexOf('<DetailBody', htmlAt);
    expect(typedAt).toBeGreaterThan(htmlAt);
  });
});

describe('automatic height — the promise the reference already made (owner report 2026-09-08)', () => {
  it('the srcdoc carries the height bridge, BEFORE the author body', () => {
    // Order is load-bearing: an unclosed element in the author's markup makes
    // the parser swallow everything after it. A bridge that never runs leaves
    // the body at its pending height for the whole session.
    const doc = buildSrcdoc('<div class="lk-value">42</div>', {});
    const scriptAt = doc.indexOf('ResizeObserver');
    expect(scriptAt).toBeGreaterThan(-1);
    expect(scriptAt).toBeLessThan(doc.indexOf('<div class="lk-value">42</div>'));
  });

  it('the bridge measures on resize, on click and on load — not once', () => {
    // Once is exactly what the fixed 232px box was: a late web font, an image
    // decoding, or the author's own script filling a number in all change the
    // height AFTER the first callback.
    expect(HTML_HEIGHT_BRIDGE).toContain('ResizeObserver');
    expect(HTML_HEIGHT_BRIDGE).toContain("addEventListener('load'");
    expect(HTML_HEIGHT_BRIDGE).toContain("addEventListener('click'");
    expect(HTML_HEIGHT_BRIDGE).toContain('DOMContentLoaded');
  });

  it('the bridge answers a host RE-ASK past its own dedupe', () => {
    // Delivery you cannot retry is delivery you cannot trust: the host's
    // listener attaching one beat after the frame already spoke used to freeze
    // Chat's blocks at their floor permanently.
    expect(HTML_HEIGHT_BRIDGE).toContain(HTML_HEIGHT_REQUEST_KEY);
    expect(HTML_HEIGHT_BRIDGE).toContain('report(true)');
    expect(HTML_HEIGHT_BRIDGE).toContain('event.source !== parent');
  });

  it('the bridge carries ONE NUMBER out and nothing else — no data channel', () => {
    // html/v1 stays the no-bridge case in the sense that matters: no nonce
    // envelope because there is no dataset to scope, and no way to ask for one.
    expect(HTML_HEIGHT_BRIDGE).toContain(`${HTML_HEIGHT_MESSAGE_KEY}: h`);
    expect(HTML_HEIGHT_BRIDGE).not.toContain('innerHTML');
    expect(HTML_HEIGHT_BRIDGE).not.toMatch(/fetch|XMLHttpRequest|sendBeacon/);
  });

  it('adding the bridge loosened NOTHING — same grant, same CSP', () => {
    expect(HTML_KIT_SANDBOX).not.toContain('allow-same-origin');
    expect(buildSrcdoc('<b>x</b>', {})).toContain(HTML_KIT_CSP);
  });

  it('readHtmlHeightMessage takes a number off the wire and rejects everything else', () => {
    expect(readHtmlHeightMessage({ [HTML_HEIGHT_MESSAGE_KEY]: 612.4 })).toBe(613);
    expect(readHtmlHeightMessage({ [HTML_HEIGHT_MESSAGE_KEY]: 0 })).toBe(0);
    expect(readHtmlHeightMessage({ [HTML_HEIGHT_MESSAGE_KEY]: -1 })).toBeNull();
    expect(readHtmlHeightMessage({ [HTML_HEIGHT_MESSAGE_KEY]: NaN })).toBeNull();
    expect(readHtmlHeightMessage({ [HTML_HEIGHT_MESSAGE_KEY]: '600' })).toBeNull();
    expect(readHtmlHeightMessage({ someOtherFrame: 600 })).toBeNull();
    expect(readHtmlHeightMessage(null)).toBeNull();
    expect(readHtmlHeightMessage('600')).toBeNull();
  });

  it('the host authenticates by SOURCE, listens in a LAYOUT effect, and re-asks', () => {
    const source = readFileSync(join(DASH, 'HtmlInsightBody.tsx'), 'utf-8');
    // Origin is the opaque "null" for a frame with no same-origin grant, so an
    // origin check would accept every other sandboxed frame on the page.
    expect(source).toContain('event.source !== frameRef.current.contentWindow');
    expect(source).not.toMatch(/event\.origin/);
    // A passive effect can be flushed after the frame has already posted.
    expect(source).toContain('useLayoutEffect');
    expect(source).toContain('onLoad={askForHeight}');
    expect(source).toContain(`{ [HTML_HEIGHT_REQUEST_KEY]: true }`);
    // The measurement travels WITH the body it measured — no reset effect.
    expect(source).toContain("measured?.html === html");
  });

  it('the CARD is capped and the DETAIL is not — and the card bounds match app/v1', () => {
    const html = readFileSync(join(DASH, 'HtmlInsightBody.tsx'), 'utf-8');
    const app = readFileSync(join(DASH, 'LabAppFrame.tsx'), 'utf-8');
    // The cap is the BOARD GRID's, not the author's: one 900px tile would set
    // its whole grid row's height and strand its neighbours in whitespace. It
    // must be the same number app/v1 uses, or the two body contracts drift and
    // the reference cannot describe both.
    for (const pin of ['CARD_MIN_HEIGHT = 120', 'CARD_MAX_HEIGHT = 320']) {
      expect(html).toContain(pin);
      expect(app).toContain(pin);
    }
    // The detail panel is where a long body is READ — effectively uncapped,
    // same as the app surface's page mode.
    expect(html).toContain('FULL_MAX_HEIGHT = 20000');
    expect(app).toContain('PAGE_MAX_HEIGHT = 20000');
    // And no hard-coded box is left anywhere: the old `height: full ? 420 : 232`.
    expect(html).not.toMatch(/height:\s*full\s*\?/);
  });

  it('the reference documents the cap instead of promising an unbounded card', () => {
    // The defect was not only the code: an author who trusts "no fixed card
    // size to fight" writes content first and discovers the box second. The
    // cap has to be visible on the author's side.
    const tf = readFileSync(join(import.meta.dirname, '../../skill/references/tasks-and-features.md'), 'utf-8');
    expect(tf).toMatch(/320/);
    expect(tf).toMatch(/html\/v1[^\n]*height|[Hh]eight[^\n]*html\/v1/);
  });
});
