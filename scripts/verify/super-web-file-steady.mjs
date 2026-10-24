#!/usr/bin/env node
/**
 * A PROJECT web page on a Super web card loads once and paints steady, and the card stays in the
 * record (owner 2026-10-23: "the HTML card has a flicker problem"; two local pages opened with
 * `super open web a b --titles …` jumped between two layouts several times a second, and both
 * cards were gone from the record within ~2-40 s, twice). Stage harness derived from
 * super-web-local-assets.mjs.
 *
 *   npm run build && npm run verify:super-web-file-steady
 *   VERIFY_ENGINE=webkit VERIFY_W=1584 VERIFY_H=1000 …   the desktop app's engine, a 14" window
 *   VERIFY_W=390 VERIFY_H=844 …                           a phone-width window (the page as a sheet)
 *
 * WHAT IT DRIVES — the real dashboard server on a scratch HOME (DREAMCONTEXT_DESKTOP=1), the real
 * dashboard in Chromium or WebKit with CLASSIC scrollbars in every frame (the owner's Mac: a
 * mouse paired, so a bar takes 15 px; VERIFY_SCROLLBARS=overlay for none), and a scripted
 * stand-in `claude` that, as the Super Agent, runs the owner's verbs: `super open web <a> <b>
 * --titles …`, `super stack` (groups, with VERIFY_SEED), `super present <a> <b>`, `present <a>`,
 * `present --off`, `half --off`, `shape <a> large`, and a turn that keeps streaming (GO-BUSY).
 * The two pages are fictional ("Pocket Ledger" decision notes): a 1100 px column of grid rows
 * with a picture each, the pictures beside the page (`shots/…`, carried into the frame), every
 * one checked decoded at the end of each watch.
 *
 * WHAT IT PROVES — in each state (side by side right after the open, side by side and presented
 * while the super's turn streams, presented with both and alone, a large floating card), once the
 * cards stand in place: over SAMPLE_MS every card's frame is the SAME element, loads 0 more times,
 * and its box and its page's own layout (inside the frame) change 0 times; the record still
 * holds both cards and the view, and after the presentation for RECORD_WATCH_MS. Over the whole
 * run: the page on screen from the open to the end made ONE frame and loaded once (the old card
 * rebuilt it on its way to side by side, and again on every move between floating and shown);
 * the other made a frame only each time it came back on screen, and loaded each once.
 * Screenshots: tmp/super-web-file-steady/. Exit 0 iff all pass.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, cpSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-web-file-steady-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'pocket-ledger');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'super-web-file-steady');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const DIR = '_dream_context/tmp/results/decision';
const PAGE_A = `${DIR}/sync.html`;
const PAGE_B = `${DIR}/backup.html`;
const SAMPLE_MS = Number(process.env.VERIFY_SAMPLE_MS || 8000);
const SEED = process.env.VERIFY_SEED || '';
const SEED_DIR = process.env.VERIFY_SEED_DIR || '';
/** How long the record is watched after the presentation (the owner's cards were gone in ~2-40 s). */
const RECORD_WATCH_MS = Number(process.env.VERIFY_RECORD_WATCH_MS || 20000);
/** `webkit` is the desktop app's engine (WKWebView); chromium is the default harness. */
const ENGINE = process.env.VERIFY_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const SCROLLBARS = process.env.VERIFY_SCROLLBARS === 'overlay' ? 'overlay' : 'classic';
const VIEWPORT = { width: Number(process.env.VERIFY_W || 1440), height: Number(process.env.VERIFY_H || 900) };
/** A phone-width window: a shown card is a sheet over the super's chat. */
const NARROW = VIEWPORT.width < 700;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'verify-super-' + process.pid;
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) { report({ kind: 'handover', steps: [] }); return 'ready'; }
  const m = text.match(/GO-CLI\\s+(.+)$/);
  if (m) {
    // Arguments split on spaces; a "|" inside --titles stays in its argument.
    const steps = [cli(...m[1].trim().split(/\\s+/))];
    report({ kind: 'verb', steps });
    return 'did ' + m[1];
  }
  return 'ok';
}
let running = false;
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user' || running) continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    running = true;
    out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
    // GO-BUSY <n>: a turn that keeps working, the way the owner's super was mid-turn: n
    // assistant messages 150 ms apart, then the result (the stage re-renders on each).
    const busy = role === 'super' ? blocks.join(' ').match(/GO-BUSY\\s+(\\d+)/) : null;
    if (busy) {
      report({ kind: 'busy', n: Number(busy[1]) });
      let i = 0;
      const step = () => {
        i += 1;
        out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPER working, line ' + i + ' of ' + busy[1] + ': the page shows what changes, one picture per step.' }] } });
        if (i < Number(busy[1])) { setTimeout(step, 150); return; }
        out({ type: 'result', subtype: 'success', is_error: false, result: 'busy done', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
        running = false;
      };
      setTimeout(step, 150);
      continue;
    }
    let said = 'ok';
    try { said = role === 'super' ? superTurn(blocks.find((b) => /GO-CLI|\\[super handover\\]/.test(b)) ?? blocks[0] ?? '') : 'ok'; } catch (e) { said = 'error ' + e; }
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: (role === 'super' ? 'SUPER ' : 'CHILD ') + said }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    running = false;
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => { const e = { ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' }; delete e.ZDOTDIR; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function startServer(port) {
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(SCRATCH, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await sleep(300);
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

const readNd = (path) => { try { return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const record = () => { try { return JSON.parse(readFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return { containers: [], view: {} }; } };
const idOf = (ref) => record().containers.find((c) => c.ref === ref)?.id;

let pass = 0;
const fails = [];
const ok = (label, cond, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 700)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};
const settle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => page.waitForTimeout(1500));

async function openChat(page, base) {
  await page.goto(`${base}/?vault=pocket-ledger`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  // The What's New popup can land late on a loaded machine: dismissed before anything else.
  const gotIt = page.getByRole('button', { name: /^Got it$/ });
  await until(page, async () => (await gotIt.count()) > 0, 6000);
  if (await gotIt.count()) await gotIt.first().click().catch(() => {});
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  const side = page.locator('aside').getByText('Chat', { exact: true }).first();
  if (await side.count()) { await side.click().catch(() => {}); await page.waitForTimeout(2000); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1200); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
}

const superComposer = (page) => page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
async function agent(page, args) {
  const before = readNd(REPORTS).filter((r) => r.kind === 'verb').length;
  const input = superComposer(page);
  await input.click();
  await input.fill(`GO-CLI ${args}`);
  await page.keyboard.press('Enter');
  const came = await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'verb').length > before, 40000);
  // No report = no result: never the previous verb's.
  return came ? readNd(REPORTS).filter((r) => r.kind === 'verb').pop()?.steps?.[0] : null;
}

/** The super starts a turn that streams for SAMPLE_MS + 4 s (GO-BUSY in the stand-in). */
async function busyTurn(page) {
  const before = readNd(REPORTS).filter((r) => r.kind === 'busy').length;
  const input = superComposer(page);
  await input.click();
  await input.fill(`GO-BUSY ${Math.ceil((SAMPLE_MS + 4000) / 150)}`);
  await page.keyboard.press('Enter');
  ok('the busy turn started', await until(page, async () => readNd(REPORTS).filter((r) => r.kind === 'busy').length > before, 30000));
  await page.waitForTimeout(800);
}

const card = (page, id) => page.locator(`[data-testid="super-container"][data-container-id="${id}"]`);
const shot = async (page, name) => { await page.screenshot({ path: join(OUT, `${name}.png`) }); return join(OUT, `${name}.png`); };

/** A fictional decision note shaped like the owner's: a 1100 px column of picture rows. */
function note(title, rows) {
  const row = (n, h, p) => `<div class="row"><img src="shots/${n}.png"><div><span class="n">${n}</span><h2>${h}</h2>${p}</div></div>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:#14151b;color:#e8e8ee}
.w{max-width:1100px;margin:0 auto;padding:28px}
h1{font-size:26px;margin:0 0 4px}.sub{color:#9a9bab;margin:0 0 22px}
.row{display:grid;grid-template-columns:260px 1fr;gap:22px;align-items:center;margin:18px 0;padding:16px;border:1px solid #2a2c38;border-radius:14px;background:#1b1c24}
.row img{width:100%;border-radius:10px;border:1px solid #2a2c38}
h2{font-size:18px;margin:0 0 6px}.n{color:#a78bfa;font-weight:600}
</style><div class="w">
<h1>${title}</h1>
<p class="sub">Pocket Ledger keeps every receipt on the phone. This note says what changes once the work is done, one picture per step, so the decision can be made at a glance.</p>
${rows.map((r, i) => row(i + 1, r[0], r[1])).join('\n')}
</div></html>`;
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(HOME, '.claude-worktrees'), join(PROJ, '_dream_context', 'state'), join(PROJ, DIR), join(PROJ, DIR, 'shots')]) mkdirSync(d, { recursive: true });
  // Screenshots of an earlier run never sit next to this one's.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  // Chats start through a login shell, whose path_helper puts /usr/local/bin first: the scratch
  // HOME's rc files put the stand-in ahead of any real `claude` on this machine.
  for (const rc of ['.zshrc', '.bash_profile', '.profile']) writeFileSync(join(HOME, rc), 'export PATH="$HOME/.local/bin:$PATH"\n');
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'pocket-ledger', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
  const png = join(REPO, 'public', 'image', 'diagram-recall.png');
  for (let i = 1; i <= 4; i++) copyFileSync(png, join(PROJ, DIR, 'shots', `${i}.png`));
  const words = 'A receipt photographed on the phone lands in the right month, its total read off the paper and checked against the bank line, without one more tap.';
  writeFileSync(join(PROJ, PAGE_A), note('Sync: what changes on the phone', [
    ['A receipt that never arrives', words], ['It shows inside the month', words], ['One button instead of four', words], ['The phone\'s own share sheet', words],
  ]));
  writeFileSync(join(PROJ, PAGE_B), note('Backup: what changes overnight', [
    ['Nothing is kept twice', words], ['A restore asks once', words],
  ]));
  // Diagnosis only (never in a committed run): VERIFY_SEED=<a .super-agent.json> starts the stage
  // with that record's cards and groups (chats dropped: no child is alive here), so a busy
  // stage can be replayed; VERIFY_SEED_DIR copies the folder its pictures live in.
  if (SEED) {
    const raw = JSON.parse(readFileSync(SEED, 'utf-8'));
    const containers = (raw.containers || []).filter((c) => c.kind !== 'chat' && c.kind !== 'browser' && c.kind !== 'team');
    const keep = new Set(containers.map((c) => c.id));
    const groups = (raw.groups || []).map((g) => ({ ...g, cards: g.cards.filter((id) => keep.has(id)) })).filter((g) => g.cards.length >= 2);
    writeFileSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), `${JSON.stringify({ v: raw.v, session: null, enabled: false, containers, groups, view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [] }, null, 2)}\n`);
    if (SEED_DIR) cpSync(SEED_DIR, join(PROJ, '_dream_context', 'tmp', 'super-sonuclar'), { recursive: true });
    console.log(`  · seeded ${containers.length} cards, ${groups.length} groups`);
  }
}

