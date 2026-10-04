#!/usr/bin/env node
/**
 * "Çok takılıyor bu işlemlerde, çok daha smooth olmalı" — frame-time proof for the three
 * interactions that stuttered with two LONG chat panes side by side (owner, 10-04).
 *
 *   npm run build && npm run verify:chat-smooth
 *
 * THE REPORT (screen recording, desktop app = WKWebView): two panes, both long transcripts.
 * Frame-change gaps measured off the recording during the interactions: 66–116ms (target ~16).
 *   S  collapsing / expanding the left nav rail
 *   P  clicking the other pane (it takes the focus bonus — `.agent-pane.active` flex-basis)
 *   T  opening a "Thought it through" row
 *
 * WHAT IS MEASURED, per interaction, in the real app (real server, real bundle, real mouse):
 *   - per-rAF frame deltas sampled inside the page → worst frame, frames > 33ms
 *   - Chromium only, under CPU throttling (THROTTLE, default 4x): a devtools.timeline TRACE
 *     of the window → layout count, layout ms, the biggest single layout, style ms, the
 *     biggest style pass and the elements it touched. From the trace, not
 *     `Performance.getMetrics`: that reported ~20ms of layout for a pane switch whose one
 *     layout the trace showed at ~100ms.
 *   - WebKit too (Playwright's WebKit, the engine WKWebView ships): frame deltas only — it has
 *     no CDP — and no throttle, since it is the engine that stuttered in the first place
 *   - an `idle` row: the same window with no interaction. The header mascot and the first-run
 *     nudge animate forever (~24 elements restyled a frame), so nothing measures below it.
 * Numbers are printed as a table and written to tmp/verify-chat-smooth/<PHASE>/numbers.json, so
 * a BEFORE run (DC_VERIFY_DIST=<old build> DC_VERIFY_PHASE=before) can be laid beside AFTER.
 *
 * WHAT IS CHECKED (pass/fail), because a smooth frame that lands somewhere wrong is not a fix:
 *   C*  setup — two panes, each a resumed several-hundred-item transcript, both pinned
 *   S*  the rail ends at EXACTLY its collapsed / expanded width, the surface's left edge on it,
 *       and both transcripts still pinned to the bottom
 *   P*  the clicked pane is the focused one, at the width the focus-bonus formula gives, with
 *       both transcripts still pinned
 *   T*  the thinking body is visible after the click, and the transcript still pinned
 *   H*  history: wheel up through the transcript — including the "load older" reveals — and
 *       back down. At every notch the row being read moves by EXACTLY what the wheel scrolled
 *       (± 1px, every frame), so no entry resolving its height above the reader, and no
 *       reveal, can jump the view; and the trip ends pinned again.
 *   S glide  the rail and the overlay's edge land in ONE step and a slab carries the motion
 *       (fails on the pre-10-04 code by design: there the width itself slid, in 6–7 steps)
 *   B*  budgets (AFTER the fix): see BUDGET below — they are the regression guard.
 *
 * WHAT WAS FOUND (10-04, recorded here because the next person will reach for the same levers):
 *   - Rail toggle: NOT mainly layout. Flipping `--app-content-left` on `.project-instance`
 *     restyled every element in the project (~16k, one 100ms+ pass at 4x) because a custom
 *     property is inherited; and the `width`/`left` transitions then re-laid out both panes
 *     every frame. Fixed: the surface names its own collapsed `left`, nothing animates layout,
 *     a transform-only slab (useRailGlide.ts) carries the motion.
 *   - Pane switch: ONE layout of ~85ms at 4x — both panes' visible content re-wrapping at the
 *     new widths, forced inside React's commit by a layout effect's read. ChatPane's
 *     ResizeObserver adds no extra layout (it reads a clean tree). Left as is.
 *   - `content-visibility: auto` was tried on transcript entries (pane switch 113 → 43ms) and on
 *     the prose bubble only (→ 72ms). Both FAILED H2: on a "load older" reveal the reader's row
 *     jumped 585px / 384px — the estimated-size race chatEntities.ts documents. Dropped. On the
 *     entry it also clipped every hover bar (they hang below their row, over the next one).
 *   - Also tried, no measurable gain, dropped: `memo` on AgentSurface (rail-toggle script time
 *     unchanged), `contain: strict` on `.chat-scroll`, `container: none` on the panes.
 *   - Thinking row: measured smooth before and after in both engines (1 layout, ≤ 26ms).
 * DIAGNOSIS HOOKS (no effect on a normal run): TRACE=1 prints the biggest passes,
 * EXPERIMENT_CSS / EXPERIMENT_JS inject a lever before writing it, DUMP=1 prints the entries'
 * shapes and what paints outside them, SKIP_H=1 skips the history trip.
 *
 * SCRATCH HOME, ALWAYS — vault registry, agent-ui.json, the seeded ~/.claude/projects
 * transcripts and the fake `claude` live in an isolated HOME the server is spawned with.
 * Nothing reads or writes the developer's own ~/.claude* or real vaults, and no running app
 * server on this machine is contacted (a fresh server on a free port is spawned).
 *
 * WHAT IT DOES NOT SPEND — tokens. `claude` is an inert stand-in that answers nothing.
 *
 * FAILURE POLICY — collect, don't fail fast. Exit 0 iff every check passed.
 * ENV — ENGINES=chromium,webkit (default both) · THROTTLE=4 · REPS=3 · BUDGETS=0 to skip B*.
 * BEFORE/AFTER — DC_VERIFY_DIST=<a copied dist>/index.js DC_VERIFY_PHASE=before|after.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { PHASE, distIndex, scratchDir, shotsDir } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_INDEX = distIndex(REPO);
const SCRATCH = scratchDir('dc-verify-chat-smooth');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const OUT = shotsDir(REPO, 'chat-smooth');

const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',').map((s) => s.trim()).filter(Boolean);
const THROTTLE = Number(process.env.THROTTLE || 4);
const REPS = Number(process.env.REPS || 3);
const BUDGETS = process.env.BUDGETS !== '0';
/** How long after the click a measurement window runs. The longest motion in play is the
 *  rail's 240ms; under a 4x throttle a stuttering frame can be 400ms on its own. */
