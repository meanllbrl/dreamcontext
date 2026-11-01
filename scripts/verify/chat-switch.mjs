#!/usr/bin/env node
/**
 * How long a click on a drawer row takes to put the target chat on screen, and whether the
 * transcript moves afterwards. Real dashboard, scratch HOME, fictional projects, a scripted
 * `claude` stand-in (no tokens spent). Needs the built app (dist/): the chat socket is not proxied
 * by the dev server.
 *
 *   node scripts/verify/chat-switch.mjs --tag before --out tmp/switch [--rounds 5] [--cpu 1]
 *        [--real a.jsonl,b.jsonl,...]   # measure on real transcripts instead of the synthetic ones
 *        [--trace]                      # a Chromium trace of 3 laps into <out>/<tag>.trace.json
 *        [--profile]                    # one CDP CPU profile of a round, top self times
 *        [--tabs n]                     # n more chat windows in acme
 *        [--live]                       # the target chat streams while it is switched to
 *
 * What a frame logs (one row per frame, read past paint, on the page itself):
 *   - which session's container is in the visible transcript slot,
 *   - that transcript's scrollTop, scrollHeight, and the viewport y of its last row.
 * `paint` = click to the first frame with the target's container on screen and its last row inside
 * the viewport. `settle` = the last frame after that in which the last row moved, and `shift` how
 * far it moved. Frames are cleaned of nothing: what is printed is what was on screen.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/verify-chat-switch'));
const TAG = arg('tag', 'after');
const ROUNDS = Number(arg('rounds', 5));
const CPU = Number(arg('cpu', 1));
const PORT = Number(arg('port', 45871 + Math.floor(Math.random() * 500)));
const REAL = (arg('real', '') || '').split(',').filter(Boolean);
const CLI = join(REPO, 'dist', 'index.js'); // --repo: another build to measure, same script
const SCRATCH = join(tmpdir(), `dc-chat-switch-${TAG}-${process.pid}`);
mkdirSync(OUT, { recursive: true });

const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || 'v-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
process.stdin.on('data', async (c) => {
  buf += c; let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'user') continue;
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' + Date.now(), role: 'assistant', content: [] } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    for (let i = 0; i < 400; i++) {
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'kelime ' } } });
      await sleep(40);
      if (i % 40 === 39) {
        const id = 'toolu_live_' + i;
        out({ type: 'assistant', message: { id: 'ml' + i, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo ' + i, description: 'Adım ' + i } }] } });
        await sleep(300);
        out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
      }
    }
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
    out({ type: 'stream_event', event: { type: 'message_stop' } });
    out({ type: 'result', subtype: 'success', result: '', session_id: sid, is_error: false });
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const HOME = join(SCRATCH, 'home');
const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });

/** A transcript shaped like a working session: turns of prose, tool calls and results. */
function synthetic(id, turns) {
  const rows = [];
  let n = 0;
  const e = (type, message) => rows.push(JSON.stringify({ type, uuid: randomUUID(), parentUuid: null, timestamp: new Date(Date.now() - 86400000 + (n++) * 1000).toISOString(), cwd: '/tmp/x', sessionId: id, version: '2.1.220', gitBranch: 'main', message }));
  const para = 'Sıradaki adımda dosyayı okudum, ilgili yolu izledim ve **sonucu** burada özetliyorum: `src/app.ts` değişti, testler geçiyor. '.repeat(3);
  for (let t = 0; t < turns; t++) {
    e('user', { role: 'user', content: [{ type: 'text', text: `Tur ${t}: sıradaki adımı yap ve bana yaz.` }] });
    for (let k = 0; k < 4; k++) {
      const tid = `toolu_${id.slice(0, 6)}_${t}_${k}`;
      e('assistant', { role: 'assistant', content: [{ type: 'text', text: k % 2 ? para : `Adım ${k}: bakıyorum.` }, { type: 'tool_use', id: tid, name: k % 2 ? 'Read' : 'Bash', input: k % 2 ? { file_path: '/tmp/x/src/app.ts' } : { command: `echo ${t}-${k}`, description: `Adım ${k}` } }] });
      e('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: [{ type: 'text', text: `çıktı ${t}-${k}\n`.repeat(20) }] }] });
    }
    e('assistant', { role: 'assistant', content: [{ type: 'text', text: `## Sonuç ${t}\n\n${para}\n\n- bir madde\n- iki madde\n\n\`\`\`ts\nconst a = ${t};\n\`\`\`` }] });
  }
  return rows.join('\n') + '\n';
}

const record = (session) => ({ v: 1, session, enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });

function project(name, chats) {
  const p = join(SCRATCH, name);
  mkdirSync(join(p, '_dream_context', 'state'), { recursive: true });
  spawnSync('git', ['-C', p, 'init', '-q']);
  dc(p, 'vaults', 'add', name, p);
  const superId = randomUUID();
  writeFileSync(join(p, '_dream_context', 'state', '.super-agent.json'), JSON.stringify(record(superId)));
  const sessions = chats.map((c, i) => ({ title: c.title, kind: 'chat', sessionId: c.id, pane: i, active: true, window: `w${i}`, size: 1, bypass: true }));
  const windows = chats.map((c, i) => ({ id: `w${i}`, name: c.title, activePane: i }));
  writeFileSync(join(p, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));
  return { name, p, superId };
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex', 'initech'], projectOrder: ['acme', 'globex', 'initech'], lastVault: 'acme' }));
  const EXTRA = Number(arg('tabs', 0));
  const chatsA = [{ title: 'Alpha', id: randomUUID() }, { title: 'Beta', id: randomUUID() }, ...Array.from({ length: EXTRA }, (_, i) => ({ title: `Extra ${i}`, id: randomUUID() }))];
  const chatsG = [{ title: 'Gamma', id: randomUUID() }];
  const A = project('acme', chatsA);
  const G = project('globex', chatsG);
  const chatsI = [{ title: 'Iota', id: randomUUID() }, { title: 'Kappa', id: randomUUID() }];
  const I = project('initech', chatsI);
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  const ids = [A.superId, chatsA[0].id, chatsA[1].id, G.superId, chatsG[0].id, ...chatsA.slice(2).map((c) => c.id), I.superId, ...chatsI.map((c) => c.id)];
  ids.forEach((id, i) => {
    const f = join(dir, `${id}.jsonl`);
    if (REAL[i % (REAL.length || 1)]) copyFileSync(REAL[i % REAL.length], f);
    else writeFileSync(f, synthetic(id, 60 + i * 40));
  });
}

async function server() {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  mkdirSync(join(SCRATCH, 'cwd'), { recursive: true });
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--launcher', '--no-open', '-p', String(PORT)], { cwd: join(SCRATCH, 'cwd'), env: { ...env(), PATH }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) return srv; } catch { /* up soon */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not come up');
}

