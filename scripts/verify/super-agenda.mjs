#!/usr/bin/env node
/**
 * The Super Agent's agenda, observed (task super-agent-ajandasi-suren-bekleyen-biten-ve-siradaki-
 * isler-tek-bakista): the real dashboard server from this checkout's dist (scratch HOME,
 * DREAMCONTEXT_DESKTOP=1), a scripted stand-in `claude` (no tokens), fictional project "orbit".
 *
 *   npm run build && node scripts/verify/super-agenda.mjs
 *
 * The owner hands five chats over; one child asks the owner a question. The agenda is a CARD on
 * the stage (owner 2026-10-22 18:56) and the super agent's own NOTEPAD (19:15), never a list of
 * its children: the stand-in super writes it with `super note add` at the hand-over (two Now
 * lines, one Waiting line, one Done line), moves a line to Done (`note done`) and clears it for
 * a new day (`note clear`). Checks: the card opens with the hand-over (large, card chrome), no
 * column or rail and the stage its full width; three sections; Now and Done show only the
 * super's lines (no child names, no estimates, no Up next); Waiting on you shows the open
 * question and the super's waiting line; a question row brings its card in the centre into
 * view (the super's own too); an event line's child name shows that child side by side; the
 * notepad updates live and survives a reload; the card sizes (small = the counts tile), goes to
 * Others and back, and the centre's Agenda button brings it back. The agenda is ALWAYS on the
 * stage (owner 2026-10-22 23:44): its close minimises it to a pill docked bottom-left (the mirror
 * of Others) showing the Waiting-on-you count, a click restores it where it stood, a reload keeps
 * it minimised; after a server restart (the app's start) it is on the stage again, a record with
 * no agenda gets it at its default place, and the stage tidy (a short idle clock on the restarted
 * server) never moves it. Screenshots at 1440x900 light and dark, 1800x1130 dark and 1280x800
 * light; zero page errors.
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
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-agenda-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'orbit');
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify-super-agenda');
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
    if (vid) { cli('super', 'send', vid, 'keep going: ikinci yarıyı render et.'); cli('super', 'brief', vid, 'İkinci yarı render ediliyor', '--eta', '20'); }
    if (dev) { cli('super', 'send', dev, 'keep going: düzeltmeyi yaz ve test et.'); cli('super', 'brief', dev, 'Devir dosyasının yarım yazılması düzeltiliyor', '--eta', '90'); }
    if (fiy) cli('super', 'send', fiy, 'Yıllık indirim oranını sahibe sor.');
    if (not) cli('super', 'brief', not, 'Biten iş artık zil çalıyor');
    if (fat) cli('super', 'brief', fat, "Yeni ledger API'ye taşındı");
    // The agenda is the super's own notepad: plain, high-level lines, never its children's names.
    const notes = [
      cli('super', 'note', 'add', 'now', 'Tanıtım videosunun ikinci yarısını bitiriyoruz'),
      cli('super', 'note', 'add', 'now', 'Oturum devrinde yarım kalan dosyayı düzeltiyoruz'),
      cli('super', 'note', 'add', 'waiting', 'Yıllık plan indirimi için kararın: %15 mi %20 mi'),
      cli('super', 'note', 'add', 'done', 'Fatura toplamları yeni ledger API üstünde, testler geçti'),
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

    ok('the agenda opens as a card on the stage with the hand-over', await until(page, async () => (await agendaCard(page).count()) === 1
      && (await agendaCard(page).getAttribute('data-where')) === 'float' && (await agendaCard(page).locator('[data-testid="super-agenda"][data-variant="full"]').count()) === 1, 15000));
    ok('…a stage card like the others: one record card of kind agenda, sized large', (record().containers ?? []).filter((c) => c.kind === 'agenda' && c.ref === 'agenda' && c.size === 'large').length === 1, JSON.stringify((record().containers ?? []).filter((c) => c.kind === 'agenda')));
    ok('…with the card chrome (size, and minimise to the corner instead of close)', (await agendaCard(page).locator('[data-testid="super-card-size-btn"], [data-testid="super-agenda-minimize"]').count()) === 2
      && (await agendaCard(page).locator('[data-testid="super-card-close"]').count()) === 0);
    ok('no agenda column and no rail', (await page.locator('.super-shell, aside.super-agenda, [data-testid="super-agenda-rail"]').count()) === 0);
    ok('three sections in order: Waiting on you, Now, Done', (await page.locator('[data-testid^="super-agenda-section-"]').evaluateAll((els) => els.map((e) => e.dataset.section))).join(',') === 'waiting,now,done');
    ok('the job bar has no counts and there is no list overlay', (await page.locator('[data-testid^="super-job-count-"], .super-job-counts, [data-testid="super-job-list"]').count()) === 0);
    // The notepad: the super's own lines, written with `super note`.
    ok('the super wrote its notepad (`super note add`)', await until(page, async () => (record().pad ?? []).length === 4, 30000), JSON.stringify(reports().filter((r) => r.kind === 'handover')));
    const noteRows = (sec) => rowsOf(page, sec).and(page.locator('[data-kind="note"]'));
    ok('Now: the super\'s own lines, in its words', await until(page, async () => (await noteRows('now').count()) === 2
      && /Tanıtım videosunun ikinci yarısını bitiriyoruz/.test(await rowsOf(page, 'now').first().innerText()), 15000));
    ok('Done: what finished, in its words', /Fatura toplamları yeni ledger API üstünde/.test(await rowsOf(page, 'done').first().innerText().catch(() => '')));
    const agendaText = await agendaCard(page).innerText();
    ok('no child session is listed (no job names, no estimates, no "Up next")', !/Bildirim düzeltmesi|Super devir sorunu|~\d+ min|Up next/.test(agendaText), agendaText.slice(0, 300));
    ok('the counts match the lines', (await page.getByTestId('super-agenda-count-now').innerText()) === '2' && (await page.getByTestId('super-agenda-count-done').innerText()) === '1');
    // Waiting on you: the question open with him, then what the super noted it needs from him.
    ok('Waiting on you: the open question (the lease is over) and the super\'s own waiting line', await until(page, async () => (await rowsOf(page, 'waiting').filter({ hasText: 'Fiyat sayfası' }).count()) === 1
      && (await noteRows('waiting').filter({ hasText: 'Yıllık plan indirimi için kararın' }).count()) === 1, 45000));
    await page.mouse.move(5, 5);
    await stageSettled(page);
    await shot(page, '01-agenda-1440-light.png');
    // An event line's child name shows that child beside the centre (the agenda lists no children).
    const name = page.locator('[data-super-slot="centre"] .super-event-line-name').first();
    if (await name.count()) {
      await name.click();
      ok('an event line\'s child name shows that child side by side', await until(page, async () => record().view?.mode === 'half', 5000), JSON.stringify(record().view));
      await motionIdle(page);
      await stageSettled(page);
      await shot(page, '05-event-line-shows-child.png');
      await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
      await until(page, async () => record().view?.mode === 'float' && (await agendaCard(page).count()) === 1, 8000);
      await motionIdle(page);
    } else ok('an event line\'s child name shows that child side by side', false, 'no event line name in the centre');
    // A child's question waiting on him opens its card in the centre chat, as the band's Answer does.
    await page.locator('[data-super-slot="centre"] .chat-scroll, [data-super-slot="centre"] [data-chat-scroll]').first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await rowsOf(page, 'waiting').filter({ hasText: 'Fiyat sayfası' }).locator('.super-agenda-row-btn').click();
    ok('a waiting question row brings its card in the centre into view', await until(page, async () => page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-question-card"][data-kind="question"]')].pop();
      if (!card) return false;
      const r = card.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
    }), 8000));
    ok('…and the agenda stays on the stage', (await agendaCard(page).count()) === 1);
    await page.mouse.move(5, 5);
    await stageSettled(page);
    await shot(page, '06-waiting-question-card.png');
    // The super agent's own question: a Waiting row under its name; a click brings its card into view.
    await sayCentre(page, 'SORU-SOR');
    const askRow = rowsOf(page, 'waiting').filter({ hasText: 'Videoyu bu akşam' });
    ok('the super agent\'s own question is a Waiting row', await until(page, async () => (await askRow.count()) === 1, 30000), JSON.stringify(reports().filter((r) => r.kind === 'asked')));
    if (await askRow.count()) {
      await page.locator('[data-super-slot="centre"] .chat-scroll, [data-super-slot="centre"] [data-chat-scroll]').first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
      await askRow.locator('.super-agenda-row-btn').click();
      ok('…a click brings its question card into view', await until(page, async () => page.evaluate(() => {
        const card = [...document.querySelectorAll('[data-super-slot="centre"] [data-testid="super-question-card"]')].pop();
        if (!card) return false;
        const r = card.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight;
      }), 5000));
    }
    // The super keeps it true: a finished line moves to Done, live.
    await sayCentre(page, 'NOT-BITTI');
    ok('`super note done` moves the line to Done, live', await until(page, async () => (await noteRows('now').count()) === 1 && (await noteRows('done').count()) === 2
      && /Tanıtım videosunun ikinci yarısını bitiriyoruz/.test(await rowsOf(page, 'done').first().innerText().catch(() => '')), 30000), JSON.stringify(reports().filter((r) => r.kind === 'note-done')));
    await page.mouse.move(5, 5);
    await stageSettled(page);
    await shot(page, '07-note-done.png');
    // A new day: the super clears it and writes what still holds.
    await sayCentre(page, 'NOT-TEMIZLE');
    ok('`super note clear` empties it; the new line shows', await until(page, async () => (await noteRows('done').count()) === 0 && (await noteRows('now').count()) === 1
      && /Yeni gün/.test(await rowsOf(page, 'now').first().innerText().catch(() => '')), 30000), JSON.stringify(reports().filter((r) => r.kind === 'note-clear')));
    ok('…after a reload the notepad is still there (the record keeps it)', await (async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await backToStage(page);
      return until(page, async () => /Yeni gün/.test(await rowsOf(page, 'now').first().innerText().catch(() => '')), 15000);
    })());
    await page.mouse.move(5, 5);
    await stageSettled(page);
    await shot(page, '08-note-cleared.png');
    // Every line is read whole (owner 2026-10-23): a long note wraps as many lines as it needs,
    // never clamped, never "…"; the card body scrolls.
    await sayCentre(page, 'NOT-UZUN');
    const longText = async () => (record().pad ?? []).find((p) => p.text.startsWith('Web kartı için oturum'))?.text;
    ok('a long note is written (asked 200 characters; the notepad keeps a line to 160)', await until(page, async () => (await longText())?.length === 160, 30000), JSON.stringify(reports().filter((r) => r.kind === 'note-long')));
    const longRow = noteRows('now').filter({ hasText: 'Web kartı için oturum' });
    ok('…it renders whole: its full text, scrollHeight == clientHeight, no ellipsis, no line clamp', await until(page, async () => {
      if (!(await longRow.count())) return false;
      const m = await longRow.locator('.super-agenda-name').evaluate((el) => {
        const cs = getComputedStyle(el);
        return { text: el.textContent, sh: el.scrollHeight, ch: el.clientHeight, to: cs.textOverflow, clamp: cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp'), ws: cs.whiteSpace, lines: Math.round(el.getBoundingClientRect().height / parseFloat(cs.lineHeight || '20')) };
      });
      log(`  long note: ${JSON.stringify({ ...m, text: m.text.length })}`);
      return m.text === await longText() && Math.abs(m.sh - m.ch) <= 1 && m.to !== 'ellipsis' && (m.clamp === 'none' || m.clamp === '') && m.ws === 'normal' && m.lines >= 3;
    }, 10000));
    await elShot(page, agendaCard(page), '08b-agenda-long-note.png', { pad: 8 });
    await agendaShot(page, '02-agenda-1440-light.png', 'light', 1440, 900);
    await agendaShot(page, '03-agenda-1800-dark.png', 'dark', 1800, 1130);
    // At 1280 with a card side by side: it must sit beside the centre, never over it.
    const chatCard = (record().containers ?? []).find((c) => c.kind === 'chat' && c.place === 'float');
    if (chatCard) {
      await page.evaluate(async (id) => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'half', card: id } }) }), chatCard.id);
      await until(page, async () => record().view?.mode === 'half', 8000);
    }
    await agendaShot(page, '04-agenda-1280-light.png', 'light', 1280, 800);
    ok('1280: the stage is not narrow (no column takes its width)', (await page.getByTestId('super-surface').getAttribute('data-narrow')) === null);
    const half = await page.evaluate(() => {
      const c = document.querySelector('.super-centre')?.getBoundingClientRect();
      const cards = [...document.querySelectorAll('[data-testid="super-container"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      return { c: c && { l: c.left, r: c.right }, over: cards.filter((r) => c && r.left < c.right - 1 && r.right > c.left + 1 && r.top < c.bottom && r.bottom > c.top).length };
    });
    ok('1280: side by side sits beside the centre, no card covers it', half.over === 0, JSON.stringify(half));
    // Side by side, the agenda waits in Others like every card; the centre's Agenda button
    // brings the floating stage back with it.
    ok('1280 side by side: the agenda waits in Others, the centre offers it', (await agendaCard(page).count()) === 0 && (await page.getByTestId('super-agenda-open').count()) === 1);
    ok('…its badge counts what waits on him', /^\d+$/.test((await page.getByTestId('super-agenda-open').locator('.super-agenda-open-n').innerText().catch(() => '')).trim()));
    await page.mouse.move(5, 5);
    await shot(page, '09a-agenda-button-1280.png');
    await page.getByTestId('super-agenda-open').click();
    ok('…its Agenda button brings it back (the floating stage)', await until(page, async () => (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float' && record().view?.mode === 'float', 8000));
    await motionIdle(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '09-agenda-1280-float.png');
    // Sizes: small is the counts tile.
    const agendaId = (record().containers ?? []).find((c) => c.kind === 'agenda')?.id;
    await agendaCard(page).hover();
    await agendaCard(page).locator('[data-testid="super-card-size-btn"]').click();
    await page.getByTestId('super-size-small').click();
    ok('sized small, the agenda is its counts tile', await until(page, async () => (await agendaCard(page).getAttribute('data-size')) === 'small'
      && (await agendaCard(page).locator('[data-testid="super-agenda"][data-variant="tile"] [data-testid^="super-agenda-tile-"]').count()) === 3, 8000));
    ok('…recorded as the owner\'s size', await until(page, async () => (record().containers ?? []).some((c) => c.id === agendaId && c.sizeBy === 'owner' && !c.size), 8000), JSON.stringify((record().containers ?? []).find((c) => c.id === agendaId)));
    await motionIdle(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '10-agenda-small-tile.png');
    for (const [size, variant, file] of [['medium', 'tile', '10b-agenda-medium.png'], ['wide', 'full', '10c-agenda-wide-1440.png']]) {
      // Wide (3x2 tiles) needs a wider window than 1280 (the menu says so): sized at 1440.
      if (size === 'wide') { await page.setViewportSize({ width: 1440, height: 900 }); await motionIdle(page); await stageSettled(page); }
      await agendaCard(page).hover();
      await agendaCard(page).locator('[data-testid="super-card-size-btn"], [data-testid="super-card-more"]').first().click();
      await page.getByTestId(`super-size-${size}`).click();
      ok(`sized ${size}, the agenda draws ${variant === 'tile' ? 'its counts in one row' : 'the notepad'}`, await until(page, async () => (await agendaCard(page).getAttribute('data-size')) === size
        && (await agendaCard(page).locator(`[data-testid="super-agenda"][data-variant="${variant}"]`).count()) === 1, 8000));
      await motionIdle(page);
      await stageSettled(page);
      await page.mouse.move(5, 5);
      await shot(page, file);
    }
    // Others and back, like any card.
    await agendaCard(page).hover();
    await agendaCard(page).getByRole('button', { name: /^(To Others|Diğerlerine)$/ }).click();
    ok('Move to Others: the agenda rests in Others', await until(page, async () => (record().containers ?? []).some((c) => c.id === agendaId && c.place === 'others') && (await agendaCard(page).count()) === 0, 8000));
    await page.getByTestId('super-agenda-open').click();
    ok('…the Agenda button brings it back from Others', await until(page, async () => (record().containers ?? []).some((c) => c.id === agendaId && c.place === 'float') && (await agendaCard(page).count()) === 1, 8000));
    // Minimised, never closed (owner 2026-10-22 23:44): a pill docked bottom-left, the mirror of
    // Others; a click restores the card where it stood.
    await page.setViewportSize({ width: 1440, height: 900 });
    await motionIdle(page);
    await stageSettled(page);
    const before = await agendaCard(page).boundingBox();
    await agendaCard(page).hover();
    // Filmed slowed: the card flies into its corner pill (as a card flies into Others).
    await filmstrip(page, 'film-minimise', () => agendaCard(page).locator('[data-testid="super-agenda-minimize"]').click(),
      { rate: 0.1, step: 90, maxMs: 900, settle: async () => (await page.locator('.super-stage-layer').evaluate((e) => e.childElementCount)) === 0 });
    ok('minimised, the agenda stays in the record (min), off the stage, never dismissed', await until(page, async () => (record().containers ?? []).some((c) => c.kind === 'agenda' && c.min === true && c.place === 'float')
      && (await agendaCard(page).count()) === 0 && !(record().dismissed ?? []).some((d) => d.kind === 'agenda'), 8000), JSON.stringify((record().containers ?? []).find((c) => c.kind === 'agenda')));
    const pillGeo = async () => page.evaluate(() => {
      const stage = document.querySelector('[data-testid="super-surface"]').getBoundingClientRect();
      const pill = document.querySelector('[data-testid="super-agenda-pill"]')?.getBoundingClientRect();
      const others = document.querySelector('[data-testid="super-others"]')?.getBoundingClientRect();
      const cards = [...document.querySelectorAll('[data-testid="super-container"], [data-testid="super-group"], .super-centre, .super-terminal-chip')].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
      return pill && {
        dl: pill.left - stage.left, db: stage.bottom - pill.bottom, w: pill.width, h: pill.height,
        others: others ? { db: stage.bottom - others.bottom, dr: stage.right - others.right } : null,
        over: cards.filter((r) => r.left < pill.right && r.right > pill.left && r.top < pill.bottom && r.bottom > pill.top).length,
        n: document.querySelector('[data-testid="super-agenda-pill-n"]')?.textContent?.trim(),
        badge: document.querySelector('[data-testid="super-agenda-open"] .super-agenda-open-n')?.textContent?.trim() ?? '0',
      };
    });
    const pg = await pillGeo();
    ok('…a pill docked at the stage\'s bottom-left corner, nothing over it', !!pg && Math.abs(pg.dl - 24) <= 1 && pg.db >= 8 && pg.db <= 16 && pg.over === 0, JSON.stringify(pg));
    ok('…mirroring Others (the same band, opposite corners)', !!pg && (!pg.others || (Math.abs(pg.others.db - pg.db) <= 1 && Math.abs(pg.others.dr - pg.dl) <= 1)), JSON.stringify(pg));
    ok('…showing the Waiting-on-you count (the header Agenda button is a second way back)', !!pg && /^\d+$/.test(pg.n ?? '') && pg.n === pg.badge && (await page.getByTestId('super-agenda-open').count()) === 1, JSON.stringify(pg));
    await page.mouse.move(5, 5);
    ok('…the stage settled before the shot', await stageSettled(page));
    await shot(page, '14-agenda-pill-1440-light.png');
    await elShot(page, '[data-testid="super-agenda-pill"]', '14b-agenda-pill-closeup-light.png', { pad: 24 });
    // Dark, after a reload: still minimised (the stage load only makes a missing agenda).
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    ok('a reload keeps it minimised (the pill, no card)', await until(page, async () => (await page.getByTestId('super-agenda-pill').count()) === 1 && (await agendaCard(page).count()) === 0, 10000));
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '15-agenda-pill-1440-dark.png');
    await elShot(page, '[data-testid="super-agenda-pill"]', '15b-agenda-pill-closeup-dark.png', { pad: 24 });
    await page.getByTestId('super-agenda-pill-btn').click();
    ok('a click on the pill restores the card where it stood', await until(page, async () => {
      const b = await agendaCard(page).boundingBox().catch(() => null);
      return !!b && !!before && Math.abs(b.x - before.x) <= 2 && Math.abs(b.y - before.y) <= 2 && Math.abs(b.width - before.width) <= 2
        && (await page.getByTestId('super-agenda-pill').count()) === 0 && !(record().containers ?? []).some((c) => c.kind === 'agenda' && c.min);
    }, 8000), JSON.stringify({ before, after: await agendaCard(page).boundingBox().catch(() => null) }));
    await motionIdle(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '16-agenda-restored-1440-dark.png');
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'light'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    // One stacking order (owner 2026-10-23: the agenda covered an opened group): the agenda the
    // owner dragged last (placed and lifted on top, the bug's precondition) still paints UNDER an
    // opened group's panel. A real drag, a group of two floating chats, the panel opened by a click.
    {
      await motionIdle(page);
      await stageSettled(page);
      const ab = await agendaCard(page).boundingBox().catch(() => null);
      ok('the agenda is on the stage before the z-order check', !!ab, JSON.stringify((record().containers ?? []).find((c) => c.kind === 'agenda')));
      if (!ab) throw new Error('no agenda card for the z-order check');
      await page.mouse.move(ab.x + 70, ab.y + 16);
      await page.mouse.down();
      await page.mouse.move(ab.x + 85, ab.y + 22, { steps: 4 });
      await page.mouse.move(ab.x + 100, ab.y + 28, { steps: 4 });
      await page.mouse.up();
      ok('the owner dragged the agenda (placed by him)', await until(page, async () => (record().containers ?? []).some((c) => c.kind === 'agenda' && c.pos), 8000), JSON.stringify((record().containers ?? []).find((c) => c.kind === 'agenda')));
      await motionIdle(page);
      await stageSettled(page);
      const chats = (record().containers ?? []).filter((c) => c.kind === 'chat' && c.place === 'float' && !(record().groups ?? []).some((g) => g.cards.includes(c.id))).slice(0, 2).map((c) => c.id);
      await page.evaluate(async (ids) => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ group: { id: 'grp-zorder', cards: ids } }) }), chats);
      await until(page, async () => (await page.locator('[data-testid="super-group"]').count()) === 1, 8000);
      await motionIdle(page);
      await stageSettled(page);
      await page.locator('[data-testid="super-group"] .super-group-name, [data-testid="super-group"]').first().click({ position: { x: 40, y: 60 } });
      const opened = await until(page, async () => (await page.getByTestId('super-group-panel').count()) === 1, 8000);
      await page.waitForTimeout(600);
      const z = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="super-group-panel"]');
        const agenda = document.querySelector('[data-testid="super-container"][data-kind="agenda"]');
        if (!panel || !agenda) return { missing: !panel ? 'panel' : 'agenda' };
        const a = agenda.getBoundingClientRect();
        let p = panel.getBoundingClientRect();
        let moved = false;
        const inter = () => ({ l: Math.max(a.left, p.left), r: Math.min(a.right, p.right), t: Math.max(a.top, p.top), b: Math.min(a.bottom, p.bottom) });
        let i = inter();
        if (i.r - i.l < 20 || i.b - i.t < 20) {
          // No natural overlap at this size: shift the panel onto the agenda (paint order does not
          // depend on where it stands).
          panel.style.translate = `${a.left + a.width / 2 - (p.left + 40)}px ${a.top + a.height / 2 - (p.top + 40)}px`;
          p = panel.getBoundingClientRect(); moved = true; i = inter();
        }
        const x = (i.l + i.r) / 2; const y = (i.t + i.b) / 2;
        const hit = document.elementFromPoint(x, y);
        const res = { moved, x: Math.round(x), y: Math.round(y), inPanel: !!hit?.closest('[data-testid="super-group-panel"]'), inAgenda: !!hit?.closest('[data-kind="agenda"]'), hit: hit?.className?.toString().slice(0, 60),
          zAgenda: getComputedStyle(agenda).zIndex, zPanel: getComputedStyle(panel).zIndex, zScrim: getComputedStyle(document.querySelector('[data-testid="super-panel-scrim"]')).zIndex };
        return res;
      });
      log(`  z-order: ${JSON.stringify(z)}`);

      ok('an opened group paints above the agenda the owner moved last (elementFromPoint over the overlap hits the panel)', opened && z.inPanel === true && z.inAgenda === false, JSON.stringify(z));
      await page.mouse.move(5, 5);
      await shot(page, '11b-group-open-over-agenda.png');
      await page.evaluate(() => { const p = document.querySelector('[data-testid="super-group-panel"]'); if (p) p.style.translate = ''; });
      await page.keyboard.press('Escape');
      await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ ungroup: ['grp-zorder'] }) }));
      await until(page, async () => !(record().groups ?? []).some((g) => g.id === 'grp-zorder'), 8000);
      await motionIdle(page);
      // A card with its size menu open lifts over the agenda (what it opened is never under it).
      await stageSettled(page);
      const menuCard = page.locator('[data-testid="super-container"][data-where="float"]:not([data-kind="agenda"])').first();
      await menuCard.hover();
      await menuCard.locator('[data-testid="super-card-size-btn"], [data-testid="super-card-more"]').first().click();
      const lift = await until(page, async () => (await menuCard.evaluate((el) => getComputedStyle(el.closest('.super-card-frame') ?? el).zIndex)) === '302'
        && (await page.locator('[data-testid="super-container"][data-kind="agenda"]').evaluate((el) => getComputedStyle(el.closest('.super-card-frame') ?? el).zIndex)) === '298', 4000);
      ok('a card with its menu open paints above the agenda (302 over 298)', lift, JSON.stringify(await menuCard.evaluate((el) => getComputedStyle(el.closest('.super-card-frame') ?? el).zIndex)));
      await page.keyboard.press('Escape');
      await until(page, async () => (await page.getByTestId('super-card-size').count()) === 0, 4000);
      await page.mouse.move(5, 5);
      await motionIdle(page);
      await stageSettled(page);
    }
    // Grouped with a card, the agenda is drawn as the group's tile: the centre offers it, and a
    // press brings it out of the group, floating (end review r1).
    const chatId = (record().containers ?? []).find((c) => c.kind === 'chat' && c.place === 'float')?.id;
    const agendaNow = (record().containers ?? []).find((c) => c.kind === 'agenda')?.id;
    if (chatId && agendaNow) {
      await page.evaluate(async (ids) => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ group: { id: 'grp-verify', cards: ids } }) }), [chatId, agendaNow]);
      ok('grouped, the agenda is no card of its own and the centre offers it', await until(page, async () => (record().groups ?? []).length === 1 && (await agendaCard(page).count()) === 0 && (await page.getByTestId('super-agenda-open').count()) === 1, 8000));
      await page.getByTestId('super-agenda-open').click();
      ok('…a press brings it out of the group, floating', await until(page, async () => !(record().groups ?? []).some((g) => g.cards.includes(agendaNow)) && (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float', 8000), JSON.stringify(record().groups));
      await motionIdle(page);
    }
    // A stage too narrow to float cards: every card waits in Others; the press opens the agenda
    // side by side (a sheet) instead of doing nothing (end review r1).
    await page.setViewportSize({ width: 1024, height: 720 });
    await until(page, async () => (await page.getByTestId('super-surface').getAttribute('data-narrow')) === 'true', 8000);
    ok('narrow stage: the centre offers the agenda', await until(page, async () => (await page.getByTestId('super-agenda-open').count()) === 1, 8000));
    await page.getByTestId('super-agenda-open').click();
    ok('…a press opens it as a sheet with the notepad', await until(page, async () => (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'sheet'
      && (await agendaCard(page).locator('[data-testid="super-agenda"][data-variant="full"]').count()) === 1, 8000));
    await motionIdle(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '13-agenda-narrow-sheet.png');
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' } }) }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await until(page, async () => record().view?.mode === 'float' && (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float', 8000);
    await motionIdle(page);
    // A child's permission waiting on him: its row shows that child beside the centre, the agenda
    // presented next to it (the agenda stays in view).
    await sayCentre(page, 'IZIN-GONDER');
    const perm = rowsOf(page, 'waiting').and(page.locator('[data-chip="permission"]'));
    ok('a child\'s permission is a Waiting row (no words of the super)', await until(page, async () => (await perm.count()) === 1, 45000), JSON.stringify(reports().filter((r) => r.kind === 'permission-sent')));
    if (await perm.count()) {
      await perm.locator('.super-agenda-row-btn').click();
      ok('…its row shows that child beside the centre with the agenda presented next to it', await until(page, async () => {
        const v = record().view;
        return v?.mode === 'present' && v.cards?.length === 2 && v.cards[1] === agendaNow
          && (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'present' && (await page.locator('[data-testid="super-shown"]').count()) === 1;
      }, 8000), JSON.stringify(record().view));
      await motionIdle(page);
      await stageSettled(page);
      await page.mouse.move(5, 5);
      await shot(page, '12-permission-row-present.png');
    }
    // The app's start (owner 2026-10-22 23:44: "it should be open by itself"): minimised before
    // the restart, the agenda is on the stage again after it; a record with no agenda at all (the
    // 0.34.2 owner's, who closed it) gets it at its default place.
    await page.evaluate(async () => fetch('/api/super/layout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dreamcontext-Vault': 'orbit' }, body: JSON.stringify({ view: { mode: 'float' }, agenda: 'min' }) }));
    ok('minimised before the restart', await until(page, async () => (record().containers ?? []).some((c) => c.kind === 'agenda' && c.min) && (await page.getByTestId('super-agenda-pill').count()) === 1, 8000));
    const restart = async (tag, edit, extraEnv = {}) => {
      srv.kill('SIGTERM');
      await new Promise((r) => (srv.exitCode !== null ? r() : srv.once('exit', r)));
      if (edit) { const rec = record(); edit(rec); writeFileSync(RECORD, JSON.stringify(rec)); }
      srv = await startServer(port, extraEnv, `server-${tag}.log`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await backToStage(page);
    };
    await restart('restart1');
    ok('after a restart the agenda is on the stage (restored from its pill, floating)', await until(page, async () => (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float'
      && (await page.getByTestId('super-agenda-pill').count()) === 0 && (record().containers ?? []).some((c) => c.kind === 'agenda' && !c.min && c.place === 'float'), 20000), JSON.stringify((record().containers ?? []).find((c) => c.kind === 'agenda')));
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '17-after-restart-1440-light.png');
    // No agenda in the record (closed under 0.34.2), and a short tidy clock: the agenda appears at
    // its default place, and the tidy puts untouched cards in Others but never the agenda.
    const IDLE = 6000;
    await restart('restart2', (rec) => { rec.containers = (rec.containers ?? []).filter((c) => c.kind !== 'agenda'); rec.view = { mode: 'float' }; },
      { DREAMCONTEXT_SUPER_TIDY_IDLE_MS: String(IDLE), DREAMCONTEXT_SUPER_TIDY_TICK_MS: '1000' });
    ok('a record with no agenda gets it on the stage load: first in the record, large, floating', await until(page, async () => {
      const cs = record().containers ?? [];
      return cs[0]?.kind === 'agenda' && cs[0].size === 'large' && cs[0].place === 'float' && (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float';
    }, 20000), JSON.stringify((record().containers ?? []).map((c) => [c.kind, c.place, c.size])));
    const floatBefore = (record().containers ?? []).filter((c) => c.kind !== 'agenda' && c.place === 'float').length;
    await page.mouse.move(5, 5);
    await page.waitForTimeout(IDLE + 4000);
    const afterTidy = record().containers ?? [];
    const tidied = afterTidy.filter((c) => c.kind !== 'agenda' && c.place === 'others').length;
    ok('the tidy ran (untouched cards went to Others)', tidied > 0, JSON.stringify({ floatBefore, after: afterTidy.map((c) => [c.kind, c.place]) }));
    ok('…and never moved the agenda (floating, on the stage)', afterTidy.some((c) => c.kind === 'agenda' && c.place === 'float' && !c.min) && (await agendaCard(page).getAttribute('data-where').catch(() => null)) === 'float');
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '18-after-tidy-1440-light.png');
    await page.evaluate(() => localStorage.setItem('dreamcontext-theme', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await backToStage(page);
    await stageSettled(page);
    await page.mouse.move(5, 5);
    await shot(page, '19-after-tidy-1440-dark.png');
    const errs = errors.filter((e) => !/favicon|WebSocket|ERR_CONNECTION_REFUSED/i.test(e));
    ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  } catch (e) {
    ok('the run completed', false, String(e).slice(0, 1200));
  } finally {
    try { writeFileSync(join(LOGS, 'reports.ndjson'), readFileSync(REPORTS, 'utf-8')); } catch {}
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