const WINDOW_MS = 1200;

const CONV_A = randomUUID();
const CONV_B = randomUUID();
/** Turns per conversation. Each turn replays as 7 items, so 60 turns = 420 — inside the
 *  500-item replay cap (transcript-history.ts), i.e. the whole thing is reachable. */
const TURNS = 60;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ─── the scripted `claude` ────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
/** Inert stand-in for \`claude -p --input-format stream-json\` — see scripts/verify/chat-smooth.mjs. */
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

// ─── the seeded transcripts ───────────────────────────────────────────────────────────
// Shaped like the recording: long markdown answers (paragraphs, lists, a code block, a
// table), tool steps between them, and thinking blocks — one before the answer and one
// short one closing each turn, so a "Thought it through" row is on screen at the bottom.

const para = (t, k) => `Bu turda ${t}. adımın ${k}. paragrafı: modülün sınırlarını yeniden çiziyoruz, çünkü `
  + 'oturum durumu iki ayrı yerde tutuluyor ve ikisi senkron kalmadığında panel yanlış sayıyı gösteriyor. '
  + 'Önce okuma yolunu tek kaynağa bağlıyorum, sonra yazma yolunu aynı kaynağa çeviriyorum; böylece '
  + 'yarış durumu ortadan kalkıyor ve testler tek bir gözlemle doğrulanabiliyor.';

function answer(t) {
  return [
    `## Tur ${t} — durum ve plan`,
    para(t, 1),
    para(t, 2),
    '- **Okuma yolu:** `store.read()` tek kaynaktan okuyor',
    '- **Yazma yolu:** `store.write()` aynı kilidi alıyor',
    '- **Kenar durum:** boş oturumda `null` dönüyor, `undefined` değil',
    '  - iç içe madde: eski önbellek temizleniyor',
    '',
    '```ts',
    `export function step${t}(input: Input): Output {`,
    '  const state = store.read(input.id);',
    '  if (!state) return { ok: false, reason: "missing" };',
    '  return { ok: true, value: transform(state, input) };',
    '}',
    '```',
    '',
    '| alan | önce | sonra |',
    '|---|---|---|',
    `| sayaç | ${t} | ${t + 1} |`,
    '| kaynak | iki | bir |',
    '',
    para(t, 3),
  ].join('\n');
}

// Real thoughts run long — paragraphs, not a line — and opening one is a text layout of all of
// it, so the fixture's have to be the size the owner's were or T measures nothing.
const THOUGHT_PARA = (t, k) => `Tur ${t}, düşünce ${k}: okuma ve yazma yolları ayrı kilit alıyor; bu yüzden `
  + 'panel bazen eski değeri gösteriyor. Tek kaynağa bağlarsam yarış kapanır, ama önbellek temizliği '
  + 'sırası değişiyor ve boş oturum dönüşü null olmalı. Testlerin zamanlaması da buna bağlı; önce '
  + 'okuma yolunu taşıyıp gözlemleyeceğim, sonra yazma yolunu aynı kilide alacağım.';
const THOUGHT = (t) => [1, 2, 3, 4, 5, 6].map((k) => THOUGHT_PARA(t, k)).join('\n\n');
const CLOSING_THOUGHT = (t) => [1, 2].map((k) => THOUGHT_PARA(t, `kapanış ${k}`)).join('\n\n');

