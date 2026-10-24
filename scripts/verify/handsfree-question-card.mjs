#!/usr/bin/env node
/**
 * Hands-free phone: a question card keeps its pick, the chat does not jump, an answer is never
 * silently lost, and the phone can send its connection log to the Mac
 * (task hands-free-telefonda-soru-kartindaki-secim-kaybolmaz-ve-ekran-ziplamaz, AC6).
 *
 *   npm run build && node scripts/verify/handsfree-question-card.mjs
 *
 * THE BUG (owner's recording, 2026-10-23, the published 0.32.0): on the phone a picked option of
 * a 4-question card vanished ~0.5 s after the tap, the chat jumped every second, and an
 * already-sent message flashed in the composer. Measured: an open-then-drop socket loop retried
 * every second (the backoff reset on every open), the "Reconnecting…" chip took layout above
 * the transcript, a card remount (an idle reattach, leaving the chat) lost its local picks, a
 * Submit while down removed the card anyway, and an account switch showed the held text as a
 * queue row.
 *
 * WHAT IT DRIVES: the real dashboard server (scratch HOME, desktop flag, the power runner only
 * logging, the loopback stand-in tunnel so the page goes through the PHONE LISTENER), a
 * scripted `claude` that raises a 4-question AskUserQuestion card on "ASK", and Chromium as the
 * phone at 390x844 and 1220x900. Playwright's `routeWebSocket` sits on the chat socket: it drops
 * it, holds it closed, swallows the page's frames (a half-open socket), rewrites a `reattached`
 * to `busy:false` (the idle reattach that re-sends the same ask) and injects an account switch.
 *
 *   (a) picks + note + "Other" + page survive drops; the waits climb 1 → 2 → 5 → 10 s and fall
 *       back to 1 s after an open that lasts 6 s; scrollTop stays within ±2 px;
 *   (b) a `busy:false` reattach (same ask re-sent) and leaving to the list and back remount the
 *       card; the tab stays in the roster (parked, never closed); everything is restored;
 *   (c) OFFLINE: every attempt closed inside the route callback; after ≥ 4 failures the waiting
 *       line is in the footer (card height unchanged); a Submit tap keeps the picks and makes an
 *       attempt within ~1 s; released, the same ask returns intact and ONE answer reaches claude;
 *   (c′) HALF-OPEN: the page's frames are swallowed, Submit "succeeds", the socket dies, the same
 *       ask is re-sent after an idle reattach: the card comes back with its picks;
 *   (d) account auto-switch with a card open: the switch waits for the answer; after the
 *       respawn the held text is never in the composer or a visible queue row, and reaches the
 *       new claude exactly once;
 *   (e) the Sohbetler list, normal and Super handed-over: both footers carry "send the
 *       connection log"; a tap says how many events reached the Mac; exactly one 0600 file
 *       holding only the schema's keys lands in the scratch HOME's phone-logs.
 *   Across the run: no console error. Screenshots per step: tmp/verify-handsfree-question-card/.
 *
 * FAILURE POLICY: collect, don't fail fast; exit 0 iff every check passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(realpathSync(tmpdir()), 'dreamcontext-verify-handsfree-question-card');
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'proj');
const SHOTS = join(REPO, 'tmp', 'verify-handsfree-question-card');
const CLI = process.env.DC_CLI || join(REPO, 'dist', 'index.js');
const USERS = join(HOME, 'users.log');
const ANSWERS = join(HOME, 'answers.log');
const LOGS = join(HOME, '.dreamcontext', 'handsfree-mac', 'phone-logs');
const HELD = 'Bu mesaj hesap değişiminden önce gönderilmişti ve bir kez gitmeli';

/** `claude -p` stand-in: "ASK…" raises a 4-question card; an answer ends the turn. */
const CLAUDE = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || crypto.randomUUID();
const cfg = process.env.CLAUDE_CONFIG_DIR || '';
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const row = (o) => fs.appendFileSync(transcript, JSON.stringify({ ...o, cwd: process.cwd(), uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), sessionId: sid }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = (f, o) => fs.appendFileSync(path.join(process.env.HOME, f), JSON.stringify({ sid, cfg, ...o }) + '\\n');
const QUESTIONS = [
  { question: 'Hangi renk?', header: 'Renk', options: [{ label: 'Mavi' }, { label: 'Yeşil' }, { label: 'Kırmızı' }] },
  { question: 'Hangi boy?', header: 'Boy', options: [{ label: 'Küçük' }, { label: 'Orta' }, { label: 'Büyük' }] },
  { question: 'Ne zaman?', header: 'Zaman', options: [{ label: 'Bugün' }, { label: 'Yarın' }] },
  { question: 'Kim yapsın?', header: 'Kim', options: [{ label: 'Ben' }, { label: 'Sen' }] },
];
let inited = false; let buf = ''; let n = 0;
const end = (text) => {
  const message = { role: 'assistant', content: [{ type: 'text', text }] };
  row({ type: 'assistant', message }); out({ type: 'assistant', message });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
};
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') {
      const r = o.response || {};
      log('answers.log', { requestId: r.request_id, behavior: r.response && r.response.behavior });
      end('Cevap alındı.');
      continue;
    }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    log('users.log', { text });
    if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
    row({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    if (text.startsWith('ASK')) {
      n += 1;
      out({ type: 'control_request', request_id: 'ask-' + sid.slice(0, 4) + '-' + n + '-' + crypto.randomUUID().slice(0, 6), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', requires_user_interaction: true, input: { questions: QUESTIONS } } });
      continue;
    }
    end('ECHO ' + text);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const report = {
  pass: 0, fails: [],
  check(label, cond, detail) {
    if (cond) { this.pass++; console.log(`  ✓ ${label}`); }
    else { this.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
  },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const near = (ms, want, slack = 600) => Math.abs(ms - want) <= slack;


/** Two accounts, so an auto-switch has somewhere to go (the account frame itself is injected).
 *  Written only for phase (d): with a register present at start the phone's capabilities differ. */
function writeAccounts() {
  const spareDir = join(HOME, '.dreamcontext', 'claude-accounts', 'spare');
  writeFileSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({
    accounts: [
      { id: 'main', accountUuid: 'u-main', email: 'main@example.com', organizationUuid: 'o', organizationName: 'Example', tier: 'max', configDir: null, preferred: true },
      { id: 'spare', accountUuid: 'u-spare', email: 'spare@example.com', organizationUuid: 'o', organizationName: 'Example', tier: 'max', configDir: spareDir, preferred: false },
    ],
    autoSwitch: true,
  }, null, 2));
}

let server = null;
let browser = null;
const nodeSockets = [];
try {
  const { chromium, devices } = await import('@playwright/test');
  const { WebSocket: NodeWs } = await import('ws');
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), PROJ, SHOTS]) mkdirSync(d, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: PROJ });
  mkdirSync(join(HOME, '.claude', 'projects', PROJ.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, CLAUDE);
  chmodSync(bin, 0o755);
  cli(['init', '-y', '--name', 'proj', '--description', 'A scratch project for the question card check']);
  cli(['vaults', 'add', 'proj', PROJ]);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath), join(HOME, '.local', 'bin')].join(':');
  server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ,
    env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(SCRATCH, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!(await until(async () => (await fetch(`${base}/`)).ok, 30000, 300))) throw new Error('server did not come up');
  const api = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'proj' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  report.check('Mac mode is set up', (await api('POST', '/api/handsfree/mac/setup', {})).status === 200);
  report.check('Mac mode starts for the project (loopback stand-in tunnel)', (await api('POST', '/api/handsfree/mac/start', { vaults: ['proj'] })).status === 200);

  browser = await chromium.launch();
  for (const width of [390, 1220]) {
    const W = `${width}`;
    const height = width === 390 ? 844 : 900;
    console.log(`\n══ ${width} px`);
    rmSync(join(HOME, '.dreamcontext', 'claude-accounts.json'), { force: true });
    const qr = (await api('POST', '/api/handsfree/mac/qr')).json.url;
    report.check(`${W}: a one-time sign-in link on the phone listener`, typeof qr === 'string' && !qr.includes(`:${port}/`), qr);
    const ctx = await browser.newContext(width === 390
      ? { ...devices['iPhone 13'], viewport: { width, height } }
      : { viewport: { width, height }, hasTouch: true });
    await markAnnouncementsSeen(ctx, base);

    // ── The chat socket, under our hand ──────────────────────────────────────────────
    let mode = 'pass';                 // 'pass' | 'hold' | 'swallow'
    let rewriteNextReattached = false;
    let cur = null;                    // the live { page, server } pair
    const attempts = [];               // one per socket the page opened
    const answerFrames = [];           // every answer frame the page wrote
    await ctx.routeWebSocket(/\/api\/agent\/chat/, async (ws) => {
      attempts.push({ at: Date.now(), mode });
      if (mode === 'hold') { await ws.close(); return; }
      const srv = ws.connectToServer();
      const pair = { page: ws, server: srv, swallow: mode === 'swallow', dead: false, delayUntil: 0, chain: Promise.resolve() };
      cur = pair;
      ws.onMessage((m) => {
        const s = typeof m === 'string' ? m : m.toString();
        try { const f = JSON.parse(s); if (f.type === 'answer') answerFrames.push({ requestId: f.requestId, swallowed: pair.swallow, at: Date.now() }); } catch { /* not json */ }
        if (pair.swallow || pair.dead) return;
        srv.send(m);
      });
      srv.onMessage((m) => {
        let s = typeof m === 'string' ? m : m.toString();
        if (rewriteNextReattached && s.includes('"reattached"')) {
          try {
            const f = JSON.parse(s);
            // The frames after it (the re-sent ask) wait a beat, so the client renders the
            // cleared card before the ask brings it back: a real remount, not a batched no-op.
            if (f.subtype === 'reattached') { f.busy = false; s = JSON.stringify(f); rewriteNextReattached = false; pair.delayUntil = Date.now(); }
          } catch { /* not json */ }
          if (!pair.dead) ws.send(s);
          return;
        }
        if (pair.delayUntil && Date.now() < pair.delayUntil + 1500) {
          pair.chain = pair.chain.then(() => sleep(400)).then(() => { if (!pair.dead) ws.send(s); });
          return;
        }
        if (!pair.dead) ws.send(s);
      });
      ws.onClose(() => { pair.dead = true; srv.close().catch(() => {}); });
      srv.onClose((code, reason) => {
        if (process.env.QC_DEBUG) console.log(`    [route] server closed ${code} ${reason}`);
        pair.dead = true; ws.close().catch(() => {});
      });
    });
    const drop = async () => {
      const c = cur; cur = null;
      if (!c) return;
      c.dead = true;
      await c.page.close().catch(() => {});
      await c.server.close().catch(() => {});
    };
    const inject = (frame) => cur?.page.send(JSON.stringify(frame));

    const phone = await ctx.newPage();
    const errors = [];
    phone.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    phone.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
    if (process.env.QC_DEBUG) {
      phone.on('websocket', (w) => { console.log(`    [page ws] ${w.url()}`); w.on('close', () => console.log(`    [page ws] closed ${w.url().slice(0, 80)}`)); w.on('socketerror', (e) => console.log(`    [page ws] error ${e}`)); });
      phone.on('console', (m) => console.log(`    [console ${m.type()}] ${m.text().slice(0, 200)}`));
    }
    const vis = (sel) => phone.locator(`${sel}:visible`);
    let shot = 0;
    const snap = async (name) => { shot += 1; await phone.screenshot({ path: join(SHOTS, `${W}-${String(shot).padStart(2, '0')}-${name}.png`) }); };
    const connLog = () => phone.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('dc-phone-conn-log') || '[]'); } catch { return []; } });
    const count = async (k) => (await connLog()).filter((e) => e.k === k).length;
    const card = () => phone.evaluate(() => {
      const cards = [...document.querySelectorAll('.chat-surveycard')].filter((c) => c.getBoundingClientRect().height > 0 && c.getAttribute('data-state') !== 'submitted');
      const el = cards[cards.length - 1];
      if (!el) return null;
      const pages = [...el.querySelectorAll('.chat-surveycard-page')];
      return {
        page: pages.findIndex((p) => !p.hasAttribute('inert')),
        on: pages.map((p) => [...p.querySelectorAll('.chat-surveycard-opt.on .chat-surveycard-opt-title')].map((t) => t.textContent)),
        field: pages.map((p) => p.querySelector('.chat-surveycard-fieldinput')?.value ?? ''),
        waiting: el.querySelector('.chat-surveycard-waiting')?.textContent ?? null,
        height: Math.round(el.getBoundingClientRect().height),
      };
    });
    const pageSel = '.chat-surveycard:not([data-state="submitted"]) .chat-surveycard-page:not([inert])';
    /** Tap option i on the page in view; confirmed, and tapped again if a layout shift ate it. */
    const pickOpt = async (i) => {
      const opt = vis(`${pageSel} .chat-surveycard-opt:not(.other)`).nth(i);
      for (let n = 0; n < 3; n++) {
        await opt.click();
        if (await until(async () => (await opt.getAttribute('aria-pressed')) === 'true', 1000, 50)) return;
      }
    };
    const typeField = (t) => vis(`${pageSel} .chat-surveycard-fieldinput`).first().fill(t);
    const next = async () => {
      const was = (await card())?.page ?? -1;
      await vis('.chat-surveycard-actions .chat-btn.primary').last().click();
      await until(async () => ((await card())?.page ?? -1) > was, 3000, 50);
      await phone.waitForTimeout(350);   // the track slides; click the settled page
    };
    const submitBtn = () => vis('.chat-surveycard-actions .chat-btn.primary').last();
    const send = async (text) => {
      await vis('.chat-cmp-input').first().fill(text);
      await vis('.chat-cmp-input').first().press('Enter');
    };
    const startScrollWatch = () => phone.evaluate(() => {
      const el = [...document.querySelectorAll('.chat-scroll')].find((e) => e.getBoundingClientRect().height > 0);
      const cardTop = () => {
        const cards = [...document.querySelectorAll('.chat-surveycard')].filter((c) => c.getBoundingClientRect().height > 0 && c.getAttribute('data-state') !== 'submitted');
        return Math.round(cards[cards.length - 1]?.getBoundingClientRect().top ?? -1);
      };
      const top0 = cardTop();
      window.__scroll = { min: el.scrollTop, max: el.scrollTop, topMin: top0, topMax: top0, chMin: el.clientHeight, chMax: el.clientHeight, changes: [] };
      let last = '';
      const t0 = performance.now();
      window.__scrollTimer = setInterval(() => {
        const t = el.scrollTop; if (t < window.__scroll.min) window.__scroll.min = t; if (t > window.__scroll.max) window.__scroll.max = t;
        const ct = cardTop(); if (ct < window.__scroll.topMin) window.__scroll.topMin = ct; if (ct > window.__scroll.topMax) window.__scroll.topMax = ct;
        const ch = el.clientHeight; if (ch < window.__scroll.chMin) window.__scroll.chMin = ch; if (ch > window.__scroll.chMax) window.__scroll.chMax = ch;
        const k = `${t}/${el.scrollHeight}/${ch}/card@${ct}`;
        if (k !== last) { last = k; if (window.__scroll.changes.length < 40) window.__scroll.changes.push(`${Math.round(performance.now() - t0)}ms ${k}`); }
      }, 50);
    });
    const stopScrollWatch = () => phone.evaluate(() => { clearInterval(window.__scrollTimer); return window.__scroll; });
    /** Wait for the client's next `open`, then drop; return ms until the page's next attempt. */
    const opensBefore = { n: 0 };
    const waitOpen = async () => { const ok = await until(async () => (await count('open')) > opensBefore.n, 40000, 50); opensBefore.n = await count('open'); return ok; };
    const dropAndMeasure = async () => {
      const n = attempts.length;
      const t0 = Date.now();
      await drop();
      await until(() => attempts.length > n, 40000, 20);
      return attempts.length > n ? attempts[n].at - t0 : -1;
    };

    // ── Sign in, open a chat, raise the card ─────────────────────────────────────────
    await phone.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    report.check(`${W}: signed in through the phone listener`, await until(async () => phone.url().includes('vault=proj'), 25000), phone.url());
    report.check(`${W}: the page is the Mac phone surface`, await until(() => phone.evaluate(() => document.querySelector('meta[name="dreamcontext-surface"]')?.getAttribute('content') === 'mac'), 10000));
    report.check(`${W}: the Sohbetler list`, await until(async () => (await vis('[data-testid="phone-list"]').count()) === 1, 20000));
    for (let i = 0; i < 3; i++) { const x = phone.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await phone.waitForTimeout(300); }
    if (process.env.QC_DEBUG) console.log('    [caps]', JSON.stringify(await phone.evaluate(async () => (await fetch('/api/agent/capabilities', { credentials: 'same-origin' })).json())).slice(0, 400),
      '[settings]', await phone.evaluate(() => Object.keys(localStorage).filter((k) => /agent|chat/i.test(k)).map((k) => `${k}=${localStorage.getItem(k)}`.slice(0, 900)).join(' | ')));
    // "New chat" before the app has read its capabilities opens a terminal tab: let it settle.
    await phone.waitForLoadState('networkidle').catch(() => {});
    await phone.waitForTimeout(2500);
    await vis('[data-testid="list-new"]').click();
    report.check(`${W}: a new chat opens`, await until(async () => (await vis('.chat-cmp-input').count()) > 0, 15000), JSON.stringify({ attempts: attempts.length, log: (await connLog()).slice(-6) }));
    await snap('chat-open');
    await waitOpen();
    // A transcript taller than the screen: the old jump showed as scrollTop moving while the
    // chip took layout, which a transcript that does not scroll could never show.
    const filler = 'Bu uzun bir dolgu mesajı, transkripti ekrandan uzun yapmak için yazıldı. '.repeat(4);
    for (let i = 1; i <= 8; i++) {
      await send(`${i}. ${filler}`);
      await until(async () => (await vis('.chat-pane').first().innerText()).includes(`ECHO ${i}. `), 10000, 100);
    }
    await send('ASK bir soru kartı aç');
    report.check(`${W}: the 4-question card is on screen`, await until(async () => (await card())?.on.length === 4, 15000), JSON.stringify(await card()));
    const cid8 = ((await connLog()).find((e) => e.k === 'ask') ?? {}).cid8;
    await snap('card');

    // ── (a) picks survive drops; the ladder; no jump ─────────────────────────────────
    console.log(`\n── ${W} (a) drops: picks stay, waits climb, nothing jumps`);
    await pickOpt(1);
    await typeField('daha koyu');
    await next();
    await vis(`${pageSel} .chat-surveycard-opt.other`).click();
    await typeField('turuncu olsun');
    const want = { page: 1, q1: ['Yeşil'], q1note: 'daha koyu', q2: ['Other'], q2text: 'turuncu olsun' };
    const intact = (c) => !!c && c.page === want.page && JSON.stringify(c.on[0]) === JSON.stringify(want.q1) && c.field[0] === want.q1note
      && JSON.stringify(c.on[1]) === JSON.stringify(want.q2) && c.field[1] === want.q2text;
    report.check(`${W}: picked option 2 + a note, then "Other" + text on Q2`, intact(await card()), JSON.stringify(await card()));
    await snap('picked');
    // Let the first open settle past the stable window so the ladder starts at its first rung.
    await phone.waitForTimeout(5500);
    const overflow0 = await phone.evaluate(() => { const el = [...document.querySelectorAll('.chat-scroll')].find((e) => e.getBoundingClientRect().height > 0); return { sh: el.scrollHeight, ch: el.clientHeight, top: el.scrollTop }; });
    report.check(`${W}: the transcript scrolls (scrollHeight ${overflow0.sh} > clientHeight ${overflow0.ch}, at ${overflow0.top})`, overflow0.sh > overflow0.ch + 100 && overflow0.top > 0, JSON.stringify(overflow0));
    await startScrollWatch();
    const waits = [];
    for (let i = 0; i < 4; i++) {
      waits.push(await dropAndMeasure());
      report.check(`${W}: reopen ${i + 1} reached the client`, await waitOpen());
    }
    report.check(`${W}: open-then-drop waits climb ≈ 1 → 2 → 5 → 10 s (${waits.join(', ')} ms)`,
      near(waits[0], 1000) && near(waits[1], 2000) && near(waits[2], 5000) && near(waits[3], 10000, 900), JSON.stringify(waits));
    await phone.waitForTimeout(6000);
    const reset = await dropAndMeasure();
    report.check(`${W}: after an open that lasted 6 s the wait is back to ≈ 1 s (${reset} ms)`, near(reset, 1000));
    await waitOpen();
    const sc = await stopScrollWatch();
    // What the eye sees: the card does not move on screen and the viewport does not shrink.
    // (scrollTop itself may follow content appended above while pinned to the bottom — the
    // first reconnect's "earlier conversation · resumed" divider — which moves nothing.)
    report.check(`${W}: the card stayed put on screen through every drop (top ${sc.topMin}..${sc.topMax}, viewport ${sc.chMin}..${sc.chMax}, scrollTop ${sc.min}..${sc.max})`,
      sc.topMax - sc.topMin <= 4 && sc.chMax === sc.chMin && sc.topMin >= 0, JSON.stringify(sc));
    report.check(`${W}: picks, note, Other text and page intact after the drops`, intact(await card()), JSON.stringify(await card()));
    await snap('after-drops');

    // ── (b) remounts: an idle reattach re-sends the ask; leaving the chat and back ───
    console.log(`\n── ${W} (b) remount: busy:false reattach, list and back`);
    const mountsBefore = await count('card-mount');
    rewriteNextReattached = true;
    await dropAndMeasure();
    await waitOpen();
    report.check(`${W}: the reattach was rewritten to busy:false`, await until(() => !rewriteNextReattached, 10000));
    report.check(`${W}: the server re-sent the same ask and the card mounted again`, await until(async () => (await count('card-mount')) > mountsBefore, 10000), String(await count('card-mount')));
    report.check(`${W}: picks restored after the idle-reattach remount`, await until(async () => intact(await card()), 5000), JSON.stringify(await card()));
    await vis('[data-testid="chat-back"]').first().click();
    report.check(`${W}: back on the list, the chat is still a row (parked, not closed)`, await until(async () => (await vis('[data-testid="list-tab-row"]').count()) >= 1, 10000));
    await snap('list-parked');
    await vis('[data-testid="list-tab-row"]').first().click();
    report.check(`${W}: back in the chat, the card mounted again and everything is restored`, await until(async () => (await count('card-mount')) >= mountsBefore + 1 && intact(await card()), 15000), JSON.stringify({ mounts: await count('card-mount'), card: await card() }));
    await snap('remounted');

    // ── (c) offline: Submit is never dead, nothing is lost ───────────────────────────
    console.log(`\n── ${W} (c) offline: the waiting line, a tap reconnects, one answer`);
    await next();
    await pickOpt(0);
    await next();
    await pickOpt(1);
    report.check(`${W}: all four answered, Submit is on the last page`, await until(async () => (await submitBtn().textContent())?.includes('Submit'), 5000));
    const before = await card();
    const askId = (await connLog()).filter((e) => e.k === 'ask').pop()?.req8;
    await phone.waitForTimeout(5500);   // a stable open: the hold below starts the ladder at 1 s
    const opensAtHold = await count('open');
    mode = 'hold';
    const holdStart = attempts.length;
    await drop();
    report.check(`${W}: ≥ 4 attempts failed while held`, await until(() => attempts.length - holdStart >= 4, 30000, 50), String(attempts.length - holdStart));
    report.check(`${W}: the waiting line shows in the footer`, await until(async () => !!(await card())?.waiting, 3000), JSON.stringify(await card()));
    const down = await card();
    report.check(`${W}: the card's height did not change (${before.height} → ${down.height})`, Math.abs(down.height - before.height) <= 1);
    await snap('offline-waiting');
    const tapAt = Date.now();
    const n0 = attempts.length;
    await submitBtn().click();
    report.check(`${W}: a Submit tap while down makes an attempt within ~1 s`, await until(() => attempts.length > n0, 1500, 20), `${attempts.length > n0 ? attempts[n0].at - tapAt : '-'} ms`);
    const kept = await card();
    report.check(`${W}: …and keeps every pick (no receipt, no answer frame)`, !!kept && kept.on.every((o) => o.length > 0) && answerFrames.length === 0, JSON.stringify({ kept, answerFrames }));
    report.check(`${W}: no open was logged during the hold`, (await count('open')) === opensAtHold);
    mode = 'pass';
    await phone.waitForTimeout(1100);
    await submitBtn().click();   // still down: this tap asks for the connection now
    report.check(`${W}: released, the socket opens again`, await waitOpen());
    report.check(`${W}: the same ask is back with every pick`, await until(async () => {
      const c = await card();
      return !!c && c.on.every((o) => o.length > 0) && c.field[0] === want.q1note && c.field[1] === want.q2text && !c.waiting;
    }, 10000), JSON.stringify(await card()));
    const answersBefore = lines(ANSWERS).length;
    await submitBtn().click();
    report.check(`${W}: exactly one answer frame reached the server`, await until(() => lines(ANSWERS).length === answersBefore + 1, 10000)
      && answerFrames.filter((f) => !f.swallowed).length === 1, JSON.stringify({ answerFrames, answers: lines(ANSWERS).slice(answersBefore) }));
    report.check(`${W}: …for that card (${askId})`, (answerFrames[0]?.requestId ?? '').startsWith(askId ?? '#'));
    await phone.waitForTimeout(800);
    await snap('answered');

    // ── (c′) half-open: written is not arrived ──────────────────────────────────────
    console.log(`\n── ${W} (c′) half-open: the re-sent ask finds its picks`);
    await send('ASK ikinci kart');
    report.check(`${W}: a second card`, await until(async () => (await card())?.on.length === 4, 15000));
    for (const i of [2, 0, 1, 1]) { await pickOpt(i); if ((await card()).page < 3) await next(); }
    await typeField('yarı açık soket');
    const half = await card();
    mode = 'swallow';
    await dropAndMeasure();
    await waitOpen();
    await phone.waitForTimeout(400);
    const swallowedBefore = answerFrames.filter((f) => f.swallowed).length;
    await submitBtn().click();
    report.check(`${W}: Submit wrote the answer (swallowed on the way) and the card left`, await until(async () => answerFrames.filter((f) => f.swallowed).length > swallowedBefore && (await card()) === null, 5000));
    mode = 'pass';
    rewriteNextReattached = true;
    await dropAndMeasure();
    await waitOpen();
    report.check(`${W}: the same ask came back with its option, note and page`, await until(async () => {
      const c = await card();
      return !!c && JSON.stringify(c.on) === JSON.stringify(half.on) && c.field[3] === 'yarı açık soket' && c.page === half.page;
    }, 10000), JSON.stringify({ half, now: await card() }));
    await snap('half-open-restored');
    const a2 = lines(ANSWERS).length;
    await submitBtn().click();
    report.check(`${W}: answered for real this time`, await until(() => lines(ANSWERS).length === a2 + 1, 10000));

    // ── (d) account auto-switch with a card open ─────────────────────────────────────
    console.log(`\n── ${W} (d) account switch: no stale text, sent once`);
    writeAccounts();
    await send('ASK üçüncü kart');
    report.check(`${W}: a third card`, await until(async () => (await card())?.on.length === 4, 15000));
    await phone.waitForTimeout(500);
    inject({ type: '_meta', subtype: 'account_switch', switched: true, reason: 'limit_hit', accountId: 'spare', fromAccountId: 'main', turnInFlight: true, pendingText: HELD, pendingTexts: [HELD] });
    await phone.waitForTimeout(2500);
    report.check(`${W}: the switch waits while the card is open (no respawn yet)`, (await count('respawn')) === 0 && !!(await card()));
    await phone.evaluate((held) => {
      window.__stale = [];
      window.__staleTimer = setInterval(() => {
        const rows = [...document.querySelectorAll('.chat-queue')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.textContent || '');
        const boxes = [...document.querySelectorAll('.chat-cmp-input')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.value || e.textContent || '');
        if (rows.some((t) => t.includes(held))) window.__stale.push('queue');
        if (boxes.some((t) => t.includes(held))) window.__stale.push('composer');
      }, 25);
    }, HELD);
    for (const i of [0, 0, 0, 0]) { await pickOpt(i); if ((await card()).page < 3) await next(); }
    await snap('switch-card-answered');
    await submitBtn().click({ timeout: 8000 }).catch(async (e) => { report.check(`${W}: (d) Submit enabled`, false, JSON.stringify(await card())); throw e; });
    report.check(`${W}: answered, the chat respawned on the spare account`, await until(async () => (await count('respawn')) === 1, 15000));
    report.check(`${W}: the held text reached the new claude exactly once`, await until(() => lines(USERS).filter((u) => u.text === HELD).length === 1, 15000), JSON.stringify(lines(USERS).filter((u) => u.text === HELD)));
    await phone.waitForTimeout(1500);
    const stale = await phone.evaluate(() => { clearInterval(window.__staleTimer); return window.__stale; });
    report.check(`${W}: the held text was never in the composer or a visible queue row`, stale.length === 0, JSON.stringify(stale.slice(0, 5)));
    report.check(`${W}: …and went to the spare account's claude`, lines(USERS).filter((u) => u.text === HELD).every((u) => u.cfg.includes('spare')), JSON.stringify(lines(USERS).filter((u) => u.text === HELD)));
    await snap('after-switch');
    await phone.waitForTimeout(11_000);   // spread the log posts below past the 10 s limit

    // ── (e) the list footers send the connection log ─────────────────────────────────
    console.log(`\n── ${W} (e) the list's "send the connection log"`);
    await vis('[data-testid="chat-back"]').first().click();
    report.check(`${W}: back on the Sohbetler list`, await until(async () => (await vis('[data-testid="phone-list"]').count()) === 1, 10000));
    const postLog = async (state) => {
      const btn = vis('[data-testid="phone-log-send"]');
      report.check(`${W} ${state}: the footer has "send the connection log"`, (await btn.count()) === 1);
      await btn.scrollIntoViewIfNeeded();
      await snap(`list-${state}-footer`);
      const filesBefore = existsSync(LOGS) ? readdirSync(LOGS).length : 0;
      await btn.click();
      const note = vis('[data-testid="phone-log-note"]');
      let text = '';
      report.check(`${W} ${state}: the status line says how many events reached the Mac`, await until(async () => {
        text = ((await note.textContent().catch(() => '')) || '').trim();
        return /^(Kayıt Mac'e gönderildi|Log sent to the Mac) \(\d+ (olay|events)\)$/.test(text);
      }, 8000), text);
      await snap(`list-${state}-sent`);
      const files = existsSync(LOGS) ? readdirSync(LOGS).sort() : [];
      report.check(`${W} ${state}: exactly one new file`, files.length === filesBefore + 1, JSON.stringify(files));
      const f = join(LOGS, files[files.length - 1] ?? 'none');
      const ok = existsSync(f);
      const mode0600 = ok && (statSync(f).mode & 0o777) === 0o600;
      const doc = ok ? JSON.parse(readFileSync(f, 'utf-8')) : {};
      const keysOk = JSON.stringify(Object.keys(doc).sort()) === '["app","events","ua","v"]'
        && (doc.events ?? []).every((e) => Object.keys(e).every((k) => ['t', 'k', 'cid8', 'code', 'busy', 'req8', 'reason'].includes(k)));
      report.check(`${W} ${state}: the file is 0600 and holds only the schema's keys`, mode0600 && keysOk, JSON.stringify({ mode: ok ? (statSync(f).mode & 0o777).toString(8) : null, keys: Object.keys(doc) }));
      report.check(`${W} ${state}: the log carries this chat's drops (close/attempt/open for ${cid8})`, (doc.events ?? []).some((e) => e.k === 'close' && e.cid8 === cid8) && (doc.events ?? []).some((e) => e.k === 'submit-held'));
      report.check(`${W} ${state}: no message text in it`, !JSON.stringify(doc).includes('ASK') && !JSON.stringify(doc).includes(HELD.slice(0, 20)) && !JSON.stringify(doc).includes('turuncu'));
    };
    await postLog('normal');
    // The Super Agent handed over: the list is its one row, with the same footer.
    const MAC_ID = crypto.randomUUID();
    const laptop = (q) => new Promise((resolve) => {
      const ws = new NodeWs(`ws://127.0.0.1:${port}/api/agent/chat?vault=proj&bypass=0&${q}`);
      nodeSockets.push(ws);
      ws.on('error', () => {});
      ws.on('open', () => resolve(ws)); ws.on('close', () => resolve(ws));
    });
    const plain = await laptop(`sessionId=${MAC_ID}`);
    await sleep(800);
    plain.send(JSON.stringify({ type: 'user', text: 'tidy the release notes' }));
    const en = await api('POST', '/api/super/enable', { adopt: [MAC_ID], titles: { [MAC_ID]: 'Release notes' } });
    report.check(`${W}: the Super Agent is handed over`, en.status === 200 && typeof en.json.session === 'string', JSON.stringify(en.json).slice(0, 200));
    await laptop(`mode=super&sessionId=${en.json.session}`);
    report.check(`${W}: the list shows the handed-over state`, await until(() => phone.evaluate(() => [...document.querySelectorAll('[data-testid="phone-list"]')].some((e) => e.getBoundingClientRect().height > 0 && e.getAttribute('data-super') === 'true')), 20000));
    await phone.waitForTimeout(10_500);
    await postLog('super');
    await api('POST', '/api/super/disable', {});
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    report.check(`${W}: no horizontal overflow`, !overflow);
    const errs = errors.filter((e) => !/__TAURI/.test(e));
    report.check(`${W}: no console errors`, errs.length === 0, errs.slice(0, 6).join('\n      '));
    for (const s of nodeSockets.splice(0)) { try { s.close(); } catch { /* gone */ } }
    await ctx.close();
  }
} catch (err) {
  report.check('the run completed', false, String(err?.stack ?? err).slice(0, 800));
} finally {
  for (const s of nodeSockets) { try { s.close(); } catch { /* gone */ } }
  await browser?.close().catch(() => {});
  server?.kill();
}
console.log(`\n${report.pass} passed, ${report.fails.length} failed${report.fails.length ? `:\n  - ${report.fails.join('\n  - ')}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(report.fails.length ? 1 : 0);
