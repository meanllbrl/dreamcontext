// The hands-free mark: the REAL dream gem with two sound waves, one description drawn into
// React, the phone's server-rendered pages and the installed app's icons. This file holds the
// three to that one description, the gem to the real mark, the composition to the icon's safe
// zone, every mirror (tokens, server markup, PNGs) to its source, and the live badge to its
// motion and honesty rules.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
// The dashboard's own React (one copy for the component and the renderer).
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { GEM_PATHS, GEM_RING_WIDTH } from '../../dashboard/src/components/brand/gemPieces.js';
import {
  handsfreeMarkTree, handsfreePaintRules, hfIds, HF_ICON_BOX, HF_ICON_SAFE, HF_MARK_BOX,
  HF_WAVES, HF_WAVE_ORIGIN, HF_WAVE_WIDTH, wavePath, type HfNode,
} from '../../dashboard/src/components/brand/handsfreeMarkGeometry.js';
import { HandsfreeMark, HandsfreeBackdrop } from '../../dashboard/src/components/brand/HandsfreeMark.js';
import { LiveBadge } from '../../dashboard/src/components/handsfree/LiveBadge.js';
import { nextLink, type PhoneLink, type PhoneState } from '../../dashboard/src/components/handsfree/phone/phoneState.js';
import {
  ASSETS, buildServerMirror, buildSvgs, ICONS, PNG_ICONS, SERVER_MIRROR, sha256, SOURCE_KEY, TOKENS_CSS,
} from '../../scripts/lib/handsfree-icons.js';
import { MAC_PAGE_STYLE, renderMacLoginPage, renderOfflinePage } from '../../src/server/handsfree-login.js';

const REPO = join(__dirname, '..', '..');
const DASH = join(REPO, 'dashboard');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS = readFileSync(TOKENS_CSS, 'utf8');