function seedConversation(convId, title) {
  const lines = [];
  const stamp0 = Date.parse('2026-10-01T10:00:00Z');
  const entry = (i, type, message) => JSON.stringify({
    type, uuid: `${type}-${i}-${randomUUID().slice(0, 8)}`,
    timestamp: new Date(stamp0 + i * 30_000).toISOString(),
    cwd: PROJ, sessionId: convId, version: '2.1.220', gitBranch: 'main', message,
  });
  let i = 0;
  lines.push(entry(i++, 'user', { role: 'user', content: [{ type: 'text', text: title }] }));
  for (let t = 1; t <= TURNS; t += 1) {
    if (t > 1) lines.push(entry(i++, 'user', { role: 'user', content: [{ type: 'text', text: `Tur ${t}: devam et, sıradaki modülü de aynı şekilde düzelt.` }] }));
    const a = `toolu_${convId.slice(0, 6)}_${t}_a`;
    const b = `toolu_${convId.slice(0, 6)}_${t}_b`;
    lines.push(entry(i++, 'assistant', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: THOUGHT(t), signature: 'x' },
        { type: 'text', text: answer(t) },
        { type: 'tool_use', id: a, name: 'Read', input: { file_path: `src/lib/module-${t}.ts` } },
        { type: 'tool_use', id: b, name: 'Bash', input: { command: `npx vitest run module-${t}`, description: `Test module ${t}` } },
      ],
    }));
    lines.push(entry(i++, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: a, content: [{ type: 'text', text: 'export const x = 1;' }] }] }));
    lines.push(entry(i++, 'user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: b, content: [{ type: 'text', text: '✓ 12 passed' }] }] }));
    lines.push(entry(i++, 'assistant', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: CLOSING_THOUGHT(t), signature: 'x' },
        { type: 'text', text: `Tur ${t} tamam: testler geçti, okuma ve yazma tek kaynakta.` },
      ],
    }));
  }
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${convId}.jsonl`), lines.join('\n') + '\n');
}

// ─── setup ────────────────────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  mkdirSync(join(PROJ, '_dream_context', 'state'), { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: false, defaultAgent: 'claude', autoTitle: false,
    hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true,
    chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '',
  }, null, 2)}\n`);
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  seedConversation(CONV_A, 'alfauzun sohbet — sol panel, uzun transkript.');
  seedConversation(CONV_B, 'betauzun sohbet — sağ panel, uzun transkript.');
  const add = spawnSync(process.execPath, [DIST_INDEX, 'vaults', 'add', 'proj', PROJ],
    { env: { ...process.env, HOME }, encoding: 'utf-8' });
  if (add.status !== 0) throw new Error(`vaults add failed: ${add.stderr || add.stdout}`);
}

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [DIST_INDEX, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`http://127.0.0.1:${port}/`); if (res.ok) return srv; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

// ─── in-page probes ───────────────────────────────────────────────────────────────────

/** Every pane's scroller metrics, left → right, in one evaluate (one frame). */
const panesProbe = (page) => page.evaluate(() => {
  const row = document.querySelector('.agent-panes');
  const panes = row ? [...row.querySelectorAll(':scope > .agent-pane')] : [];
  return panes.map((p) => {
    const s = p.querySelector('.chat-scroll');
    const r = p.getBoundingClientRect();
    return {
      active: p.classList.contains('active'),
      left: r.left, width: r.width,
      rows: s?.querySelector('.chat-scroll-inner')?.children.length ?? 0,
      fromBottom: s ? s.scrollHeight - s.scrollTop - s.clientHeight : -1,
      scrollTop: s ? s.scrollTop : -1,
      jump: !!p.querySelector('.chat-jump'),
    };
  });
});

/** Start a per-rAF sampler (+ a long-animation-frame observer where the engine has one). */
const startSampler = (page) => page.evaluate(() => {
  const s = { frames: [], loaf: [], done: false };
  window.__smooth = s;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.loaf.push(e.duration);
    });
    po.observe({ type: 'long-animation-frame', buffered: false });
    s.po = po;
  } catch { /* WebKit: no LoAF */ }
  const tick = (t) => { if (s.done) return; s.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const stopSampler = (page) => page.evaluate(() => {
  const s = window.__smooth;
  s.done = true;
  s.po?.disconnect();
  const d = [];
  for (let i = 1; i < s.frames.length; i += 1) d.push(s.frames[i] - s.frames[i - 1]);
  return { deltas: d, loaf: s.loaf };
});

const metricMap = async (cdp) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

/**
 * A devtools.timeline trace around one interaction (Chromium). This, not
 * `Performance.getMetrics`, is where layout/style numbers come from: measured 10-04, the
 * pane switch's one forced layout was ~100ms in the trace while LayoutDuration reported
 * ~20ms — the instrument has to be checked before its verdict is believed.
 * TRACE=1 adds the stack-bearing category and prints the biggest passes (diagnosis only).
 */
function startTrace(cdp) {
  const events = [];
  const onData = (d) => events.push(...d.value);
  cdp.on('Tracing.dataCollected', onData);
  const started = cdp.send('Tracing.start', {
    categories: process.env.TRACE === '1'
      ? 'devtools.timeline,disabled-by-default-devtools.timeline'
      : 'devtools.timeline',
    transferMode: 'ReportEvents',
  });
  return {
    started,
    stop: () => new Promise((res) => {
      cdp.once('Tracing.tracingComplete', () => { cdp.off('Tracing.dataCollected', onData); res(events); });
      cdp.send('Tracing.end');
    }),
  };
}
const complete = (events, name) => events.filter((e) => e.name === name && e.ph === 'X' && e.dur);
function printTrace(events) {
  for (const name of (process.env.TRACE_NAMES || 'UpdateLayoutTree,Layout,FunctionCall,EventDispatch,PrePaint,Paint,Layerize,Commit,RunTask').split(',')) {
    for (const e of complete(events, name).sort((a, b) => b.dur - a.dur).slice(0, 3)) {
      const a = { ...(e.args?.data || {}), ...(e.args?.beginData || {}), ...(e.args || {}), ...(e.args?.endData || {}) };
      const st = (a.stackTrace || []).slice(0, 4).map((f) => `${f.functionName || '?'}@${(f.url || '').split('/').pop()}:${f.lineNumber}`).join(' < ');
      console.log(`        ${name.padEnd(18)} ${(e.dur / 1000).toFixed(1).padStart(7)}ms ${a.elementCount != null ? `elements=${a.elementCount} ` : ''}${a.dirtyObjects != null ? `dirty=${a.dirtyObjects}/${a.totalObjects} ` : ''}${a.type || ''} ${a.functionName || ''} ${a.url ? `${a.url.split('/').pop()}:${a.lineNumber}:${a.columnNumber}` : ''} ${st}`);
    }
  }
}

/** One measured interaction: per-rAF sampler + (Chromium) a throttled trace around `act`. */
async function measure(page, cdp, act) {
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await startSampler(page);
  await page.waitForTimeout(120);
  const m0 = cdp ? await metricMap(cdp) : null;
  const trace = cdp ? startTrace(cdp) : null;
  if (trace) await trace.started;
  await act();
  await page.waitForTimeout(WINDOW_MS);
  const m1 = cdp ? await metricMap(cdp) : null;
  const events = trace ? await trace.stop() : null;
  const { deltas, loaf } = await stopSampler(page);
  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const out = {
    worst: Math.round(Math.max(0, ...deltas)),
    over33: deltas.filter((x) => x > 33.4).length,
    frames: deltas.length,
    loafMs: Math.round(loaf.reduce((a, b) => a + b, 0)),
  };
  if (events) {
    if (process.env.TRACE === '1') printTrace(events);
    const lay = complete(events, 'Layout');
    const sty = complete(events, 'UpdateLayoutTree');
    const ms = (xs) => Math.round(xs.reduce((x, e) => x + e.dur, 0) / 1000);
    out.layouts = lay.length;
    out.layoutMs = ms(lay);
    out.bigLayout = Math.round(Math.max(0, ...lay.map((e) => e.dur)) / 1000);
    out.styleMs = ms(sty);
    out.bigStyle = Math.round(Math.max(0, ...sty.map((e) => e.dur)) / 1000);
    out.styleEls = sty.reduce((x, e) => x + (e.args?.elementCount || 0), 0);
    out.scriptMs = Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000);
  }
  return out;
}

