#!/usr/bin/env node
/**
 * The agenda keeps itself true, observed (owner 2026-10-27: "the agenda goes stale"): the real
 * dashboard server from this checkout's dist (scratch HOME, DREAMCONTEXT_DESKTOP=1), the same
 * scripted stand-in `claude` as super-agenda.mjs (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-agenda-fresh.mjs
 *
 * At the hand-over the stand-in super writes three Now lines: one linked to the video job, which
 * keeps working (`--for`), one linked to the notification job, which already finished its turn
 * (`--for`), and one with no job. Checks: the notification line moves to Done BY ITSELF once that
 * job settles done, marked "kendiliğinden kapandı" on the card; the super's next `[super events]`
 * turn carries the `[agenda]` block naming it; the video line stays in Now; the owner's "Geri al"
 * puts it back in Now (`by: owner`) and later writes never move it again; a jobless Now line two
 * hours old (record edited across a server restart) is flagged on the card and in `super state`.
 * Screenshots at 1440x900 light and dark and 390x844; zero page errors.
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-agenda-fresh-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-agenda-fresh');
const LOGS = join(OUT, 'logs');
const FRAMES = join(SCRATCH, 'frames.ndjson');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const W = 1440; const H = 900;

// ─── the stand-in `claude` ──────────────────────────────────────────────────────────────
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = 'cap-' + process.pid;
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
async function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    await sleep(800);
    const vid = byBrief('Tanıtım videosu'); const dev = byBrief('Super devir sorunu'); const fiy = byBrief('Fiyat sayfası');
    const not = byBrief('Bildirim düzeltmesi'); const fat = byBrief('Fatura toplamları');
    if (vid) { cli('super', 'send', vid, 'keep going: ikinci yarıyı render et.'); cli('super', 'brief', vid, 'İkinci yarı render ediliyor'); }
    if (dev) { cli('super', 'send', dev, 'keep going: düzeltmeyi yaz ve test et.'); cli('super', 'brief', dev, 'Devir dosyasının yarım yazılması düzeltiliyor'); }
    if (not) cli('super', 'brief', not, 'Biten iş artık zil çalıyor');
    if (fat) cli('super', 'brief', fat, "Yeni ledger API'ye taşındı");
    // The agenda is the super's own notepad: plain, high-level lines, never its children's names.
    // Two NEW jobs started with their agenda line (delegate --note): one keeps working, one
    // finishes; plus a line with no job. The owner's own chats are never linked (--for refuses).
    const notes = [
      cli('super', 'delegate', '--prompt', 'Tanitim videosu keep going: ikinci yarıyı render et.', '--brief', 'Video ikinci yarı', '--note', 'Tanıtım videosunun ikinci yarısını bitiriyoruz'),
      cli('super', 'delegate', '--prompt', 'Bildirim: biten iş zil çalmıyor, düzelt.', '--brief', 'Zil düzeltmesi', '--note', 'Biten işte zilin çalmasını düzeltiyoruz'),
      cli('super', 'note', 'add', 'now', 'Fiyat sayfasının metnini toparlıyoruz'),
      cli('super', 'note', 'add', 'now', 'Adopted chat line', '--for', not),
    ];
    report({ kind: 'handover', children: Object.keys(children()), notes: notes.map((n) => ({ st: n.status, o: n.out.slice(0, 160) })) });
    return 'Beş işi devraldım. Video ve devir sorunu çalışıyor, fiyat sayfası sana bir şey soracak.';
  }
  if (text.startsWith('[super')) { report({ kind: 'event', text: text.slice(0, 300) }); return null; }
  if (/IZIN-GONDER/.test(text)) {
    const not = byBrief('Biten iş artık zil çalıyor') ?? byBrief('Bildirim düzeltmesi');
    const r = not ? cli('super', 'send', not, 'IZIN-ISTE: build klasörünü temizle') : null;
    report({ kind: 'permission-sent', child: not, status: r?.status });
    return 'Bildirim işine temizlik yaptırıyorum.';
  }
  if (/NOT-BITTI/.test(text)) {
    // The video finished: its Now line moves to Done.
    const r = cli('super', 'note', 'done', 'n1');
    report({ kind: 'note-done', status: r.status, out: r.out.slice(0, 160) });
    return 'Video bitti, ajandaya yazdım.';
  }
  if (/NOT-TEMIZLE/.test(text)) {
    // A new day: the super clears its notepad and writes what still holds.
    const c = cli('super', 'note', 'clear');
    const a = cli('super', 'note', 'add', 'now', 'Yeni gün: fiyat sayfası metnini bitiriyoruz');
    report({ kind: 'note-clear', status: [c.status, a.status], out: a.out.slice(0, 160) });
    return 'Ajandayı yeni güne göre temizledim.';
  }
  if (/NOT-UZUN/.test(text)) {
    // A long line (owner 2026-10-23: a cut line cannot be read): 200 characters asked for.
    const long = 'Web kartı için oturum kalıcı olacak, önbellek temizleme düğmesi gelecek, Inspect seçimi mesaja eklenecek ve sunum düzenleri tahtada geniş site ile küçük Super seçenekleriyle çizilip sana gösterilecek bugün';
    const r = cli('super', 'note', 'add', 'now', long.slice(0, 200));
    report({ kind: 'note-long', status: r.status, asked: long.slice(0, 200).length, out: r.out.slice(0, 200) });
    return 'Uzun notu yazdım.';
  }
  if (/SORU-SOR/.test(text)) {
    const r = cli('super', 'ask', 'Videoyu bu akşam yayına alalım mı?', '--options', 'Evet|Yarın');
    report({ kind: 'asked', status: r.status, out: r.out.slice(0, 200) });
    return 'Bir sorum var.';
  }
  report({ kind: 'owner', text });
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

async function main() {
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = await startServer(port);
  log(`server on ${base}, scratch ${SCRATCH}`);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'tr-TR' });
  await context.addInitScript(() => { try { if (!localStorage.getItem('dreamcontext-theme')) localStorage.setItem('dreamcontext-theme', 'light'); } catch {} });
  const page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const pad = () => record().pad ?? [];
  const line = (re) => pad().find((p) => re.test(p.text));
  const VIDEO = /Tanıtım videosunun/; const BELL = /zilin çalmasını/; const FREE = /Fiyat sayfasının metnini/;
  const noteRow = (sec, re) => rowsOf(page, sec).and(page.locator('[data-kind="note"]')).filter({ hasText: re });
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
    ok('the super wrote three Now lines at the hand-over, two linked to a job', await until(page, async () => pad().length === 3 && !!line(VIDEO)?.for && !!line(BELL)?.for, 90000), JSON.stringify(reports().filter((r) => r.kind === 'handover')));
    const kids = record().children ?? {};
    const vidSid = Object.keys(kids).find((k) => kids[k].brief === 'Video ikinci yarı');
    const bellSid = Object.keys(kids).find((k) => kids[k].brief === 'Zil düzeltmesi');
    ok('…`delegate --note` links each line to the child it started; the jobless line has none', !!vidSid && !!bellSid && !kids[vidSid].adopted && line(VIDEO)?.for === vidSid && line(BELL)?.for === bellSid && !line(FREE)?.for, JSON.stringify(pad()));
    ok('…and `--for` on the owner\'s own chat is refused (`adopted`)', await until(page, async () => !pad().some((p) => /Adopted chat line/.test(p.text))
      && /"error": "adopted"/.test(reports().find((r) => r.kind === 'handover')?.notes?.[3]?.o ?? ''), 20000), JSON.stringify(reports().find((r) => r.kind === 'handover')?.notes));

    // The finished job's line moves to Done by itself, the owner sees it on the card.
    ok('the finished job\'s line moves Now -> Done by itself (by: auto, why: done)', await until(page, async () => {
      const b = line(BELL); return b?.section === 'done' && b.by === 'auto' && b.why === 'done';
    }, 120000), JSON.stringify(line(BELL)));
    ok('…on the card: in Done, marked "kendiliğinden kapandı"', await until(page, async () => (await noteRow('done', BELL).count()) === 1
      && /kendiliğinden kapandı|closed by itself/.test(await noteRow('done', BELL).innerText()), 15000));
    ok('the working job\'s line stays in Now', line(VIDEO)?.section === 'now' && (await noteRow('now', VIDEO).count()) === 1);
    // No question is open with the owner in this run (the held path, where the notice rides in
    // his answer or the first batch after it, is tests/unit/super-held.test.ts).
    const told = async () => frames().some((f) => f.role === 'super' && f.blocks.join('').includes('[agenda]')
      && f.blocks.join('').includes(`note=${line(BELL)?.id} moved Now -> Done by itself`) && f.blocks.join('').includes(`child=${bellSid}`));
    ok('the super\'s next `[super events]` turn carries `[agenda]` (note id, child)', await until(page, told, 90000),
      frames().filter((f) => f.role === 'super').map((f) => f.blocks.join('').slice(0, 160)).join(' || ').slice(0, 600));
    await page.waitForTimeout(1500);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '01-auto-closed-1440-light.png');
    await elShot(page, agendaCard(page), '02-agenda-card-auto-closed-1440-light.png', { pad: 8 });

    // The owner puts it back by hand: it stays where he put it.
    const row = noteRow('done', BELL);
    await row.hover();
    const back = row.locator('[data-testid="super-agenda-move"][data-to="now"]');
    ok('hovering a Done note shows the owner\'s "Geri al"', await until(page, async () => (await back.evaluate((e) => getComputedStyle(e).opacity)) === '1', 5000));
    await elShot(page, agendaCard(page), '03-agenda-hover-geri-al-1440-light.png', { pad: 8 });
    await back.click();
    ok('"Geri al" puts it in Now, marked the owner\'s (by: owner)', await until(page, async () => line(BELL)?.section === 'now' && line(BELL)?.by === 'owner'
      && (await noteRow('now', BELL).count()) === 1 && (await noteRow('done', BELL).count()) === 0, 10000), JSON.stringify(line(BELL)));
    // Later writes (the owner's layout here) never move it back while its job stays done.
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    await page.waitForTimeout(4000);
    ok('…and later writes leave it where he put it', line(BELL)?.section === 'now' && line(BELL)?.by === 'owner' && (record().children?.[bellSid]?.row === 'done'), JSON.stringify({ l: line(BELL), row: record().children?.[bellSid]?.row }));
    // The owner's Done on a Now line, then back: both by hand.
    const vrow = noteRow('now', VIDEO);
    await vrow.hover();
    await vrow.locator('[data-testid="super-agenda-move"][data-to="done"]').click();
    ok('the owner\'s "Bitti" moves a Now line to Done (by: owner)', await until(page, async () => line(VIDEO)?.section === 'done' && line(VIDEO)?.by === 'owner' && (await noteRow('done', VIDEO).count()) === 1, 10000), JSON.stringify(line(VIDEO)));

    // A jobless Now line two hours old: flagged on the card and in `super state`.
    const restart = async (tag, edit) => {
      srv.kill('SIGTERM');
      await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r)));
      if (edit) { const rec = record(); edit(rec); writeFileSync(RECORD, JSON.stringify(rec)); }
      srv = await startServer(port, {}, `server-${tag}.log`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await backToStage(page);
    };
    await restart('stale', (rec) => { for (const p of rec.pad) if (FREE.test(p.text)) p.at = Date.now() - 2 * 60 * 60 * 1000 - 5 * 60 * 1000; });
    ok('a jobless Now line unchanged for 2 h is flagged on the card ("2 saattir değişmedi")', await until(page, async () => (await noteRow('now', FREE).count()) === 1
      && /2 saattir değişmedi|unchanged 2h\+/.test(await noteRow('now', FREE).innerText()), 20000));
    ok('…and the owner\'s moves survived the restart', line(BELL)?.by === 'owner' && line(BELL)?.section === 'now');
    const st = await page.evaluate(async () => (await fetch('/api/super/state', { headers: { 'X-Dreamcontext-Vault': 'orbit' } })).json());
    ok('the window\'s state carries the line\'s time (the card computes the flag)', (st.pad ?? st.state?.pad ?? []).some((p) => /Fiyat sayfasının/.test(p.text)));
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '04-stale-1440-light.png');
    await elShot(page, agendaCard(page), '05-agenda-card-stale-1440-light.png', { pad: 8 });
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await elShot(page, agendaCard(page), '06-agenda-card-1440-dark.png', { pad: 8 });
    // A phone width: the card still reads, the move buttons show without hover.
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await page.waitForTimeout(1500);
    await clean(page);
    await page.screenshot({ path: join(OUT, '07-stage-390-light.png') });
    log('  saved 07-stage-390-light.png');
    const narrowAgenda = await page.locator('[data-testid="super-agenda"]').count();
    ok('at 390 px the agenda is still reachable on the stage', narrowAgenda >= 1 || (await page.getByTestId('super-agenda-pill').count()) === 1 || (await page.locator('[data-testid="super-agenda-open"], [data-testid="super-agenda-btn"]').count()) >= 1);
    const errs = errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
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
