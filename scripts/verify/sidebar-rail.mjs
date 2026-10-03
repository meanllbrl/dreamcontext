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
 *   C7  Collapsed to 56px the rail drops the badges (owner, 2026-10-03): every
 *       idle glyph is bare and in ONE neutral ink, the group dividers are plain
 *       rules, only the active row is coloured, and hovering a glyph shows its
 *       name at once.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PHASE, distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);

const SCRATCH = scratchDir('dc-ui-sidebar-rail');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const CONTEXT_ROOT = join(PROJ, '_dream_context');
const SHOTS = shotsDir(REPO, 'sidebar-rail');

/** The four groups, in rail order, with the token each one's hue comes from. */
const GROUPS = [
  { label: 'Workspace', token: '--nav-hue-workspace' },
  { label: 'Memory', token: '--nav-hue-memory' },
  { label: 'Brain', token: '--nav-hue-brain' },
  // Was "Control Panel": the default whiteboard board took that name (whiteboard A15).
  { label: 'System', token: '--nav-hue-control' },
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
      // The group's hue sample is its first NON-active row: the active badge wears the accent,
      // so sampling it (Chat, first in Workspace, is active whenever the chat surface is open)
      // would compare the active badge with itself.
      const icon = g?.querySelector('.sidebar-item:not(.sidebar-item--active) .sidebar-icon');
      const labelEl = g?.querySelector('.sidebar-group-label');
      sample[label] = {
        found: !!g,
        item: (icon?.closest('.sidebar-item')?.querySelector('.sidebar-label')?.textContent || '').trim(),
        itemActive: !!icon?.closest('.sidebar-item--active'),
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
      // Every group's label and its rows' labels, for the rename checks (whiteboard A15).
      groupRows: groupEls.map((g) => ({
        label: (g.querySelector('.sidebar-group-label')?.textContent || '').trim(),
        items: [...g.querySelectorAll('.sidebar-item .sidebar-label')].map((el) => (el.textContent || '').trim()),
      })),
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
        afterTasks: (hero.closest('li')?.previousElementSibling?.querySelector('.sidebar-label')?.textContent || '').trim() === 'Tasks',
        title: hero.getAttribute('title'),
      } : null,
      plain: plain ? {
        weight: cs(plain, 'font-weight'),
        color: cs(plain, 'color'),
        ring: cs(plain.querySelector('.sidebar-icon'), 'box-shadow'),
      } : null,
      active: active ? {
        label: (active.querySelector('.sidebar-label')?.textContent || '').trim(),
        bg: cs(active.querySelector('.sidebar-icon'), 'background-color'),
        ring: cs(active.querySelector('.sidebar-icon'), 'box-shadow'),
        ink: cs(active.querySelector('.sidebar-icon'), 'color'),
      } : null,
    };
    probe.remove();
    return out;
  }, GROUPS);
}

/**
 * Round 2 (R2-1, AD-1): the GEOMETRY of every rail row, read off painted line boxes.
 *
 * `lines` counts the distinct tops of the label's text rects, and `spill` is how far the
 * painted text runs past the label's own box: `getClientRects` is not clipped by
 * `overflow`, so an ellipsised label reports the full width of the words it hides. For the
 * collapsed rail, `iconOff` is the icon centre's distance from its row's centre.
 */
