#!/usr/bin/env node
/**
 * "Write about this" on an agenda line, observed (task ajandada-her-maddenin-yaninda-bir-ikon-…,
 * plan r3 'Observed 1'): the real dashboard server from this checkout's dist (scratch HOME,
 * DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-agenda-about.mjs
 *
 * The owner hands five chats over; the stand-in super writes its notepad (Now, Waiting, Done),
 * asks him its own question while a child finishes (held), and one child's question waits on him.
 * Checks: an icon on every agenda row, faint until hovered (contrast measured); a press puts an
 * "About: …" chip in the centre's composer with the caret there; Enter sends ONE turn opening
 * with the line's block, no held block, the super's question still open; the bubble draws the
 * strip and only his words; a question row's icon stages its chip and does NOT open its card,
 * its row press still does; a dropped note's message still goes and draws; a reply quote and the
 * block both reach the super and both draw; `/compact` goes as a command and the chip stays; a
 * busy super is steered ("sent mid-turn"), a queued one shows the strip; About on the question's
 * own row answers it and the held events ride with it; a reload draws the strips again; at
 * 390x844 the icon is whole, a press shows the centre with the chip, nothing overflows, the send
 * works. Screenshots at 1440x900 light and dark and 390x844; zero page errors.
 *
 * Collect, don't fail fast: every check prints ✓/✗. Exit 0 iff all pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const { chromium } = createRequire(join(REPO, 'package.json'))('playwright');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-agenda-about-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-agenda-about');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, readdirSync, mkdirSync as mk } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
// The super's own messages are written to a transcript the way claude stores them, so a reload
// replays them (the strip is drawn again from the replayed text). A folded frame is stored as a
// queued_command attachment (claude 2.1.304, measured in super-agent.mjs).
const convo = at('--resume') || at('--session-id') || '';
function persist(blocks, queued) {
  if (role !== 'super' || !/^[0-9a-f-]{36}$/.test(convo)) return;
  const dir = process.env.HOME + '/.claude/projects/verify-super-about';
  mk(dir, { recursive: true });
  const row = queued
    ? { type: 'attachment', sessionId: convo, attachment: { type: 'queued_command', prompt: blocks.map((text) => ({ type: 'text', text })) } }
    : { type: 'user', sessionId: convo, message: { role: 'user', content: blocks.map((text) => ({ type: 'text', text })) } };
  appendFileSync(dir + '/' + convo + '.jsonl', JSON.stringify(row) + '\\n');
}
const RECORD = ${JSON.stringify(RECORD)};
const OPENED = ${JSON.stringify(join(SCRATCH, 'opened'))};
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  let json = null; try { json = JSON.parse(r.stdout || r.stderr); } catch {}
  return { args: args.join(' '), status: r.status, json, out: (r.stdout || '') + (r.stderr || '') };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
let awaiting = null;
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolCall = (name, input, result, isError = false) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  if (result !== undefined) out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: result }], is_error: isError }] } });
  return id;
};
const shq = (a) => /^[A-Za-z0-9_.\\/:=-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\\\''") + "'";
const bashCall = (description, ...args) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: ['dreamcontext', ...args].map(shq).join(' '), description } }] } });
  const r = cli(...args);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: r.out.trim().slice(0, 600) }], is_error: r.status !== 0 }] } });
  return r;
};
const ask = (request) => new Promise((resolve) => {
  const id = 'toolu_' + (++seq) + '_' + process.pid;
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: request.tool_name, input: request.input }] } });
  out({ type: 'control_request', request_id: 'req-' + process.pid + '-' + seq, request: { subtype: 'can_use_tool', ...request, tool_use_id: id, requires_user_interaction: true } });
  awaiting = (r) => { out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'answered' }] }] } }); resolve(r); };
});
const title = (t) => say('\\n\\n\`\`\`dream-view\\n' + JSON.stringify({ type: 'title', text: t }) + '\\n\`\`\`');

const TASKS = (() => { try { return readdirSync(${JSON.stringify(join(PROJ, '_dream_context', 'state'))}).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).slice(0, 12); } catch { return []; } })();
const CHATS = [
  { title: 'Fatura toplamları', key: 'ledger API', tool: ['Grep', { pattern: 'invoiceTotal', path: 'src/billing', output_mode: 'files_with_matches' }], result: 'src/billing/invoice.ts\\nsrc/billing/totals.ts',
    answer: 'Fatura toplamları yeni ledger API üstünde. Eski uç nokta bir sürüm daha açık. 212 testin hepsi geçti.' },
  { title: 'Tanıtım videosu', key: 'tanitim videosu', tool: ['Bash', { command: 'npx remotion render promo out/promo.mp4', description: 'Render the promo' }], result: 'Rendered 412/900 frames',
    answer: 'Videonun ilk yarısı hazır, ikinci yarıyı render ediyorum.' },
  { title: 'Bildirim düzeltmesi', key: 'bildirim', tool: ['Bash', { command: 'npm test -- notify', description: 'Run notify tests' }], result: '14 passing',
    answer: 'Bildirim düzeldi: biten iş artık zil çalıyor. 14 testin hepsi geçti.' },
  { title: 'Super devir sorunu', key: 'devir', tool: ['Read', { file_path: 'src/handoff.ts' }], result: 'export function writeHandoff…',
    answer: 'Sorunu buldum: devir dosyası yarım yazılıyor. Düzeltiyorum.' },
  { title: 'Fiyat sayfası', key: 'fiyat sayfasi', tool: ['Read', { file_path: 'site/pricing.md' }], result: '# Pricing',
    answer: 'Fiyat sayfasının taslağı hazır.' },
];
const OPENERS = ${JSON.stringify([
  ['Tanitim videosu: 45 saniyelik tanıtım videosunu bitir.', false],
  ['Bildirim: biten iş zil çalmıyor, düzelt.', true],
  ['Devir: super oturum devrinde dosya yarım yazılıyor, bul ve düzelt.', false],
  ['Fiyat sayfasi: yeni fiyat sayfasının metnini yaz.', true],
])};

async function childTurn(text) {
  if (/HATA-VER/.test(text)) return '__ERROR__';
  if (/ledger API/.test(text) && !existsSync(OPENED)) {
    appendFileSync(OPENED, '1');
    const steps = [];
    for (const [prompt, split] of OPENERS) { steps.push(cli('window', 'new', ...(split ? ['--split'] : []), '--prompt', prompt)); await sleep(700); }
    report({ kind: 'opened', steps: steps.map((s) => ({ a: s.args.slice(0, 40), st: s.status, o: s.out.slice(0, 200) })) });
  }
  const low = text.toLowerCase();
  const first = CHATS.find((c) => low.includes(c.key.toLowerCase()));
  if (first && !/^\\[super/.test(text) && !/keep going|indirim/i.test(text)) {
    await sleep(500);
    toolCall(first.tool[0], first.tool[1], first.result);
    await sleep(300);
    say(first.answer);
    title(first.title);
    return null;
  }
  if (/IZIN-ISTE/.test(text)) {
    // A tool permission the owner must answer (it never reaches the super agent).
    const r = await ask({ tool_name: 'Bash', display_name: 'Bash', input: { command: 'rm -rf build', description: 'Clean the build folder' } });
    report({ kind: 'permission-answered', response: r });
    return 'Tamam.';
  }
  if (/indirim/i.test(text)) {
    const r = await ask({ tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input: { questions: [{ question: 'Yıllık planda indirim yüzde kaç olsun?', header: 'İndirim', multiSelect: false, options: [{ label: '%15', description: 'mevcut' }, { label: '%20', description: 'daha çekici' }] }] } });
    report({ kind: 'answered', response: r });
    return 'Tamam, öyle yazıyorum.';
  }
  if (/keep going/i.test(text)) {
    say('Devam ediyorum.');
    toolCall('Bash', { command: 'npm run long-job', description: 'Keep working' });
    report({ kind: 'busy', what: text.slice(0, 60) });
    await sleep(30 * 60 * 1000);
    return null;
  }
  return 'Not aldım.';
}

const children = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')).children ?? {}; } catch { return {}; } };
const containers = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')).containers ?? []; } catch { return []; } };
const byBrief = (name) => Object.entries(children()).find(([, c]) => (c.brief ?? '').toLowerCase() === name.toLowerCase())?.[0];
let busyOnce = false;
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    await sleep(800);
    const fiy = byBrief('Fiyat sayfası');
    if (fiy) cli('super', 'send', fiy, 'Yıllık indirim oranını sahibe sor.');
    for (const [k, v] of Object.entries(children())) if (k !== fiy) cli('super', 'brief', k, v.brief || 'Çalışıyor');
    const notes = [
      cli('super', 'note', 'add', 'now', 'Tanıtım videosunun ikinci yarısını bitiriyoruz'),
      cli('super', 'note', 'add', 'waiting', "Safari'den haftalık pano PDF indirmeyi bir kez dene"),
      cli('super', 'note', 'add', 'done', 'Fatura toplamları yeni ledger API üstünde'),
      cli('super', 'note', 'add', 'waiting', 'Eski bülten taslağına bir göz at'),
    ];
    report({ kind: 'handover', notes: notes.map((n) => ({ st: n.status, o: n.out.slice(0, 160) })) });
    return 'Devraldım.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 300) }); return null; }
  if (/SORU-SOR/.test(text)) {
    const r = cli('super', 'ask', 'Videoyu bu akşam yayına alalım mı?', '--options', 'Evet|Yarın');
    // While it is open a child finishes: that event is held for his answer.
    const not = byBrief('Biten iş artık zil çalıyor') ?? byBrief('Bildirim düzeltmesi') ?? Object.keys(children())[0];
    const s = not ? cli('super', 'send', not, 'Son bir kontrol yap ve bitir.') : null;
    report({ kind: 'asked', status: r.status, out: r.out.slice(0, 200), sent: s?.status });
    return 'Bir sorum var.';
  }
  if (/NOT-SIL-SONRA/.test(text)) {
    // The note is dropped a moment after this turn, while his chip about it is staged.
    setTimeout(() => { const r = cli('super', 'note', 'drop', 'n4'); report({ kind: 'note-drop', status: r.status }); }, 2500);
    return 'Tamam.';
  }
  if (/MESGUL/.test(text) && !busyOnce) {
    busyOnce = true;
    say('Uzun bir iş yapıyorum.');
    toolCall('Bash', { command: 'sleep 25', description: 'Long job' });
    report({ kind: 'busy' });
    await sleep(25000);
    return 'Bitti.';
  }
  report({ kind: 'owner', text: text.slice(0, 400) });
  return 'Not aldım.';
}
let inited = false;
let running = false;
let chain = Promise.resolve();
async function turn(blocks) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  let said = 'ok';
  try { said = role === 'super' ? await superTurn(blocks[0] ?? '') : await childTurn(blocks.join('')); } catch (e) { said = 'error ' + e; }
  const failed = said === '__ERROR__';
  if (failed) said = 'API Error: the tool crashed';
  if (said) say(said);
  out({ type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: said ?? '', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
  report({ kind: 'turn-end', said });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_response') { if (awaiting) { const r = awaiting; awaiting = null; r(o.response && o.response.response); } continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (!blocks.length) continue;
    appendFileSync(${JSON.stringify(FRAMES)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), blocks, folded: running }) + '\\n');
    persist(blocks, running);
    if (running) continue;
    running = true;
    chain = chain.then(() => turn(blocks)).finally(() => { running = false; });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;

const PRICING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>orbit pricing</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f1220;color:#e8eaf6}
header{padding:48px 56px 8px}h1{font-size:40px;margin:0 0 8px}p.sub{color:#9aa0c3;margin:0;font-size:18px}
.plans{display:flex;gap:20px;padding:32px 56px}
.plan{flex:1;background:#171b2e;border:1px solid #262b45;border-radius:16px;padding:28px}
.plan.hot{border-color:#7c83ff;box-shadow:0 0 0 1px #7c83ff inset}
.plan h2{margin:0 0 4px;font-size:22px}.price{font-size:44px;font-weight:700;margin:12px 0}.price small{font-size:16px;color:#9aa0c3;font-weight:400}
ul{padding-left:18px;color:#c9cdea;line-height:1.9}button{margin-top:16px;width:100%;padding:12px;border-radius:10px;border:0;background:#7c83ff;color:#fff;font-size:16px}
</style></head><body>
<header><h1>orbit pricing</h1><p class="sub">Analytics for small teams. Plain limits, no surprises.</p></header>
<div class="plans">
<div class="plan"><h2>Starter</h2><div class="price">$0 <small>/ month</small></div><ul><li>3 dashboards</li><li>100k events a month</li><li>7-day history</li></ul><button>Start free</button></div>
<div class="plan hot"><h2>Team</h2><div class="price">$49 <small>/ month</small></div><ul><li>10 dashboards</li><li>1 M events a month</li><li>1-year history</li><li>Slack digests</li></ul><button>Try Team</button></div>
<div class="plan"><h2>Scale</h2><div class="price">$199 <small>/ month</small></div><ul><li>Unlimited dashboards</li><li>20 M events a month</li><li>Full history</li><li>SSO</li></ul><button>Talk to us</button></div>
</div></body></html>`;

const env = () => ({ ...process.env, HOME, DREAMCONTEXT_DESKTOP: '1' });
function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'mockups'), OUT, LOGS]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  writeFileSync(join(PROJ, 'mockups', 'pricing.html'), PRICING_HTML);
  spawnSync('git', ['-C', PROJ, 'init', '-q']);
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const r = spawnSync(process.execPath, [CLI, 'vaults', 'add', 'orbit', PROJ], { env: env(), encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`vaults add failed: ${r.stderr || r.stdout}`);
}
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
async function startServer(port, extraEnv = {}, logName = 'server.log') {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: PROJ, env: { ...env(), PATH, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(LOGS, logName));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}
const readNd = (p) => { try { return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reports = () => readNd(REPORTS);
const frames = () => readNd(FRAMES);
const record = () => { try { return JSON.parse(readFileSync(RECORD, 'utf-8')); } catch { return { containers: [], children: {} }; } };
const log = (...a) => console.log(...a);
const until = async (page, fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); } return false; };

const leaks = [];
async function leakCheck(page, name) {
  const text = await page.evaluate(() => document.body.innerText);
  const hits = [];
  for (const re of [/@/g, /mehmet/gi, /\/Users\//g, /nuraydin/gi]) {
    let m; while ((m = re.exec(text))) hits.push(text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, ' '));
  }
  if (hits.length) { leaks.push({ name, hits }); log(`  ! leak check ${name}: ${hits.length} hit(s): ${hits.slice(0, 3).join(' | ')}`); }
}
async function clean(page) {
  await page.evaluate(() => {
    document.querySelectorAll('.announcements-modal-scrim').forEach((e) => e.remove());
    if (!document.getElementById('cap-kill')) {
      const s = document.createElement('style'); s.id = 'cap-kill';
      s.textContent = '.announcements-modal-scrim,.sleep-tracker-wrap{display:none!important}';
      document.head.appendChild(s);
    }
  });
}
async function shot(page, name) {
  await clean(page);
  await page.screenshot({ path: join(OUT, name) });
  await leakCheck(page, name);
  log(`  saved ${name}`);
}
let cdp;
async function setDpr(page, dpr) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: dpr, mobile: false });
  await page.waitForTimeout(300);
}
async function elShot(page, locator, name, { pad = 0 } = {}) {
  try {
    await clean(page);
    const el = typeof locator === 'string' ? page.locator(locator).first() : locator.first();
    if (!(await el.count())) { log(`  ! missing for ${name}`); return false; }
    const b = await el.boundingBox();
    const x = Math.max(0, b.x - pad); const y = Math.max(0, b.y - pad);
    const clip = { x, y, width: Math.min(W - x, b.width + 2 * pad), height: Math.min(H - y, b.height + 2 * pad), scale: 2 };
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    log(`  saved ${name} (${Math.round(clip.width)}x${Math.round(clip.height)} css px @2x)`);
    return true;
  } catch (e) { log(`  ! ${name}: ${e.message.split('\n')[0]}`); return false; }
}
/** Slow every Web Animation / CSS animation and shoot frames: `step` ms of animation time apart. */
async function filmstrip(page, prefix, trigger, { rate = 0.1, step = 60, maxMs = 1400, settle, minSettleMs = 300 } = {}) {
  await clean(page);
  await page.screenshot({ path: join(OUT, `${prefix}-pre.png`) });
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
  const index = [];
  await trigger();
  const t0 = Date.now();
  let n = 0;
  for (;;) {
    const animMs = Math.round((Date.now() - t0) * rate);
    const name = `${prefix}-${String(n).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(OUT, name) });
    index.push({ frame: name, animMs, realMs: Date.now() - t0 });
    n += 1;
    if (animMs > maxMs) break;
    if (settle && animMs > minSettleMs && await settle()) { // two more after settling
      for (let k = 0; k < 2; k++) { await page.waitForTimeout(step / rate); const nm = `${prefix}-${String(n).padStart(2, '0')}.png`; await page.screenshot({ path: join(OUT, nm) }); index.push({ frame: nm, animMs: Math.round((Date.now() - t0) * rate), realMs: Date.now() - t0, settled: true }); n += 1; }
      break;
    }
    const next = t0 + (n * step) / rate;
    const wait = next - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  writeFileSync(join(OUT, `${prefix}-index.json`), JSON.stringify({ playbackRate: rate, stepAnimMs: step, note: 'animMs = real elapsed since trigger x playbackRate (Web Animations + CSS animations slowed via CDP Animation.setPlaybackRate; JS timers not slowed)', frames: index }, null, 2));
  log(`  filmstrip ${prefix}: ${index.length} frames`);
}
async function sayCentre(page, text, { typed = false } = {}) {
  const input = page.locator('[data-super-slot="centre"] .chat-cmp-input').first();
  await input.click();
  if (typed) await page.keyboard.type(text, { delay: 20 }); else await input.fill(text);
  await page.keyboard.press('Enter');
}
/** The stage is at rest: no stand-ins in the motion layer and every card and the centre where
 *  they were 400 ms ago (motionIdle only follows the hand-over; a view change flies too). */
async function stageSettled(page, ms = 15000) {
  let last = '';
  for (const end = Date.now() + ms; Date.now() < end;) {
    const now = await page.evaluate(() => {
      const layer = document.querySelector('.super-stage-layer');
      const rects = [...document.querySelectorAll('.super-centre, [data-testid="super-container"]')]
        .map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${getComputedStyle(e).opacity}`; });
      return `${layer ? layer.childElementCount : 0}|${rects.join(';')}`;
    });
    if (now === last && now.startsWith('0|')) return true;
    last = now;
    await page.waitForTimeout(400);
  }
  return false;
}
const motionIdle = (page) => until(page, async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000);