/** The in-page probe: one log row per animation frame. */
const PROBE = `(() => {
  const ids = new WeakMap(); let next = 1;
  const idOf = (o) => { if (!ids.has(o)) ids.set(o, next++); return ids.get(o); };
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; };
  window.__probe = { longs: [], clicks: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__probe.longs.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'click') window.__probe.clicks.push({ at: Math.round(e.startTime), total: Math.round(e.duration), proc: Math.round(e.processingEnd - e.processingStart), wait: Math.round(e.processingStart - e.startTime) }); }).observe({ type: 'event', durationThreshold: 16 });
  window.__sample = () => {
    const inst = document.querySelector('.project-instance:not([hidden])');
    const scs = [...(inst?.querySelectorAll('.agent-surface .chat-scroll, .agent-surface .chat-transcript > [class*="scroll"]') ?? [])].filter(visible);
    return { sel: document.querySelector('.ns-dr-child.is-sel, [data-testid="drawer-super-row"].is-sel')?.textContent?.trim().slice(0, 30) ?? null,
      vault: inst?.dataset.instance ?? null,
      chats: scs.map((sc) => { const c = sc.closest('.agent-surface')?.getBoundingClientRect(); const inner = sc.firstElementChild; const last = inner?.lastElementChild; const box = sc.getBoundingClientRect();
        return { id: idOf(sc), top: Math.round(sc.scrollTop), h: sc.scrollHeight, ch: sc.clientHeight, y: last ? Math.round(last.getBoundingClientRect().bottom - box.top) : null, rows: inner?.childElementCount ?? 0, x: Math.round(box.left) }; }) };
  };
  window.__arm = () => new Promise((armed) => {
    const log = []; window.__log = log; window.__clickAt = 0; window.__run = true;
    const onClick = (e) => { window.__clickAt = performance.now(); window.__clickEvent = e.timeStamp; };
    window.addEventListener('pointerdown', onClick, { capture: true, once: true });
    // Read AFTER the frame: a rAF runs before ResizeObserver, so reading inside it would report
    // a position the pane corrects before paint. A task posted from the rAF runs past paint.
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { log.push({ t: performance.now(), ...window.__sample() }); if (window.__run) requestAnimationFrame(tick); };
    const tick = () => ch.port2.postMessage(0);
    requestAnimationFrame(tick); armed();
  });
  window.__disarm = () => { window.__run = false; return { log: window.__log, clickAt: window.__clickAt }; };
})();`;