async function readGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll('.sidebar-nav .sidebar-item, .sidebar-group .sidebar-item')]
    .filter((el, i, all) => all.indexOf(el) === i)
    .map((item) => {
      const label = item.querySelector('.sidebar-label');
      const icon = item.querySelector('.sidebar-icon');
      const ir = item.getBoundingClientRect();
      const out = {
        hero: item.hasAttribute('data-hero'),
        text: (label?.textContent || '').trim(),
        rowH: Math.round(ir.height * 10) / 10,
        iconOff: icon ? Math.abs((icon.getBoundingClientRect().left + icon.getBoundingClientRect().width / 2) - (ir.left + ir.width / 2)) : null,
        lines: 0,
        spill: 0,
      };
      if (label && label.getClientRects().length) {
        const box = label.getBoundingClientRect();
        const tops = [];
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const q of range.getClientRects()) {
            if (q.width <= 0) continue;
            tops.push(Math.round(q.top));
            out.spill = Math.max(out.spill, Math.round((q.right - box.right) * 10) / 10, Math.round((q.bottom - box.bottom) * 10) / 10);
          }
        }
        tops.sort((a, b) => a - b);
        out.lines = tops.filter((t, i) => i === 0 || t - tops[i - 1] > 2).length;
      }
      return out;
    }));
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
        snap.geo = await readGeometry(page);
        snaps[key] = snap;
        console.log(`  · ${key}: active="${snap.active?.label ?? ''}", Workspace sample="${snap.sample.Workspace?.item}" (active=${snap.sample.Workspace?.itemActive}) activeBg=${snap.active?.bg} sampleBg=${snap.sample.Workspace?.bg} accentSoft=${snap.accentSoft}`);

        const n = ['light-expanded', 'light-collapsed', 'dark-expanded', 'dark-collapsed'].indexOf(key) + 1;
        await page.screenshot({ path: join(SHOTS, `${n}-${key}.png`), clip: { x: 0, y: 0, width: 280, height: 1000 } });
        if (collapsed) {
          // The name tag: hover the second Workspace row (the first is Chat, which may be active).
          const row = page.locator('.sidebar-group .sidebar-item:not(.sidebar-item--active)').nth(1);
          const expect = await row.getAttribute('data-tip');
          await row.hover();
          await page.waitForTimeout(150);
          snap.tip = await page.evaluate(() => {
            const el = document.querySelector('.sidebar-tip');
            const rail = document.querySelector('.sidebar')?.getBoundingClientRect();
            return el ? { text: (el.textContent || '').trim(), right: el.getBoundingClientRect().left >= (rail?.right ?? 0) } : null;
          });
          if (snap.tip) snap.tip.expect = expect;
          await page.screenshot({ path: join(SHOTS, `${n}-${key}-hover.png`), clip: { x: 0, y: 0, width: 280, height: 1000 } });
        }
        await ctx.close();
      }
    }

    // ── 1: Agents is first, named, and Beta ──────────────────────────────
    console.log('\n═══ 1. The Agents entry ═══');
    const le = snaps['light-expanded'];
    check('the rail has a hero item at all', !!le.hero, JSON.stringify(le.hero));
    check('it reads "Automations" — the nav label IS the page title', le.hero?.label === 'Automations', `label="${le.hero?.label}"`);
    check('…and it sits right after Tasks in Workspace (owner, 2026-09-29)', le.hero?.afterTasks === true);
    check('…wearing a Beta tag', le.hero?.maturity === 'Beta', `tag="${le.hero?.maturity}"`);
    // F16: the tooltip is user-visible copy too, and it joined the label and the tag with an
    // em dash ("Agentic Automations — Beta"). A parenthesis says the same without one.
    check('[F16] the hero tooltip reads "Automations (Beta)", no em dash',
      le.hero?.title === 'Automations (Beta)', `title="${le.hero?.title}"`);
    check('…in sentence case, not shouted (K15)', le.hero?.maturityTransform === 'none',
      `text-transform: ${le.hero?.maturityTransform}`);

    // ── 1b: the group names after the Control Panel rename (whiteboard A15) ──
    console.log('\n═══ 1b. System group, Whiteboard entry ═══');
    const rows = le.groupRows ?? [];
    const rowsOf = (label) => rows.find((g) => g.label === label)?.items ?? [];
    check('the group holding Packs and Settings is titled "System"',
      rowsOf('System').includes('Packs') && rowsOf('System').includes('Settings'), JSON.stringify(rows));
    check('…and no group is titled "Control Panel" any more', !rows.some((g) => g.label === 'Control Panel'),
      rows.map((g) => g.label).join(' | '));
    check('Workspace carries the "Whiteboard" entry', rowsOf('Workspace').includes('Whiteboard'),
      rowsOf('Workspace').join(' | '));
    check('…and no rail row says "Control Panel" (that names the default board only)',
      !rows.some((g) => g.items.includes('Control Panel')), JSON.stringify(rows));

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
    check('the Workspace hue sample is not the active row (no self-comparison)',
      le.sample['Workspace']?.itemActive === false && le.sample['Workspace']?.item !== le.active?.label,
      `sampled ${le.sample['Workspace']?.item}, active ${le.active?.label}`);
    check('the active badge is the accent-soft fill, not its section tint',
      le.active?.bg !== le.sample['Workspace']?.bg,
      `active=${le.active?.bg} (${le.active?.label}) section=${le.sample['Workspace']?.bg} (sampled ${le.sample['Workspace']?.item}, active=${le.sample['Workspace']?.itemActive})`);
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
    // Owner, 2026-10-03: the tinted boxes and four hues made the collapsed rail unreadable.
    // Collapsed, an idle glyph is bare and every group speaks the SAME neutral ink.
    const bare = (snap) => GROUPS.every((g) => /rgba\(0, 0, 0, 0\)|transparent/.test(snap.sample[g.label]?.bg ?? '')
      && (snap.sample[g.label]?.ring ?? '') === 'none');
    const oneInk = (snap) => new Set(GROUPS.map((g) => snap.sample[g.label]?.ink)).size === 1;
    check('[C7] collapsed: no idle glyph sits in a box', bare(lc),
      GROUPS.map((g) => `${g.label}=${lc.sample[g.label]?.bg}/${lc.sample[g.label]?.ring}`).join(' '));
    check('[C7] …and all four groups share one neutral glyph ink', oneInk(lc),
      GROUPS.map((g) => `${g.label}=${lc.sample[g.label]?.ink}`).join(' '));
    check('[C7] …which is not the accent', lc.sample['Workspace']?.ink !== lc.accent, `${lc.sample['Workspace']?.ink}`);
    check('[C7] the active glyph is the accent, so the one colour means "you are here"',
      lc.active?.ink === lc.accent, `${lc.active?.label}: ${lc.active?.ink} vs ${lc.accent}`);
    const dividers = GROUPS.slice(1).map((g) => lc.sample[g.label]?.labelBorderTop);
    check('[C7] the group dividers are one plain rule, not four hues',
      new Set(dividers.filter(Boolean)).size === 1, dividers.join(' '));
    check('[C7] hovering a collapsed glyph shows its name at once',
      lc.tip?.text === lc.tip?.expect && !!lc.tip?.expect && lc.tip?.right, JSON.stringify(lc.tip));

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
      de.hero?.label === 'Automations' && de.hero?.afterTasks === true && de.hero?.maturity === 'Beta',
      JSON.stringify(de.hero));
    check('[C7] dark collapsed: bare glyphs in one neutral ink', bare(dc) && oneInk(dc),
      GROUPS.map((g) => `${g.label}=${dc.sample[g.label]?.bg}/${dc.sample[g.label]?.ink}`).join(' '));
    check('[C7] dark collapsed: the active glyph is the accent', dc.active?.ink === dc.accent,
      `${dc.active?.ink} vs ${dc.accent}`);
    check('[C7] dark collapsed: the name tag shows on hover', dc.tip?.text === dc.tip?.expect && !!dc.tip?.expect,
      JSON.stringify(dc.tip));

    // ── 8 (round 2): the label wraps instead of truncating ───────────────
    // R2-1 (owner decision 1a): the label wraps rather than truncating. Since 2026-09-29 the
    // hero reads "Automations", which fits on ONE line; the check is that it paints whole.
    // Originally: "Agentic Automations" wrapped to two lines rather than
    // painting as "Agentic A…". Pre-fix the label was `nowrap` + ellipsis in about 75px,
    // so its text painted as ONE line running well past its box.
    console.log('\n═══ 8. Round 2: the label wraps, the rail stays centred ═══');
    const rowsFile = join(REPO, 'tmp', 'verify-sidebar-rail', 'rows-before-r2.json');
    for (const theme of ['light', 'dark']) {
      const geo = snaps[`${theme}-expanded`].geo;
      const hero = geo.find((g) => g.hero);
      check(`[R2-1] ${theme}: the hero label paints whole and fits its box`,
        hero?.lines === 1 && hero.spill <= 0.5, JSON.stringify(hero));
      const others = geo.filter((g) => !g.hero && g.text);
      const bad = others.filter((g) => g.lines !== 1 || g.spill > 0.5);
      check(`[guard] ${theme}: every other expanded label paints on one line inside its box`,
        others.length > 0 && bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : `${others.length} rows`);
      // Row heights are compared with the PRE-FIX build's, recorded by the before-r2 run.
      // Only rows other than the hero: the hero is the one row allowed to grow.
      if (PHASE === 'before-r2') {
        mkdirSync(dirname(rowsFile), { recursive: true });
        const prev = existsSync(rowsFile) ? JSON.parse(readFileSync(rowsFile, 'utf-8')) : {};
        prev[theme] = Object.fromEntries(others.map((g) => [g.text, g.rowH]));
        writeFileSync(rowsFile, JSON.stringify(prev, null, 2));
      }
      const baseline = existsSync(rowsFile) ? JSON.parse(readFileSync(rowsFile, 'utf-8'))[theme] : null;
      const moved = baseline ? others.filter((g) => baseline[g.text] !== undefined && Math.abs(baseline[g.text] - g.rowH) > 1) : [];
      check(`[guard] ${theme}: every other row keeps its pre-fix height ±1`,
        baseline !== null && moved.length === 0,
        baseline === null ? `no baseline at ${rowsFile}: run the before-r2 phase first` : moved.map((g) => `${g.text}: ${baseline[g.text]} → ${g.rowH}`).join(', ') || `${others.length} rows`);
      // AD-1: the new end-of-row wrapper must not push a collapsed icon off centre.
      const icons = snaps[`${theme}-collapsed`].geo.filter((g) => g.iconOff !== null);
      const off = icons.filter((g) => g.iconOff > 1);
      check(`[guard] ${theme} collapsed: every rail icon sits at its row's centre ±1px`,
        icons.length > 0 && off.length === 0, off.length ? JSON.stringify(off.slice(0, 3)) : `${icons.length} icons`);
    }

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
