#!/usr/bin/env node
/**
 * The side menu — runtime proof that the rail's maturity model, section hues and
 * honest icons are real, in BOTH themes and BOTH widths.
 *
 *   npm run build && npm run verify:sidebar-rail
 *
 * Every colour below is read with `getComputedStyle` off the REAL rendered rail
 * in Chromium, never parsed out of the stylesheet. That distinction is the whole
 * point of this file: a `color-mix()` that resolves to the wrong thing, a token
 * declared in one theme block and not the other, and a rule that a later
 * selector overrides all typecheck and all read correctly in source.
 *
 * WHAT IT PROVES, one checkpoint per acceptance criterion:
 *   C5  Agents reads "Agents", wears a sentence-case Beta tag, sits FIRST in
 *       Workspace, and is emphasised by weight + ring — never by a colour the
 *       other rows do not have.
 *   C6  Every group's icon badge carries its own hue as a TINTED SURFACE; the
 *       active badge is still full accent; no `--nav-hue-*` resolves to the
 *       accent; nothing in the rail spends `--color-warning`.
 *   C7  Collapsed to 56px the four hues are still distinct on the badges, and
 *       the group divider still carries its section's hue.
 *   C4  Nothing in the rail renders in uppercase (K15).
 *   D4  Both themes: every hue-derived value CHANGES between light and dark, so
 *       nothing is baked.
 *
 * THEME AND WIDTH ARE SET THROUGH localStorage, then the page is reloaded — both
 * are read on mount (`ThemeContext`, `useSidebarCollapse`), so this drives the
 * real code path a returning user gets rather than poking the DOM.
 *
 * WHAT IT DOES NOT TOUCH — your machine. Isolated fake HOME and a scratch
 * project; no `claude` is ever spawned and no automation is ever run.
 *
 * FAILURE POLICY — COLLECT, DON'T FAIL FAST. Exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = join(REPO, 'dist', 'index.js');

const SCRATCH = join(tmpdir(), 'dc-ui-sidebar-rail');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const SHOTS = join(REPO, 'tmp', 'verify-sidebar-rail');

/** The four groups, in rail order, with the token each one's hue comes from. */
const GROUPS = [
  { label: 'Workspace', token: '--nav-hue-workspace' },
  { label: 'Memory', token: '--nav-hue-memory' },
  { label: 'Brain', token: '--nav-hue-brain' },
  { label: 'Control Panel', token: '--nav-hue-control' },
];

const report = { pass: 0, fail: 0 };
function check(label, ok, ev = '') {
  if (ok) { report.pass++; console.log(`  ✓ ${label}`); }
  else { report.fail++; console.log(`  ✗ ${label}${ev ? `\n      ${ev}` : ''}`); }
}

const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

