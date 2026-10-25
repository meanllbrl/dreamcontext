/**
 * Capture the v0.35.0 announcement's screenshots: the Super Agent's stage with its agenda, a
 * PDF and a clip; a picture question presented on that stage; the Super dock over the Tasks
 * board; a global AI Team agent and a task given to an agent with a reviewer; and the phone in
 * Mac mode (one list over two projects, the Super Agent's chat with its agenda).
 *
 * Runs against the release candidate's own build over the fictional "orbit" demo vault in a fake
 * HOME under the OS temp dir (nothing real on screen), with a `claude` stand-in that answers from
 * a fixed script and, as the Super Agent, really runs `dreamcontext super …` from inside its
 * chat, so the stage is the app's own layout of real cards. No turn is spent.
 *   npm run build
 *   T=$(node -e "console.log(require('fs').realpathSync(require('os').tmpdir()))")
 *   ROOT=$T/dc-ann-035 DC=$PWD/dist/index.js <main checkout>/marketing/build-demo-vault-v2.sh
 *   unlink $T/dc-ann-035/home/Library/Keychains     # no live Claude login in the fake HOME
 *   (mkdir $T/dc-ann-035/atlas-mobile; cd there; git init; HOME=$T/dc-ann-035/home
 *    node dist/index.js init -y --name atlas-mobile; … vaults add atlas-mobile <dir>)
 *   DEMO_ROOT=$T/dc-ann-035 node e2e/announce-shots-0-35.mjs
 *
 * The PDF, the clip and the three picture options are made here, from fictional HTML. Mac mode
 * runs over the server's loopback stand-ins (`DREAMCONTEXT_MAC_VERIFY_POWER_LOG`,
 * `DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL`, honoured only under the OS temp dir): no pmset, no tunnel.
 * COLLECT-DON'T-FAIL-FAST: a scene that cannot be reached is reported and skipped.
 */
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { markAnnouncementsSeen, setTheme } from '../scripts/verify/lib/measure.mjs';

const DEMO = process.env.DEMO_ROOT;
if (!DEMO) throw new Error('DEMO_ROOT is required (the demo vault root)');
const HOME = join(DEMO, 'home');
if (!realpathSync(HOME).startsWith(realpathSync(tmpdir()) + '/')) throw new Error('the demo HOME must sit under os.tmpdir()');
const PROJ = realpathSync(join(DEMO, 'proj'));
const ATLAS = realpathSync(join(DEMO, 'atlas-mobile'));
const CLI = resolve('dist/index.js');
const OUT = resolve(process.env.OUT_DIR ?? 'dashboard/public/announcements/shots/v0-35-0');
const RAW = join(DEMO, 'raw');
const REPORTS = join(DEMO, 'super-reports.ndjson');
const VAULT = 'orbit';
const ONLY = (process.env.ONLY ?? 'all').split(',');
const on = (g) => ONLY.includes('all') || ONLY.includes(g);
for (const d of [OUT, RAW, join(HOME, '.local', 'bin'), join(PROJ, 'docs'), join(PROJ, 'clips'), join(PROJ, 'designs')]) mkdirSync(d, { recursive: true });
rmSync(REPORTS, { force: true });

const PDF = 'docs/trial-interviews-sept.pdf';
const CLIP = 'clips/day-1-walkthrough.mp4';
const DESIGNS = ['designs/prompt-banner.png', 'designs/prompt-modal.png', 'designs/prompt-checklist.png'];