const wait = (p, ms) => p.waitForTimeout(ms);
const rowOf = (p, vault, text) => p.locator(`[data-drawer-project="${vault}"] .ns-dr-child`).filter({ hasText: text }).first();
const superOf = (p, vault) => p.locator(`[data-drawer-project="${vault}"] [data-testid="drawer-super-row"]`).first();

/** Read one hop's frames into numbers. */
function judge(hop, frames, clickAt) {
  const pre = frames.filter((f) => f.t < clickAt).at(-1);
  const after = frames.filter((f) => f.t >= clickAt);
  const prior = new Set((pre?.chats ?? []).map((c) => c.id));
  const showing = (f) => f.chats.some((c) => !prior.has(c.id));
  const isIn = (f) => f.chats.some((c) => !prior.has(c.id) && c.y !== null && c.y <= c.ch + 2 && c.y > 0);
  const first = after.find(showing);
  const landed = after.find(isIn);
  const selAt = after.find((f) => f.sel !== pre?.sel);
  const blank = after.filter((f) => f.chats.length === 0).length;
  const toEnd = landed ? after.slice(after.indexOf(landed)) : [];
  let settle = 0; let shift = 0; let moves = 0;
  const target = landed?.chats.find((c) => !prior.has(c.id));
  for (let i = 1; i < toEnd.length; i++) {
    const a = toEnd[i - 1].chats.find((c) => c.id === target.id); const b = toEnd[i].chats.find((c) => c.id === target.id);
    if (!a || !b) continue;
    if (a.y !== b.y || a.top !== b.top || a.x !== b.x) { settle = Math.round(toEnd[i].t - clickAt); shift = Math.max(shift, Math.abs((b.y ?? 0) - (a.y ?? 0))); moves++; }
  }
  const trail = [];
  for (let i = 1; i < toEnd.length; i++) {
    const a = toEnd[i - 1].chats.find((c) => c.id === target?.id); const b = toEnd[i].chats.find((c) => c.id === target?.id);
    if (a && b && (a.y !== b.y || a.top !== b.top || a.x !== b.x || a.h !== b.h || a.ch !== b.ch)) trail.push({ t: Math.round(toEnd[i].t - clickAt), y: [a.y, b.y], top: [a.top, b.top], h: [a.h, b.h], ch: [a.ch, b.ch], x: [a.x, b.x] });
  }
  const maxGap = Math.round(after.slice(1).reduce((m, f, i) => Math.max(m, f.t - after[i].t), 0));
  return {
    hop,
    sel: selAt ? Math.round(selAt.t - clickAt) : null,
    first: first ? Math.round(first.t - clickAt) : null,
    paint: landed ? Math.round(landed.t - clickAt) : null,
    settle, shift, moves, blank, maxGap, trail, frames: after.length,
    end: after.at(-1)?.chats.map((c) => ({ top: c.top, h: c.h, ch: c.ch, y: c.y, rows: c.rows })),
  };
}

async function hop(p, name, click, hold = 1500) {
  await p.evaluate(() => { window.__probe.longs.length = 0; window.__probe.clicks.length = 0; return window.__arm(); });
  await click();
  await wait(p, hold);
  const { log, clickAt } = await p.evaluate(() => window.__disarm());
  const longs = await p.evaluate(() => window.__probe.longs.filter((l) => l.at >= window.__clickAt - 5));
  const clicks = await p.evaluate(() => window.__probe.clicks);
  return { ...judge(name, log, clickAt), longs, clicks };
}

