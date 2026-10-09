import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEM_CENTER, GEM_PATHS, GEM_RING_WIDTH, GEM_VIEWBOX } from '../../dashboard/src/components/brand/gemPieces.js';

/**
 * THE NODE SETUP PAGE AND THE GEM PIECES ARE MIRRORS, AND MIRRORS DRIFT.
 *
 * `node-setup.html` is a self-contained page the Tauri shell opens before the dashboard
 * server exists, so it cannot load the dashboard's stylesheet: it carries its own copy of the
 * design tokens it uses. `gemPieces.ts` carries the gem's piece geometry because the dashboard
 * cannot import from the marketing package that owns it. Each copy is checked here against
 * its source, so a token retune or a refitted mark fails this test instead of shipping a
 * setup screen in last season's colours.
 *
 * It also holds the page to the rules a hand-written page is most likely to break: no colour
 * literal outside its token blocks, no innerHTML (every shell- or URL-supplied string goes
 * through textContent), no em dash in its copy, and the six-command contract with the shell.
 */

const REPO = join(__dirname, '..', '..');
/**
 * The source of truth for the gem lives in the marketing package, which is gitignored: it is on
 * the owner's machine and absent from a fresh clone or CI. Where it exists the mirrors are checked
 * against it; where it does not, only those checks skip (named, not silent) and the page's own
 * rules still run. A static import here would fail the whole file on every clean checkout.
 */
const GEOMETRY_SRC = join(REPO, 'marketing/remotion/src/splash/geometry.ts');
const HAS_GEOMETRY = existsSync(GEOMETRY_SRC);
const geometry = (HAS_GEOMETRY
  ? await import('../../marketing/remotion/src/splash/geometry.js')
  : null) as typeof import('../../marketing/remotion/src/splash/geometry.js');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const PAGE = readFileSync(join(REPO, 'desktop/src-tauri/frontend-placeholder/node-setup.html'), 'utf8');
const TOKENS_CSS = stripComments(readFileSync(join(REPO, 'dashboard/src/styles/tokens.css'), 'utf8'));

type Decls = Record<string, string>;

/** The body of the first `{…}` block that follows `marker` (brace-balanced). */
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
  for (const m of stripComments(block).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  }
  return out;
}

/** Substitute `var(--x)` from `scope` until nothing resolvable is left. */
function resolve(value: string, scope: Decls, depth = 0): string {
  if (depth > 20) throw new Error(`var() cycle resolving ${value}`);
  const next = value.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => (name in scope ? scope[name] : whole));
  return next === value ? value : resolve(next, scope, depth + 1);
}

// Source of truth.
const lightSrc = decls(blockAfter(TOKENS_CSS, ':root'));
const darkSrc: Decls = { ...lightSrc, ...decls(blockAfter(TOKENS_CSS, "[data-theme='dark'],")) };

// The page's own blocks, found by the comments that label them.
const pageCss = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
const pageLight = decls(blockAfter(pageCss, 'tokens: mirrored from dashboard/src/styles/tokens.css (:root) */'));
const pageDarkOnly = decls(blockAfter(blockAfter(pageCss, "tokens: mirrored from dashboard/src/styles/tokens.css ([data-theme='dark']) */"), ':root'));
const pageDark: Decls = { ...pageLight, ...pageDarkOnly };
const pageGem = decls(blockAfter(pageCss, 'tokens: gem colours mirrored from'));
const pageLocal = decls(blockAfter(pageCss, 'tokens: page-local'));

describe('node-setup.html token mirror', () => {
  it('mirrors a meaningful set of tokens', () => {
    expect(Object.keys(pageLight).length).toBeGreaterThan(20);
  });

  it.each(Object.keys(pageLight))('%s equals tokens.css (light)', (name) => {
    expect(lightSrc[name], `${name} is not defined in tokens.css`).toBeDefined();
    expect(resolve(pageLight[name], pageLight)).toBe(resolve(lightSrc[name], lightSrc));
  });

  it.each(Object.keys(pageLight))('%s equals tokens.css (dark)', (name) => {
    // A token the dashboard retints for dark must be retinted here too, or a dark Mac shows a
    // light value inside a dark card.
    expect(resolve(pageDark[name], pageDark)).toBe(resolve(darkSrc[name], darkSrc));
  });

  it('only overrides, in dark, tokens it also declares for light', () => {
    for (const name of Object.keys(pageDarkOnly)) expect(pageLight).toHaveProperty(name);
  });

  it.skipIf(!HAS_GEOMETRY)('gem colours equal GEM_COLORS (needs marketing/ geometry.ts)', () => {
    const expected: Decls = {
      '--gem-body-hi': geometry.GEM_COLORS.bodyHi,
      '--gem-body-lo': geometry.GEM_COLORS.bodyLo,
      '--gem-chevron-hi': geometry.GEM_COLORS.chevronHi,
      '--gem-chevron-lo': geometry.GEM_COLORS.chevronLo,
      '--gem-dark': geometry.GEM_COLORS.dark,
      '--gem-dark-lo': geometry.GEM_COLORS.darkLo,
      '--gem-dark-edge': geometry.GEM_COLORS.darkEdge,
      '--gem-hairline': geometry.GEM_COLORS.hairline,
      '--gem-ring': geometry.GEM_COLORS.ring,
    };
    expect(pageGem).toEqual(expected);
  });

  it('--motion-converge is the dashboard motion token (520ms)', () => {
    // Added to tokens.css by the dashboard lane of the same plan; until then the page's value
    // is pinned to the plan's, and once it exists the two must agree.
    expect(pageLocal['--motion-converge']).toBe('520ms');
    if (lightSrc['--motion-converge']) expect(pageLocal['--motion-converge']).toBe(lightSrc['--motion-converge']);
    expect(Object.keys(pageLocal)).toEqual(['--motion-converge']);
  });
});