let failures = 0;
const ok = (name, pass, detail = '') => { if (!pass) failures += 1; log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  (${detail})` : ''}`); };
const rowsOf = (page, sec) => page.locator(`[data-testid="super-agenda-section-${sec}"] [data-testid="super-agenda-row"]`);
/** After a reload the app opens on its start page: bring the Chat screen (the stage) back. */
async function backToStage(page) {
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  await clean(page);
  if (!(await page.getByTestId('super-surface').isVisible().catch(() => false))) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) await nav.click().catch(() => {});
  }
  await until(page, async () => page.getByTestId('super-surface').isVisible(), 30000);
  await motionIdle(page);
}
async function agendaShot(page, name, theme, w, h) {
  await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
  await page.setViewportSize({ width: w, height: h });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await backToStage(page);
  await page.mouse.move(5, 5);
  ok(`${name}: the stage settled before the shot`, await stageSettled(page));
  await shot(page, name);
  // No column: the stage has the surface's full width; every card and the centre inside the
  // window, the stage's cards (the agenda among them) never over the centre.
  const geo = await page.evaluate(() => {
    const stage = document.querySelector('[data-testid="super-surface"]').getBoundingClientRect();
    const host = document.querySelector('[data-testid="super-surface"]').parentElement.getBoundingClientRect();
    const c = document.querySelector('.super-centre').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('[data-testid="super-container"], [data-testid="super-group"], .super-centre, .super-others-stack')]
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const cards = [...document.querySelectorAll('[data-testid="super-container"][data-where="float"], [data-testid="super-group"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    return {
      column: document.querySelectorAll('.super-shell, [data-testid="super-agenda-rail"], aside.super-agenda').length,
      stageW: stage.width, hostW: host.width, w: innerWidth, h: innerHeight,
      boxes: boxes.map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom })),
      over: cards.filter((r) => r.left < c.right - 1 && r.right > c.left + 1 && r.top < c.bottom - 1 && r.bottom > c.top + 1).length,
    };
  });
  ok(`${name}: no agenda column or rail; the stage has the full width`, geo.column === 0 && Math.abs(geo.stageW - geo.hostW) < 1, JSON.stringify({ column: geo.column, stageW: geo.stageW, hostW: geo.hostW }));
  const bad = geo.boxes.filter((b) => b.l < -0.5 || b.r > geo.w + 0.5 || b.b > geo.h + 0.5);
  ok(`${name}: the centre and every card inside ${w}x${h}, no floating card over the centre`, geo.boxes.length > 0 && bad.length === 0 && geo.over === 0, JSON.stringify({ bad, over: geo.over }).slice(0, 200));
}
const agendaCard = (page) => page.locator('[data-testid="super-container"][data-kind="agenda"]');

