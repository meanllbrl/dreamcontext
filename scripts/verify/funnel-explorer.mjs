#!/usr/bin/env node
/**
 * The built-in funnel explorer, end to end: the agent flow on the CLI, then the
 * explorer card in the real dashboard, every page, in light AND dark, in English
 * AND Turkish.
 *
 *   npm run build && npm run verify:funnel-explorer
 *   node scripts/verify/funnel-explorer.mjs --only='^ui'          (sections whose name matches)
 *   node scripts/verify/funnel-explorer.mjs --shots=<dir>         (also copy the screenshots there)
 *   node scripts/verify/funnel-explorer.mjs --from-vault=<path> --board=<slug> [--select=a=b,c=d] [--funnel=<id>] [--parity]
 *                                           [--shots=<dir>] [--compare=<dir of reference PNGs>]
 *
 * Follows the lab-boards conventions: the REAL server from dist/ on an isolated
 * scratch vault under the OS temp dir, a fake HOME (no user state touched), every
 * CLI call through dist/index.js, WebKit (the engine the desktop app ships).
 *
 * Fixture mode (default) builds two insights from the synthetic snapshot fixture
 * (scripts/verify/fixtures/acme-funnel-snapshot.mjs) exactly as an agent would:
 * `lab create --preset funnel-explorer`, then `lab data write`. Sections:
 *
 *   1. CLI SCAFFOLD AND GATE: the preset writes the manifest and the snapshot
 *      reading script, never lab/data; a sync before the snapshot fails loudly;
 *      a refused snapshot leaves the file absent or byte-identical; a valid one
 *      is written and synced; `lab data check` reports it.
 *   2. DERIVED BOARD + CLI: the category board derives the 12x18 explorer card,
 *      and `lab board show --select --json` prints the fixture's own numbers
 *      (steps, worst drop, ladder order, payment, notes order; `--funnel`).
 *   3. EVERY TAB in light and dark, EN and TR: the localized label, the page's
 *      DOM hooks, the honesty markers, a screenshot of each.
 *   4. ACCESS is hidden on the bare snapshot (no data, never zeros), shown on the full one.
 *   5. EMPTY STATES name the missing part and show the snapshot's hint.
 *   6. DEEP LINK: funnel + chip + 2 lanes + the Compare tab survive a reload,
 *      a fullscreen reload and the copied URL in a new page.
 *   7. NOTES: every funnel trap is among the first 4 lines; funnel traps, then
 *      set traps, then info.
 *   8. CLI/DOM PARITY on the Steps and Benchmark pages.
 *   9. THEME REPAINT (inside section 3).
 *
 * `--from-vault=<path>` copies `<path>/_dream_context/lab` into the scratch vault
 * (the real brain is never written; credentials are not copied) and runs the
 * tab walk, the notes check, the parity check (with `--parity`) and the
 * comparison sheet on `--board`. `--compare=<dir>` writes side-by-side.html (and
 * one PNG per page) pairing the reference renders gunluk, bench, siralama, akis,
 * adimlar, odeme, erisim, platform, ulke, dil with our tabs, per theme and locale.
 *
 * Turkish is the explorer's own: a second fixture insight is created with
 * `lab create --preset funnel-explorer --locale tr`, and its card speaks Turkish
 * (`data-lab-card-locale="tr"`, a card-scoped I18n provider) while the dashboard
 * stays English. On a real vault the card is walked in its own locale.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import { webkit } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** A flag's value: `--name=value`, `--name value`, or `true` for a bare `--name`. */
const arg = (name) => {
  const argv = process.argv;
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return null;
  if (argv[i].includes('=')) return argv[i].slice(argv[i].indexOf('=') + 1);
  const next = argv[i + 1];
  return next !== undefined && !next.startsWith('--') ? next : true;
};
const FROM_VAULT = typeof arg('from-vault') === 'string' ? resolve(arg('from-vault')) : null;
const BOARD_ARG = typeof arg('board') === 'string' ? arg('board') : null;
const SELECT_ARG = typeof arg('select') === 'string' ? arg('select') : null;
const FUNNEL_ARG = typeof arg('funnel') === 'string' ? arg('funnel') : null;
const PARITY = arg('parity') !== null;
const COMPARE_DIR = typeof arg('compare') === 'string' ? resolve(arg('compare')) : null;
/** The reference set to pair (`<prefix>-<page>.png`); default: the first prefix, alphabetically, that has all 10 pages. */
const COMPARE_PREFIX = typeof arg('compare-prefix') === 'string' ? arg('compare-prefix') : null;
const SHOTS_OUT = typeof arg('shots') === 'string' ? resolve(arg('shots')) : null;
const ONLY = typeof arg('only') === 'string' ? new RegExp(arg('only')) : null;

