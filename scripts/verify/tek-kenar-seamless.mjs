#!/usr/bin/env node
/**
 * Tek kenar çubuğu, AC4: a switch between projects is seamless. Seven fictional projects in a
 * scratch HOME; on Tasks, a click on another project's sidebar row. Chromium and WebKit.
 *
 * Per switch, every animation frame is sampled (the visible instance's project, page and item,
 * loading markers in the readiness region, a running agent-surface animation, the lit tab, the
 * sidebar mode, the clicked row's y, the focused element), and the window's gate log
 * (`window.__dcReveal`, set only by this probe) gives match/bound and the time to activation.
 *
 * Pass: 5 cold switches each within 1500 ms; 20 warm switches with 0 bound-fired; every frame
 * shows A until activation and B after; 0 frames with a loading marker or a running surface
 * animation after activation; the lit tab and sidebar mode change at most once; the clicked row's
 * y within ±1 px; focus never on body; no reload; A's scroll kept; no console errors.
 *
 *   dreamcontext builder heavy -- node scripts/verify/tek-kenar-seamless.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openApp } from './lib/app.mjs';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(new URL(import.meta.url).pathname), '..', '..');
// The selectors the gate itself reads (lib/revealGate.ts), so probe and gate never drift.
const gateSrc = readFileSync(join(REPO, 'dashboard', 'src', 'lib', 'revealGate.ts'), 'utf-8');
const sel = (name) => {
  const m = gateSrc.match(new RegExp(`export const ${name} = '([^']+)'`));
  if (!m) throw new Error(`revealGate.ts has no ${name}`);
  return m[1];
};
const SELECTORS = { region: sel('PAGE_REGION_SELECTOR'), surface: sel('AGENT_SURFACE_SELECTOR'), loading: sel('LOADING_SELECTOR') };

const PROJECTS = ['proj', 'pocket-ledger', 'northwind', 'orbit', 'lumen', 'harbor', 'quill'];
const COLD_MS = 1500;
const WARM = 20;

const app = await openApp({ suite: 'tek-kenar-seamless' });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k))), HOME: app.home, PATH: `${join(app.home, '.local', 'bin')}:${process.env.PATH}` };
for (const name of PROJECTS.slice(1)) {
  const dir = join(dirname(app.proj), name);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  const r = spawnSync('npx', ['--yes', 'tsx', join(REPO, 'src', 'cli', 'index.ts'), 'vaults', 'add', name, dir], { cwd: dir, env, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`register ${name}: ${r.stderr.slice(-200)}`);
}

/** Installed before the app: the gate log, a reload marker and a per-frame sampler. */
function probeInit(s) {
  window.__dcReveal = [];
  window.__dcFrames = null;
  const sample = () => {
    const frames = window.__dcFrames;
    if (frames) {
      const inst = document.querySelector('.project-instance[data-active]');
      const region = inst?.querySelector(window.__dcTarget === 'chat' ? s.surface : s.region) ?? null;
      const surface = inst?.querySelector(s.surface) ?? null;
      let anim = 0;
      if (surface && document.getAnimations) {
        for (const a of document.getAnimations()) {
          const t = a.effect && a.effect.target;
          const iters = a.effect && a.effect.getTiming ? a.effect.getTiming().iterations : 1;
          if (a.playState === 'running' && iters !== Infinity && t instanceof Node && surface.contains(t)) anim++;
        }
      }
      const row = window.__dcRowKey ? document.querySelector(`[data-row-key="${CSS.escape(window.__dcRowKey)}"]`) : null;
      const lit = document.querySelector('[data-testid^="ns-tab-"][data-on]');
      frames.push({
        t: performance.now(),
        vault: inst?.getAttribute('data-instance-vault') ?? null,
        page: inst?.getAttribute('data-page') ?? null,
        loading: (region ?? inst)?.querySelectorAll(s.loading).length ?? 0,
        anim,
        lit: lit?.getAttribute('data-testid') ?? null,
        mode: document.querySelector('[data-testid="chat-drawer"]')?.getAttribute('data-mode') ?? null,
        rowY: row ? Math.round(row.getBoundingClientRect().top * 10) / 10 : null,
        bodyFocus: document.activeElement === document.body,
      });
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

/** Counts the distinct runs of a field's non-null values: 2 = it changed once. */
const runs = (frames, key) => {
  let n = 0; let last;
  for (const f of frames) { if (f[key] == null) continue; if (f[key] !== last) { n++; last = f[key]; } }
  return n;
};

/** The frame shows the target: Chat lit for a Chat target, else the page. */
const shows = (f, target) => (target === 'chat' ? f.lit === 'ns-tab-chat' : f.page === target && f.lit !== 'ns-tab-chat');

async function oneSwitch(page, from, to, kind, label, target = 'tasks') {
  const key = `project:${to}`;
  const before = await page.evaluate(([k, t]) => { window.__dcRowKey = k; window.__dcTarget = t; window.__dcFrames = []; return window.__dcReveal.length; }, [key, target]);
  const t0 = Date.now();
  await page.locator(`[data-row-key="${key}"]`).first().click();
  // Activation, then a quiet 700 ms so a late loading marker or animation would be caught.
  await page.waitForFunction(([v, n]) => document.querySelector('.project-instance[data-active]')?.getAttribute('data-instance-vault') === v && window.__dcReveal.length > n,
    [to, before], { timeout: 8000, polling: 'raf' }).catch(() => app.findings.push(`${label}: ${to} never became active`));
  await page.waitForTimeout(700);
  const { frames, log } = await page.evaluate((n) => { const f = window.__dcFrames; window.__dcFrames = null; return { frames: f ?? [], log: window.__dcReveal.slice(n) }; }, before);
  const entry = log[log.length - 1] ?? null;
  const bad = [];
  if (!entry) bad.push('no gate entry');
  else {
    if (kind === 'warm' && entry.why === 'bound') bad.push(`warm bound-fired (${entry.ms} ms)`);
    if (kind === 'cold' && entry.ms > COLD_MS) bad.push(`cold ${entry.ms} ms > ${COLD_MS}`);
  }
  const at = entry?.at ?? Infinity;
  const pre = frames.filter((f) => f.t < at);
  const post = frames.filter((f) => f.t >= at);
  const wrongPre = pre.filter((f) => f.vault !== from || !shows(f, target)).length;
  const wrongPost = post.filter((f) => f.vault !== to || !shows(f, target)).length;
  if (wrongPre) bad.push(`${wrongPre} frames before activation not ${from} › ${target}`);
  if (wrongPost) bad.push(`${wrongPost} frames after activation not ${to} › ${target}`);
  const loadingPost = post.filter((f) => f.loading > 0).length;
  const animPost = post.filter((f) => f.anim > 0).length;
  if (loadingPost) bad.push(`${loadingPost} frames loading after activation`);
  if (animPost) bad.push(`${animPost} frames animating after activation`);
  if (runs(frames, 'lit') > 2) bad.push(`lit tab changed ${runs(frames, 'lit') - 1} times`);
  if (runs(frames, 'mode') > 2) bad.push(`sidebar mode changed ${runs(frames, 'mode') - 1} times`);
  const ys = frames.map((f) => f.rowY).filter((y) => y != null);
  if (ys.length && Math.max(...ys) - Math.min(...ys) > 1) bad.push(`row moved ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)} px`);
  const bodyFrames = frames.filter((f) => f.bodyFocus).length;
  if (bodyFrames) bad.push(`${bodyFrames} frames with focus on body`);
  for (const b of bad) app.findings.push(`${label}: ${b}`);
  return { label, kind, target, why: entry?.why ?? '-', ms: entry?.ms ?? Date.now() - t0, frames: frames.length, bad: bad.length };
}

const rows = [];
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await markAnnouncementsSeen(context, app.base);
  await context.addInitScript(probeInit, SELECTORS);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/\/@vite\/|favicon|\/ws\b|WebSocket/.test(m.text())) app.findings.push(`${engineName} console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => app.findings.push(`${engineName} crash: ${String(e.message).slice(0, 200)}`));
  let reloads = -1;
  page.on('load', () => { reloads++; });
  try {
    await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('chat-drawer').waitFor({ timeout: 60_000 });
    if (engineName === 'chromium') {
      // A few tasks in every project, so Tasks has a list to scroll and a landing to wait for.
      await page.evaluate(async (names) => {
        for (const v of names) for (let i = 1; i <= 30; i++) {
          await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': v }, body: JSON.stringify({ name: `${v} task ${i}`, why: 'Seeded for the seamless probe.' }) });
        }
      }, PROJECTS);
      await page.reload({ waitUntil: 'domcontentloaded' });
      reloads = 0;
      await page.getByTestId('chat-drawer').waitFor({ timeout: 60_000 });
    }
    await page.getByTestId('ns-tab-tasks').click();
    await page.waitForFunction(() => document.querySelector('.project-instance[data-active]')?.getAttribute('data-page') === 'tasks', null, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.__dcMarker = 'still-here'; });

    // A's scroll: Tasks' list scrolled down a little, read back after the round trip.
    const scrollOf = () => page.evaluate(() => {
      const inst = document.querySelector('.project-instance[data-active]');
      const el = [...(inst?.querySelectorAll('[data-region="page"] *') ?? [])].find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible');
      return el ? { top: el.scrollTop, set: (el.scrollTop = 160, el.scrollTop) } : null;
    });
    const scrolled = await scrollOf();

    // Cold: the first visit of five projects, from the one before.
    let from = 'proj';
    for (const to of PROJECTS.slice(1, 6)) {
      rows.push({ engine: engineName, ...(await oneSwitch(page, from, to, 'cold', `${engineName} cold ${from}→${to}`)) });
      from = to;
    }
    // Warm: back and forth among the visited ones, on Tasks, then Whiteboards, then Chat. Each
    // visited project is first put on the page once (not measured), so the switch carries it.
    const visited = PROJECTS.slice(0, 6);
    const plan = [['tasks', 7], ['whiteboards', 7], ['chat', WARM - 14]];
    let n = 0;
    for (const [target, count] of plan) {
      if (target !== 'tasks') {
        for (const v of [from, ...visited.filter((x) => x !== from)]) {
          if (v !== from) { await page.locator(`[data-row-key="project:${v}"]`).first().click(); await page.waitForTimeout(900); from = v; }
          await page.getByTestId(`ns-tab-${target}`).click();
          await page.waitForTimeout(1200);
        }
      }
      for (let i = 0; i < count; i++) {
        const to = visited[(visited.indexOf(from) + 1 + (i % 3)) % visited.length];
        n++;
        rows.push({ engine: engineName, ...(await oneSwitch(page, from, to, 'warm', `${engineName} warm#${n} ${target} ${from}→${to}`, target)) });
        from = to;
      }
      if (target === 'tasks') await scrollCheck();
    }
    /** Back on proj › Tasks: the list kept the scroll set before the first switch. */
    async function scrollCheck() {
      if (from !== 'proj') { rows.push({ engine: engineName, ...(await oneSwitch(page, from, 'proj', 'warm', `${engineName} back to proj`)) }); from = 'proj'; }
      if (scrolled) {
        const after = await page.evaluate(() => {
          const inst = document.querySelector('.project-instance[data-active]');
          const el = [...(inst?.querySelectorAll('[data-region="page"] *') ?? [])].find((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY !== 'visible');
          return el?.scrollTop ?? null;
        });
        if (after !== scrolled.set) app.findings.push(`${engineName}: A's scroll not kept (${scrolled.set} → ${after})`);
      } else app.findings.push(`${engineName}: no scrollable list on proj › tasks to check the scroll`);
    }
    if ((await page.evaluate(() => window.__dcMarker)) !== 'still-here' || reloads > 0) app.findings.push(`${engineName}: the page reloaded`);
  } catch (err) {
    app.findings.push(`${engineName} could not finish: ${err instanceof Error ? err.message : err}`);
  }
  await browser.close();
}

for (const r of rows) process.stdout.write(`${r.engine.padEnd(8)} ${r.kind.padEnd(4)} ${r.why.padEnd(5)} ${String(r.ms).padStart(5)} ms  ${String(r.frames).padStart(3)} frames  ${r.bad ? `✗ ${r.bad}` : '✓'}  ${r.label}\n`);
for (const e of ['chromium', 'webkit']) {
  const mine = rows.filter((r) => r.engine === e);
  const cold = mine.filter((r) => r.kind === 'cold');
  const warm = mine.filter((r) => r.kind === 'warm');
  process.stdout.write(`${e}: cold ${cold.length} max ${Math.max(0, ...cold.map((r) => r.ms))} ms · warm ${warm.length}, bound-fired ${warm.filter((r) => r.why === 'bound').length} · failing switches ${mine.filter((r) => r.bad).length}\n`);
}
process.exit(await app.finish());