// ── The stand-in `claude` ──────────────────────────────────────────────────────────────
const CHILD = [
  ['Why did trial-to-paid fall', 'It fell the week the v2 onboarding emails shipped, and single-source trials fell hardest.'],
  ['data sources each trial connected', 'Two-source trials converted at 31%, single-source trials at 11%. Single-source trials carry the whole drop.'],
  ['look for in a change', 'What breaks for a customer, what has no test, and what the next person will not understand. I say each in one line, worst first.'],
  ['day-1', 'Three designs for the day-1 prompt are in designs/: a banner, a modal and a checklist.'],
];
const SUPER_EVENT = [
  ['Cohort split', 'The split is in: two-source trials convert at 31%, single-source at 11%. The drop is the single-source trials.'],
  ['Day-1 prompt', 'The three day-1 prompt designs are ready. I will put them in front of you.'],
];
const SUPER_HANDOVER = 'Your trial-to-paid chat is with me now. I started two more: one splits the drop by data sources, one designs a day-1 prompt. The September interviews and the day-1 walkthrough are on the stage.';
const QUESTION = {
  title: 'Trial-to-paid → day-1 prompt',
  questions: [{
    question: 'Which day-1 prompt goes on the investigation task?',
    header: 'Day-1 prompt',
    description: 'The design you pick is the one the onboarding task builds next.',
    multiSelect: false,
    options: [
      { label: 'Banner', description: 'Quiet, stays on top of the first dashboard', preview: `<img src="${DESIGNS[0]}" alt="">` },
      { label: 'Modal', description: 'Hard to miss, one click to dismiss', preview: `<img src="${DESIGNS[1]}" alt="">` },
      { label: 'Checklist', description: 'Part of a three-step setup list', preview: `<img src="${DESIGNS[2]}" alt="">` },
    ],
  }],
};
const QUESTION_FILE = join(DEMO, 'question.json');
writeFileSync(QUESTION_FILE, JSON.stringify(QUESTION));
const STANDIN = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const CHILD = ${JSON.stringify(CHILD)};
const SUPER_EVENT = ${JSON.stringify(SUPER_EVENT)};
const SUPER_HANDOVER = ${JSON.stringify(SUPER_HANDOVER)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { out({}); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const sid = at('--session-id') || at('--resume') || ('stand-in-' + process.pid);
const cli = (...args) => {
  const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, ...args], { env: process.env, encoding: 'utf-8', timeout: 60000 });
  return { args: args.join(' '), status: r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(0, 400) };
};
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, pid: process.pid, t: Date.now(), ...o }) + '\\n');
function superTurn(text) {
  if (text.startsWith('[super handover]')) {
    const adopted = [...text.matchAll(/child=([0-9a-zA-Z-]+)/g)].map((m) => m[1]);
    const steps = adopted.map((c) => cli('super', 'brief', c, 'Trial-to-paid drop'));
    steps.push(cli('super', 'delegate', '--prompt', 'Split last month\\'s trials by how many data sources each trial connected, and compare their trial-to-paid.', '--brief', 'Cohort split'));
    steps.push(cli('super', 'delegate', '--prompt', 'Design three versions of a day-1 in-app prompt that asks a new trial to connect a second data source.', '--brief', 'Day-1 prompt'));
    steps.push(cli('super', 'note', 'add', 'done', 'Took over the trial-to-paid chat'));
    steps.push(cli('super', 'note', 'add', 'now', 'Splitting the drop by data sources'));
    steps.push(cli('super', 'note', 'add', 'now', 'Designing a day-1 prompt for single-source trials'));
    steps.push(cli('super', 'note', 'add', 'waiting', 'Your pick of the day-1 prompt designs'));
    steps.push(cli('super', 'open', 'pdf', ${JSON.stringify(PDF)}, '--size', 'large', '--title', 'Trial interviews, September'));
    steps.push(cli('super', 'open', 'video', ${JSON.stringify(CLIP)}, '--title', 'Day-1 walkthrough'));
    report({ kind: 'handover', adopted, steps });
    return SUPER_HANDOVER;
  }
  if (text.startsWith('[super event]')) {
    const hit = SUPER_EVENT.find(([k]) => text.includes(k));
    report({ kind: 'event', hit: hit ? hit[0] : null });
    return hit ? hit[1] : 'Noted.';
  }
  if (text.includes('three designs')) {
    const step = cli('super', 'ask', '--json', '@' + ${JSON.stringify(QUESTION_FILE)});
    report({ kind: 'ask', step });
    return 'Here they are, side by side. Pick one and I put it on the task.';
  }
  if (text.includes('[On page')) {
    report({ kind: 'dock' });
    return 'Four tasks wait in To Do, and Stripe checkout is the critical one. Of the two in progress, the trial-to-paid investigation is mine.';
  }
  return 'On it.';
}
const childTurn = (text) => (CHILD.find(([k]) => text.includes(k)) ?? [null, 'On it.'])[1];
let inited = false; let buf = ''; let chain = Promise.resolve();
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8'); let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join('\\n');
    chain = chain.then(async () => {
      if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
      let said = 'On it.';
      try { said = role === 'super' ? superTurn(text) : childTurn(text); } catch (e) { said = 'error ' + e; }
      out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: said }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: said, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sid });
    });
  }
});
process.stdin.on('end', () => chain.then(() => process.exit(0)));
`;
writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
// A clean start: no roster, no super state, the Super Agent switch on.
rmSync(join(PROJ, '_dream_context', 'state', '.agent-sessions.json'), { force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.super-agent.json'), { force: true });
rmSync(join(PROJ, '_dream_context', 'state', '.super'), { recursive: true, force: true });
const uiFile = join(HOME, '.dreamcontext', 'agent-ui.json');
const ui = existsSync(uiFile) ? JSON.parse(readFileSync(uiFile, 'utf-8')) : {};
writeFileSync(uiFile, `${JSON.stringify({ enabled: true, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', lightMode: 'off', ...ui, superAgent: true }, null, 2)}\n`);

const { chromium } = await import('@playwright/test');
// Google Chrome, not the bundled Chromium: its built-in PDF viewer draws the PDF card, as
// WKWebView does in the app, where the bundled build only offers "Open on computer".
const b = await chromium.launch({ channel: 'chrome' });

// ── The fictional material the stage shows: a PDF, a clip, three picture options ──────
{
  const page = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const css = `body{margin:0;font-family:-apple-system,'Helvetica Neue',sans-serif;color:#1d1b2e}`;
  await page.setContent(`<style>${css} .p{padding:56px 64px} h1{font-size:30px;margin:0 0 6px} .s{color:#6b6880;margin-bottom:28px}
    h2{font-size:18px;margin:28px 0 10px} li{margin:6px 0;line-height:1.5} q{font-style:italic}
    .bar{display:flex;align-items:center;gap:12px;margin:8px 0}.bar b{display:block;height:18px;border-radius:4px;background:#7c5cff}
    .pb{page-break-before:always}</style>
    <div class="p"><div class="s">orbit · research</div><h1>Trial interviews, September</h1>
    <div class="s">12 trial accounts, 30 minutes each. Why trials did or did not convert.</div>
    <h2>What we heard</h2><ul><li><q>We only hooked up Stripe, so the dashboard never showed us anything new.</q></li>
    <li><q>I did not know I could add our product events too.</q></li><li><q>Once both sources were in, the cohort view sold it to my boss.</q></li></ul>
    <h2>Trial-to-paid by sources connected</h2>
    <div class="bar"><span style="width:120px">Two sources</span><b style="width:310px"></b>31%</div>
    <div class="bar"><span style="width:120px">One source</span><b style="width:110px"></b>11%</div>
    <div class="pb p"><h1>Recommendations</h1><ol><li>Ask for a second source on day 1.</li><li>Show what the second source adds, with the user's own numbers.</li><li>Re-test the v2 onboarding emails against v1.</li></ol></div></div>`);
  await page.pdf({ path: join(PROJ, PDF), format: 'A4', printBackground: true });

  const mock = (body) => `<style>${css} html,body{width:1200px;height:800px;background:#f4f3f8}
    .app{position:absolute;inset:0;display:grid;grid-template-columns:200px 1fr}.side{background:#1d1b2e}
    .main{padding:40px}.card{background:#fff;border-radius:12px;height:150px;margin-bottom:20px;box-shadow:0 1px 3px #0001}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:20px} .btn{display:inline-block;background:#7c5cff;color:#fff;border-radius:8px;padding:12px 20px;font-weight:600}
    </style><div class="app"><div class="side"></div><div class="main">${body}</div></div>`;
  const shotsHtml = [
    mock(`<div style="background:#7c5cff;color:#fff;border-radius:12px;padding:22px 26px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;font-size:22px">
      <span><b>Connect a second data source</b> and watch your numbers join up.</span><span class="btn" style="background:#fff;color:#7c5cff">Connect</span></div>
      <div class="row"><div class="card"></div><div class="card"></div></div><div class="card"></div>`),
    mock(`<div class="row" style="filter:blur(1px);opacity:.5"><div class="card"></div><div class="card"></div></div><div class="card" style="opacity:.5"></div>
      <div style="position:absolute;left:380px;top:200px;width:560px;background:#fff;border-radius:16px;padding:40px;box-shadow:0 20px 60px #0003">
      <div style="font-size:30px;font-weight:700;margin-bottom:12px">Two sources, one picture</div>
      <div style="font-size:20px;color:#6b6880;margin-bottom:28px">Trials that connect a second source convert almost three times as often. It takes two minutes.</div>
      <span class="btn" style="font-size:20px">Connect a source</span></div>`),
    mock(`<div style="display:grid;grid-template-columns:1fr 360px;gap:24px"><div><div class="card"></div><div class="card"></div></div>
      <div style="background:#fff;border-radius:12px;padding:26px;box-shadow:0 1px 3px #0001;font-size:20px">
      <div style="font-weight:700;font-size:24px;margin-bottom:18px">Set up orbit · 1 of 3</div>
      <div style="margin:14px 0">✅ Connect your first source</div><div style="margin:14px 0;color:#7c5cff;font-weight:600">◻︎ Connect a second source</div>
      <div style="margin:14px 0;color:#6b6880">◻︎ Invite a teammate</div></div></div>`),
  ];
  await page.setViewportSize({ width: 1200, height: 800 });
  for (let i = 0; i < DESIGNS.length; i++) {
    await page.setContent(shotsHtml[i]);
    await page.screenshot({ path: join(PROJ, DESIGNS[i]) });
  }
  // The clip: the modal design, zooming in slowly, so its poster is a real frame of a product screen.
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', join(PROJ, DESIGNS[1]), '-t', '6',
    '-vf', "zoompan=z='min(zoom+0.0012,1.18)':d=150:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1200x800:fps=25,format=yuv420p",
    '-c:v', 'libx264', '-movflags', '+faststart', join(PROJ, CLIP)]);
  await page.close();
}

// ── The AI Team: a global reviewer (listed in every project) and a project analyst ──
for (const args of [
  ['agents', 'create', 'critic', '--title', 'Critic', '--scope', 'global', '--soul-template', 'harsh-reviewer', '--prompt', 'You read a change or a document and say what is wrong with it, worst first.'],
  ['agents', 'create', 'analyst', '--title', 'Analyst', '--soul-template', 'careful-researcher', '--prompt', 'You answer product questions from orbit\'s own numbers and research.'],
]) spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: { ...process.env, HOME }, encoding: 'utf-8' });