const centre = (page) => page.locator('[data-super-slot="centre"]');
const centreInput = (page) => centre(page).locator('.chat-cmp-input').first();
const chip = (page) => centre(page).locator('.chat-cmp-attachment-about');
const iconOf = (row) => row.locator('[data-testid="super-agenda-about"]');
const superFrames = () => frames().filter((f) => f.role === 'super');
const lastSuperFrame = () => superFrames().at(-1);
const openAsk = () => (record().queue ?? []).find((q) => q.kind === 'ask' && q.state !== 'done');
async function typeAndSend(page, text) {
  await centreInput(page).click();
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
}
async function showLastUser(page) {
  await centre(page).locator('.chat-msg-user-row').last().evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
  await page.waitForTimeout(300);
}
async function lastBubble(page) {
  return centre(page).locator('.chat-msg-user-row').last().evaluate((row) => ({
    strip: row.querySelector('[data-testid="chat-msg-about"]')?.textContent ?? null,
    bubble: row.querySelector('.chat-msg-user-bubble')?.textContent ?? null,
    steered: !!row.querySelector('.chat-msg-steered'),
  }));
}

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US' });
  await context.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); } catch {} });
  const page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  try {
    await page.goto(`${base}/?vault=orbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
    await clean(page);
    if (!(await page.locator('.agent-surface.expanded').count())) {
      const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
    }
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 90000);
    const input = page.locator('.chat-cmp-input:visible').first();
    await input.click();
    await input.fill('Fatura toplamlarını yeni ledger API üstüne taşı.');
    await page.keyboard.press('Enter');
    await until(page, async () => reports().some((r) => r.kind === 'opened'), 60000);
    await until(page, async () => reports().filter((r) => r.role === 'child' && r.kind === 'turn-end').length >= 5, 60000);
    await page.waitForTimeout(2000);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await motionIdle(page);
    await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000);
    ok('the super wrote its notepad (4 lines)', await until(page, async () => (record().pad ?? []).length === 4, 30000), JSON.stringify(reports().filter((r) => r.kind === 'handover')));
    ok('a child\'s question waits on him (Waiting row)', await until(page, async () => (await rowsOf(page, 'waiting').filter({ hasText: 'Fiyat sayfası' }).count()) === 1, 60000));
    // The row's own press, unchanged by the icon beside it: a child's question row brings its
    // card in the centre into view (as super-agenda.mjs proves, before any question of the super's).
    const qRow0 = rowsOf(page, 'waiting').filter({ hasText: 'Fiyat sayfası' });
    await centre(page).locator('.chat-scroll, [data-chat-scroll]').first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await qRow0.locator('.super-agenda-row-btn').click();
    ok('a question row\'s own press still brings its question card into view', await until(page, async () => page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-question-card"][data-kind="question"]')].pop();
      if (!card) return false;
      const r = card.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }), 8000));
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    await until(page, async () => record().view?.mode === 'float' && (await agendaCard(page).count()) === 1, 8000);
    await motionIdle(page);

    // The super's own question, and a child finishing while it is open (held).
    await sayCentre(page, 'SORU-SOR');
    const askRow = rowsOf(page, 'waiting').filter({ hasText: 'Videoyu bu akşam' });
    ok('the super\'s own question is open (a Waiting row)', await until(page, async () => (await askRow.count()) === 1 && !!openAsk(), 30000), JSON.stringify(reports().filter((r) => r.kind === 'asked')));
    ok('…a child finished while it was open: the event is held', await until(page, async () => (record().held ?? []).length > 0, 90000), JSON.stringify(record().held ?? null));

    // 1. An icon on every row, faint until hovered.
    await page.mouse.move(5, 5);
    await stageSettled(page);
    const counts = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="super-agenda"][data-variant="full"] [data-testid="super-agenda-row"]').length,
      icons: document.querySelectorAll('[data-testid="super-agenda"][data-variant="full"] [data-testid="super-agenda-row"] > [data-testid="super-agenda-about"]').length,
      nested: document.querySelectorAll('button button').length,
    }));
    ok('an icon on every agenda row (notes and questions), no button inside a button', counts.rows >= 6 && counts.icons === counts.rows && counts.nested === 0, JSON.stringify(counts));
    const n2 = rowsOf(page, 'waiting').filter({ hasText: "Safari'den haftalık pano" });
    const faint = await iconOf(n2).evaluate((el) => Number(getComputedStyle(el).opacity));
    await n2.hover();
    await page.waitForTimeout(150);
    const lit = await iconOf(n2).evaluate((el) => Number(getComputedStyle(el).opacity));
    const box = await iconOf(n2).boundingBox();
    ok('faint at rest, full on the row\'s hover; a 28px hit area', faint < 0.6 && lit === 1 && box && box.width >= 28 && box.height >= 28, JSON.stringify({ faint, lit, box }));
    await elShot(page, agendaCard(page), '01-agenda-icons-hover-1440-light.png', { pad: 8 });

    // 2. A note: the chip, the caret, one turn with the block, the strip.
    await iconOf(n2).click();
    ok('a press puts "About: …" in the centre composer', await until(page, async () => (await chip(page).count()) === 1
      && /About: Safari'den haftalık pano PDF/.test(await chip(page).innerText()), 5000), await chip(page).innerText().catch(() => ''));
    ok('…the caret is in the centre composer', await until(page, async () => page.evaluate(() => !!document.activeElement?.closest('[data-super-slot="centre"]') && document.activeElement.classList.contains('chat-cmp-input')), 3000));
    ok('…the chip alone: the placeholder asks for the words, Send stays off', (await centreInput(page).getAttribute('placeholder')) === 'Write about this line…');
    await shot(page, '02-chip-staged-1440-light.png');
    const before = superFrames().length;
    await typeAndSend(page, 'denedim, indir düğmesi hiç çıkmıyor');
    ok('Enter sends one turn opening with the line\'s block, then his words', await until(page, async () => superFrames().length === before + 1, 15000)
      && lastSuperFrame().blocks[0] === "[About agenda line note=n2 section=waiting]\nline: \"Safari'den haftalık pano PDF indirmeyi bir kez dene\"\n\ndenedim, indir düğmesi hiç çıkmıyor", JSON.stringify(lastSuperFrame()?.blocks?.[0]));
    ok('…no held block rides with a message about another line', !lastSuperFrame().blocks.some((b) => b.startsWith('<super-while-you-asked')));
    await page.waitForTimeout(1500);
    ok('…the super\'s question stays open and the pile stays held', !!openAsk() && (record().held ?? []).length > 0, JSON.stringify({ ask: openAsk()?.state, held: record().held?.length }));
    const b1 = await lastBubble(page);
    ok('the bubble: the About strip and only his words', b1.strip?.includes("Safari'den haftalık pano PDF indirmeyi bir kez dene") && b1.bubble === 'denedim, indir düğmesi hiç çıkmıyor', JSON.stringify(b1));
    ok('…the chip is gone after the send', (await chip(page).count()) === 0);
    await showLastUser(page);
    await shot(page, '03-sent-strip-1440-light.png');

    // 3. A question row: the icon stages its chip and opens nothing; its row press still does.
    const qRow = rowsOf(page, 'waiting').filter({ hasText: 'Fiyat sayfası' });
    const viewBefore = JSON.stringify(record().view);
    await iconOf(qRow).click();
    ok('a question row\'s icon stages "About: <job>\'s question"', await until(page, async () => /About: .*question/.test(await chip(page).innerText().catch(() => '')), 5000), await chip(page).innerText().catch(() => ''));
    ok('…and opens nothing (the view is unchanged)', JSON.stringify(record().view) === viewBefore);
    await chip(page).locator('.chat-cmp-chip-x').click();
    ok('…its ✕ drops the chip', (await chip(page).count()) === 0);
    // 3b. About on the question's own row: it answers it, the held events ride with it.
    await iconOf(askRow).click();
    ok('the super\'s own question row stages "About: Super\'s question"', await until(page, async () => /About: Super's question/.test(await chip(page).innerText().catch(() => '')), 5000), await chip(page).innerText().catch(() => ''));
    const askId = openAsk()?.id;
    await typeAndSend(page, 'Evet, bu akşam');
    ok('…the message names that question and carries the held events', await until(page, async () => {
      const f = superFrames().find((x) => x.blocks[0].startsWith(`[About agenda line item=${askId} section=waiting]`));
      return !!f && f.blocks.some((b) => b.startsWith('<super-while-you-asked'));
    }, 15000), JSON.stringify(superFrames().slice(-1).map((f) => f.blocks.map((b) => b.slice(0, 80)))));
    ok('…and closes it; nothing stays held', await until(page, async () => !openAsk() && !(record().held ?? []).length, 15000), JSON.stringify({ ask: openAsk(), held: record().held }));
    const b4 = await lastBubble(page);
    ok('…its strip reads the super\'s question while it was open, or a question', /Super's question|a question/.test(b4.strip ?? '') && b4.bubble === 'Evet, bu akşam', JSON.stringify(b4));


    // 4. A note dropped while his chip about it is staged: the message still goes and draws.
    await sayCentre(page, 'NOT-SIL-SONRA');
    const n4 = rowsOf(page, 'waiting').filter({ hasText: 'Eski bülten taslağına' });
    await until(page, async () => (await n4.count()) === 1, 5000);
    await iconOf(n4).click();
    ok('the note is dropped while its chip is staged', await until(page, async () => (await n4.count()) === 0 && !(record().pad ?? []).some((p) => p.id === 'n4'), 20000));
    await typeAndSend(page, 'tamam, gerek kalmadı');
    ok('…the message still goes with its block', await until(page, async () => (lastSuperFrame()?.blocks?.[0] ?? '').startsWith('[About agenda line note=n4 section=waiting]'), 15000), JSON.stringify(lastSuperFrame()?.blocks?.[0]));
    const b2 = await lastBubble(page);
    ok('…and the strip still draws its line', b2.strip?.includes('Eski bülten taslağına bir göz at') && b2.bubble === 'tamam, gerek kalmadı', JSON.stringify(b2));

    // 5. A reply quote with an About chip: block, then the quote, then his words; both draw.
    await until(page, async () => (reports().filter((r) => r.role === 'super' && r.kind === 'turn-end').length > 0), 10000);
    await page.waitForTimeout(800);
    const answer = centre(page).locator('.chat-msg-assistant-row').last();
    await answer.hover();
    await answer.locator('[aria-label="Quote-reply"]').click();
    const n1 = rowsOf(page, 'now').filter({ hasText: 'Tanıtım videosunun' });
    await iconOf(n1).click();
    await typeAndSend(page, 'bunu da düşün');
    ok('a reply quote and the block: block first, then the quote, then his words', await until(page, async () => {
      const t = lastSuperFrame()?.blocks?.[0] ?? '';
      return t.startsWith('[About agenda line note=n1 section=now]\nline: "Tanıtım videosunun ikinci yarısını bitiriyoruz"\n\n> ') && t.endsWith('\n\nbunu da düşün');
    }, 15000), JSON.stringify(lastSuperFrame()?.blocks?.[0]));
    const b3 = await lastBubble(page);
    ok('…the strip and the quote both draw', b3.strip?.includes('Tanıtım videosunun') && (b3.bubble ?? '').startsWith('> ') && (b3.bubble ?? '').endsWith('bunu da düşün'), JSON.stringify(b3));
    await showLastUser(page);
    await shot(page, '04-quote-and-about-1440-light.png');
    await centre(page).locator('.chat-msg-user-row').filter({ has: page.locator('[data-testid="chat-msg-about"]') }).last().screenshot({ path: join(OUT, '04b-quote-and-about-bubble.png') }).catch((e) => log(`  ! 04b-quote-and-about-bubble.png: ${e.message.split('\n')[0]}`));

    // 6. A slash command with a chip: sent as a command, the chip stays.
    await iconOf(n1).click();
    const beforeSlash = superFrames().length;
    await typeAndSend(page, '/compact');
    ok('`/compact` with a chip goes as typed, the chip still staged', await until(page, async () => superFrames().length > beforeSlash, 15000)
      && superFrames().slice(beforeSlash).every((f) => !f.blocks[0].startsWith('[About')) && (await chip(page).count()) === 1, JSON.stringify(superFrames().slice(beforeSlash).map((f) => f.blocks[0].slice(0, 60))));
    await chip(page).locator('.chat-cmp-chip-x').click();
    await page.waitForTimeout(3000);

    // 7. Busy: Enter steers; ⇡ queues and the queued row shows the strip.
    await sayCentre(page, 'MESGUL');
    ok('the super is busy', await until(page, async () => reports().some((r) => r.kind === 'busy'), 15000));
    await iconOf(n1).click();
    await typeAndSend(page, 'araya giriyorum');
    ok('busy: Enter steers the message with its block ("sent mid-turn")', await until(page, async () => {
      const f = superFrames().find((x) => x.blocks[0].startsWith('[About agenda line note=n1') && x.blocks[0].endsWith('araya giriyorum'));
      return !!f && f.folded === true && (await lastBubble(page)).steered;
    }, 15000), JSON.stringify(superFrames().slice(-2)));
    await iconOf(n1).click();
    await centreInput(page).click();
    await page.keyboard.type('sırada bekle', { delay: 10 });
    await centre(page).locator('[aria-label="Queue for the next turn"]').click();
    ok('⇡ queue: the queued row shows the strip, not the raw block', await until(page, async () => {
      const row = centre(page).locator('.chat-queue-row').last();
      if (!(await row.count())) return false;
      const t = await row.innerText();
      return (await row.locator('[data-testid="chat-queue-about"]').count()) === 1 && !t.includes('[About agenda line') && t.includes('sırada bekle');
    }, 8000));
    await shot(page, '05-queued-strip-1440-light.png');
    ok('…the queued message goes after the busy turn, with its block', await until(page, async () => superFrames().some((f) => f.blocks[0].startsWith('[About agenda line note=n1') && f.blocks[0].endsWith('sırada bekle') && !f.folded), 60000));
    await until(page, async () => (await centre(page).locator('.chat-queue-row').count()) === 0, 30000);
    await page.waitForTimeout(1500);

    // 9. A reload draws the strips again from the replayed transcript.
    const stripsBefore = await centre(page).locator('[data-testid="chat-msg-about"]').count();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    ok('after a reload the strips draw again', await until(page, async () => (await centre(page).locator('[data-testid="chat-msg-about"]').count()) >= Math.min(stripsBefore, 4), 20000),
      `before ${stripsBefore}, after ${await centre(page).locator('[data-testid="chat-msg-about"]').count()}; user rows: ${JSON.stringify((await centre(page).locator('.chat-msg-user-row').allInnerTexts()).map((t) => t.slice(0, 50)))}`);
    await showLastUser(page);
    await shot(page, '06a-after-reload-strips-1440-light.png');
    await centre(page).locator('.chat-msg-user-row').filter({ has: page.locator('[data-testid="chat-msg-about"]') }).last().screenshot({ path: join(OUT, '06b-after-reload-bubble.png') }).catch((e) => log(`  ! 06b-after-reload-bubble.png: ${e.message.split('\n')[0]}`));
    ok('…and no bubble shows a raw block', await until(page, async () => !(await centre(page).locator('.chat-msg-user-bubble').allInnerTexts()).some((t) => t.includes('[About agenda line')), 5000));

    // 10. Screenshots: 1440 dark and light, then 390.
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => localStorage.setItem('dreamcontext-theme', t), theme);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await backToStage(page);
      await stageSettled(page);
      await rowsOf(page, 'now').first().hover();
      await iconOf(rowsOf(page, 'now').first()).click();
      await page.waitForTimeout(400);
      await shot(page, `06-1440-${theme}.png`);
      await chip(page).locator('.chat-cmp-chip-x').click().catch(() => {});
    }

    // 11. 390x844: the icon whole, the press shows the centre with the chip, no overflow, send works.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await stageSettled(page);
    if (!(await agendaCard(page).count())) { await page.getByTestId('super-agenda-open').click().catch(() => {}); await motionIdle(page); await stageSettled(page); }
    await shot(page, '07-390-agenda.png');
    const icon390 = iconOf(rowsOf(page, 'now').first());
    const ib = await icon390.boundingBox().catch(() => null);
    ok('390: the agenda is shown and its row icon is whole on screen, 28px', !!ib && ib.x >= 0 && ib.x + ib.width <= 390.5 && ib.width >= 28 && ib.height >= 28, JSON.stringify(ib));
    if (ib) await icon390.click();
    await motionIdle(page);
    await stageSettled(page);
    ok('390: the press shows the centre with the chip, the caret in its composer', await until(page, async () => (await chip(page).count()) === 1 && await centreInput(page).isVisible()
      && (await centreInput(page).boundingBox()).x >= 0, 8000));
    ok('390: the head\'s Agenda button is there to bring the agenda back', await until(page, async () => (await page.getByTestId('super-agenda-open').count()) === 1 || (await agendaCard(page).count()) === 1, 5000));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok('390: no horizontal overflow', overflow <= 1, `over by ${overflow}`);
    await shot(page, '08-390-chip.png');
    const before390 = superFrames().length;
    await typeAndSend(page, 'telefondan yazıyorum');
    ok('390: the send works, with its block', await until(page, async () => superFrames().length > before390 && superFrames().at(-1).blocks[0].startsWith('[About agenda line note=') && superFrames().at(-1).blocks[0].endsWith('telefondan yazıyorum'), 15000));
    await page.waitForTimeout(800);
    await showLastUser(page);
    await shot(page, '09-390-sent.png');

    const errs = errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
    ok('no leak of real names or paths on screen', leaks.length === 0, JSON.stringify(leaks).slice(0, 300));
  } catch (e) {
    ok('the run completed', false, String(e?.stack || e).slice(0, 1200));
    await page.screenshot({ path: join(OUT, 'crash.png') }).catch(() => {});
  } finally {
    try { writeFileSync(join(LOGS, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8')); } catch {}
    try { writeFileSync(join(LOGS, 'frames.ndjson'), readFileSync(FRAMES, 'utf-8')); } catch {}
    try { writeFileSync(join(LOGS, 'record.json'), readFileSync(RECORD, 'utf-8')); } catch {}
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    srv.kill('SIGTERM');
    spawnSync('pkill', ['-f', join(HOME, '.local', 'bin', 'claude')]);
    await new Promise((r) => setTimeout(r, 800));
    if (!process.env.KEEP_SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`} — screenshots in ${OUT}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
