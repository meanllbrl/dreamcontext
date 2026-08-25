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
  LAB_HTML_KIT_CSS,
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

  it('HtmlInsightBody mounts the iframe with exactly the pinned grant', () => {
    const source = readFileSync(join(DASH, 'HtmlInsightBody.tsx'), 'utf-8');
    // The sandbox attribute must be the pinned constant — a literal here could
    // quietly widen the grant. (Prose may MENTION allow-same-origin; the
    // constant itself is asserted never to carry it, above.)
    expect(source).toContain('sandbox={HTML_KIT_SANDBOX}');
    expect(source).toContain('srcDoc={srcdoc}');
    expect(source).not.toMatch(/sandbox=["'][^"']*allow-same-origin/);
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