describe('node-setup.html rules', () => {
  /** The page with every token block removed: what remains may only USE colours. */
  function outsideTokenBlocks(): string {
    let css = pageCss;
    for (const marker of [
      "tokens: mirrored from dashboard/src/styles/tokens.css ([data-theme='dark']) */",
      'tokens: mirrored from dashboard/src/styles/tokens.css (:root) */',
      'tokens: gem colours mirrored from',
      'tokens: page-local',
    ]) {
      const body = blockAfter(css, marker);
      css = css.replace(body, '');
    }
    return css + PAGE.slice(PAGE.indexOf('</style>'));
  }

  it('has no colour literal outside its token blocks', () => {
    const rest = outsideTokenBlocks();
    expect(rest.match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
    expect(rest.match(/\b(?:rgba?|hsla?|oklch)\(/gi) ?? []).toEqual([]);
  });

  it('never uses innerHTML, outerHTML, insertAdjacentHTML or document.write', () => {
    expect(PAGE).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('renders the startup error message with textContent', () => {
    expect(PAGE).toMatch(/detail\.textContent\s*=\s*message/);
  });

  it('has no em dash in its copy', () => {
    const body = PAGE.slice(PAGE.indexOf('<body>'));
    expect(body).not.toMatch(/—|&mdash;|\\u2014/);
  });

  it('calls exactly the six shell commands, none with an argument', () => {
    const calls = [...PAGE.matchAll(/(?:invoke|send)\('(node_setup_[a-z_]+)'(\s*,)?/g)];
    const names = new Set(calls.map((m) => m[1]));
    expect([...names].sort()).toEqual([
      'node_setup_cancel',
      'node_setup_open_download_page',
      'node_setup_quit',
      'node_setup_retry',
      'node_setup_start',
      'node_setup_status',
    ]);
    expect(calls.filter((m) => m[2])).toEqual([]);
  });

  it('starts the install on load and defines the exit hook the shell calls', () => {
    expect(PAGE).toMatch(/window\.__dcNodeSetupExit\s*=\s*function/);
    expect(PAGE).toMatch(/else \{[\s\S]*?begin\(\);\s*poll\(\);/);
  });

  it('stands every animation down under reduced motion', () => {
    expect(pageCss).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  });

  it('draws the gem from the same paths gemPieces.ts carries', () => {
    for (const d of Object.values(GEM_PATHS)) expect(PAGE).toContain(`d="${d}"`);
    expect(PAGE).toContain(`viewBox="${GEM_VIEWBOX}"`);
  });
});

describe.skipIf(!HAS_GEOMETRY)('gemPieces.ts mirrors the splash geometry (needs marketing/ geometry.ts)', () => {
  it('every piece path equals the one computed in geometry.ts', () => {
    expect(GEM_PATHS).toEqual({
      body: geometry.BODY_PATH,
      ring: geometry.RING_PATH,
      left: geometry.LEFT_PATH,
      chevron: geometry.CHEVRON_PATH,
      wedge: geometry.WEDGE_PATH,
      rhombus: geometry.RHOMBUS_PATH,
      hairlines: geometry.HAIRLINES,
    });
  });

  it('centre, view box and ring width match', () => {
    expect([...GEM_CENTER]).toEqual(geometry.GEM_C);
    const [cx, cy] = geometry.GEM_C;
    expect(GEM_VIEWBOX).toBe(`${cx - 400} ${cy - 400} 800 800`);
    expect(GEM_RING_WIDTH).toBe(geometry.RING_W);
  });
});
