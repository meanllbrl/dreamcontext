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
  buildChatSrcdoc, readHeightMessage, HEIGHT_BRIDGE, HEIGHT_MESSAGE_KEY,
  CHAT_HTML_CSP, CHAT_HTML_SANDBOX, CHAT_HTML_KIT_CSS, CHAT_KIT_TOKENS,
  MIN_HTML_HEIGHT, MAX_HTML_HEIGHT,
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
    expect(CHAT_HTML_CSP).not.toMatch(/connect-src|img-src|font-src|https?:/);
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
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {} }).match(/<style>/g)?.length).toBe(2);
  });

  it('carries the mode on <html> so the kit\'s slide rules can see it', () => {
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {} })).toContain('data-dc-mode="card"');
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, mode: 'full' })).toContain('data-dc-mode="full"');
  });

  it('runs the height bridge inline ONLY — in fullscreen the host owns the height', () => {
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, mode: 'card' })).toContain(HEIGHT_MESSAGE_KEY);
    expect(buildChatSrcdoc({ html: '<b>x</b>', tokens: {}, mode: 'full' })).not.toContain(HEIGHT_MESSAGE_KEY);
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

  it('is the only thing it posts: one namespaced number', () => {
    expect(HEIGHT_MESSAGE_KEY).toBe('__dreamHtmlHeight');
    expect(HEIGHT_BRIDGE.match(/postMessage/g)?.length).toBe(1);
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

  it('keeps html and body at auto height, or the bridge would chase the frame it sets', () => {
    expect(CHAT_HTML_KIT_CSS).toMatch(/html,\s*body\s*\{[^}]*height:\s*auto/);
  });

  it('only .dc-slide reads the host mode — everything else renders the same in both', () => {
    const modeRules = CHAT_HTML_KIT_CSS.match(/html\[data-dc-mode="full"\][^{]*/g) ?? [];
    expect(modeRules.length).toBeGreaterThan(0);
    for (const rule of modeRules) {
      expect(rule, rule).toMatch(/\.dc-slides?|body/);
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
