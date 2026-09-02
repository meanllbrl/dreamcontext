/**
 * The export layer's PURE half — document assembly, filenames, titles, and the snapshot
 * message contract. The rasterising half needs a real engine and is proven in
 * `scripts/verify/chat-html.mjs`.
 *
 * What these lock is mostly the SECURITY story, because that is the part of an export that
 * is easy to get subtly wrong: the exported file must carry the same CSP the live block
 * runs under (a file you email to a colleague must not be able to phone home either), the
 * brand override must still win the cascade, and the snapshot leg of the bridge must reject
 * anything that is not the frame's own honest answer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildStandaloneHtml, exportFilename, titleFromHtml, EXPORT_CHROME_CSS, EXPORT_WIDTH,
} from '../../dashboard/src/components/sleepy/chat/htmlExport.js';
import {
  readSnapshotMessage, SNAPSHOT_MESSAGE_KEY, SNAPSHOT_REQUEST_KEY, MAX_SNAPSHOT_CHARS,
  CHAT_HTML_KIT_CSS, HEIGHT_BRIDGE, KIT_BEHAVIOUR,
} from '../../dashboard/src/components/sleepy/chat/chatHtmlKit.js';
import { SANDBOX_CSP } from '../../dashboard/src/lib/sandboxHtml.js';

const CHAT_DIR = join(
  new URL('../../', import.meta.url).pathname,
  'dashboard/src/components/sleepy/chat',
);

const TOKENS = { '--color-text': '#111', '--color-accent': '#7c9cff' };
const BLOCK = '<div class="dc-doc"><h2 class="dc-h2">Worktree panosu</h2></div>';

describe('the exported document', () => {
  const doc = buildStandaloneHtml({ html: BLOCK, tokens: TOKENS, meta: { title: 'Panel' } });

  it('carries the SAME CSP the live block runs under', () => {
    // Not belt-and-braces: the export's whole safety story is that the block was already
    // self-contained. Shipping the policy with it means the file cannot beacon from
    // whatever machine it is opened on either — a property we get for free and should
    // therefore never drop.
    expect(doc).toContain(SANDBOX_CSP);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf(BLOCK));
  });

  it('inlines the kit and the resolved tokens — it must render with no network at all', () => {
    expect(doc).toContain(CHAT_HTML_KIT_CSS);
    expect(doc).toContain('--color-accent: #7c9cff;');
    // The one thing that would betray it: a URL it expects to fetch.
    expect(doc).not.toMatch(/<link[^>]+href/i);
    expect(doc).not.toMatch(/@import/);
    expect(doc).not.toMatch(/https?:\/\//);
  });

  it('never carries the height bridge — there is no parent to report to', () => {
    expect(doc).not.toContain(HEIGHT_BRIDGE);
    expect(doc).not.toContain(SNAPSHOT_REQUEST_KEY);
  });

  it('DOES carry the kit tab script — an exported tabbed block still switches', () => {
    // The distinction with the bridge above is the point: the bridge talks to a parent
    // this file does not have, while the tab script only rearranges the markup shipped
    // inside it. "Exactly what the block rendered" has to include the reader being able to
    // open panel two.
    expect(doc).toContain(KIT_BEHAVIOUR);
    // …and it is the only script the wrapper adds. The author's own script rides inside
    // `html`, which is the snapshot — counted here so a second host script cannot slip in
    // without someone re-reading the CSP argument above.
    const wrapper = doc.replace(BLOCK, '');
    expect(wrapper.match(/<script>/g)?.length).toBe(1);
  });

  it('puts the brand override LAST, so a branded block exports branded', () => {
    const branded = buildStandaloneHtml({
      html: BLOCK, tokens: TOKENS, meta: { title: 'Panel' },
      overrideCss: '.dc-h2 { color: hotpink; }',
    });
    expect(branded.lastIndexOf('.dc-h2 { color: hotpink; }'))
      .toBeGreaterThan(branded.lastIndexOf(EXPORT_CHROME_CSS));
  });

  it('sets its own reading size — a page has no transcript to inherit one from', () => {
    // The kit reads `var(--chat-text, 14px)`, which resolves to nothing outside the app.
    // Without this the exported file would silently fall back a notch smaller than what
    // the user was looking at.
    expect(doc).toMatch(/html \{ font-size: 15px; \}/);
  });

  it('carries the name and the conversation it came out of', () => {
    const withSource = buildStandaloneHtml({
      html: BLOCK, tokens: TOKENS,
      meta: { title: 'Worktree panosu', source: 'marketing-os', date: '2026-09-02' },
    });
    expect(withSource).toContain('Worktree panosu');
    expect(withSource).toContain('marketing-os');
    expect(withSource).toContain('2026-09-02');
  });

  it('escapes the chrome but NOT the block — the sandbox is the boundary, not a filter', () => {
    const hostile = buildStandaloneHtml({
      html: '<p class="dc-p">a &lt; b</p><script>ok()</script>',
      tokens: TOKENS,
      meta: { title: '<script>bad()</script>' },
    });
    expect(hostile).toContain('&lt;script&gt;bad()&lt;/script&gt;');   // the title: escaped
    expect(hostile).toContain('<script>ok()</script>');                 // the block: verbatim
  });

  it('carries the locale, so uppercase still casts by the right rules offline', () => {
    const tr = buildStandaloneHtml({ html: BLOCK, tokens: TOKENS, meta: { title: 'x' }, lang: 'tr' });
    expect(tr).toContain('<html lang="tr"');
    // And a hostile locale cannot break out of the attribute.
    const bad = buildStandaloneHtml({
      html: BLOCK, tokens: TOKENS, meta: { title: 'x' }, lang: 'tr" onload="x',
    });
    expect(bad).toContain('lang="tronloadx"');
  });

  it('re-flows to the export width, not the pane it was read in', () => {
    expect(EXPORT_CHROME_CSS).toContain(`max-width: ${EXPORT_WIDTH}px`);
  });

  it('has a print stylesheet that keeps a card off a page break', () => {
    expect(EXPORT_CHROME_CSS).toMatch(/@media print/);
    expect(EXPORT_CHROME_CSS).toMatch(/break-inside: avoid/);
  });
});

describe('filenames', () => {
  it.each([
    ['Pay el değiştiriyor', 'pay-el-degistiriyor.png'],
    ['Uyku borcu eşikleri', 'uyku-borcu-esikleri.png'],
    ['  Şirket  /  Gelir  ', 'sirket-gelir.png'],
    ['', 'block.png'],
    ['!!!', 'block.png'],
  ])('%s -> %s', (title, expected) => {
    // Transliterated, not stripped: `pay-el-.png` would not be findable three weeks later,
    // which is half of what this feature is for.
    expect(exportFilename(title, 'png')).toBe(expected);
  });

  it('stays a sane length even for an essay of a title', () => {
    expect(exportFilename('a'.repeat(400), 'html').length).toBeLessThanOrEqual(65);
  });

  it('cannot escape the download directory', () => {
    expect(exportFilename('../../etc/passwd', 'png')).toBe('etc-passwd.png');
  });
});

describe('the block names itself when nobody named it', () => {
  it.each([
    ['<div class="dc-doc"><h2 class="dc-h2">Worktree panosu</h2></div>', 'Worktree panosu'],
    ['<h1 class="dc-h1">Two ways <span class="dc-chip">x</span></h1>', 'Two ways x'],
    ['<p class="dc-p">no heading here</p>', 'Rendered answer'],
  ])('%s', (html, expected) => {
    expect(titleFromHtml(html)).toBe(expected);
  });
});

describe('the snapshot leg of the bridge', () => {
  it('accepts the frame\'s honest answer', () => {
    const msg = { [SNAPSHOT_MESSAGE_KEY]: { html: '<p>x</p>', width: 900.2, height: 300.7 } };
    expect(readSnapshotMessage(msg)).toEqual({ html: '<p>x</p>', width: 901, height: 301 });
  });

  it.each([
    ['a foreign message', { type: 'webpackOk' }],
    ['null', null],
    ['a string payload', 'hello'],
    ['a missing body', { [SNAPSHOT_MESSAGE_KEY]: { width: 1, height: 1 } }],
    ['a non-string body', { [SNAPSHOT_MESSAGE_KEY]: { html: 5, width: 1, height: 1 } }],
    ['a zero size', { [SNAPSHOT_MESSAGE_KEY]: { html: 'x', width: 0, height: 10 } }],
    ['NaN', { [SNAPSHOT_MESSAGE_KEY]: { html: 'x', width: Number.NaN, height: 10 } }],
  ])('ignores %s', (_label, data) => {
    expect(readSnapshotMessage(data)).toBeNull();
  });

  it('refuses a runaway body rather than wedging the host on it', () => {
    const huge = { [SNAPSHOT_MESSAGE_KEY]: { html: 'x'.repeat(MAX_SNAPSHOT_CHARS + 1), width: 1, height: 1 } };
    expect(readSnapshotMessage(huge)).toBeNull();
  });

  it('the bridge answers the request, and rides in BOTH modes', () => {
    expect(HEIGHT_BRIDGE).toContain(SNAPSHOT_REQUEST_KEY);
    expect(HEIGHT_BRIDGE).toContain(SNAPSHOT_MESSAGE_KEY);
    // Both host scripts ride in the head, in both modes: the bridge (the export bar in the
    // fullscreen header talks to its snapshot leg) and the kit's tab script.
    const kit = readFileSync(join(CHAT_DIR, 'chatHtmlKit.ts'), 'utf-8');
    expect(kit).toContain('headScript: `${HEIGHT_BRIDGE}\n${KIT_BEHAVIOUR}`,');
  });
});

describe('the grants the export helpers mount frames with', () => {
  const source = readFileSync(join(CHAT_DIR, 'htmlExport.ts'), 'utf-8');

  it('never grants same-origin AND scripts together — the pair is the whole danger', () => {
    // Two helpers mount a frame off-screen (print, measure) and both need same-origin: the
    // host has to call print() on one and read scrollHeight off the other, neither of which
    // works against an opaque origin. That is only safe while `allow-scripts` is absent,
    // because a frame with no code cannot use the origin it was handed. This test is the
    // thing standing between that reasoning and someone adding scripts back "to fix" a
    // block whose script did not run.
    const grants = [...source.matchAll(/setAttribute\('sandbox', '([^']*)'\)/g)].map((m) => m[1]);
    expect(grants.length, 'no sandbox grant found — did the helpers change shape?')
      .toBeGreaterThanOrEqual(2);
    for (const grant of grants) {
      if (grant.includes('allow-same-origin')) {
        expect(grant, grant).not.toContain('allow-scripts');
      }
    }
  });

  it('every off-screen frame is removed again, whatever happened', () => {
    // A measure that threw used to be the classic way to leave a hidden iframe wedged in
    // the DOM for the rest of the session.
    expect(source.match(/finally \{\s*frame\.remove\(\);\s*\}/g)?.length).toBe(2);
  });
});