const med = (a) => { const s = a.filter((x) => x !== null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const max = (a) => a.filter((x) => x !== null).reduce((m, x) => Math.max(m, x), 0);

async function main() {
  seed();
  const srv = await server();
  const browser = await chromium.launch();
  const report = { tag: TAG, cpu: CPU, rounds: ROUNDS, real: REAL.length, hops: {} };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', recordVideo: flag('video') ? { dir: join(OUT, `video-${TAG}`), size: { width: 1440, height: 900 } } : undefined });
    const p = await ctx.newPage();
    p.setDefaultTimeout(15000);
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await p.addInitScript(PROBE);
    await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
    await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
    await wait(p, 4000);
    const got = p.getByRole('button', { name: 'Got it' });
    if (await got.isVisible().catch(() => false)) await got.click();
    if (await p.locator('[data-testid="ns-rail-chat"]').first().isVisible().catch(() => false)) { await p.locator('[data-testid="ns-rail-chat"]').first().click(); await wait(p, 900); }
    await p.screenshot({ path: join(OUT, `${TAG}-start.png`) });

    // The first click on a project that is not mounted: the row picked must be the one that opens.
    await rowOf(p, 'initech', 'Kappa').click();
    await wait(p, 3500);
    report.cold = {
      selected: await p.locator('[data-drawer-project="initech"] .ns-dr-child.is-sel').first().textContent().catch(() => null),
      arriving: await p.locator('[data-testid="agent-arriving"]').filter({ visible: true }).count(),
    };
    report.coldOk = /Kappa/.test(report.cold.selected ?? '') && report.cold.arriving === 0;
    await p.screenshot({ path: join(OUT, `${TAG}-cold.png`) });

    const hops = [
      ['acme:super', () => superOf(p, 'acme').click()],
      ['globex:super', () => superOf(p, 'globex').click()],
      ['globex:Gamma', () => rowOf(p, 'globex', 'Gamma').click()],
      ['acme:Alpha', () => rowOf(p, 'acme', 'Alpha').click()],
      ['acme:Beta', () => rowOf(p, 'acme', 'Beta').click()],
    ];
    // First visit of everything: what a cold chat costs, and it wakes each session.
    report.firstVisit = [];
    for (const [name, click] of hops) report.firstVisit.push(await hop(p, name, click, 5000));
    await p.screenshot({ path: join(OUT, `${TAG}-warm.png`) });
    if (CPU > 1) { const c = await ctx.newCDPSession(p); await c.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }
    if (flag('live')) {
      // A turn streams in Beta (the owner's video: a chat that is working), then the laps below.
      await rowOf(p, 'acme', 'Beta').click(); await wait(p, 500);
      await p.locator('textarea').filter({ visible: true }).first().fill('devam et');
      await p.keyboard.press('Enter'); await wait(p, 800);
    }
    const rows = [];
    for (let r = 0; r < ROUNDS; r++) for (const [name, click] of hops) rows.push(await hop(p, name, click));
    for (const [name] of hops) {
      const of = rows.filter((x) => x.hop === name);
      report.hops[name] = { sel: med(of.map((x) => x.sel)), first: med(of.map((x) => x.first)), paint: med(of.map((x) => x.paint)), paintMax: max(of.map((x) => x.paint)), settle: med(of.map((x) => x.settle)), settleMax: max(of.map((x) => x.settle)), shiftMax: max(of.map((x) => x.shift)), blank: max(of.map((x) => x.blank)), longMax: max(of.flatMap((x) => x.longs.map((l) => l.ms))), clickTotal: med(of.map((x) => x.clicks[0]?.total ?? null)), end: of.at(-1).end };
    }
    report.rows = rows;
    if (flag('profile')) {
      const c = await ctx.newCDPSession(p);
      await c.send('Profiler.enable');
      await c.send('Profiler.setSamplingInterval', { interval: 200 });
      await c.send('Profiler.start');
      for (const [, click] of hops) { await click(); await wait(p, 700); }
      const { profile } = await c.send('Profiler.stop');
      const self = new Map(); const dt = profile.timeDeltas; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      profile.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + dt[i] / 1000); });
      report.profile = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${Math.round(v)}ms ${k}`);
      writeFileSync(join(OUT, `${TAG}.cpuprofile`), JSON.stringify(profile));
    }
    if (flag('trace')) {
      const file = join(OUT, `${TAG}.trace.json`);
      await browser.startTracing(p, { path: file, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing'] });
      for (let r = 0; r < 3; r++) for (const [, click] of hops) { await click(); await wait(p, 900); }
      await browser.stopTracing();
    }
    await p.screenshot({ path: join(OUT, `${TAG}-end.png`) });
    report.errors = errs;
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(report, null, 1));
  const line = (o) => process.stdout.write(`${o}\n`);
  line(`${TAG} cpu×${CPU} rounds ${ROUNDS} real ${REAL.length}  (ms; median unless max)`);
  line('first visit  ' + report.firstVisit.map((h) => `${h.hop} paint ${h.paint} settle ${h.settle} shift ${h.shift} blank ${h.blank}`).join(' | '));
  for (const [k, v] of Object.entries(report.hops)) line(`${k.padEnd(14)} sel ${v.sel} first ${v.first} paint ${v.paint} (max ${v.paintMax}) settle ${v.settle} (max ${v.settleMax}) shiftMax ${v.shiftMax} blankFrames ${v.blank} longMax ${v.longMax} click ${v.clickTotal} ${JSON.stringify(v.end)}`);
  line(`cold project first click: ${report.coldOk ? 'ok' : 'WRONG'} ${JSON.stringify(report.cold)}`);
  if (report.profile) report.profile.forEach(line);
  if (report.errors?.length) line(`console errors: ${JSON.stringify(report.errors)}`);
  if (!report.coldOk) process.exitCode = 1;
}

main().then(() => { if (process.exitCode) process.exit(process.exitCode); }).catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