// ── Past chats in the second project, for the phone's one list ─────────────────────
{
  const dir = join(HOME, '.claude', 'projects', ATLAS.replace(/[^a-zA-Z0-9]/g, '-'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const seed = (user, assistant, hoursAgo) => {
    const sid = crypto.randomUUID();
    const ts = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const rows = [
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: user }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistant }] } },
    ].map((o) => JSON.stringify({ ...o, cwd: ATLAS, uuid: crypto.randomUUID(), timestamp: ts, sessionId: sid }));
    const file = join(dir, `${sid}.jsonl`);
    writeFileSync(file, `${rows.join('\n')}\n`);
    utimesSync(file, new Date(ts), new Date(ts));
  };
  seed('Offline sync: which edit wins?', 'Last write wins per field, with the device clock checked against the server.', 2);
  seed('Why does the iOS build take nine minutes?', 'Two thirds of it is the image assets being re-encoded on every build.', 20);
  seed('Push notification copy for the weekly summary', 'Three options, each under 40 characters.', 44);
}

// ── Server ──────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
const server = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
  cwd: PROJ,
  env: { ...process.env, HOME, PATH, DREAMCONTEXT_DESKTOP: '1', DREAMCONTEXT_MAC_VERIFY_POWER_LOG: join(DEMO, 'power.log'), DREAMCONTEXT_MAC_VERIFY_FAKE_TUNNEL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = join(DEMO, 'server-0-35.log');
server.stdout.on('data', (d) => appendFileSync(log, d));
server.stderr.on('data', (d) => appendFileSync(log, d));
{
  const end = Date.now() + 30000;
  let up = false;
  while (!up && Date.now() < end) { try { up = (await fetch(`${BASE}/`)).ok; } catch { /* not up */ } if (!up) await sleep(300); }
  if (!up) { server.kill(); throw new Error('dashboard server did not come up'); }
}

const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });
await setTheme(ctx, 'dark');
await markAnnouncementsSeen(ctx, BASE);
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const CLEAN = `[class*="sleep-debt"],[class*="debt-badge"]{display:none!important}`;
const captured = [];
const failed = [];
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await sleep(200); }
  return false;
};
async function shot(name, clip) {
  await page.addStyleTag({ content: CLEAN });
  await sleep(500);
  const raw = join(RAW, `${name}-2x.png`);
  await page.screenshot({ path: raw, ...(clip ? { clip } : {}) });
  spawnSync('sips', ['-Z', '1600', raw, '--out', join(OUT, `${name}.png`)]);
  captured.push(name);
  console.log('  ✓', name);
}
async function scene(name, fn) {
  if (!on(name)) return;
  try { await fn(); } catch (e) { failed.push(name); console.log('  ✗', name, String(e?.stack ?? e).slice(0, 500)); }
}
const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const settle = () => until(async () => (await page.locator('[data-super-motion="running"]').count()) === 0, 8000).then(() => sleep(1200));
const centreInput = page.locator('[data-super-slot="centre"] .chat-cmp-input');
const nav = async (label) => {
  await page.locator('nav button').filter({ has: page.locator('.sidebar-label', { hasText: new RegExp(`^\\s*${label}\\s*$`, 'i') }) }).first().click();
  await sleep(1500);
};

