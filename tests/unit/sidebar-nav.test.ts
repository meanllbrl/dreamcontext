/**
 * THE RAIL'S DRIFT TEST — the sidebar's nav list, its icon family, its i18n keys and its
 * section-hue tokens all have to agree, and nothing in the build makes them.
 *
 * Every failure this catches is SILENT in production: a nav item with no glyph renders an
 * empty 24px badge; a `labelKey` nobody translated renders the raw key (`t()` falls back to
 * the key, not to English); a hue declared light-only silently inherits the wrong value in
 * dark; a `text-transform: uppercase` creeping back breaks K15 with nothing to fail.
 *
 * ── Why this parses TEXT instead of importing ────────────────────────────────────────
 * `Sidebar.tsx` and `NavIcons.tsx` are dashboard-bundle TSX: root vitest runs plain Node and
 * cannot load JSX, and the CSS files are not modules at all. `chat-mode-mirror.test.ts` gets
 * to import its two sides because `chatModes.ts` is deliberately React-free; nothing here is.
 * So these are TEXT-SHAPE assertions — they pin the LISTS and the DECLARATIONS, not rendered
 * behaviour. What renders is `scripts/verify/sidebar-rail.mjs`'s job, in a real browser with
 * `getComputedStyle`. Keeping the split explicit is the point: this file is cheap and runs on
 * every commit; that one is slow and runs at a wave gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SIDEBAR_TSX = join(ROOT, 'dashboard/src/components/layout/Sidebar.tsx');
const NAV_ICONS = join(ROOT, 'dashboard/src/components/layout/NavIcons.tsx');
const I18N = join(ROOT, 'dashboard/src/context/I18nContext.tsx');
const TOKENS = join(ROOT, 'dashboard/src/styles/tokens.css');
const SIDEBAR_CSS = join(ROOT, 'dashboard/src/components/layout/Sidebar.css');
const MATURITY_CSS = join(ROOT, 'dashboard/src/components/common/maturity-tag.css');

const read = (p: string): string => readFileSync(p, 'utf-8');

/** The `NAV_GROUPS` array literal, from `const NAV_GROUPS` to the line that closes it. */
function navGroupsBlock(src: string): string {
  const start = src.indexOf('const NAV_GROUPS');
  expect(start, 'NAV_GROUPS not found in Sidebar.tsx').toBeGreaterThan(-1);
  const end = src.indexOf('\n];', start);
  expect(end, 'NAV_GROUPS never closes').toBeGreaterThan(start);
  return src.slice(start, end);
}

interface NavEntry { page: string; labelKey: string; maturity?: string; hero: boolean }

/** Every `{ page: 'x', labelKey: 'y', … }` row, in source order. */
function navItems(src: string): NavEntry[] {
  const block = navGroupsBlock(src);
  return [...block.matchAll(/\{\s*page:\s*'([^']+)',\s*labelKey:\s*'([^']+)'([^}]*)\}/g)].map((m) => ({
    page: m[1],
    labelKey: m[2],
    maturity: /maturity:\s*'([^']+)'/.exec(m[3])?.[1],
    hero: /hero:\s*true/.test(m[3]),
  }));
}

/** Group label keys paired with the CSS custom-property NAME each publishes. */
function navGroups(src: string): { labelKey: string; hue: string }[] {
  const block = navGroupsBlock(src);
  return [...block.matchAll(/labelKey:\s*'(nav\.group\.[^']+)',\s*\n?\s*hue:\s*'(--[a-z-]+)'/g)]
    .map((m) => ({ labelKey: m[1], hue: m[2] }));
}

/** The keys of the exported `ICONS` map. */
function iconPages(src: string): string[] {
  const start = src.indexOf('export const ICONS');
  expect(start, 'ICONS is not exported from NavIcons.tsx').toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  return [...src.slice(start, end).matchAll(/^\s{2}([a-zA-Z]+):\s/gm)].map((m) => m[1]);
}