/**
 * Watch every web card's frame for `ms`: marks the frames there now, counts iframe `load`s,
 * and samples each frame's box every animation frame. Returns, per card id: whether the marked
 * frame is still the one drawn, the loads, the distinct sizes seen and how often the size changed.
 */
async function watchFrames(page, ids, ms) {
  return page.evaluate(async ({ ids, ms }) => {
    const frameIn = (id) => document.querySelector(`[data-testid="super-container"][data-container-id="${id}"] iframe`);
    const cardOf = (f) => f.closest('[data-container-id]')?.getAttribute('data-container-id') ?? '?';
    const out = {};
    const seen = new WeakSet();
    for (const id of ids) {
      const f = frameIn(id);
      if (f) { f.dataset.steadyProbe = id; seen.add(f); }
      out[id] = { first: !!f, frames: f ? 1 : 0, missing: 0, loads: 0, sizes: new Set(), changes: 0, last: '', samples: 0, log: [] };
    }
    const onLoad = (e) => { const t = e.target; if (t instanceof HTMLIFrameElement) { const id = cardOf(t); if (out[id]) out[id].loads += 1; } };
    document.addEventListener('load', onLoad, true);
    const t0 = performance.now();
    const end = t0 + ms;
    await new Promise((resolve) => {
      const tick = () => {
        for (const id of ids) {
          const o = out[id];
          const f = frameIn(id);
          o.samples += 1;
          if (!f) { o.missing += 1; if (o.log.length < 40) o.log.push(`${Math.round(performance.now() - t0)}:gone`); o.last = ''; continue; }
          // A frame element this watch has not seen yet: the card built a new one.
          if (!seen.has(f)) { seen.add(f); o.frames += 1; if (o.log.length < 40) o.log.push(`${Math.round(performance.now() - t0)}:new`); }
          const b = f.getBoundingClientRect();
          const s = `${Math.round(b.width)}x${Math.round(b.height)}`;
          if (o.last && o.last !== s) { o.changes += 1; if (o.log.length < 40) o.log.push(`${Math.round(performance.now() - t0)}:${s}`); }
          o.last = s;
          o.sizes.add(s);
        }
        if (performance.now() < end) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    document.removeEventListener('load', onLoad, true);
    const res = {};
    for (const [id, o] of Object.entries(out)) {
      const still = frameIn(id)?.dataset.steadyProbe === id;
      res[id] = { same: o.first && still && o.frames === 1, frames: o.frames, missing: o.missing, loads: o.loads, sizes: [...o.sizes].slice(0, 6), changes: o.changes, samples: o.samples, log: o.log };
    }
    return res;
  }, { ids, ms });
}

/**
 * Inside each card's page for `ms` (Playwright reaches into the sandboxed frame): its layout
 * width (`clientWidth`, which a classic scrollbar narrows) and its body height, sampled every
 * animation frame. A page laid out at one width has `widths.length === 1`.
 */
async function watchInside(page, ids, ms) {
  const runs = await Promise.all(ids.map(async (id) => {
    const el = await card(page, id).locator('iframe').first().elementHandle({ timeout: 5000 }).catch(() => null);
    const frame = el ? await el.contentFrame() : null;
    if (!frame) return [id, null];
    const r = await frame.evaluate(async (ms) => {
      const widths = new Set();
      const heights = new Set();
      let flips = 0;
      let last = '';
      const log = [];
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          const w = document.documentElement.clientWidth;
          const h = Math.ceil(document.body.getBoundingClientRect().height);
          const k = `${w}/${h}`;
          widths.add(w);
          heights.add(h);
          if (last && last !== k) { flips += 1; if (log.length < 30) log.push(`${Math.round(performance.now() - t0)}:${k}`); }
          last = k;
          if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      const pics = [...document.images];
      return { widths: [...widths], heights: [...heights].slice(0, 6), flips, log, pictures: pics.length, painted: pics.filter((i) => i.complete && i.naturalWidth > 0).length };
    }, ms).catch((e) => ({ error: String(e).slice(0, 200) }));
    return [id, r];
  }));
  return Object.fromEntries(runs);
}

/** One state: the stage settles, then the frames are watched and the record is read after. */
async function steadyIn(page, label, ids, expectView, where) {
  await settle(page);
  // The view switch lands after the verb's answer: the watch starts once every card stands where
  // the view puts it and its box held still for 600 ms (a card's flight into place is motion, not
  // flicker).
  const placed = await until(page, async () => {
    const boxes = async () => Promise.all(ids.map((id) => card(page, id).evaluate((e) => {
      const b = e.getBoundingClientRect();
      return `${e.dataset.where}:${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
    })));
    const first = await boxes();
    if (!first.every((x) => x.startsWith(`${where}:`))) return false;
    await page.waitForTimeout(600);
    return JSON.stringify(await boxes()) === JSON.stringify(first);
  }, 20000);
  ok(`${label}: every card stands ${where} and holds still`, placed);
  const drawn = [];
  for (const id of ids) if ((await card(page, id).locator('iframe').count()) > 0) drawn.push(id);
  ok(`${label}: every page is drawn in its frame (${drawn.length}/${ids.length})`, drawn.length === ids.length, JSON.stringify({ drawn, ids }));
  const t0 = Date.now();
  const [w, inside] = await Promise.all([watchFrames(page, ids, SAMPLE_MS), watchInside(page, ids, SAMPLE_MS)]);
  console.log(`  · ${JSON.stringify(w)}`);
  console.log(`  · inside: ${JSON.stringify(inside)}`);
  for (const id of ids) {
    const r = w[id];
    ok(`${label}: ${id} keeps the same frame for ${SAMPLE_MS / 1000} s (never remounted, never gone)`, r && r.same && r.missing === 0, JSON.stringify(r));
    ok(`${label}: ${id} loads 0 more times`, r && r.loads === 0, JSON.stringify(r));
    ok(`${label}: ${id} paints at ONE size (0 size changes)`, r && r.changes === 0 && r.sizes.length === 1, JSON.stringify(r));
    const i = inside[id];
    ok(`${label}: ${id}'s page lays out at ONE width and height (0 flips inside the frame)`, i && !i.error && i.flips === 0 && i.widths.length === 1, JSON.stringify(i));
    ok(`${label}: every picture in ${id}'s page is painted`, i && !i.error && i.pictures > 0 && i.painted === i.pictures, JSON.stringify(i && { pictures: i.pictures, painted: i.painted }));
  }
  const rec = record();
  const held = ids.filter((id) => rec.containers.some((c) => c.id === id));
  ok(`${label}: the record still holds both cards ${Math.round((Date.now() - t0) / 1000)} s on`, held.length === ids.length, JSON.stringify({ held, view: rec.view }));
  ok(`${label}: the view is still ${expectView(null)}`, expectView(rec.view), JSON.stringify(rec.view));
}

let server = null;
let browser = null;
let lastPage = null;
try {
  const pw = await import('@playwright/test');
  const port = await freePort();
  setupScratch();
  server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  browser = await pw[ENGINE].launch();
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  // The owner's Mac draws CLASSIC scrollbars (Automatic + a mouse paired): a bar that takes
  // 15 px of width. Headless engines draw none, so every frame (the window and each card's
  // page) gets one here; VERIFY_SCROLLBARS=overlay leaves the engine's own.
  if (SCROLLBARS === 'classic') {
    await context.addInitScript(() => {
      const css = '::-webkit-scrollbar{width:15px;height:15px}::-webkit-scrollbar-thumb{background:#5a5b66;border-radius:8px}::-webkit-scrollbar-track{background:#22232b}';
      const add = () => { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).appendChild(st); };
      if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
    });
  }
  // The whole run, in the window: every frame element a card creates and every load it fires,
  // from the first paint on (a card that loads its page once has made 1 and loaded 1).
  await context.addInitScript(() => {
    if (window.top !== window) return;
    const made = {};
    const loads = {};
    window.__steady = { made, loads };
    const cardOf = (f) => f.closest('[data-container-id]')?.getAttribute('data-container-id');
    const seen = new WeakSet();
    const scan = (n) => {
      const list = n.tagName === 'IFRAME' ? [n] : n.querySelectorAll ? [...n.querySelectorAll('iframe')] : [];
      for (const f of list) {
        if (seen.has(f)) continue;
        seen.add(f);
        const id = cardOf(f);
        if (id) made[id] = (made[id] || 0) + 1;
      }
    };
    const start = () => {
      new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n); })
        .observe(document.documentElement, { childList: true, subtree: true });
      document.addEventListener('load', (e) => {
        const t = e.target;
        if (t && t.tagName === 'IFRAME') { const id = cardOf(t); if (id) loads[id] = (loads[id] || 0) + 1; }
      }, true);
    };
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Content Security Policy|ERR_BLOCKED/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`\n── the super agent opens two project pages (${ENGINE}, ${VIEWPORT.width}x${VIEWPORT.height}, ${SCROLLBARS} scrollbars)`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  ok('a chat opens', await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0));
  await sleep(1500);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok('the surface shows', await until(page, async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0));
  ok('the super agent took the hand-over', await until(page, async () => readNd(REPORTS).some((r) => r.kind === 'handover'), 60000));
  await until(page, async () => (await superComposer(page).count()) > 0, 20000);
  await settle(page);
  const open = await agent(page, `super open web ${PAGE_A} ${PAGE_B} --titles Sync:_what_changes|Backup:_what_changes`);
  ok('`super open web a b --titles` succeeded', open && open.status === 0, JSON.stringify(open));
  const a = idOf(PAGE_A);
  const b = idOf(PAGE_B);
  ok('both cards are in the record', !!a && !!b, JSON.stringify(record().containers.map((c) => [c.id, c.ref])));
  if (NARROW) {
    // A phone-width window: the page opens as a sheet over the super's chat (its composer under
    // it), so only this state is driven here.
    await steadyIn(page, 'as a sheet', [a], (v) => (v === null ? 'half on the first page' : v?.mode === 'half' && v.card === a), 'sheet');
    await shot(page, '1-sheet');
    const whole = await page.evaluate(() => window.__steady);
    console.log(`  · ${JSON.stringify(whole)}`);
    ok(`${a}: ONE frame from the open on, its page loaded once`, whole?.made?.[a] === 1 && whole?.loads?.[a] === 1, JSON.stringify(whole));
    ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
    throw Object.assign(new Error('narrow: done'), { done: true });
  }
  await steadyIn(page, 'side by side', [a], (v) => (v === null ? 'half on the first page' : v?.mode === 'half' && v.card === a), 'half');
  await shot(page, '1-half');

  console.log('\n── side by side while the super agent keeps working (its turn streams)');
  await busyTurn(page);
  await steadyIn(page, 'side by side, super working', [a], (v) => (v === null ? 'half on the first page' : v?.mode === 'half' && v.card === a), 'half');
  // The busy turn ends 4 s after the watch (a message sent meanwhile would only queue).
  await page.waitForTimeout(5000);

  // The owner's super put the groups on the stage away first (`super stack <group>`).
  for (const g of record().groups ?? []) {
    if (g.place !== 'float') continue;
    ok(`\`super stack ${g.id}\``, (await agent(page, `super stack ${g.id}`))?.status === 0);
  }

  console.log('\n── the super agent presents both');
  const pres = await agent(page, `super present ${a} ${b}`);
  ok('`super present a b` succeeded', pres && pres.status === 0, JSON.stringify(pres));
  // VERIFY_PLANT=close: the watch below must FAIL (a card closed during it), the proof it can.
  if (process.env.VERIFY_PLANT === 'close') console.log(`  · planted: super close ${b} -> ${JSON.stringify((await agent(page, `super close ${b}`))?.status)}`);
  {
    // The record over RECORD_WATCH_MS: the two cards and the presentation stay.
    const end = Date.now() + RECORD_WATCH_MS;
    let lost = null;
    while (Date.now() < end && !lost) {
      const rec = record();
      const held = [a, b].filter((id) => rec.containers.some((c) => c.id === id));
      if (held.length < 2 || rec.view?.mode !== 'present') lost = { at: Math.round((RECORD_WATCH_MS - (end - Date.now())) / 1000), held, view: rec.view, n: rec.containers.length };
      await sleep(250);
    }
    ok(`presented: both cards and the presentation stay in the record for ${RECORD_WATCH_MS / 1000} s`, !lost, JSON.stringify(lost));
  }
  await steadyIn(page, 'presented', [a, b], (v) => (v === null ? 'present with both' : v?.mode === 'present' && [a, b].every((id) => v.cards?.includes(id))), 'present');
  await shot(page, '2-present');

  console.log('\n── presented while the super agent keeps working (its turn streams)');
  {
    await busyTurn(page);
    await steadyIn(page, 'presented, super working', [a, b], (v) => (v === null ? 'present with both' : v?.mode === 'present' && [a, b].every((id) => v.cards?.includes(id))), 'present');
    await shot(page, '2b-present-busy');
    await until(page, async () => (await superComposer(page).count()) > 0, 20000);
    await page.waitForTimeout(2000);
  }

  console.log('\n── one page presented on its own');
  const one = await agent(page, `super present ${a}`);
  ok('`super present a` succeeded', one && one.status === 0, JSON.stringify(one));
  await steadyIn(page, 'presented alone', [a], (v) => (v === null ? 'present with the one page' : v?.mode === 'present' && v.cards?.length === 1 && v.cards[0] === a), 'present');
  await shot(page, '3-present-one');

  console.log('\n── a large floating card');
  ok('`super present --off`', (await agent(page, 'super present --off'))?.status === 0);
  ok('`super half --off`', (await agent(page, 'super half --off'))?.status === 0);
  ok('`super shape a large`', (await agent(page, `super shape ${a} large`))?.status === 0);
  await steadyIn(page, 'floating large', [a], (v) => (v === null ? 'float' : v?.mode === 'float'), 'float');
  await shot(page, '4-float-large');

  console.log('\n── the whole run: each page loaded once');
  const whole = await page.evaluate(() => window.__steady);
  console.log(`  · ${JSON.stringify(whole)}`);
  // The first page is on screen from the open to the end: one frame, one load.
  ok(`${a}: ONE frame from the open on, through side by side, presented and floating`, whole?.made?.[a] === 1, JSON.stringify(whole));
  ok(`${a}: its page loaded once`, whole?.loads?.[a] === 1, JSON.stringify(whole));
  // The second leaves the screen (side by side and "presented alone" show only the first): a
  // project page holds a frame only on screen (webBudget), so it loads again when it is back,
  // and never twice in one frame.
  ok(`${b}: every frame it made loaded its page once (never reloaded in place)`, whole?.made?.[b] >= 1 && whole?.loads?.[b] === whole?.made?.[b], JSON.stringify(whole));

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join('\n'));
  await context.close();
} catch (e) {
  if (e?.done) { /* the narrow run ends after its one state */ } else {
  fails.push(`crashed: ${e?.stack || e}`);
  if (lastPage) await lastPage.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  console.log(`  ✗ crashed: ${e?.stack || e}`);
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.kill();
  // The scratch HOME, its vault and any seeded copy go with the run (VERIFY_KEEP=1 keeps them).
  if (!process.env.VERIFY_KEEP) { await sleep(500); rmSync(SCRATCH, { recursive: true, force: true }); }
}
console.log(`\n${pass} passed, ${fails.length} failed. Screenshots: ${OUT}`);
process.exit(fails.length === 0 ? 0 : 1);