// ── The Super Agent: hand a chat over, the stage fills ───────────────────────────────
await scene('super-stage', async () => {
  await page.goto(`${BASE}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
  await sleep(1500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(200); }
  await nav('Chat');
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click();
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.waitFor({ timeout: 20000 });
  await input.click();
  await input.fill('Why did trial-to-paid fall to 13% last week?');
  await page.keyboard.press('Enter');
  await until(async () => /single-source trials fell hardest/.test(await page.locator('.chat-scroll:visible').first().innerText()), 30000);
  await sleep(1000);
  await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  await until(async () => (await page.locator('[data-testid="super-surface"]:visible').count()) > 0, 20000);
  await until(async () => reports().some((r) => r.kind === 'handover'), 90000);
  const ho = reports().find((r) => r.kind === 'handover');
  for (const s of ho?.steps ?? []) if (s.status !== 0) console.log(`    ! ${s.args}: exit ${s.status} ${s.out}`);
  await until(async () => reports().filter((r) => r.kind === 'event' && r.hit).length >= 2, 60000);
  await settle();
  await sleep(2500);
  await page.mouse.move(800, 990);
  await shot('super-stage');
});

// ── The PDF card, opened: it reads side by side with the Super chat ──────────────────
await scene('pdf-side', async () => {
  await page.locator('[data-testid="super-container"]', { hasText: 'Trial interviews, September' }).first().click();
  await settle();
  await sleep(2500);
  await page.mouse.move(800, 990);
  await shot('pdf-side');
  const back = page.getByRole('button', { name: /Back to the stage/ });
  if (await back.count()) await back.first().click();
  else await page.keyboard.press('Escape');
  await settle();
});

// ── A picture question: the options come onto the stage by themselves ─────────────────
await scene('picture-question', async () => {
  await centreInput.first().click();
  await centreInput.first().fill('Show me the three designs.');
  await page.keyboard.press('Enter');
  await until(async () => reports().some((r) => r.kind === 'ask'), 30000);
  const ask = reports().find((r) => r.kind === 'ask');
  if (ask?.step?.status !== 0) console.log(`    ! super ask: ${ask?.step?.out}`);
  await until(async () => (await page.locator('[data-testid="super-question-card"][data-state="open"]').count()) > 0, 15000);
  await settle();
  await sleep(2000);
  await page.mouse.move(800, 990);
  await shot('picture-question');
});

// ── The Super dock: the same Super chat beside any page, with that page as context ────
await scene('super-dock', async () => {
  await nav('Tasks');
  const pill = page.locator('[data-testid="super-dock-pill"]').first();
  await pill.waitFor({ timeout: 10000 });
  await pill.click();
  const dockInput = page.locator('[data-super-slot="dock"] .chat-cmp-input').first();
  await dockInput.waitFor({ timeout: 10000 });
  await dockInput.fill('What is still open here?');
  await page.keyboard.press('Enter');
  await until(async () => reports().some((r) => r.kind === 'dock'), 30000);
  await until(async () => /Four tasks wait in To Do/.test(await page.locator('[data-testid="super-dock-window"]').first().innerText()), 15000);
  await sleep(1500);
  await page.mouse.move(600, 990);
  await shot('super-dock');
});

// ── AI Team: a global agent, listed in this project ──────────────────────────────────
await scene('team-global', async () => {
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await sleep(200); }
  await nav('AI Team');
  await page.getByText('Critic', { exact: true }).first().click();
  await sleep(1500);
  const input = page.locator('.chat-cmp-input:visible').last();
  await input.waitFor({ timeout: 15000 });
  await input.click();
  await input.fill('What do you look for in a change?');
  await page.keyboard.press('Enter');
  await until(async () => /worst first/.test(await page.locator('main').first().innerText()), 30000);
  await sleep(1500);
  await page.mouse.move(600, 990);
  await shot('team-global');
});

// ── AI Team: give a task to an agent, with another agent as its reviewer ─────────────
await scene('give-to-agent', async () => {
  await nav('Tasks');
  await page.locator('.bd-card', { hasText: 'Churn exit survey' }).first().click();
  await sleep(1500);
  await page.locator('[data-testid="give-to-agent"]').first().click({ timeout: 10000 });
  await page.locator('.gta-menu [data-testid^="give-agent-"]', { hasText: 'Analyst' }).first().click({ timeout: 8000 });
  const composer = page.locator('.modal.ata').first();
  await composer.waitFor({ timeout: 8000 });
  await composer.locator('.ata-option', { hasText: 'Analyst' }).first().click().catch(() => {});
  await composer.locator('textarea').first().fill('Group the exit answers by reason and tell me which one we can fix this month.');
  await composer.locator('label.field', { hasText: 'Reviewer' }).locator('select').selectOption({ label: 'Critic' });
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(1000);
  // The whole window: the dialog over the task it is for (a tall crop is unreadable in a story).
  await page.mouse.move(1590, 990);
  await shot('give-to-agent');
});

// ── The phone in Mac mode: one list over both projects, the Super Agent with its agenda ─
await scene('handsfree-phone', async () => {
  const mac = async (path, body) => {
    const res = await fetch(`${BASE}/api/handsfree/mac/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const setup = await mac('setup');
  if (setup.status !== 200) throw new Error(`Mac mode setup: ${setup.status}`);
  const started = await mac('start', { vaults: [VAULT, 'atlas-mobile'] });
  if (started.status !== 200) throw new Error(`Mac mode start: ${started.status} ${JSON.stringify(started.json).slice(0, 200)}`);
  const qr = (await mac('qr')).json.url;
  const { devices } = await import('@playwright/test');
  const phone = await b.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await setTheme(phone, 'dark');
  await markAnnouncementsSeen(phone, BASE);
  const p = await phone.newPage();
  const vis = (sel) => p.locator(`${sel}:visible`);
  const dismiss = async () => {
    for (let i = 0; i < 3; i++) { const x = p.locator('.announcements-modal-close'); if (!(await x.count())) break; await x.first().click().catch(() => {}); await sleep(300); }
    // The Bag-mode notice is read once and put away with its OK.
    const okBtn = p.getByRole('button', { name: /^OK$/ });
    if (await okBtn.count()) { await okBtn.first().click().catch(() => {}); await sleep(400); }
  };
  const snap = async (name) => { await dismiss(); await p.evaluate(() => document.activeElement?.blur()); await sleep(600); await p.screenshot({ path: join(RAW, `${name}.png`) }); };
  await p.goto(qr, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await vis('[data-testid="phone-list"]').first().waitFor({ timeout: 25000 });
  await until(async () => (await vis('[data-testid="super-row"]').count()) === 1, 20000);
  await until(async () => /Offline sync/.test(await vis('[data-testid="phone-list"]').first().innerText()), 15000);
  await sleep(1500);
  await snap('phone-list');
  await vis('[data-testid="super-row"]').first().click();
  await vis('[data-testid="phone-agenda-strip"]').first().waitFor({ timeout: 15000 });
  await sleep(1500);
  await snap('phone-super');
  await vis('[data-testid="phone-agenda-strip"]').first().click();
  await vis('[data-testid="phone-agenda-sheet"]').first().waitFor({ timeout: 8000 });
  await sleep(1200);
  await snap('phone-agenda');
  await phone.close();
  await mac('stop');
  const b64 = (n) => `data:image/png;base64,${readFileSync(join(RAW, `${n}.png`)).toString('base64')}`;
  const board = await b.newPage({ viewport: { width: 1600, height: 1060 }, deviceScaleFactor: 1 });
  await board.setContent(`<body style="margin:0;background:#0d0f16">
    <div style="display:flex;justify-content:center;align-items:center;gap:44px;height:1060px">
      ${['phone-list', 'phone-super', 'phone-agenda'].map((n) => `<img src="${b64(n)}" style="width:440px;height:952px;border-radius:44px;border:1px solid #2a2d3a;box-shadow:0 24px 60px -30px rgba(0,0,0,.8);display:block">`).join('')}
    </div></body>`);
  await sleep(300);
  await board.screenshot({ path: join(OUT, 'handsfree-phone.png') });
  await board.close();
  captured.push('handsfree-phone');
});

await b.close();
server.kill('SIGTERM');
console.log(`\ncaptured ${captured.length}: ${captured.join(', ')}`);
if (failed.length) console.log(`FAILED ${failed.length}: ${failed.join(', ')}`);
process.exit(0);