/** Locale → its key set. One entry per `<locale>: {` block in `translations`. */
function localeKeys(src: string): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  const heads = [...src.matchAll(/^ {2}([a-z]{2}(?:-[A-Z]{2})?): \{$/gm)];
  for (const [i, head] of heads.entries()) {
    const from = head.index! + head[0].length;
    const to = i + 1 < heads.length ? heads[i + 1].index! : src.indexOf('\n};', from);
    out[head[1]] = new Set([...src.slice(from, to).matchAll(/^\s{4}'([^']+)':/gm)].map((m) => m[1]));
  }
  return out;
}

/** The declarations inside one CSS block, keyed by custom-property name. */
function blockVars(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found in tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('\n}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) out[m[1]] = m[2].trim();
  return out;
}

describe('sidebar rail — nav ↔ icons ↔ i18n (C8)', () => {
  it('every nav item has a glyph, and every glyph has a nav item', () => {
    const items = navItems(read(SIDEBAR_TSX));
    const icons = new Set(iconPages(read(NAV_ICONS)));
    expect(items.length).toBeGreaterThan(5);

    for (const item of items) {
      expect(icons.has(item.page), `nav item "${item.page}" has no ICONS entry`).toBe(true);
    }
    // The reverse direction, minus the two pages that are deliberately NOT in a nav group:
    // `announcements` is pinned to the rail's footer and `about` is unlinked (page kept,
    // entry removed). Both still render a glyph, so both still need one.
    const footerOnly = new Set(['announcements', 'about']);
    const pages = new Set(items.map((i) => i.page));
    for (const page of icons) {
      if (footerOnly.has(page)) continue;
      expect(pages.has(page), `ICONS has "${page}" but no nav group does`).toBe(true);
    }
  });

  it('every label and maturity key resolves in every locale the app ships', () => {
    const items = navItems(read(SIDEBAR_TSX));
    const groups = navGroups(read(SIDEBAR_TSX));
    const locales = localeKeys(read(I18N));
    expect(Object.keys(locales).length).toBeGreaterThan(0);

    // Asserted against EVERY locale block present, not a hardcoded ['en'] — `t()` falls
    // back to the raw KEY, never to English, so a half-populated second locale would put
    // `nav.tasks` on screen. Today that is `en` alone; the day a `tr` block lands, this
    // covers it with no edit here.
    const needed = [
      ...items.map((i) => i.labelKey),
      ...groups.map((g) => g.labelKey),
      ...items.flatMap((i) => (i.maturity ? [`maturity.${i.maturity}`] : [])),
      // `off` is applied dynamically (a switched-off learning layer), so no item declares it.
      'maturity.off',
    ];
    for (const [locale, keys] of Object.entries(locales)) {
      for (const key of needed) {
        expect(keys.has(key), `locale "${locale}" is missing "${key}"`).toBe(true);
      }
    }
  });

  it('the retired Lab/Beta/Off nav keys are gone', () => {
    // The style guide: "Lab is Insights in the UI — the `lab` CLI name never surfaces to a
    // user". The rail printed it on five rows, including the Insights page itself.
    const keys = localeKeys(read(I18N));
    for (const [locale, set] of Object.entries(keys)) {
      for (const dead of ['nav.lab', 'nav.beta', 'nav.off']) {
        expect(set.has(dead), `locale "${locale}" still defines "${dead}"`).toBe(false);
      }
    }
    expect(read(SIDEBAR_TSX)).not.toMatch(/nav\.(lab|beta|off)'/);
  });
});

describe('sidebar rail — the icon family is one hand (C9)', () => {
  it('declares exactly one stroke weight and one linecap/linejoin pair', () => {
    const src = read(NAV_ICONS);
    expect([...src.matchAll(/strokeWidth:/g)]).toHaveLength(1);
    expect([...src.matchAll(/strokeLinecap:/g)]).toHaveLength(1);
    expect([...src.matchAll(/strokeLinejoin:/g)]).toHaveLength(1);
    // …and no per-glyph override sneaking in as an SVG attribute.
    expect(src).not.toMatch(/stroke-width=/);
  });

  it('draws Agents as agents, not as a clock (C10)', () => {
    const src = read(NAV_ICONS);
    const start = src.indexOf('function AutomationsIcon');
    const body = src.slice(start, src.indexOf('\n}', start));
    // The clock was a ring plus two hands plus two bells. Two heads is the shape now; the
    // assertion is on the GLYPH's own body so a comment elsewhere cannot satisfy it.
    expect([...body.matchAll(/<circle/g)].length).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/cy="13\.6"/);
  });
});

describe('sidebar rail — K15, no shouting (C4)', () => {
  it('neither the rail nor the maturity chip uppercases anything', () => {
    for (const path of [SIDEBAR_CSS, MATURITY_CSS]) {
      const css = read(path).replace(/\/\*[\s\S]*?\*\//g, ''); // comments may NAME the rule
      expect(css, `${path} still uppercases`).not.toMatch(/text-transform:\s*uppercase/);
    }
  });

  it('the three old rail chips are gone, replaced by one component', () => {
    const css = read(SIDEBAR_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const dead of ['.sidebar-lab-tag', '.sidebar-beta-tag', '.sidebar-off-tag']) {
      expect(css, `${dead} still has rules`).not.toContain(dead);
    }
    expect(css).toContain('.sidebar-maturity');
  });
});

describe('sidebar rail — section hues (C6)', () => {
  const HUES = ['--nav-hue-workspace', '--nav-hue-memory', '--nav-hue-brain', '--nav-hue-control'];

  it('declares every hue in BOTH theme blocks', () => {
    const css = read(TOKENS);
    const light = blockVars(css, ':root {');
    const dark = blockVars(css, "[data-theme='dark']");
    for (const hue of HUES) {
      expect(light[hue], `${hue} missing from :root`).toBeTruthy();
      expect(dark[hue], `${hue} missing from [data-theme='dark']`).toBeTruthy();
    }
  });

  it('never spends the accent on a section hue', () => {
    // --chart-1 IS --color-accent. A section hue equal to it would make every idle icon in
    // that group read as the ACTIVE one — identity impersonating status, which is the one
    // thing the colour=MOOD rule cannot tolerate.
    const css = read(TOKENS);
    for (const block of [':root {', "[data-theme='dark']"]) {
      const vars = blockVars(css, block);
      for (const hue of HUES) {
        expect(vars[hue], `${hue} in ${block} resolves to the accent`).not.toContain('--chart-1');
      }
    }
  });

  it('bakes no hex into a hue, in either theme', () => {
    const css = read(TOKENS);
    for (const block of [':root {', "[data-theme='dark']"]) {
      const vars = blockVars(css, block);
      for (const hue of HUES) {
        expect(vars[hue], `${hue} in ${block} bakes a colour`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      }
    }
  });

  it('every group publishes a hue that tokens.css actually defines', () => {
    const groups = navGroups(read(SIDEBAR_TSX));
    const light = blockVars(read(TOKENS), ':root {');
    expect(groups.length).toBe(4);
    for (const g of groups) {
      expect(light[g.hue], `group ${g.labelKey} publishes undefined ${g.hue}`).toBeTruthy();
    }
    // Four groups, four DIFFERENT hues — the whole point is telling sections apart.
    expect(new Set(groups.map((g) => g.hue)).size).toBe(4);
  });

  it('spends the hue as a tinted surface and lets the active accent win', () => {
    const css = read(SIDEBAR_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
    // Tinted, never filled: the hue is always color-mixed into a theme surface.
    expect(css).toMatch(/\.sidebar-icon\s*\{[^}]*color-mix\(in srgb, var\(--nav-hue/);
    // `--nav-hue` must NOT be declared on .sidebar-icon — a declaration there wins over the
    // group's inherited value and every badge goes grey. The default is a var() fallback.
    const iconRule = /\.sidebar-icon\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(iconRule).not.toMatch(/^\s*--nav-hue:/m);
    // The active override is what makes identity lose to status. It stays accent-only.
    expect(css).toMatch(/\.sidebar-item--active \.sidebar-icon\s*\{[^}]*var\(--color-accent\)/);
  });

  it('spends no warning ink on NAV CHROME', () => {
    // Scoped to the nav rows on purpose. `--color-warning` is reserved for "genuinely hot
    // things" and the rail still has two of those — the teammate-conflict banner and the
    // sync-failed label — which are exactly the reserved case. What had to go is the amber
    // BETA tag, because Agents now wears Beta and a warning colour on the row the product
    // most wants opened would read as a fault.
    const css = read(SIDEBAR_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
    // Not `.sidebar-label` — `.sidebar-label--sync-warn` is the brain-sync control's own
    // failure text, which shares the prefix but is one of the hot things. A nav row's label
    // has no ink of its own anyway; it inherits from `.sidebar-item`, which IS checked.
    const navChrome = /^\.sidebar-(item|icon|maturity|group|nav)\b/;
    for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = rule[1].trim();
      if (!selector.split(',').some((s) => navChrome.test(s.trim().replace(/^\.sidebar--collapsed\s+/, '')))) continue;
      expect(rule[2], `"${selector}" spends warning ink`).not.toContain('--color-warning');
    }
  });
});

describe('sidebar rail — the hero row (C5)', () => {
  it('puts Agents first in Workspace, at beta, flagged hero', () => {
    const items = navItems(read(SIDEBAR_TSX));
    expect(items[0].page).toBe('automations');
    expect(items[0].maturity).toBe('beta');
    expect(items[0].hero).toBe(true);
    // Exactly one hero: the emphasis is only worth anything if it is not shared.
    expect(items.filter((i) => i.hero)).toHaveLength(1);
  });

  it('emphasises the hero without spending a colour the other rows lack', () => {
    const css = read(SIDEBAR_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.sidebar-item\[data-hero\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule, 'no [data-hero] rule').toBeTruthy();
    expect(rule).toMatch(/font-weight:/);
    // Weight and ink only — an accent here would break K8's budget (primary button, switch,
    // focus ring), and the row already carries the accent on its unread badge.
    expect(rule).not.toContain('--color-accent');
    // Its badge carries MORE OF THE SAME hue, never a second one.
    const ring = /\.sidebar-item\[data-hero\] \.sidebar-icon\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(ring).toContain('--nav-hue');
    expect(ring).not.toContain('--color-accent');
  });
});