const SCRATCH = join(tmpdir(), `dreamcontext-verify-funnel-explorer${FROM_VAULT ? '-vault' : ''}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(SCRATCH, 'shots');
const PORT = FROM_VAULT ? 46219 : 46218;
const BASE = `http://127.0.0.1:${PORT}`;
const CLI = join(REPO, 'dist', 'index.js');
const DC = join(PROJ, '_dream_context');
const LAB = join(DC, 'lab');
const FIXTURE = join(REPO, 'scripts', 'verify', 'fixtures', 'acme-funnel-snapshot.mjs');

/** The two fixture insights and the boards their categories derive. */
const FULL = 'acme-funnel-snapshot';
/** The same snapshot on a card created with `--locale tr`: the Turkish explorer, on the same board. */
const FULL_TR = 'acme-funnel-snapshot-tr';
const BARE = 'acme-funnel-bare';
const FULL_BOARD = 'acme-funnels';
const BARE_BOARD = 'acme-bare';
const cardIdOf = (slug) => `c-${slug}`;

/** Every explorer tab key with its label in each dashboard language (the catalog copy). */
const TAB_LABELS = {
  daily: { en: 'Daily', tr: 'Günlük' },
  benchmark: { en: 'Benchmark', tr: 'Benchmark' },
  ranking: { en: 'Ranking', tr: 'Sıralama' },
  flow: { en: 'Flow', tr: 'Akış' },
  steps: { en: 'Steps', tr: 'Adımlar' },
  compare: { en: 'Compare', tr: 'Karşılaştır' },
  payment: { en: 'Payment', tr: 'Ödeme' },
  access: { en: 'Access', tr: 'Erişim' },
  'dim.platform': { en: 'Platform', tr: 'Platform' },
  'dim.country': { en: 'Country', tr: 'Ülke' },
  'dim.language': { en: 'Language', tr: 'Dil' },
};
/** The tabs of the fixture's explorer card, in order (its dims: platform, country, language). */
const FULL_TABS = ['daily', 'benchmark', 'ranking', 'flow', 'steps', 'compare', 'payment', 'access', 'dim.platform', 'dim.country', 'dim.language'];
/** "Not measured" and "derived" in each language. */
const WORDS = { en: { notMeasured: /not measured/i, derived: /derived/i }, tr: { notMeasured: /ölçülmüyor/i, derived: /türetilmiş/i } };
/** Reference page -> our tab, for the comparison sheet. */
const REF_PAGES = [
  ['gunluk', 'daily'], ['bench', 'benchmark'], ['siralama', 'ranking'], ['akis', 'flow'], ['adimlar', 'steps'],
  ['odeme', 'payment'], ['erisim', 'access'], ['platform', 'dim.platform'], ['ulke', 'dim.country'], ['dil', 'dim.language'],
];
const THEMES = ['light', 'dark'];
const LOCALES = ['en', 'tr'];

// ─── Report ──────────────────────────────────────────────────────────────────

const results = [];
function ok(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: pass ? '' : String(detail).slice(0, 900) });
}
const sectionsRan = [];
let sectionPage = null;
async function section(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  sectionsRan.push(name);
  try {
    await fn();
  } catch (e) {
    ok(`${name} (section threw)`, false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
    if (sectionPage) await sectionPage.screenshot({ path: join(SHOTS, `threw-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, step = 150) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}

/** A CLI call through dist/, with its exit code (the gate checks are about exit codes). */
function run(args, { cwd = PROJ } = {}) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd, env: { ...process.env, HOME, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function dc(args, opts) {
  const r = run(args, opts);
  if (r.code !== 0) throw new Error(`dreamcontext ${args.join(' ')} exited ${r.code}: ${r.out.slice(0, 600)}`);
  return r.out;
}
const sha = (path) => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);

/**
 * A shown figure equals a number at the precision it is shown: "1,234.5", "1.2K", "42%" in English,
 * "1.234,5" / "6,6%" in Turkish (the card's own locale decides the separators).
 */
function shownEquals(text, want, loc = 'en') {
  let s = String(text ?? '').replace(/ /g, ' ').replace('−', '-');
  // Turkish: "1.234,5", "%21,8", "660 bin" / "1,2 mn" / "3 mr".
  if (loc === 'tr') s = s.replace(/\./g, '').replace(/,/g, '.').replace(/\s*bin\b/i, 'K').replace(/\s*mn\b/i, 'M').replace(/\s*mr\b/i, 'B');
  const m = /(-?[\d,]*\.?\d+)\s*([KMB])?/i.exec(s);
  if (!m || want === null || want === undefined) return false;
  const k = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase()] ?? 1;
  const decimals = (m[1].split('.')[1] ?? '').length;
  // Equal at the precision shown: within half a unit of the last shown digit (a .x5 tie may round either way).
  return Math.abs(Number(m[1].replace(/,/g, '')) - want / k) <= 0.5 * 10 ** -decimals + 1e-9;
}

/** `a=b,c=d` -> {a: 'b', c: 'd'}. */
function parseSelect(s) {
  const out = {};
  for (const part of String(s ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The step drops the engine computes: an unmeasured step is skipped, the next one compares to the last measured. */
function fixtureDrops(steps) {
  let last = null;
  let worst = null;
  let worstPct = -Infinity;
  for (const s of steps) {
    if (s.measured === false) continue;
    if (last !== null && last.users > 0) {
      const drop = 100 - (s.users / last.users) * 100;
      if (drop > worstPct) { worstPct = drop; worst = s.key; }
    }
    last = s;
  }
  return { worst, worstPct };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  // `vaults add` refuses a path without _dream_context/: create it first (lab-boards does the same).
  mkdirSync(join(DC, 'state'), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  dc(['vaults', 'add', 'proj', PROJ], { cwd: REPO });
  run(['init', '--yes']);
  if (FROM_VAULT) {
    const src = join(FROM_VAULT, '_dream_context', 'lab');
    if (!existsSync(src)) throw new Error(`--from-vault: no _dream_context/lab under ${FROM_VAULT}`);
    // A COPY: nothing under the real brain is ever written. Credentials stay where they are.
    cpSync(src, LAB, { recursive: true, filter: (p) => basename(p) !== 'credentials.json' });
  }
}

// ─── In-page readers ─────────────────────────────────────────────────────────

/** What the explorer card SHOWS (data-* hooks only locate; the compared figures are the painted text). */
function explorerInPage(root) {
  const visible = (el) => {
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const q = (sel) => [...root.querySelectorAll(sel)].filter(visible);
  const text = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);
  const num = (s) => {
    const m = /-?[\d,]*\.?\d+/.exec(String(s ?? ''));
    return m ? Number(m[0].replace(/,/g, '')) : null;
  };
  const picker = root.querySelector('[data-lab-funnel-picker]');
  return {
    header: !!root.querySelector('[data-lab-explorer-header]'),
    funnel: picker ? picker.value : null,
    funnelOptions: picker ? [...picker.querySelectorAll('option')].map((o) => o.value) : [],
    window: root.querySelector('[data-lab-explorer-window]')?.getAttribute('data-lab-explorer-window') ?? null,
    windowText: text(root.querySelector('[data-lab-explorer-window]')),
    source: text(root.querySelector('[data-lab-explorer-source]')),
    // The selection: the pressed chips, or the compact form's selects (one per dimension).
    chips: [
      ...q('[data-lab-breakdown-chip][aria-pressed="true"]').map((c) => ({
        dim: c.closest('[data-lab-breakdown-dim]')?.getAttribute('data-lab-breakdown-dim') ?? null, value: c.getAttribute('data-lab-breakdown-chip'),
      })),
      ...[...root.querySelectorAll('select[data-lab-breakdown-select]')].filter((el) => el.value !== '').map((el) => ({ dim: el.getAttribute('data-lab-breakdown-select'), value: el.value })),
    ],
    breakdownCompact: !!root.querySelector('[data-lab-breakdown][data-compact="true"]'),
    lanes: root.querySelectorAll('[data-lab-breakdown-lanes] [data-lab-lane]').length,
    tabs: [...root.querySelectorAll('[data-lab-tab]')].map((b) => ({
      key: b.getAttribute('data-lab-tab-key'), label: b.textContent.trim(), selected: b.getAttribute('aria-selected') === 'true',
    })),
    notes: q('[data-lab-explorer-note]').map((n) => ({
      code: n.getAttribute('data-lab-explorer-note'), level: n.getAttribute('data-level'), scope: n.getAttribute('data-scope'), text: text(n),
    })),
    notesMore: root.querySelector('[data-lab-notes-more]')?.getAttribute('data-lab-notes-more') ?? null,
    steps: q('[data-lab-step]').map((r) => ({
      key: r.getAttribute('data-lab-step'), users: r.getAttribute('data-measured') === 'false' ? null : num(r.getAttribute('data-users')),
      basis: r.getAttribute('data-basis'), measured: r.getAttribute('data-measured') !== 'false', worst: r.getAttribute('data-worst') === 'true',
      dropPct: r.hasAttribute('data-drop-pct') ? num(r.getAttribute('data-drop-pct')) : null, text: text(r),
    })),
    bench: q('[data-lab-bench-row]').map((r) => ({
      key: r.getAttribute('data-lab-bench-row'), status: r.getAttribute('data-status'),
      value: r.querySelector('[data-lab-bench-value]')?.textContent.trim() ?? null,
      source: r.querySelector('[data-lab-bench-source]')?.textContent.trim() ?? null, text: text(r),
    })),
    ranking: q('[data-lab-ranking-row]').map((r) => ({
      funnel: r.getAttribute('data-lab-ranking-row'), selection: r.getAttribute('data-selection'),
      value: r.hasAttribute('data-value') ? Number(r.getAttribute('data-value')) : null, low: r.getAttribute('data-low-sample') === 'true',
    })),
    rankingFloor: root.querySelector('[data-lab-ranking-floor]')?.getAttribute('data-lab-ranking-floor') ?? null,
    payment: (() => {
      const p = q('[data-lab-payment]')[0];
      if (!p) return null;
      const rate = p.querySelector('[data-lab-payment-rate]');
      return {
        scope: p.getAttribute('data-scope'), rate: rate ? rate.textContent.trim() : null, kn: rate?.getAttribute('data-lab-kn') ?? null,
        reasons: [...p.querySelectorAll('[data-lab-payment-reason]')].map((r) => r.getAttribute('data-lab-payment-reason')),
        cohorts: p.querySelectorAll('[data-lab-payment-cohort]').length, clipped: !!p.querySelector('[data-lab-payment-clipped]'),
        notForSel: !!p.querySelector('[data-lab-payment-not-for-sel]'), setScope: !!p.querySelector('[data-lab-payment-scope="set"]'),
      };
    })(),
    access: q('[data-lab-access-row]').map((r) => ({ row: r.getAttribute('data-lab-access-row'), kn: [...r.querySelectorAll('[data-lab-kn]')].map((e) => e.getAttribute('data-lab-kn')), text: text(r) })),
    segments: q('[data-lab-segment-row]').map((r) => ({
      value: r.getAttribute('data-lab-segment-row'), low: r.hasAttribute('data-lab-low-sample'),
      kn: [...r.querySelectorAll('[data-lab-kn]')].map((e) => e.getAttribute('data-lab-kn')),
    })),
    kn: q('[data-lab-kn]').map((e) => e.getAttribute('data-lab-kn')),
    empties: q('[data-lab-empty]').map((e) => ({ part: e.getAttribute('data-lab-empty'), hint: e.querySelector('[data-lab-hint]')?.textContent.trim() ?? null, text: text(e) })),
    notMeasured: q('[data-lab-not-measured]').map((e) => text(e)),
    derived: q('[data-lab-step][data-basis="derived"], [data-lab-derived]').length,
    trend: q('[data-lab-trend]').length > 0,
    flow: q('[data-lab-flow]').length > 0,
    lanesDrawn: q('.funnel-lanes[data-lab-lanes]').length > 0,
    bodyText: text(root),
  };
}

/** Pairs of colours that must change with the theme: the card surface and its body text. */
function paintInPage(root) {
  const cs = getComputedStyle(root);
  const head = root.querySelector('[data-lab-explorer-header]');
  return `${cs.backgroundColor}|${cs.color}|${head ? getComputedStyle(head).color : ''}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  setupScratch();
  const fixture = await import(pathToFileURL(FIXTURE).href);
  const full = fixture.snapshot('full');
  const bare = fixture.snapshot('bare');
  const fx = full.data;
  const fxFunnel = (id) => fx.funnels.find((f) => f.id === id);
  const exactPath = (id, sel) => {
    const f = fxFunnel(id);
    const keys = Object.keys(sel);
    if (keys.length === 0) return { users: f.steps[0].users, steps: f.steps };
    return f.segments.find((s) => Object.keys(s.dims).length === keys.length && keys.every((k) => s.dims[k] === sel[k])) ?? null;
  };

  // ── 1. CLI: scaffold and gate (fixture mode) ────────────────────────────────
  if (!FROM_VAULT) {
    await section('cli: scaffold and gate', async () => {
      const created = run(['lab', 'create', FULL, '--title', 'Acme storefront funnels', '--category', 'Acme Funnels', '--preset', 'funnel-explorer']);
      ok('lab create --preset funnel-explorer succeeds', created.code === 0, created.out);
      const manifest = matter(readFileSync(join(LAB, 'insights', `${FULL}.md`), 'utf-8'));
      const fm = manifest.data;
      ok('the preset manifest: render funnel, adapter script, preset funnel-explorer, no range tweak',
        fm.render === 'funnel' && fm.source?.adapter === 'script' && fm.preset === 'funnel-explorer' && Array.isArray(fm.tweaks) && fm.tweaks.length === 0,
        JSON.stringify({ render: fm.render, source: fm.source, preset: fm.preset, tweaks: fm.tweaks }));
      ok('the preset manifest carries the Meaning skeleton (source, window, steps, traps, refresh)',
        /## Meaning/.test(manifest.content) && /Reading traps/i.test(manifest.content) && /Refresh/i.test(manifest.content), manifest.content.slice(0, 600));
      const script = readFileSync(join(LAB, 'scripts', `${FULL}.mjs`), 'utf-8');
      ok('the template script reads only lab/data/<slug>.json: no fetch, no credentials',
        script.includes(`../data/${FULL}.json`) && !/\bfetch\s*\(/.test(script) && !/credentials/.test(script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
        script.slice(0, 800));
      ok('lab create never writes lab/data', !existsSync(join(LAB, 'data', `${FULL}.json`)));
      ok('a derived vault places the explorer without writing a board', !existsSync(join(LAB, 'boards')) || readdirSync(join(LAB, 'boards')).length === 0);

      const early = run(['lab', 'sync', FULL, '--force']);
      ok('a sync before the snapshot fails loudly ("No snapshot yet", non-zero exit)', early.code !== 0 && /No snapshot yet/.test(early.out), `${early.code} ${early.out.slice(0, 400)}`);

      const dataFile = join(LAB, 'data', `${FULL}.json`);
      const write = (snap, name) => {
        const file = join(SCRATCH, `${name}.json`);
        writeFileSync(file, JSON.stringify(snap));
        return run(['lab', 'data', 'write', FULL, '--file', file]);
      };
      const noDate = JSON.parse(JSON.stringify(full));
      noDate.source.applied_filters = noDate.source.applied_filters.filter((f) => f.op !== 'between');
      delete noDate.source.queries;
      const refused = write(noDate, 'no-date-filter');
      ok('lab data write refuses a snapshot without an explicit date filter, and writes nothing', refused.code === 1 && !existsSync(dataFile), `${refused.code} ${refused.out.slice(0, 400)}`);

      const wrote = write(full, 'full');
      ok('lab data write accepts the full snapshot and syncs it', wrote.code === 0 && existsSync(dataFile), `${wrote.code} ${wrote.out.slice(0, 600)}`);
      const before = sha(dataFile);
      const noPull = JSON.parse(JSON.stringify(full));
      delete noPull.source.pulled_at;
      const refused2 = write(noPull, 'no-pulled-at');
      ok('a refused snapshot leaves the written one byte-identical (missing pulled_at)', refused2.code === 1 && sha(dataFile) === before, `${refused2.code} ${refused2.out.slice(0, 300)}`);
      const notFunnel = { source: full.source, data: [{ name: 'series', points: [{ t: '2026-09-01', v: 1 }] }] };
      const refused3 = write(notFunnel, 'not-a-funnel');
      ok('a preset insight refuses a snapshot that is not a funnel set', refused3.code === 1 && sha(dataFile) === before, `${refused3.code} ${refused3.out.slice(0, 300)}`);

      const check = run(['lab', 'data', 'check', FULL, '--json']);
      let parsed = null;
      try { parsed = JSON.parse(check.out); } catch { /* reported below */ }
      ok('lab data check: ok, 3 funnels, the window, stored bytes under 400 000, no notice',
        check.code === 0 && parsed?.ok === true && parsed.summary?.funnels === 3 && parsed.summary?.window?.from === fx.window.from
          && parsed.summary?.storedBytes < 400_000 && parsed.notices.length === 0, check.out.slice(0, 600));
      const cache = JSON.parse(readFileSync(join(LAB, 'cache', `${FULL}.json`), 'utf-8'));
      ok('the synced cache covers the snapshot window, not the 30-day default',
        cache.funnel?.range?.fromISO === fx.window.from && cache.funnel?.range?.toISO === fx.window.to, JSON.stringify(cache.funnel?.range));

      // The Turkish card: the same snapshot, created with --locale tr (the card speaks Turkish, the dashboard stays English).
      const trCreated = run(['lab', 'create', FULL_TR, '--title', 'Acme mağaza hunileri', '--category', 'Acme Funnels', '--preset', 'funnel-explorer', '--locale', 'tr']);
      const trFm = matter(readFileSync(join(LAB, 'insights', `${FULL_TR}.md`), 'utf-8')).data;
      ok('lab create --preset funnel-explorer --locale tr writes locale: tr into the manifest', trCreated.code === 0 && trFm.locale === 'tr', `${trCreated.out.slice(0, 300)} ${JSON.stringify(trFm.locale)}`);
      const trFile = join(SCRATCH, 'full-tr.json');
      writeFileSync(trFile, JSON.stringify(full));
      const wroteTr = run(['lab', 'data', 'write', FULL_TR, '--file', trFile]);
      ok('lab data write accepts the snapshot for the Turkish card', wroteTr.code === 0, wroteTr.out.slice(0, 400));

      // The bare insight, for the empty states and the hidden Access tab.
      dc(['lab', 'create', BARE, '--title', 'Acme bare funnels', '--category', 'Acme Bare', '--preset', 'funnel-explorer']);
      const bareFile = join(SCRATCH, 'bare.json');
      writeFileSync(bareFile, JSON.stringify(bare));
      const wroteBare = run(['lab', 'data', 'write', BARE, '--file', bareFile]);
      ok('lab data write accepts the bare snapshot', wroteBare.code === 0, wroteBare.out.slice(0, 400));
    });

    // ── 2. Derived board + `lab board show` (the fixture's own numbers) ─────────
    await section('cli: derived board and board show', async () => {
      const list = JSON.parse(dc(['lab', 'board', 'list', '--json']));
      const board = list.boards.find((b) => b.slug === FULL_BOARD);
      ok('the category board derives (nothing materialized)', !!board && list.derived === true, JSON.stringify(list.boards.map((b) => b.slug)));
      const view = JSON.parse(dc(['lab', 'board', 'show', FULL_BOARD, '--select', 'country=US', '--json']));
      const card = view.cards.find((c) => c.id === cardIdOf(FULL));
      ok('the derived board carries the 12x18 explorer card', !!card && card.at.w === 12 && card.at.h === 18, JSON.stringify(card?.at));
      const tabOf = (label) => card?.blocks.find((b) => b.tab === label)?.explorer ?? null;
      const tabsSeen = [...new Set((card?.blocks ?? []).map((b) => b.tab).filter(Boolean))];
      ok('the explorer card has every page and one tab per axis', JSON.stringify(tabsSeen) === JSON.stringify(FULL_TABS.map((k) => TAB_LABELS[k].en)), JSON.stringify(tabsSeen));

      const us = exactPath('quiz-v3', { country: 'US' });
      const steps = tabOf('Steps');
      const want = fixtureDrops(us.steps.map((s) => ({ ...s, measured: true })));
      ok("board show --select country=US: the Steps page prints the US path's own users",
        JSON.stringify((steps?.slice?.steps ?? []).map((s) => [s.key, s.users])) === JSON.stringify(us.steps.map((s) => [s.key, s.users])),
        JSON.stringify(steps?.slice?.steps));
      ok('board show: the worst drop is the one the fixture computes', steps?.drops?.find((d) => d.worst)?.key === want.worst, `${JSON.stringify(steps?.drops)} want ${want.worst}`);
      ok('board show: derived steps print their basis', (steps?.drops ?? []).filter((d) => d.basis === 'derived').map((d) => d.key).join(',') === 'page2,lead,finish', JSON.stringify(steps?.drops));
      const bench = tabOf('Benchmark');
      ok('board show: the Benchmark rows follow the ladder stages in order',
        JSON.stringify((bench?.rows ?? []).map((r) => r.key)) === JSON.stringify(fx.ladder.stages.map((s) => s.metric)), JSON.stringify(bench?.rows?.map((r) => r.key)));
      ok('board show: every ladder row says which source won the floor and the target',
        (bench?.rows ?? []).filter((r) => r.floor !== null).every((r) => r.floorFrom === 'book' || r.floorFrom === 'own'), JSON.stringify(bench?.rows?.map((r) => [r.key, r.floorFrom, r.targetFrom])));
      const pay = tabOf('Payment')?.payment;
      const usCell = fxFunnel('quiz-v3').payment.cells.find((c) => c.dims.country === 'US' && c.cohort === 'first');
      ok("board show: Payment reads the US cell's own attempts and declines",
        pay?.current?.attempts === usCell.attempts && pay?.current?.declines === usCell.declines, JSON.stringify(pay?.current));
      ok('board show: Access is shown on the full snapshot', tabOf('Access')?.hidden === false, JSON.stringify(tabOf('Access')));
      const head = card?.blocks.find((b) => b.type === 'breakdown')?.explorer?.header;
      ok('board show: the header notes are ordered funnel traps, set traps, info',
        JSON.stringify((head?.notes ?? []).map((n) => n.code)) === JSON.stringify(['T1', 'T2', 'S1', 'I1', 'I2', 'I3']), JSON.stringify(head?.notes?.map((n) => n.code)));
      ok('board show: the header carries the window and the source', head?.window?.from === fx.window.from && /synthetic/i.test(head?.provenance?.source ?? ''), JSON.stringify(head));

      const trial = JSON.parse(dc(['lab', 'board', 'show', FULL_BOARD, '--funnel', 'trial-start', '--json']));
      const trialSteps = trial.cards.find((c) => c.id === cardIdOf(FULL))?.blocks.find((b) => b.tab === 'Steps')?.explorer;
      const lead = trialSteps?.drops?.find((d) => d.key === 'lead');
      ok('board show --funnel trial-start: the unmeasured Lead step has no drop and no users', trialSteps?.funnelId === 'trial-start' && lead?.measured === false && lead?.dropPct === null,
        JSON.stringify(trialSteps?.drops));
      const plain = JSON.parse(dc(['lab', 'board', 'show', FULL_BOARD, '--json']));
      const first = plain.cards.find((c) => c.id === cardIdOf(FULL))?.blocks.find((b) => b.tab === 'Steps')?.explorer;
      ok('board show without --funnel answers the first funnel in payload order', first?.funnelId === fx.funnels[0].id, String(first?.funnelId));
    });
  }

  // ── The dashboard ───────────────────────────────────────────────────────────
  const taken = await fetch(`${BASE}/api/lab`).then(() => true, () => false);
  if (taken) throw new Error(`port ${PORT} is already serving something; stop it first (lsof -nP -iTCP:${PORT})`);
  const server = spawn('node', [CLI, 'dashboard', '--no-open', '-p', String(PORT)], {
    cwd: PROJ, env: { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore',
  });
  let browser;
  const shotsTaken = new Map();
  try {
    await until(() => fetch(`${BASE}/api/lab`).then((r) => r.ok, () => false), 30000, 250);
    browser = await webkit.launch();
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    sectionPage = page;
    await page.addLocatorHandler(page.locator('.announcements-modal-scrim'), async () => {
      const gotIt = page.getByRole('button', { name: /^got it$/i });
      if (await gotIt.count()) await gotIt.first().click();
      else await page.keyboard.press('Escape');
    });

    const setTheme = async (t) => {
      await page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);
      await sleep(250);
    };
    /** Open a board by its address; when a direct load does not land on it, through the Insights page and the board route. */
    const gotoBoard = async (slug) => {
      const board = page.locator(`[data-lab-board="${slug}"]`);
      await page.goto(`${BASE}/lab/b/${encodeURIComponent(slug)}?vault=proj`, { waitUntil: 'domcontentloaded' });
      if (!(await board.waitFor({ timeout: 12000 }).then(() => true, () => false))) {
        await page.goto(`${BASE}/?vault=proj`, { waitUntil: 'domcontentloaded' });
        await page.locator('.sidebar-item').first().waitFor();
        await page.locator('.sidebar-item[title^="Insights"]').first().click();
        await page.locator('[data-lab-board]').first().waitFor({ timeout: 20000 });
        await page.evaluate((b) => {
          window.history.pushState(null, '', `/lab/b/${encodeURIComponent(b)}${window.location.search}`);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, slug);
        await board.waitFor({ timeout: 15000 });
      }
      await sleep(900);
    };
    const card = (id) => page.locator(`[data-lab-card="${id}"]`).first();
    const tabBtn = (scope, key) => scope.locator(`[data-lab-tab-key="${key}"]`).first();
    const openTab = async (scope, key) => {
      await tabBtn(scope, key).click();
      await sleep(450);
    };
    const read = (loc) => loc.evaluate(explorerInPage);
    const pickFunnel = async (scope, id) => {
      await scope.locator('[data-lab-funnel-picker]').first().selectOption(id);
      await sleep(450);
    };
    /**
     * Set the card's selection to exactly `sel`: through the chips, or (the compact form a card
     * whose header takes its share draws) through one select per dimension.
     */
    const selectChips = async (scope, sel) => {
      if (await scope.locator('[data-lab-breakdown-all]').count()) {
        await scope.locator('[data-lab-breakdown-all]').first().click();
        await sleep(200);
        for (const [dim, value] of Object.entries(sel)) {
          await scope.locator(`[data-lab-breakdown-dim="${dim}"] [data-lab-breakdown-chip="${value}"]`).first().click();
          await sleep(250);
        }
        return;
      }
      const selects = scope.locator('[data-lab-breakdown-select]');
      for (let i = 0; i < await selects.count(); i++) {
        const dim = await selects.nth(i).getAttribute('data-lab-breakdown-select');
        await selects.nth(i).selectOption(sel[dim] ?? '');
        await sleep(250);
      }
    };
    const shotName = (loc, theme, key) => `${loc}-${theme}-${key.replace(/\./g, '-')}.png`;
    const saveShot = async (loc, name) => {
      await loc.screenshot({ path: join(SHOTS, name) });
      if (SHOTS_OUT) {
        mkdirSync(SHOTS_OUT, { recursive: true });
        copyFileSync(join(SHOTS, name), join(SHOTS_OUT, name));
      }
      shotsTaken.set(name, true);
    };

    // The board and the cards under test. A card speaks its own locale (`data-lab-card-locale`, the
    // preset's `locale`), whatever the dashboard's language: the dashboard stays English throughout.
    const boardSlug = FROM_VAULT ? BOARD_ARG : FULL_BOARD;
    if (FROM_VAULT && !boardSlug) throw new Error('--from-vault needs --board=<slug>');
    await gotoBoard(boardSlug);
    const cardId = FROM_VAULT
      ? await page.locator('[data-lab-card]:has([data-lab-explorer-header])').first().getAttribute('data-lab-card')
      : cardIdOf(FULL);
    ok('the board shows the explorer card (native, with its header)', !!cardId && await card(cardId).locator('[data-lab-explorer-header]').count() === 1, String(cardId));
    const ex = card(cardId);
    const localeOf = async (loc) => (await loc.locator('[data-lab-card-locale]').first().getAttribute('data-lab-card-locale').catch(() => null)) ?? 'en';
    /** [card id, the locale it must speak]: the English and the Turkish fixture card, or the vault's card in its own locale. */
    const walkCards = FROM_VAULT ? [[cardId, await localeOf(ex)]] : [[cardIdOf(FULL), 'en'], [cardIdOf(FULL_TR), 'tr']];
    if (!FROM_VAULT) {
      ok('the --locale tr card carries data-lab-card-locale="tr", the default card "en"',
        await localeOf(card(cardIdOf(FULL_TR))) === 'tr' && await localeOf(ex) === 'en', `${await localeOf(card(cardIdOf(FULL_TR)))} / ${await localeOf(ex)}`);
    }

    // ── 3. Every tab, light and dark, in each card's language ─────────────────
    await section('ui: every tab, both themes, both languages', async () => {
      const paint = {};
      await gotoBoard(boardSlug);
      ok('the dashboard itself stays English (the card scopes its own language)', await page.locator('.sidebar-item[title^="Insights"]').count() > 0);
      for (const [id, loc] of walkCards) {
        const c = card(id);
        for (const theme of THEMES) {
          await setTheme(theme);
          await c.scrollIntoViewIfNeeded();
          const st = await read(c);
          paint[`${loc}:${theme}`] = await c.evaluate(paintInPage);
          const keys = st.tabs.map((t) => t.key);
          if (!FROM_VAULT) ok(`tabs in order, Access shown on the full snapshot (${loc}, ${theme})`, JSON.stringify(keys) === JSON.stringify(FULL_TABS), JSON.stringify(keys));
          const wrongLabels = st.tabs.filter((t) => TAB_LABELS[t.key] && t.label !== TAB_LABELS[t.key][loc]).map((t) => `${t.key}="${t.label}"`);
          ok(`every tab label is in ${loc} (${theme})`, st.tabs.length > 0 && wrongLabels.length === 0, wrongLabels.join(', '));
          if (loc === 'tr' && st.windowText) {
            ok(`the header speaks Turkish on the tr card (${theme})`, /arası/.test(st.windowText), st.windowText);
          }
          for (const { key } of st.tabs) {
            if (!key) continue;
            await openTab(c, key);
            const m = await read(c);
            const empty = m.empties.find((e) => e.text);
            let drew;
            if (key === 'daily') drew = m.trend || !!empty;
            else if (key === 'benchmark') drew = m.bench.length > 0 || !!empty;
            else if (key === 'ranking') drew = m.ranking.length > 0 || !!empty;
            else if (key === 'flow') drew = m.flow;
            else if (key === 'steps') drew = m.steps.length > 0;
            else if (key === 'compare') drew = m.lanesDrawn || !!empty;
            else if (key === 'payment') drew = !!m.payment && (m.payment.rate !== null || !!empty);
            else if (key === 'access') drew = m.access.length > 0;
            else drew = m.segments.length > 0 || !!empty;
            ok(`the ${key} tab draws its page or says what is missing (${loc}, ${theme})`, drew, JSON.stringify({ ...m, bodyText: m.bodyText?.slice(0, 200) }).slice(0, 700));
            if (key === 'steps' && m.steps.length > 0) {
              const derived = m.steps.filter((s) => s.basis === 'derived');
              ok(`steps: derived steps are labelled (${loc}, ${theme})`, FROM_VAULT ? true : derived.length === 3 && derived.every((s) => WORDS[loc].derived.test(s.text)),
                JSON.stringify(m.steps.map((s) => [s.key, s.basis, s.text])));
              ok(`steps: exactly one worst drop is marked (${loc}, ${theme})`, m.steps.filter((s) => s.worst).length === 1, JSON.stringify(m.steps.map((s) => [s.key, s.worst])));
            }
            await saveShot(c, shotName(loc, theme, key));
          }
          await openTab(c, 'daily');
        }
        ok(`the explorer repaints between light and dark (${loc})`, paint[`${loc}:light`] !== paint[`${loc}:dark`], `${paint[`${loc}:light`]} vs ${paint[`${loc}:dark`]}`);
      }
      await setTheme('light');
    });

    if (!FROM_VAULT) {
      // ── Honesty markers on the fixture's deliberate cases, on both cards ──────
      await section('ui: honesty markers', async () => {
        await gotoBoard(FULL_BOARD);
        for (const [id, loc] of walkCards) {
          const c = card(id);
          await c.scrollIntoViewIfNeeded();
          // The trial funnel's Lead step is not measured: its reason, never a 0.
          await pickFunnel(c, 'trial-start');
          await openTab(c, 'steps');
          let m = await read(c);
          const lead = m.steps.find((s) => s.key === 'lead');
          ok(`an unmeasured step reads "not measured", never 0 (${loc})`, !!lead && lead.measured === false && lead.users === null && WORDS[loc].notMeasured.test(lead.text) && !/(^|\s)0(\s|$)/.test(lead.text),
            JSON.stringify(lead));
          ok(`the worst drop skips the unmeasured step (${loc})`, m.steps.find((s) => s.worst)?.key !== 'lead', JSON.stringify(m.steps.map((s) => [s.key, s.worst])));
          // gift-card x PT: under 100 users, shown as k/n and faded.
          await pickFunnel(c, 'gift-card');
          await openTab(c, 'dim.language');
          m = await read(c);
          const pt = m.segments.find((r) => r.value === 'PT');
          ok(`a path under 100 users shows k/n and is faded (${loc})`, !!pt && pt.kn.length > 0 && pt.low, JSON.stringify(pt));
          // gift-card has no ad spend: its ROAS column is carried by no row, said once.
          ok(`a column no row carries collapses into one note with the hint (${loc})`, m.empties.some((e) => e.part === 'column'), JSON.stringify(m.empties));
          // Payment: the funnel without a split shows all funnels; a k/n cell; a clipped cell.
          await openTab(c, 'payment');
          m = await read(c);
          ok(`payment: a funnel without payment shows the all-funnels figures (${loc})`, m.payment?.setScope === true || m.payment?.scope === 'set', JSON.stringify(m.payment));
          await pickFunnel(c, 'quiz-v3');
          await selectChips(c, { country: 'GB' });
          m = await read(c);
          ok(`payment: under 100 attempts the rate reads k/n (${loc})`, !!m.payment?.kn, JSON.stringify(m.payment));
          await selectChips(c, { country: 'FR' });
          m = await read(c);
          ok(`payment: reasons above the declines show the clipped warning (${loc})`, m.payment?.clipped === true, JSON.stringify(m.payment));
          await selectChips(c, {});
          m = await read(c);
          // The three named reasons, then the residual ("other or unnamed") the engine adds.
          const named = (m.payment?.reasons ?? []).filter((r) => r !== 'other');
          ok(`payment: the total cell, two cohorts, every named reason (${loc})`, !!m.payment?.rate && m.payment.cohorts === 2
            && JSON.stringify(named) === JSON.stringify(fx.payment_reasons.map((r) => r.key)), JSON.stringify(m.payment));
          // Access: the rows of the picked funnel; the gift-card row is under 100 paid users, shown as k/n.
          await openTab(c, 'access');
          m = await read(c);
          ok(`access: the picked funnel's row and the all-traffic rows, with shares (${loc})`, m.access.length >= 2 && m.access.some((r) => r.row === 'quiz-v3'), JSON.stringify(m.access));
          await pickFunnel(c, 'gift-card');
          m = await read(c);
          ok(`access: under 100 paid users the shares read k/n (${loc})`, m.access.some((r) => r.row === 'gift-card' && r.kn.length > 0), JSON.stringify(m.access));
          await pickFunnel(c, 'quiz-v3');
          // Ranking: one row per funnel with a path over the default floor of 300.
          await openTab(c, 'ranking');
          m = await read(c);
          ok(`ranking: the default floor is 300 and each row is a funnel's best path (${loc})`,
            m.rankingFloor === '300' && m.ranking.length >= 2 && m.ranking.every((r) => fx.funnels.some((f) => f.id === r.funnel) && Number.isFinite(r.value)), JSON.stringify(m.ranking));
          await openTab(c, 'daily');
        }
      });

      // ── 4. Access hidden on the bare snapshot ──────────────────────────────────
      await section('ui: access hidden without data', async () => {
        await gotoBoard(BARE_BOARD);
        const bareCard = card(cardIdOf(BARE));
        const st = await read(bareCard);
        ok('the bare snapshot hides the Access tab (no data, never zeros)', st.tabs.length > 0 && !st.tabs.some((t) => t.key === 'access'), JSON.stringify(st.tabs.map((t) => t.key)));
        await gotoBoard(FULL_BOARD);
        ok('the full snapshot shows the Access tab', (await read(ex)).tabs.some((t) => t.key === 'access'));
      });

      // ── 5. Empty states and their hints ────────────────────────────────────────
      await section('ui: empty states', async () => {
        await gotoBoard(BARE_BOARD);
        const bareCard = card(cardIdOf(BARE));
        await openTab(bareCard, 'daily');
        let m = await read(bareCard);
        const daily = m.empties.find((e) => e.part === 'daily');
        ok('Daily without daily: names the missing part and shows the snapshot hint', !!daily && /daily/i.test(daily.text) && (daily.hint ?? '').includes(bare.data.hints.daily), JSON.stringify(m.empties));
        await openTab(bareCard, 'payment');
        m = await read(bareCard);
        const pay = m.empties.find((e) => e.part === 'payment');
        ok('Payment without payment: names the missing part and shows the hint', !!pay && /payment/i.test(pay.text) && (pay.hint ?? '').includes(bare.data.hints.payment), JSON.stringify(m.empties));
        ok('Payment without payment draws no 0% rate', !m.payment?.rate, JSON.stringify(m.payment));
        await gotoBoard(FULL_BOARD);
        await selectChips(ex, { country: 'US' });
        await openTab(ex, 'daily');
        m = await read(ex);
        ok('Daily for a path without its own series says the funnel level carries daily', m.empties.some((e) => e.part === 'daily'), JSON.stringify(m.empties));
        await selectChips(ex, {});
        await openTab(ex, 'compare');
        m = await read(ex);
        ok('Compare with no lane pinned says how to pin, draws no lanes', !m.lanesDrawn && /pin/i.test(m.empties.map((e) => e.text).join(' ') + m.bodyText), JSON.stringify(m.empties));
        await openTab(ex, 'daily');
      });

      // ── 6. Deep link ───────────────────────────────────────────────────────────
      await section('ui: deep link', async () => {
        await gotoBoard(FULL_BOARD);
        await pickFunnel(ex, 'trial-start');
        await selectChips(ex, { country: 'US' });
        await ex.locator('[data-lab-lane-pin]').first().click();
        await sleep(300);
        await selectChips(ex, { country: 'DE' });
        await ex.locator('[data-lab-lane-pin]').first().click();
        await sleep(300);
        await openTab(ex, 'compare');
        const want = await read(ex);
        const stateOf = (m) => ({ funnel: m.funnel, chips: m.chips, lanes: m.lanes, tab: m.tabs.find((t) => t.selected)?.key ?? null });
        ok('deep link precondition: funnel, chip, 2 lanes and the Compare tab are set', want.funnel === 'trial-start' && want.lanes === 2 && stateOf(want).tab === 'compare',
          JSON.stringify(stateOf(want)));
        const url = new URL(page.url());
        ok('the card view lives in the URL (v.<cardId>)', url.searchParams.has(`v.${cardId}`), page.url());
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator(`[data-lab-board="${FULL_BOARD}"]`).waitFor({ timeout: 20000 });
        await sleep(900);
        const afterReload = await read(ex);
        ok('a reload restores funnel, selection, lanes and tab', JSON.stringify(stateOf(afterReload)) === JSON.stringify(stateOf(want)), `${JSON.stringify(stateOf(afterReload))} want ${JSON.stringify(stateOf(want))}`);
        // Fullscreen, then reload inside it.
        await ex.locator('[data-lab-card-menu]').first().click();
        await page.locator('[data-lab-card-fullscreen="open"]').first().click();
        const ov = page.locator(`[data-lab-fullscreen="${cardId}"]`);
        await ov.waitFor({ timeout: 8000 });
        await sleep(500);
        ok('fullscreen shows the same view', JSON.stringify(stateOf(await read(ov))) === JSON.stringify(stateOf(want)));
        const fsUrl = page.url();
        ok('fullscreen adds ?card=<id> next to the view', new URL(fsUrl).searchParams.get('card') === cardId && new URL(fsUrl).searchParams.has(`v.${cardId}`), fsUrl);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ov.waitFor({ timeout: 20000 }).catch(() => {});
        await sleep(900);
        ok('a reload in fullscreen reopens the card with the same view', await ov.count() === 1 && JSON.stringify(stateOf(await read(ov))) === JSON.stringify(stateOf(want)),
          await ov.count() === 1 ? JSON.stringify(stateOf(await read(ov))) : 'no overlay');
        // The copied URL in a fresh page.
        const other = await context.newPage();
        await other.goto(fsUrl, { waitUntil: 'domcontentloaded' });
        const ov2 = other.locator(`[data-lab-fullscreen="${cardId}"]`);
        await ov2.waitFor({ timeout: 20000 }).catch(() => {});
        await sleep(900);
        ok('the copied URL opens the same view in a new page', await ov2.count() === 1 && JSON.stringify(stateOf(await ov2.evaluate(explorerInPage))) === JSON.stringify(stateOf(want)));
        await other.close();
        if (await page.locator('[data-lab-card-exit]').count()) await page.locator('[data-lab-card-exit]').first().click();
        await sleep(400);
        if (await ex.locator('[data-lab-lanes-clear]').count()) await ex.locator('[data-lab-lanes-clear]').first().click();
        await selectChips(ex, {});
        await pickFunnel(ex, fx.funnels[0].id);
        await openTab(ex, 'daily');
      });
    }

    // ── 7. Notes: every funnel trap among the first 4 lines, in reading order ───
    await section('ui: notes order and visibility', async () => {
      await gotoBoard(boardSlug);
      const ids = (await read(ex)).funnelOptions;
      const rank = (n) => (n.level === 'trap' ? (n.scope === 'funnel' ? 0 : 1) : n.scope === 'funnel' ? 2 : 3);
      for (const id of ids) {
        await pickFunnel(ex, id);
        const m = await read(ex);
        // What the funnel's traps are: the fixture's, or (on a real vault) the CLI's own header for that funnel.
        let traps;
        if (FROM_VAULT) {
          const v = JSON.parse(dc(['lab', 'board', 'show', boardSlug, '--funnel', id, '--json']));
          const head = v.cards.find((c) => c.id === cardId)?.blocks.find((b) => b.type === 'breakdown')?.explorer?.header;
          traps = (head?.notes ?? []).filter((n) => n.scope === 'funnel' && n.level === 'trap').map((n) => n.code ?? n.text);
        } else {
          traps = (fxFunnel(id).notes ?? []).filter((n) => n.level !== 'info').map((n) => n.code);
        }
        const shown = m.notes.slice(0, 4);
        const missing = traps.filter((t) => !shown.some((n) => n.code === t || n.text?.includes(t)));
        ok(`notes: every trap of ${id} is among the first 4 visible lines`, missing.length === 0, `missing ${missing.join(', ')}; shown ${JSON.stringify(shown.map((n) => n.code))}`);
        const ranks = m.notes.map(rank);
        ok(`notes: ${id} reads funnel traps, set traps, then info`, ranks.every((r, i) => i === 0 || ranks[i - 1] <= r), JSON.stringify(m.notes.map((n) => [n.code, n.scope, n.level])));
        ok(`notes: at most 4 lines visible for ${id}, the rest behind "+N"`, m.notes.length <= 4, JSON.stringify(m.notes.map((n) => n.code)));
      }
      await pickFunnel(ex, ids[0]);
    });

    // ── 8. CLI / DOM parity on Steps and Benchmark ─────────────────────────────
    if (!FROM_VAULT || PARITY) {
      await section('cli/dom parity', async () => {
        const sel = FROM_VAULT ? parseSelect(SELECT_ARG) : { country: 'US' };
        const funnel = FROM_VAULT ? FUNNEL_ARG : null;
        await gotoBoard(boardSlug);
        const parityLoc = await localeOf(ex);
        if (funnel) await pickFunnel(ex, funnel);
        await selectChips(ex, sel);
        await openTab(ex, 'steps');
        const dom = await read(ex);
        await openTab(ex, 'benchmark');
        const domBench = (await read(ex)).bench;
        const selArg = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(',');
        const args = ['lab', 'board', 'show', boardSlug, '--json', ...(selArg ? ['--select', selArg] : []), ...(funnel ? ['--funnel', funnel] : [])];
        const view = JSON.parse(dc(args));
        const blocks = view.cards.find((c) => c.id === cardId)?.blocks ?? [];
        const steps = blocks.find((b) => b.type === 'funnel' && b.explorer?.drops && b.tab === 'Steps')?.explorer
          ?? blocks.find((b) => b.type === 'funnel' && b.explorer?.drops)?.explorer;
        const cliPairs = (steps?.slice?.steps ?? []).map((s) => [s.key, s.measured === false ? null : s.users]);
        const domPairs = dom.steps.map((s) => [s.key, s.users]);
        ok(`parity: Steps users under ${selArg || 'all traffic'} equal the CLI`, cliPairs.length > 0 && JSON.stringify(cliPairs) === JSON.stringify(domPairs), `${JSON.stringify(cliPairs)} vs ${JSON.stringify(domPairs)}`);
        const cliWorst = steps?.drops?.find((d) => d.worst);
        const domWorst = dom.steps.find((s) => s.worst);
        ok('parity: the worst drop is the same step, the same percent', !!cliWorst && cliWorst.key === domWorst?.key
          && (domWorst?.dropPct === null || Math.abs(domWorst.dropPct - cliWorst.dropPct) < 0.06),
          `${cliWorst?.key} ${cliWorst?.dropPct} vs ${domWorst?.key} ${domWorst?.dropPct}`);
        if (cliWorst) console.log(`parity: worst drop ${cliWorst.key} ${cliWorst.dropPct?.toFixed(1)}% under ${selArg || 'all traffic'}${funnel ? ` (${funnel})` : ''}`);
        const bench = blocks.find((b) => b.type === 'benchmark')?.explorer?.rows ?? [];
        const benchBad = bench.filter((r) => {
          const d = domBench.find((x) => x.key === r.key);
          if (!d || d.status !== r.status) return true;
          return r.current === null ? false : !shownEquals(d.value, r.current, parityLoc);
        }).map((r) => r.key);
        ok('parity: Benchmark rows, status and figures equal the CLI', bench.length > 0 && bench.length === domBench.length && benchBad.length === 0,
          `bad ${benchBad.join(',')}; cli ${JSON.stringify(bench.map((r) => [r.key, r.status, r.current]))} dom ${JSON.stringify(domBench.map((r) => [r.key, r.status, r.value]))}`);
        if (!FROM_VAULT) {
          const us = exactPath('quiz-v3', { country: 'US' });
          ok("parity: the DOM's US path is the fixture's own path", JSON.stringify(domPairs) === JSON.stringify(us.steps.map((s) => [s.key, s.users])), JSON.stringify(domPairs));
        }
        await selectChips(ex, {});
        await openTab(ex, 'daily');
      });
    }

    // ── A thin path, visible: a low-sample (faded) row whose rates read k/n ─────
    await section('ui: thin path shot (low sample, k/n)', async () => {
      await gotoBoard(boardSlug);
      const [, loc] = walkCards[0];
      const c = card(walkCards[0][0]);
      const funnels = (await read(c)).funnelOptions;
      const axes = (await read(c)).tabs.map((t) => t.key).filter((k) => k && k.startsWith('dim.'));
      let found = null;
      // The default funnel first: a reader opening the card should meet the honesty rules without searching.
      search: for (const id of funnels) {
        await pickFunnel(c, id);
        for (const key of axes) {
          await openTab(c, key);
          const rows = (await read(c)).segments;
          const both = rows.find((r) => r.low && r.kn.length > 0);
          if (both) { found = { id, key, row: both.value, kn: both.kn }; break search; }
        }
      }
      ok('a thin path (faded row, rates as k/n) is on screen in one shot', !!found, `searched ${funnels.length} funnels x ${axes.length} axes`);
      if (found) {
        console.log(`thin path: funnel ${found.id}, ${found.key}, row ${found.row}, k/n ${found.kn.join(' ')}`);
        if (!FROM_VAULT) ok('the default funnel shows the thin path (no search needed)', found.id === funnels[0], JSON.stringify(found));
        for (const theme of THEMES) {
          await setTheme(theme);
          await c.locator(`[data-lab-segment-row="${found.row}"]`).first().scrollIntoViewIfNeeded().catch(() => {});
          await saveShot(c, `${loc}-${theme}-thin-${found.id}-${found.key.replace(/\./g, '-')}.png`);
        }
        await setTheme('light');
      }
      await pickFunnel(c, funnels[0]);
      await openTab(c, 'daily');
    });

    // ── The comparison sheet ────────────────────────────────────────────────────
    if (COMPARE_DIR) {
      await section('compare sheet', async () => {
        const out = SHOTS_OUT ?? SHOTS;
        mkdirSync(out, { recursive: true });
        const refs = existsSync(COMPARE_DIR) ? readdirSync(COMPARE_DIR).filter((f) => f.toLowerCase().endsWith('.png')) : [];
        // One reference SET: every file `<prefix>-<page>.png` grouped by prefix. A page is paired only with
        // its own file of the chosen set, never with another set's screenshot that merely ends in `-<page>.png`.
        const sets = new Map();
        for (const f of refs) {
          for (const [page] of REF_PAGES) {
            const tail = `-${page}.png`;
            if (!f.endsWith(tail)) continue;
            const prefix = f.slice(0, -tail.length);
            if (!sets.has(prefix)) sets.set(prefix, new Map());
            sets.get(prefix).set(page, f);
          }
        }
        const complete = [...sets.entries()].filter(([, m]) => m.size === REF_PAGES.length).map(([prefix]) => prefix).sort();
        const prefix = COMPARE_PREFIX ?? complete[0] ?? null;
        const chosen = prefix ? sets.get(prefix) ?? new Map() : new Map();
        console.log(`comparison: reference set "${prefix ?? 'none'}" (${chosen.size} of ${REF_PAGES.length} pages); complete sets: ${complete.length}`);
        ok('the reference set has every page (exact <prefix>-<page>.png per page)', chosen.size === REF_PAGES.length,
          `set ${prefix}: ${[...chosen.keys()].join(', ')}; complete sets ${complete.length}`);
        const rows = [];
        for (const [ref, key] of REF_PAGES) {
          const refFile = chosen.get(ref) ?? null;
          const refCopy = refFile ? `ref-${ref}.png` : null;
          if (refFile) copyFileSync(join(COMPARE_DIR, refFile), join(out, refCopy));
          const ours = [];
          for (const loc of LOCALES) for (const theme of THEMES) {
            const name = shotName(loc, theme, key);
            if (shotsTaken.has(name) && !existsSync(join(out, name))) copyFileSync(join(SHOTS, name), join(out, name));
            ours.push({ label: `${loc.toUpperCase()} ${theme}`, file: shotsTaken.has(name) ? name : null });
          }
          rows.push({ ref, key, refCopy, ours });
        }
        const cell = (file, label) => (file
          ? `<figure><img src="${file}" alt="${label}"><figcaption>${label}</figcaption></figure>`
          : `<figure class="none"><div>not drawn (hidden: no data)</div><figcaption>${label}</figcaption></figure>`);
        const block = (r) => `<section><h2>${r.ref} vs ${r.key}</h2><div class="row">${cell(r.refCopy, 'reference')}${r.ours.map((o) => cell(o.file, o.label)).join('')}</div></section>`;
        const css = 'body{font:14px system-ui;margin:24px;background:#f4f4f5}section{margin-bottom:32px}.row{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;align-items:start}'
          + 'figure{margin:0;background:#fff;padding:6px;border-radius:6px}img{width:100%;display:block}figcaption{padding-top:4px;color:#555}.none div{height:120px;display:grid;place-items:center;color:#888}';
        const html = (body) => `<!doctype html><meta charset="utf-8"><title>Funnel explorer vs reference</title><style>${css}</style>${body}`;
        // The thin-path shots (a faded, k/n row) close the sheet: the honesty rules the reference has no page for.
        const thin = [...shotsTaken.keys()].filter((n) => n.includes('-thin-'));
        for (const n of thin) if (!existsSync(join(out, n))) copyFileSync(join(SHOTS, n), join(out, n));
        const thinBlock = thin.length > 0
          ? `<section><h2>thin path: low sample faded, k/n under 100</h2><div class="row">${thin.map((n) => cell(n, n.replace(/\.png$/, ''))).join('')}</div></section>`
          : '';
        writeFileSync(join(out, 'side-by-side.html'), html(`<h1>Funnel explorer vs reference (${prefix ?? 'no reference set'})</h1>${rows.map(block).join('')}${thinBlock}`));
        for (const r of rows) {
          const file = join(out, `side-by-side-${r.ref}.html`);
          writeFileSync(file, html(block(r)));
          await page.goto(pathToFileURL(file).href);
          await sleep(300);
          await page.screenshot({ path: join(out, `side-by-side-${r.ref}.png`), fullPage: true });
          rmSync(file);
        }
        ok('the comparison sheet pairs every reference page it found with our tabs',
          rows.filter((r) => r.refCopy).length > 0 && existsSync(join(out, 'side-by-side.html')),
          `references found: ${rows.filter((r) => r.refCopy).map((r) => r.ref).join(', ') || 'none'} in ${COMPARE_DIR}`);
        console.log(`comparison sheet: ${join(out, 'side-by-side.html')}`);
      });
    }
  } finally {
    if (browser) await browser.close();
    server.kill();
  }

  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`);
  console.log(`shots: ${SHOTS}${SHOTS_OUT ? ` (and ${SHOTS_OUT})` : ''}`);
  console.log(`sections run (${sectionsRan.length}): ${sectionsRan.join(' | ')}`);
  const fails = results.filter((r) => !r.pass);
  console.log(fails.length ? `${fails.length} FAILED of ${results.length}` : `all ${results.length} green`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