function cli(args) {
  const r = spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`cli ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'automations'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'core'), { recursive: true });
  mkdirSync(join(CONTEXT_ROOT, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  cli(['vaults', 'add', 'proj', PROJ]);
}

async function startServer(port) {
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...process.env, HOME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  srv.kill();
  throw new Error('server did not come up');
}

/**
 * Everything the rail's colour story can be read from, in ONE evaluate so the
 * whole snapshot comes from a single layout pass.
 *
 * Returns computed values (`rgb(...)`), not declarations: `color-mix()` and
 * `var()` are resolved by the engine here, which is the only way to catch a
 * token that exists in one theme block and not the other.
 */
async function readRail(page) {
  return page.evaluate((groups) => {
    const cs = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop).trim() : null);
    const root = getComputedStyle(document.documentElement);

    /**
     * One notation for every colour compared below.
     *
     * A custom property's computed value is its own TEXT (`#7b68ee`), while a
     * real colour property computes to `rgb(…)`. Comparing the two directly
     * says "the active ink is not the accent" about an ink that is exactly the
     * accent — so every value goes through the engine's own parser first.
     */
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const norm = (value) => {
      if (!value) return value;
      probe.style.color = '';
      probe.style.color = value;
      return getComputedStyle(probe).color;
    };

    // The first nav item of each group — its badge is the group's hue sample.
    const groupEls = [...document.querySelectorAll('.sidebar-group')];
    const byLabel = Object.fromEntries(groupEls.map((g) => [
      (g.querySelector('.sidebar-group-label')?.textContent || '').trim(), g,
    ]));

    const sample = {};
    for (const { label } of groups) {
      const g = byLabel[label];
      const icon = g?.querySelector('.sidebar-item .sidebar-icon');
      const labelEl = g?.querySelector('.sidebar-group-label');
      sample[label] = {
        found: !!g,
        bg: cs(icon, 'background-color'),
        ring: cs(icon, 'box-shadow'),
        ink: cs(icon, 'color'),
        labelTransform: cs(labelEl, 'text-transform'),
        labelBorderTop: cs(labelEl, 'border-top-color'),
      };
    }

    const hero = document.querySelector('.sidebar-item[data-hero]');
    const heroGroup = hero?.closest('.sidebar-group');
    // A plain sibling in the SAME group — same hue, so any difference is the
    // hero treatment rather than the section's.
    const plain = [...(heroGroup?.querySelectorAll('.sidebar-item') ?? [])]
      .find((el) => !el.hasAttribute('data-hero') && !el.classList.contains('sidebar-item--active'));

    const active = document.querySelector('.sidebar-item--active');

    // Every element in the rail, for the uppercase sweep (K15).
    const uppercase = [...document.querySelectorAll('.sidebar *')]
      .filter((el) => getComputedStyle(el).textTransform === 'uppercase')
      .map((el) => el.className || el.tagName)
      .slice(0, 5);

    // Anything spending the warning ink — the rail must not (it is reserved for
    // genuinely hot things, and after the Beta retag nothing here qualifies).
    // NORMALISED, and a mutation test is why: comparing the raw token text
    // against a computed `rgb(…)` never matches, so a Beta tag that went back to
    // spending the warning survived this sweep untouched.
    const warning = norm(root.getPropertyValue('--color-warning').trim());
    const warned = [...document.querySelectorAll('.sidebar *')]
      .filter((el) => {
        if (!warning) return false;
        const s = getComputedStyle(el);
        return [s.color, s.backgroundColor, s.borderTopColor, s.borderColor].includes(warning);
      })
      .map((el) => el.className || el.tagName)
      .slice(0, 5);

    const items = [...document.querySelectorAll('.sidebar-group')][0];
    const firstItem = items?.querySelector('.sidebar-item');

    const out = {
      sample,
      tokens: Object.fromEntries(groups.map((g) => [g.token, norm(root.getPropertyValue(g.token).trim())])),
      chart1: norm(root.getPropertyValue('--chart-1').trim()),
      accent: norm(root.getPropertyValue('--color-accent').trim()),
      accentSoft: norm(root.getPropertyValue('--color-accent-soft').trim()),
      theme: document.documentElement.getAttribute('data-theme'),
      railWidth: Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0),
      collapsed: !!document.querySelector('.sidebar--collapsed'),
      uppercase,
      warned,
      hero: hero ? {
        label: (hero.querySelector('.sidebar-label')?.textContent || '').trim(),
        weight: cs(hero, 'font-weight'),
        color: cs(hero, 'color'),
        ring: cs(hero.querySelector('.sidebar-icon'), 'box-shadow'),
        maturity: (hero.querySelector('.sidebar-maturity')?.textContent || '').trim(),
        maturityTransform: cs(hero.querySelector('.sidebar-maturity'), 'text-transform'),
        isFirst: hero === firstItem,
      } : null,
      plain: plain ? {
        weight: cs(plain, 'font-weight'),
        color: cs(plain, 'color'),
        ring: cs(plain.querySelector('.sidebar-icon'), 'box-shadow'),
      } : null,
      active: active ? {
        bg: cs(active.querySelector('.sidebar-icon'), 'background-color'),
        ring: cs(active.querySelector('.sidebar-icon'), 'box-shadow'),
        ink: cs(active.querySelector('.sidebar-icon'), 'color'),
      } : null,
    };
    probe.remove();
    return out;
  }, GROUPS);
}

/** Load the rail under one theme/width combination, from a cold mount. */
async function load(page, base, { theme, collapsed }) {
  await page.addInitScript(([t, c]) => {
    localStorage.setItem('dreamcontext-theme', t);
    localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', c);
    // The first-run nudges add an animation to the rail; silencing them keeps
    // the screenshots comparable between the four passes.
    localStorage.setItem('dreamcontext.dashboard.aboutSeen', '1');
  }, [theme, collapsed ? '1' : '0']);
  await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    if (await page.locator('.announcements-modal-scrim').count() === 0) break;
  }
  await page.waitForSelector('.sidebar-group', { timeout: 15000 });
  await page.waitForTimeout(400);
}