/** Median of each numeric field across reps, plus the worst rep's worst frame. */
function summarize(reps) {
  const keys = Object.keys(reps[0]);
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const o = {};
  for (const k of keys) o[k] = med(reps.map((r) => r[k]));
  o.worstOfReps = Math.max(...reps.map((r) => r.worst));
  return o;
}

// ─── one engine ───────────────────────────────────────────────────────────────────────

async function runEngine(engineName, base) {
  const engine = engineName === 'webkit' ? webkit : chromium;
  const tag = `[${engineName}]`;
  const browser = await engine.launch();
  const numbers = {};
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 }, colorScheme: 'dark', reducedMotion: 'no-preference',
    });
    const cdp = engineName === 'chromium' ? await page.context().newCDPSession(page) : null;
    if (cdp) await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    const vis = (sel) => page.locator(`${sel}:visible`);
    const until = async (fn, ms = 20000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(150); }
      return false;
    };
    const mod = 'Meta';

    await page.goto(`${base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3500);
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
    if (!(await page.locator('.agent-surface.expanded').count())) {
      for (const sel of ['.agent-fab', '.agent-dock-chip', '.agent-overlay-head', '.agent-surface']) {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
        if (await page.locator('.agent-surface.expanded').count()) break;
      }
    }

    // ── open conversation A through the real resume path ───────────────────────────
    const pastBtn = page.getByRole('button', { name: /Past chats/ }).first();
    const havePast = await until(async () => (await pastBtn.count()) > 0, 15000);
    if (!havePast) {
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: join(OUT, `${engineName}-no-past-chats.png`) });
    }
    await pastBtn.click();
    await until(async () => (await vis('.chp-input').count()) > 0, 8000);
    await vis('.chp-input').first().fill('alfauzun');
    await page.waitForTimeout(700);
    await vis('.chp-row').first().click();
    const oneUp = await until(async () => {
      const p = await panesProbe(page);
      return p.length === 1 && p[0].rows > 10;
    }, 25000);
    check(`${tag} C1 conversation A resumes into a chat pane with its history`, oneUp);

    // ── split, then resume B into the new (active) right pane ──────────────────────
    await vis('.chat-cmp-input').first().click();
    await page.keyboard.press(`${mod}+d`);
    await until(async () => (await panesProbe(page)).length === 2, 20000);
    await page.waitForTimeout(1500);
    // The chord's listener lives on the surface host, so the keydown has to start inside the
    // NEW pane — its composer. Retried: on a loaded machine the freshly split pane can still be
    // homing its session when the first chord lands. WebKit's synthetic chord does not always
    // reach the listener at all; the Past-chats button is the same picker.
    for (let attempt = 0; attempt < 4 && !(await vis('.chp-input').count()); attempt += 1) {
      await vis('.chat-cmp-input').last().click().catch(() => {});
      await page.keyboard.press(`${mod}+Shift+O`);
      if (await until(async () => (await vis('.chp-input').count()) > 0, 3000)) break;
      await page.getByRole('button', { name: /Past chats/ }).first().click().catch(() => {});
      await until(async () => (await vis('.chp-input').count()) > 0, 3000);
    }
    if (!(await vis('.chp-input').count())) {
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: join(OUT, `${engineName}-no-picker.png`) });
    }
    await vis('.chp-input').first().fill('betauzun');
    await page.waitForTimeout(700);
    await vis('.chp-row').first().click();
    const twoUp = await until(async () => {
      const p = await panesProbe(page);
      return p.length === 2 && p.every((x) => x.rows > 10);
    }, 25000);
    await page.waitForTimeout(2500);
    const p0 = await panesProbe(page);
    check(`${tag} C2 two panes, each a long resumed transcript, both pinned to the bottom`,
      twoUp && p0.every((x) => x.fromBottom <= 2 && !x.jump),
      JSON.stringify(p0.map((x) => ({ rows: x.rows, fromBottom: Math.round(x.fromBottom), active: x.active }))));
    const mounted = await page.evaluate(() => [...document.querySelectorAll('.chat-scroll')]
      .map((s) => ({ entries: s.querySelector('.chat-scroll-inner')?.children.length ?? 0, h: Math.round(s.scrollHeight), thinking: s.querySelectorAll('.chat-m-thinking').length, md: s.querySelectorAll('pre, table, li').length })));
    console.log(`      mounted: ${JSON.stringify(mounted)}`);

    // Diagnosis hook (DUMP=1): the shape of the transcript's entries, and every descendant
    // that paints OUTSIDE a candidate container's box — what paint containment would clip.
    if (process.env.DUMP === '1') {
      const dump = await page.evaluate((cands) => {
        const sig = (el, d) => {
          if (d < 0) return '';
          const kids = [...el.children].slice(0, 4).map((c) => sig(c, d - 1)).filter(Boolean);
          return `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${kids.length ? `{${kids.join(' ')}}` : ''}`;
        };
        const kinds = {};
        for (const c of document.querySelectorAll('.chat-scroll-inner > *')) {
          const k = `${c.tagName}.${c.className}`;
          if (!kinds[k]) kinds[k] = { n: 0, shape: sig(c, 3) };
          kinds[k].n += 1;
        }
        const over = {};
        for (const sel of cands) {
          const hits = {};
          for (const box of document.querySelectorAll(sel)) {
            const b = box.getBoundingClientRect();
            for (const d of box.querySelectorAll('*')) {
              const r = d.getBoundingClientRect();
              if (!r.width || !r.height) continue;
              if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) {
                const k = `${d.tagName.toLowerCase()}.${[...d.classList].join('.')}`;
                hits[k] = (hits[k] || 0) + 1;
              }
            }
          }
          over[sel] = hits;
        }
        return { kinds, over };
      }, (process.env.DUMP_SEL || '.chat-scroll-inner > *').split('|'));
      console.log(JSON.stringify(dump, null, 1));
      console.log(JSON.stringify(await page.evaluate(() => document.getAnimations().map((a) => {
        const t = a.effect?.target;
        return [a.animationName || a.transitionProperty || a.constructor.name, t ? `${t.tagName}.${t.className}`.slice(0, 90) : '?', a.playState, a.effect?.getTiming().iterations];
      }))));
      return numbers;
    }

    // Diagnosis hook: inject a stylesheet (EXPERIMENT_CSS) to test a lever before writing it.
    if (process.env.EXPERIMENT_CSS) await page.addStyleTag({ content: process.env.EXPERIMENT_CSS });
    if (process.env.EXPERIMENT_JS) await page.evaluate(process.env.EXPERIMENT_JS);
    const pinnedAll = async () => (await panesProbe(page)).every((x) => x.fromBottom <= 2 && !x.jump);

    // ── idle: the same window with NO interaction — what every number below sits on ─────
    const idle = [];
    for (let r = 0; r < REPS; r += 1) idle.push(await measure(page, cdp, async () => {}));
    numbers.idle = summarize(idle);

    // ── S: rail collapse / expand ───────────────────────────────────────────────────
    const toggle = vis('[data-testid="sidebar-collapse"]').first();
    const railState = () => page.evaluate(() => ({
      rail: document.querySelector('.sidebar')?.getBoundingClientRect().width ?? -1,
      surfaceLeft: document.querySelector('.agent-surface.expanded')?.getBoundingClientRect().left ?? -1,
      collapsedToken: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width-collapsed')),
      expandedToken: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')),
    }));
    const sCollapse = [];
    const sExpand = [];
    for (let r = 0; r < REPS; r += 1) {
      for (const dir of ['collapse', 'expand']) {
        const box = await toggle.boundingBox();
        const res = await measure(page, cdp, () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2));
        (dir === 'collapse' ? sCollapse : sExpand).push(res);
        await page.waitForTimeout(400);
        const st = await railState();
        const want = dir === 'collapse' ? st.collapsedToken : st.expandedToken;
        if (r === 0 || Math.abs(st.rail - want) > 0.5 || Math.abs(st.surfaceLeft - want) > 0.5) {
          check(`${tag} S ${dir} #${r + 1}: the rail lands at exactly ${want}px and the surface's left edge on it`,
            Math.abs(st.rail - want) <= 0.5 && Math.abs(st.surfaceLeft - want) <= 0.5,
            `rail=${st.rail} surfaceLeft=${st.surfaceLeft}`);
        }
        const pinned = await pinnedAll();
        if (r === 0 || !pinned) check(`${tag} S ${dir} #${r + 1}: both transcripts still pinned to the bottom`, pinned, JSON.stringify(await panesProbe(page)));
      }
    }
    // The contract the numbers above rest on (10-04): the rail and the overlay's edge land in
    // ONE step, and the motion is the glide slab, sampled per rAF from inside the page on an
    // unmeasured toggle. On the old code this fails by design: the width itself slid.
    for (const dir of ['collapse', 'expand']) {
      const box = await toggle.boundingBox();
      const sampling = page.evaluate(async () => {
        const out = [];
        const t0 = performance.now();
        await new Promise((res) => {
          const tick = () => {
            const slab = document.querySelector('.sidebar-glide-slab');
            const m = slab ? new DOMMatrix(getComputedStyle(slab).transform) : null;
            out.push([
              Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
              Math.round(document.querySelector('.agent-surface.expanded').getBoundingClientRect().left),
              m ? Math.round(m.m41) : null,
            ]);
            if (performance.now() - t0 < 700) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        const slab = document.querySelector('.sidebar-glide-slab');
        return { out, running: slab ? slab.getAnimations().length : -1 };
      });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const { out, running } = await sampling;
      const rails = [...new Set(out.map((x) => x[0]))];
      const lefts = [...new Set(out.map((x) => x[1]))];
      const slabs = [...new Set(out.map((x) => x[2]).filter((x) => x != null))];
      check(`${tag} S ${dir} glide: the rail and the overlay's edge land in ONE step — no per-frame layout`,
        rails.length <= 2 && lefts.length <= 2, `rail widths=${JSON.stringify(rails)} surface lefts=${JSON.stringify(lefts)}`);
      check(`${tag} S ${dir} glide: the slab carries the motion over many frames, then rests`,
        slabs.length > 5 && running === 0, `distinct slab x=${slabs.length} running after=${running}`);
      await page.waitForTimeout(400);
    }

    numbers.sidebarCollapse = summarize(sCollapse);
    numbers.sidebarExpand = summarize(sExpand);

    // ── P: click the background pane ───────────────────────────────────────────────
    const pRes = [];
    for (let r = 0; r < REPS + 1; r += 1) {
      const before = await panesProbe(page);
      const bg = before.findIndex((x) => !x.active);
      const input = page.locator('.agent-panes > .agent-pane').nth(bg).locator('.chat-cmp-input').first();
      const box = await input.boundingBox();
      const res = await measure(page, cdp, () => page.mouse.click(box.x + 40, box.y + box.height / 2));
      pRes.push(res);
      await page.waitForTimeout(300);
      const after = await panesProbe(page);
      const geo = await page.evaluate(() => {
        const row = document.querySelector('.agent-panes');
        const cs = getComputedStyle(document.querySelector('.agent-surface'));
        return {
          rowW: row.getBoundingClientRect().width,
          bonus: parseFloat(cs.getPropertyValue('--pane-focus-bonus')),
          min: parseFloat(cs.getPropertyValue('--pane-min')),
        };
      });
      const n = after.length;
      const bonus = Math.max(0, Math.min(geo.bonus, geo.rowW - n * geo.min));
      const wantW = bonus + (geo.rowW - bonus) / n;
      const act = after.findIndex((x) => x.active);
      const okGeo = act === bg && Math.abs(after[act].width - wantW) <= 2;
      if (r === 0 || !okGeo) check(`${tag} P #${r + 1}: the clicked pane is focused, at the focus-bonus width (${Math.round(wantW)}px)`,
        okGeo, `active=${act} clicked=${bg} width=${Math.round(after[act]?.width)}`);
      const pinned = await pinnedAll();
      if (r === 0 || !pinned) check(`${tag} P #${r + 1}: both transcripts still pinned to the bottom`, pinned, JSON.stringify(after));
    }
    numbers.paneSwitch = summarize(pRes);

    // ── T: open a "Thought it through" row in the focused pane ─────────────────────
    const tRes = [];
    for (let r = 0; r < REPS; r += 1) {
      // The lowest thinking head that is fully inside the focused pane's scroller viewport.
      const target = await page.evaluate(() => {
        const pane = document.querySelector('.agent-panes > .agent-pane.active');
        const s = pane.querySelector('.chat-scroll');
        const sr = s.getBoundingClientRect();
        const heads = [...s.querySelectorAll('.chat-m-thinking-head')].filter((h) => {
          const r = h.getBoundingClientRect();
          return r.top >= sr.top && r.bottom <= sr.bottom && h.getAttribute('aria-expanded') === 'false';
        });
        const h = heads[heads.length - 1];
        if (!h) return null;
        document.querySelectorAll('[data-smooth-t]').forEach((n) => n.removeAttribute('data-smooth-t'));
        h.parentElement.setAttribute('data-smooth-t', '1');
        const r = h.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (!target) { check(`${tag} T #${r + 1}: a closed thinking row is on screen to open`, false); break; }
      const res = await measure(page, cdp, () => page.mouse.click(target.x, target.y));
      tRes.push(res);
      await page.waitForTimeout(300);
      const body = await page.evaluate(() => {
        const t = document.querySelector('[data-smooth-t]');
        const b = t?.querySelector('.chat-m-thinking-body');
        const s = t?.closest('.chat-scroll');
        if (!b || !s) return { ok: false };
        const br = b.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        const visiblePx = Math.min(br.bottom, sr.bottom) - Math.max(br.top, sr.top);
        return { ok: br.height > 0 && visiblePx > 10, h: Math.round(br.height), visiblePx: Math.round(visiblePx) };
      });
      check(`${tag} T #${r + 1}: the thinking body is open and visible`, body.ok, JSON.stringify(body));
      const pinned = await pinnedAll();
      check(`${tag} T #${r + 1}: the transcripts are still pinned to the bottom`, pinned, JSON.stringify(await panesProbe(page)));
      // Close it again (unmeasured) so the next rep opens a fresh one.
      const head = page.locator('[data-smooth-t] .chat-m-thinking-head');
      await head.click().catch(() => {});
      await page.waitForTimeout(400);
    }
    if (tRes.length) numbers.thinkingOpen = summarize(tRes);

    if (process.env.SKIP_H === '1') return numbers;
    // ── H: wheel up through history (incl. "load older"), and back down ────────────
    // The invariant: the row being read moves by EXACTLY what the wheel scrolled, at every
    // sampled frame after the notch. Content resolving its size above the reader (or a
    // reveal landing) without a matching correction shows up here as a residual.
    // Marked, not `:nth-child`: `.agent-panes` also holds the glide bar, so a child index
    // would point the wheel at one pane and read the probe off the other.
    const histPane = await page.evaluate(() => {
      const panes = [...document.querySelectorAll('.agent-panes > .agent-pane')];
      const i = panes.findIndex((p) => p.classList.contains('active'));
      panes[i].querySelector('.chat-scroll').setAttribute('data-smooth-hist', '1');
      return i;
    });
    const scrollSel = '.chat-scroll[data-smooth-hist]';
    const sb = await page.locator(scrollSel).first().boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    // 420 replayed items is ~80k px of transcript: a notch of a screenful-and-a-bit gets
    // through it (and its ten "load older" reveals) in a bounded number of steps.
    const NOTCH = 1200;
    /** Mark the fold row, wheel once, then sample its viewport top for a dozen frames. */
    const notch = async (dy) => {
      await page.evaluate((sel) => {
        const s = document.querySelector(sel);
        const fold = s.getBoundingClientRect().top;
        const inner = s.querySelector('.chat-scroll-inner');
        document.querySelectorAll('[data-smooth-h]').forEach((n) => n.removeAttribute('data-smooth-h'));
        for (const c of inner.children) {
          if (c.classList.contains('chat-window-more')) continue;
          if (c.getBoundingClientRect().bottom > fold + 1) { c.setAttribute('data-smooth-h', '1'); break; }
        }
        const m = s.querySelector('[data-smooth-h]');
        window.__h = { top0: m ? m.getBoundingClientRect().top : null, st0: s.scrollTop, max0: s.scrollHeight - s.clientHeight, rows0: inner.children.length };
      }, scrollSel);
      await page.mouse.wheel(0, dy);
      return page.evaluate(async (sel) => {
        const s = document.querySelector(sel);
        const tops = [];
        const sts = [];
        const end = performance.now() + 700; // > SCROLL_SETTLE_MS + a reveal's commit
        await new Promise((res) => {
          const tick = () => {
            const m = s.querySelector('[data-smooth-h]');
            tops.push(m && m.isConnected ? m.getBoundingClientRect().top : null);
            sts.push(s.scrollTop);
            if (performance.now() < end) requestAnimationFrame(tick); else res();
          };
          requestAnimationFrame(tick);
        });
        const inner = s.querySelector('.chat-scroll-inner');
        return { ...window.__h, tops, sts, rows1: inner.children.length, st1: s.scrollTop, fromBottom: s.scrollHeight - s.scrollTop - s.clientHeight };
      }, scrollSel);
    };
    let worstResidual = 0;
    let worstDetail = '';
    let reveals = 0;
    let upNotches = 0;
    const judge = (n, dir) => {
      if (n.top0 == null) return;
      const final = n.tops[n.tops.length - 1];
      if (final == null) return; // the row was trimmed away (pinned tail) — nothing to hold
      // What the wheel asked for, clamped by where the scroller could go at the time.
      const want = dir < 0 ? Math.min(NOTCH, n.st0) : -Math.min(NOTCH, n.max0 - n.st0);
      const res = Math.abs((final - n.top0) - want);
      // …and no frame on the way may sit anywhere but the start or the end (no flash).
      const settled = n.tops.filter((x) => x != null);
      const strays = settled.filter((x) => Math.abs(x - final) > 1 && Math.abs(x - n.top0) > 1 && Math.abs(x - (n.top0 + want)) > 1);
      // A wheel step itself may animate (smooth scrolling), so intermediate positions on
      // the straight path are fine; a frame that is NOT between start and end is a jump.
      const lo = Math.min(n.top0, final) - 1;
      const hi = Math.max(n.top0, final) + 1;
      const outOfPath = strays.filter((x) => x < lo || x > hi);
      const r = Math.max(res, outOfPath.length ? Math.max(...outOfPath.map((x) => Math.min(Math.abs(x - lo), Math.abs(x - hi)))) : 0);
      if (r > worstResidual) { worstResidual = r; worstDetail = JSON.stringify({ dir, want, moved: final - n.top0, st0: n.st0, rows: [n.rows0, n.rows1], tops: n.tops.map((x) => (x == null ? x : Math.round(x))) }); }
    };
    // Up: until the scroller rests at its ceiling with nothing more revealed.
    let stuckAtTop = 0;
    for (let i = 0; i < 220 && stuckAtTop < 2; i += 1) {
      const n = await notch(-NOTCH);
      upNotches += 1;
      if (process.env.DEBUG_H) console.log(`      up ${i}: st ${Math.round(n.st0)}→${Math.round(n.st1)} rows ${n.rows0}→${n.rows1}`);
      if (n.rows1 > n.rows0) reveals += 1;
      judge(n, -1);
      stuckAtTop = n.st1 <= 1 && n.rows1 === n.rows0 ? stuckAtTop + 1 : 0;
    }
    const top = await panesProbe(page);
    check(`${tag} H1 wheeling up reached the top through ${reveals} "load older" reveal(s)`,
      reveals > 0 && top[histPane].scrollTop <= 1, `notches=${upNotches} rows=${top[histPane].rows}`);
    let downNotches = 0;
    for (let i = 0; i < 260; i += 1) {
      const n = await notch(NOTCH);
      downNotches += 1;
      judge(n, 1);
      if (n.fromBottom <= 2) break;
    }
    check(`${tag} H2 the row being read moves exactly with the wheel, every frame, up AND down (worst residual ≤ 1px)`,
      worstResidual <= 1, `worst=${worstResidual.toFixed(1)}px ${worstResidual > 1 ? worstDetail : ''}`);
    await page.waitForTimeout(1000);
    const end = await panesProbe(page);
    check(`${tag} H3 back at the bottom the transcript is pinned again (and stays there)`,
      end[histPane].fromBottom <= 2 && !end[histPane].jump, `notches down=${downNotches} ${JSON.stringify(end[histPane])}`);

    if (process.env.SHOT) await page.screenshot({ path: join(OUT, `${engineName}.png`) });
  } finally {
    await browser.close().catch(() => {});
  }
  return numbers;
}

// ─── budgets (the regression guard, AFTER the fix) ───────────────────────────────────
// Chromium at THROTTLE x CPU, medians of REPS. Measured 10-04 on the same fixture:
//   rail toggle   BEFORE 14–32 layouts, one 96–157ms style pass of ~16k elements
//                 AFTER  8 layouts, biggest style pass 15–19ms (~10k elements in total)
//   pane switch   6 layouts both — its one big layout (~85ms) is the content re-wrapping at
//                 the new widths, which no lever here removes (see WHAT WAS FOUND above)
//   thinking      1 layout both
// `bigStyle` is the guard against the inherited `--app-content-left` flip coming back: that
// is what made one rail toggle restyle every element in the project.
const BUDGET = {
  chromium: {
    sidebarCollapse: { layouts: 10, bigStyle: 60 },
    sidebarExpand: { layouts: 10, bigStyle: 60 },
    paneSwitch: { layouts: 8 },
    thinkingOpen: { layouts: 3 },
  },
};

// ─── run ──────────────────────────────────────────────────────────────────────────────

let server;
const all = {};
try {
  setupScratch();
  const port = await freePort();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  for (const e of ENGINES) {
    try {
      all[e] = await runEngine(e, base);
    } catch (err) {
      check(`[${e}] the run completed`, false, String(err?.stack || err).slice(0, 600));
    }
  }
} catch (err) {
  check('the harness came up', false, String(err?.stack || err).slice(0, 600));
} finally {
  server?.kill();
}

console.log(`\n── numbers (${PHASE}; median of reps; chromium at ${THROTTLE}x CPU throttle, webkit unthrottled)`);
const COLS = ['worst', 'worstOfReps', 'over33', 'frames', 'layouts', 'layoutMs', 'bigLayout', 'styleMs', 'bigStyle', 'styleEls', 'scriptMs', 'loafMs'];
console.log(`engine    interaction      ${COLS.map((c) => c.padStart(11)).join('')}`);
for (const [e, nums] of Object.entries(all)) {
  for (const [k, v] of Object.entries(nums)) {
    console.log(`${e.padEnd(9)} ${k.padEnd(16)} ${COLS.map((c) => String(v[c] ?? '-').padStart(11)).join('')}`);
  }
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'numbers.json'), `${JSON.stringify({ phase: PHASE, throttle: THROTTLE, reps: REPS, numbers: all }, null, 2)}\n`);

if (BUDGETS) {
  for (const [e, byInteraction] of Object.entries(BUDGET)) {
    if (!all[e]) continue;
    for (const [k, lim] of Object.entries(byInteraction)) {
      const v = all[e][k];
      if (!v) continue;
      check(`[${e}] B ${k}: ${v.layouts} layouts ≤ ${lim.layouts} — it lands in a bounded number of layouts, not one per frame`,
        v.layouts <= lim.layouts);
      if (lim.bigStyle != null) {
        check(`[${e}] B ${k}: biggest style pass ${v.bigStyle}ms ≤ ${lim.bigStyle}ms — the toggle restyles the rail and the overlay, not the whole project`,
          v.bigStyle <= lim.bigStyle);
      }
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