type Decls = Record<string, string>;
function blockAfter(css: string, marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = css.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced block after: ${marker}`);
}
function decls(block: string): Decls {
  const out: Decls = {};
  for (const m of stripComments(block).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]?/g)) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}
function resolve(value: string, scope: Decls, depth = 0): string {
  if (depth > 20) throw new Error(`var() cycle resolving ${value}`);
  const next = value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => (name in scope ? scope[name] : whole));
  return next === value ? value : resolve(next, scope, depth + 1);
}
const TOKENS_CLEAN = stripComments(TOKENS);
const lightSrc = decls(blockAfter(TOKENS_CLEAN, ':root'));
const darkSrc: Decls = { ...lightSrc, ...decls(blockAfter(TOKENS_CLEAN, "[data-theme='dark'],")) };
const GEM_TOKENS = Object.keys(lightSrc).filter((k) => k.startsWith('--gem-'));

/** Every node of the tree, depth first (paint order). */
function flat(nodes: HfNode[]): HfNode[] {
  return nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
}

describe('the mark is the real gem, not a redrawing', () => {
  const tree = handsfreeMarkTree(hfIds('t'));
  const paths = flat(tree).filter((n) => n.tag === 'path').map((n) => String(n.attrs.d));

  it('draws every gem piece verbatim, in Gem.tsx\'s stacking, then the two waves', () => {
    // defs: the body as the clip; then ring, left, chevron, wedge, rhombus, hairlines, waves.
    expect(paths).toEqual([
      GEM_PATHS.body,
      GEM_PATHS.ring, GEM_PATHS.left, GEM_PATHS.chevron, GEM_PATHS.wedge, GEM_PATHS.rhombus, GEM_PATHS.hairlines,
      ...HF_WAVES.map((w) => wavePath(w.r, w.halfDeg)),
    ]);
  });

  it('clips left, chevron and wedge by the body, strokes the ring at its own width', () => {
    for (const piece of [GEM_PATHS.left, GEM_PATHS.chevron, GEM_PATHS.wedge]) {
      const g = tree.find((n) => n.tag === 'g' && n.children?.[0]?.attrs.d === piece);
      expect(g?.attrs['clip-path']).toBe('url(#t-clip)');
    }
    const ring = tree.find((n) => n.attrs.d === GEM_PATHS.ring)!;
    expect(ring.attrs['stroke-width']).toBe(GEM_RING_WIDTH);
    expect(ring.paint).toEqual({ kind: 'stroke', role: 'ring' });
  });

  it('paints from the gem\'s own tokens (the fitted mark\'s colours), never the UI accent', () => {
    for (const [, , value] of handsfreePaintRules()) {
      const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(token, value).toMatch(/^--gem-/);
      expect(lightSrc[token!], `${token} in tokens.css`).toBeDefined();
    }
  });

  it('the gem colours are the mark\'s, the same in both themes, and node-setup.html carries the same block', () => {
    expect(GEM_TOKENS.sort()).toEqual([
      '--gem-body-hi', '--gem-body-lo', '--gem-chevron-hi', '--gem-chevron-lo',
      '--gem-dark', '--gem-dark-edge', '--gem-dark-lo', '--gem-hairline', '--gem-ring',
    ]);
    const dark = decls(blockAfter(TOKENS_CLEAN, "[data-theme='dark'],"));
    for (const k of GEM_TOKENS) expect(dark[k], `${k} is retinted for dark`).toBeUndefined();
    // node-setup.html's block is checked against GEM_COLORS itself (desktop-pages-mirror.test.ts).
    const page = readFileSync(join(REPO, 'desktop/src-tauri/frontend-placeholder/node-setup.html'), 'utf8');
    const pageGem = decls(blockAfter(page.slice(page.indexOf('<style>')), 'tokens: gem colours mirrored from'));
    expect(Object.fromEntries(GEM_TOKENS.map((k) => [k, lightSrc[k]]))).toEqual(pageGem);
  });
});

describe('the composition', () => {
  const gemRight = 878.83 + GEM_RING_WIDTH / 2; // the ring centreline's tip, measured in Chromium

  it('the waves sit right of the gem\'s tip, concentric, with round caps, near before far', () => {
    const tree = handsfreeMarkTree(hfIds('t'));
    const waves = tree.filter((n) => n.attrs['data-wave']);
    expect(waves.map((w) => w.attrs['data-wave'])).toEqual(['near', 'far']);
    for (const w of waves) expect(w.attrs['stroke-linecap']).toBe('round');
    const [near, far] = HF_WAVES;
    expect(far.r).toBeGreaterThan(near.r);
    for (const w of HF_WAVES) {
      const capX = HF_WAVE_ORIGIN[0] + w.r * Math.cos((w.halfDeg * Math.PI) / 180) - HF_WAVE_WIDTH / 2;
      expect(capX, `${w.tone} wave starts right of the tip`).toBeGreaterThan(gemRight);
    }
    // A gap between the waves at least as wide as a wave: two arcs, not one blur.
    expect(far.r - near.r - HF_WAVE_WIDTH).toBeGreaterThanOrEqual(HF_WAVE_WIDTH);
  });

  it('the whole icon stays inside the maskable safe circle (40 % of the side)', () => {
    const cx = HF_ICON_BOX.x + HF_ICON_BOX.side / 2;
    const cy = HF_ICON_BOX.y + HF_ICON_BOX.side / 2;
    const safe = HF_ICON_SAFE * HF_ICON_BOX.side;
    // The ring's points (a quadratic stays inside its control polygon) plus half its stroke.
    const nums = [...GEM_PATHS.ring.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
    let reach = 0;
    for (let i = 0; i + 1 < nums.length; i += 2) reach = Math.max(reach, Math.hypot(nums[i] - cx, nums[i + 1] - cy) + GEM_RING_WIDTH / 2);
    // Every point of both arcs plus half a wave.
    for (const w of HF_WAVES) {
      for (let k = 0; k <= 64; k++) {
        const a = ((-w.halfDeg + (2 * w.halfDeg * k) / 64) * Math.PI) / 180;
        reach = Math.max(reach, Math.hypot(HF_WAVE_ORIGIN[0] + w.r * Math.cos(a) - cx, HF_WAVE_ORIGIN[1] + w.r * Math.sin(a) - cy) + HF_WAVE_WIDTH / 2);
      }
    }
    expect(reach).toBeLessThanOrEqual(safe + 0.5);
    // ...and it fills it: the composition is not lost in a corner of an oversized square.
    expect(reach).toBeGreaterThan(safe * 0.97);
    expect(HF_MARK_BOX.w).toBeGreaterThan(HF_MARK_BOX.h);
  });
});

describe('one description, every rendering', () => {
  it('the React mark renders the tree: same paths, the paint classes, per-instance ids', () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(HandsfreeMark, { height: 22 }), createElement(HandsfreeMark, { title: 'dreamcontext' })));
    for (const d of Object.values(GEM_PATHS)) expect(html).toContain(`d="${d}"`);
    for (const w of HF_WAVES) expect(html).toContain(`d="${wavePath(w.r, w.halfDeg)}"`);
    for (const [sel] of handsfreePaintRules()) expect(html).toContain(sel.slice(1));
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).toMatch(/aria-hidden="true"/);
    expect(html).toContain('role="img" aria-label="dreamcontext"');
  });

  it('handsfreeMark.css paints exactly the classes the tree uses, from the same tokens', () => {
    const css = stripComments(readFileSync(join(DASH, 'src/components/brand/handsfreeMark.css'), 'utf8'));
    const rules = [...css.matchAll(/(\.hfm-(?:stroke|fill|stop)-[\w-]+)\s*\{\s*([\w-]+)\s*:\s*([^;]+);\s*\}/g)].map((m) => [m[1], m[2], m[3].trim()]);
    expect(rules.sort()).toEqual(handsfreePaintRules().sort());
  });

  it('the static SVGs and the server mirror are what the generator writes (npm run gen:handsfree-icons)', () => {
    const svgs = buildSvgs(TOKENS);
    expect(readFileSync(join(ASSETS, 'handsfree-mark.svg'), 'utf8')).toBe(svgs.mark);
    expect(readFileSync(join(ASSETS, 'handsfree-icon.svg'), 'utf8')).toBe(svgs.icon);
    expect(readFileSync(SERVER_MIRROR, 'utf8')).toBe(buildServerMirror());
  });

  it('each PNG was rendered from the current SVG (its dc-source stamp) at its size', () => {
    const svgs = buildSvgs(TOKENS);
    for (const icon of PNG_ICONS) {
      const b = readFileSync(join(ICONS, icon.file));
      expect(b.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([b.readUInt32BE(16), b.readUInt32BE(20)], icon.file).toEqual([icon.size, icon.size]);
      const at = b.indexOf(Buffer.from(`tEXt${SOURCE_KEY}\0`, 'latin1'));
      expect(at, `${icon.file} has no ${SOURCE_KEY} stamp: run npm run gen:handsfree-icons`).toBeGreaterThan(0);
      const len = b.readUInt32BE(at - 4);
      const text = b.subarray(at + 4 + SOURCE_KEY.length + 1, at + 4 + len).toString('latin1');
      expect(text, `${icon.file} is stale: run npm run gen:handsfree-icons`).toBe(sha256(icon.opaque ? svgs.iconOpaque : svgs.icon));
    }
  });

  it('the manifest installs exactly those icons, and the notification uses the 192', () => {
    const manifest = JSON.parse(readFileSync(join(DASH, 'public', 'manifest.webmanifest'), 'utf8')) as { icons: Array<{ src: string; sizes: string }> };
    const key = (a: string[]) => a.join(' ');
    expect(manifest.icons.map((i) => key([i.src, i.sizes])).sort()).toEqual(PNG_ICONS.map((i) => key([`/icons/${i.file}`, `${i.size}x${i.size}`])).sort());
    const sw = readFileSync(join(REPO, 'src/server/handsfree-sw.ts'), 'utf8');
    expect(sw).toContain("icon: '/icons/icon-192.png'");
  });
});

describe('the phone\'s sign-in and offline pages', () => {
  const css = MAC_PAGE_STYLE;
  const pageLight = decls(blockAfter(css, 'tokens: mirrored from dashboard/src/styles/tokens.css (:root) */'));
  const pageDarkOnly = decls(blockAfter(blockAfter(css, "tokens: mirrored from dashboard/src/styles/tokens.css ([data-theme='dark']) */"), ':root'));
  const pageDark: Decls = { ...pageLight, ...pageDarkOnly };
  const pageGem = decls(blockAfter(css, 'tokens: gem colours mirrored from dashboard/src/styles/tokens.css */'));

  it.each(Object.keys(pageLight))('%s equals tokens.css, light and dark', (name) => {
    expect(lightSrc[name], `${name} is not in tokens.css`).toBeDefined();
    expect(resolve(pageLight[name], pageLight)).toBe(resolve(lightSrc[name], lightSrc));
    expect(resolve(pageDark[name], pageDark), `${name} (dark)`).toBe(resolve(darkSrc[name], darkSrc));
  });

  it('the gem block equals tokens.css', () => {
    expect(pageGem).toEqual(Object.fromEntries(GEM_TOKENS.map((k) => [k, lightSrc[k]])));
  });

  it('has no colour literal outside its token blocks', () => {
    let rest = css;
    for (const marker of [
      'tokens: mirrored from dashboard/src/styles/tokens.css (:root) */',
      "tokens: mirrored from dashboard/src/styles/tokens.css ([data-theme='dark']) */",
      'tokens: gem colours mirrored from dashboard/src/styles/tokens.css */',
    ]) rest = rest.replace(blockAfter(rest, marker), '');
    rest = stripComments(rest);
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rest).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(/);
  });

  it('both lead with the mark (an image named dreamcontext) and carry the corner outlines', () => {
    for (const html of [renderMacLoginPage('en', { revoked: false, qrFailed: false }).html, renderOfflinePage('tr').html]) {
      expect(html).toContain('class="hf-hero-mark" role="img" aria-label="dreamcontext"');
      expect(html).toContain('class="hf-backdrop" aria-hidden="true"');
      expect((html.match(/class="hfm-decor /g) ?? []).length).toBe(2);
      for (const [sel] of handsfreePaintRules()) expect(css).toContain(`${sel}{`);
    }
  });

  it('the sign-in keeps its form contract and speaks Turkish', () => {
    const tr = renderMacLoginPage('tr', { revoked: false, qrFailed: false }).html;
    for (const id of ['id="f"', 'id="p"', 'id="t"', 'id="go"', 'id="m"']) expect(tr).toContain(id);
    expect(tr).toContain('Eller serbest · dreamcontext');
    expect(tr).toContain('class="hf-card"');
  });
});

describe('the live badge', () => {
  const st: PhoneState = { battery: { percent: 80, charging: false }, sleepAllowed: false, thermal: { state: null, slowed: 0 } };
  const off: PhoneLink = { state: null, reachable: false };

  it('reachable only while the Mac answers; a dropped link keeps the last state, a 401 changes nothing', () => {
    const up = nextLink(off, { status: 200, fromMac: true, state: st });
    expect(up).toEqual({ state: st, reachable: true });
    expect(nextLink(up, { status: null, fromMac: false, state: null })).toEqual({ state: st, reachable: false });
    // The tunnel's own error page (no surface header): the Mac did not answer.
    expect(nextLink(up, { status: 530, fromMac: false, state: null })).toEqual({ state: st, reachable: false });
    expect(nextLink(up, { status: 401, fromMac: true, state: null })).toBe(up);
    expect(nextLink({ state: st, reachable: false }, { status: 200, fromMac: true, state: null })).toEqual({ state: st, reachable: true });
  });

  it('pulses only when live, says so to a screen reader, and keeps the verify class', () => {
    const live = renderToStaticMarkup(createElement(LiveBadge, { tone: 'ok', live: true, label: 'Mac · 80%', sr: 'Connected to your Mac.' }));
    expect(live).toContain('class="dc-hf-chip" data-mac="ok" data-live="true" role="status"');
    expect(live).toContain('<span class="dc-hf-sr">Connected to your Mac.</span>Mac · 80%');
    const dropped = renderToStaticMarkup(createElement(LiveBadge, { tone: 'ok', live: false, label: 'Reaching your Mac…' }));
    expect(dropped).toContain('data-live="false"');
    expect(dropped).not.toContain('dc-hf-sr');
    // Beside an open chat's title the badge is quiet: live, but the pulse rule never matches it.
    expect(renderToStaticMarkup(createElement(LiveBadge, { tone: 'ok', live: true, label: 'Mac', quiet: true }))).toContain('data-quiet="true"');
    expect(renderToStaticMarkup(createElement(LiveBadge, { tone: 'ok', live: true, label: 'Mac' }))).not.toContain('data-quiet');
  });

  it('the pulse is an AMBIENT endless animation on the motion contract, composited, still under reduced motion', () => {
    const css = stripComments(readFileSync(join(DASH, 'src/components/handsfree/liveBadge.css'), 'utf8'));
    const rule = blockAfter(css, ".dc-hf-chip[data-live='true']:not([data-quiet]) .dc-hf-chip-dot::after");
    expect(rule).toMatch(/animation:\s*var\(--dc-motion-ambient-name,\s*dc-hf-live\)[^;]*infinite;/);
    expect(rule).toMatch(/animation-play-state:\s*var\(--dc-motion-play,\s*running\);/);
    // Its base style is invisible: a rested (removed) animation leaves a plain dot.
    expect(rule).toMatch(/opacity:\s*0;/);
    const frames = blockAfter(css, '@keyframes dc-hf-live');
    expect(stripComments(frames).match(/[\w-]+(?=\s*:)/g)!.every((p) => p === 'transform' || p === 'opacity')).toBe(true);
    expect(blockAfter(css, '@media (prefers-reduced-motion: reduce)')).toMatch(/::after\s*\{\s*animation:\s*none;/);
  });

  it('every LiveBadge string exists in English and Turkish', () => {
    const src = readFileSync(join(DASH, 'src/context/I18nContext.tsx'), 'utf8');
    const trAt = src.indexOf('const TR_PARTIAL');
    for (const key of ['handsfree.mac.live', 'handsfree.mac.chipReaching', 'handsfree.mac.badgeOn', 'handsfree.mac.badgeStopping', 'handsfree.mac.heroTitle']) {
      expect(src.slice(0, trAt), `${key} (en)`).toContain(`'${key}':`);
      expect(src.slice(trAt), `${key} (tr)`).toContain(`'${key}':`);
    }
  });
});

describe('the backdrop is decoration', () => {
  it('is aria-hidden, behind its page, never hit by a tap', () => {
    const html = renderToStaticMarkup(createElement(HandsfreeBackdrop));
    expect(html).toContain('class="hfm-backdrop" aria-hidden="true"');
    const css = stripComments(readFileSync(join(DASH, 'src/components/brand/handsfreeMark.css'), 'utf8'));
    const rule = blockAfter(css, '.hfm-backdrop');
    expect(rule).toMatch(/pointer-events:\s*none/);
    expect(rule).toMatch(/z-index:\s*-1/);
  });

  it('no colour literal in the hands-free and brand-mark UI files', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(css|tsx?)$/.test(n)) files.push(p); } };
    walk(join(DASH, 'src/components/handsfree'));
    files.push(...['HandsfreeMark.tsx', 'handsfreeMark.css', 'handsfreeMarkGeometry.ts'].map((f) => join(DASH, 'src/components/brand', f)));
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])/);
      expect(src, f).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(/);
    }
  });
});