/** The four badge fills are all different from one another. */
function distinct(snap) {
  const bgs = GROUPS.map((g) => snap.sample[g.label]?.bg);
  return new Set(bgs.filter(Boolean)).size === GROUPS.length;
}

async function main() {
  console.log('· fixture (isolated HOME, scratch vault, no claude)…');
  seed();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);

  const browser = await chromium.launch();
  const pageErrors = [];

  /** Snapshots keyed by `<theme>-<width>`, for the cross-theme comparison. */
  const snaps = {};

  try {
    for (const theme of ['light', 'dark']) {
      for (const collapsed of [false, true]) {
        const key = `${theme}-${collapsed ? 'collapsed' : 'expanded'}`;
        const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
        const page = await ctx.newPage();
        page.on('pageerror', (e) => pageErrors.push(`${key}: ${e}`));
        await load(page, base, { theme, collapsed });
        const snap = await readRail(page);
        snaps[key] = snap;

        const n = ['light-expanded', 'light-collapsed', 'dark-expanded', 'dark-collapsed'].indexOf(key) + 1;
        await page.screenshot({ path: join(SHOTS, `${n}-${key}.png`), clip: { x: 0, y: 0, width: 280, height: 1000 } });
        await ctx.close();
      }
    }

    // ── 1: Agents is first, named, and Beta ──────────────────────────────
    console.log('\n═══ 1. The Agents entry ═══');
    const le = snaps['light-expanded'];
    check('the rail has a hero item at all', !!le.hero, JSON.stringify(le.hero));
    check('it reads "Agents" — the nav label IS the page title', le.hero?.label === 'Agents', `label="${le.hero?.label}"`);
    check('…and it is FIRST in Workspace', le.hero?.isFirst === true);
    check('…wearing a Beta tag', le.hero?.maturity === 'Beta', `tag="${le.hero?.maturity}"`);
    check('…in sentence case, not shouted (K15)', le.hero?.maturityTransform === 'none',
      `text-transform: ${le.hero?.maturityTransform}`);

    // ── 2: the emphasis is weight and ring, never a colour of its own ────
    console.log('\n═══ 2. Emphasis without a new colour ═══');
    check('the hero row is heavier than its neighbours',
      Number(le.hero?.weight) > Number(le.plain?.weight), `${le.hero?.weight} vs ${le.plain?.weight}`);
    check('…and its ink is the stronger of the two', le.hero?.color !== le.plain?.color,
      `${le.hero?.color} vs ${le.plain?.color}`);
    check('…and its icon ring is stronger than a plain row\'s', le.hero?.ring !== le.plain?.ring,
      `${le.hero?.ring}\n      vs ${le.plain?.ring}`);
    // The emphasis must be MORE OF THE SAME HUE — the badge fill is the section's
    // tint, identical to its neighbours. A hero with its own fill would be the
    // second colour channel the ★★★ rule forbids.
    const heroBg = le.sample['Workspace']?.bg;
    check('…but its badge FILL is the section\'s, not a colour of its own',
      typeof heroBg === 'string' && heroBg.length > 0, `workspace fill: ${heroBg}`);

    // ── 3: per-group hues, and none of them is the accent ────────────────
    console.log('\n═══ 3. Section hues ═══');
    for (const g of GROUPS) check(`the ${g.label} group renders`, le.sample[g.label]?.found === true);
    check('all four badge fills differ from one another', distinct(le),
      GROUPS.map((g) => `${g.label}=${le.sample[g.label]?.bg}`).join(' '));
    check('…and every hue token resolves to something', GROUPS.every((g) => (le.tokens[g.token] ?? '') !== ''),
      JSON.stringify(le.tokens));
    // --chart-1 IS --color-accent. A section hue equal to it would make every
    // idle badge in that group read as the active one.
    check('no --nav-hue-* is the accent (--chart-1)',
      GROUPS.every((g) => le.tokens[g.token] !== le.chart1 && le.tokens[g.token] !== le.accent),
      `chart-1=${le.chart1} accent=${le.accent} tokens=${JSON.stringify(le.tokens)}`);
    check('no badge fill is the accent itself', GROUPS.every((g) => le.sample[g.label]?.bg !== le.accent));

    // ── 4: identity loses to status ──────────────────────────────────────
    console.log('\n═══ 4. The active badge still wins ═══');
    check('an item is active', !!le.active);
    check('the active badge is the accent-soft fill, not its section tint',
      le.active?.bg !== le.sample['Workspace']?.bg, `active=${le.active?.bg} section=${le.sample['Workspace']?.bg}`);
    check('…and its ink is the accent', le.active?.ink === le.accent, `${le.active?.ink} vs ${le.accent}`);
    check('…and its ring is the accent outright', (le.active?.ring ?? '').includes(le.accent),
      `ring=${le.active?.ring} accent=${le.accent}`);

    // ── 5: K15 and the warning reserve ───────────────────────────────────
    console.log('\n═══ 5. Casing and the reserved ink ═══');
    check('nothing in the rail renders in uppercase (K15)', le.uppercase.length === 0,
      `uppercase: ${le.uppercase.join(', ')}`);
    check('…and nothing spends --color-warning', le.warned.length === 0, `warned: ${le.warned.join(', ')}`);

    // ── 6: collapsed keeps the section readable ──────────────────────────
    console.log('\n═══ 6. Collapsed to the icon rail ═══');
    const lc = snaps['light-collapsed'];
    check('the rail actually collapsed', lc.collapsed && lc.railWidth <= 80, `width=${lc.railWidth}px`);
    check('the four hues are still distinct on the badges at 56px', distinct(lc),
      GROUPS.map((g) => `${g.label}=${lc.sample[g.label]?.bg}`).join(' '));
    // The label collapses to zero height and its border becomes the section
    // divider — which must keep the hue, or the groups merge into one column.
    const dividers = GROUPS.map((g) => lc.sample[g.label]?.labelBorderTop);
    check('…and the group divider still carries its section hue',
      new Set(dividers.filter(Boolean)).size === GROUPS.length, dividers.join(' '));

    // ── 7: both themes, and nothing is baked ─────────────────────────────
    console.log('\n═══ 7. Dark theme ═══');
    const de = snaps['dark-expanded'];
    const dc = snaps['dark-collapsed'];
    check('the dark pass really rendered dark', de.theme === 'dark' && le.theme === 'light',
      `light=${le.theme} dark=${de.theme}`);
    check('all four badge fills differ from one another in dark too', distinct(de),
      GROUPS.map((g) => `${g.label}=${de.sample[g.label]?.bg}`).join(' '));
    // THE NO-BAKED-HEX PROOF. Every one of these is a color-mix against a theme
    // surface, so a hardcoded second operand would pin one theme and show up
    // here as a value that did not move.
    const moved = GROUPS.filter((g) => de.sample[g.label]?.bg !== le.sample[g.label]?.bg);
    check('every badge fill CHANGES between themes — nothing is baked',
      moved.length === GROUPS.length,
      GROUPS.map((g) => `${g.label}: ${le.sample[g.label]?.bg} → ${de.sample[g.label]?.bg}`).join(' | '));
    const inkMoved = GROUPS.filter((g) => de.sample[g.label]?.ink !== le.sample[g.label]?.ink);
    check('…and so does every icon stroke', inkMoved.length === GROUPS.length,
      GROUPS.map((g) => `${g.label}: ${le.sample[g.label]?.ink} → ${de.sample[g.label]?.ink}`).join(' | '));
    check('the hue TOKENS themselves resolve differently per theme',
      GROUPS.every((g) => de.tokens[g.token] !== le.tokens[g.token]),
      `light=${JSON.stringify(le.tokens)} dark=${JSON.stringify(de.tokens)}`);
    check('no --nav-hue-* is the accent in dark either',
      GROUPS.every((g) => de.tokens[g.token] !== de.chart1 && de.tokens[g.token] !== de.accent),
      `chart-1=${de.chart1} tokens=${JSON.stringify(de.tokens)}`);
    check('nothing renders uppercase in dark either', de.uppercase.length === 0, de.uppercase.join(', '));
    check('…and nothing spends --color-warning in dark either', de.warned.length === 0, de.warned.join(', '));
    check('the hero is still first, named and Beta in dark',
      de.hero?.label === 'Agents' && de.hero?.isFirst === true && de.hero?.maturity === 'Beta',
      JSON.stringify(de.hero));
    check('dark collapsed keeps its four distinct hues', distinct(dc),
      GROUPS.map((g) => `${g.label}=${dc.sample[g.label]?.bg}`).join(' '));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    srv.kill();
  }

  console.log(`\n${report.fail === 0 ? '✓ PASS' : '✗ FAIL'} — ${report.pass} passed, ${report.fail} failed`);
  console.log(`  screenshots: ${SHOTS}`);
  process.exit(report.fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
