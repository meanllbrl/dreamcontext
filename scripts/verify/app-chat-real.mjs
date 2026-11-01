#!/usr/bin/env node
/**
 * An app's real Chat in its frame, through the REAL gateway, socket gate and spawn, in Chromium at
 * 390 and 1440 px, isolated HOME, a stand-in `claude` that records its argv (plan r9, W2). The Mac
 * runner window itself needs Accessibility; its native alert is stood for by Chromium's `confirm`.
 * Needs a build first.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/app-chat-real.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = await openApp({ suite: 'app-chat', build: true, desktop: true });
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: app.proj, env: { ...hostEnv, HOME: app.home }, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`dreamcontext ${args.join(' ')} failed: ${(r.stdout + r.stderr).slice(0, 300)}`);
  return r.stdout;
};

// ── the stand-in ────────────────────────────────────────────────────────────────────────
const standin = `#!/usr/bin/env node
const { appendFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
if (argv[0] === 'auth' || argv[0] === '--version' || argv[0] === 'mcp') { process.stdout.write('{}\\n'); process.exit(0); }
if (argv[0] === '-p' && !argv.includes('--input-format')) { const q = argv[1] || ''; process.stdout.write(JSON.stringify({ result: 'cevap: ' + (q.includes('Yük özeti') ? 'makine rahat' : 'tamam') }) + '\\n'); process.exit(0); }
let id = flag('--session-id') || flag('--resume') || 'x';
appendFileSync(join(homedir(), 'argv.jsonl'), JSON.stringify(argv) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const result = () => out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
const say = (t) => { out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: t }] } }); result(); };
let init = false; let n = 0; let stopped = false;
const ask = (tool, input) => out({ type: 'control_request', request_id: 'r' + (++n), request: { subtype: 'can_use_tool', tool_name: tool, input } });
function turn(text) {
  if (!init) { init = true; out({ type: 'system', subtype: 'init', session_id: id, model: 'x', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', cwd: process.cwd() }); }
  const dir = join(homedir(), '.claude', 'projects', 'standin'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: text } }) + '\\n');
  stopped = false;
  if (text === 'PERM') return ask('Bash', { command: 'grep -r TOKEN .' });
  if (text === 'BIDI') return ask('Bash', { command: 'echo safe\\u202e\\u200bdanger' });
  if (text === 'LONG') return ask('Bash', { command: 'echo ' + 'x'.repeat(700) });
  if (text === 'EDIT') return ask('Write', { file_path: '/tmp/a.txt', content: 'hello' });
  if (text === 'MCP') return ask('mcp__meta__pause', { id: 7 });
  if (text === 'ASK') {
    const input = { questions: [{ question: 'Which one?', header: 'Pick', description: 'Pick one.', kind: 'choice', multiSelect: false, options: [{ label: 'Left', description: 'the left' }, { label: 'Right', description: 'the right' }] }] };
    out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input }] } });
    return out({ type: 'control_request', request_id: 'q' + (++n), request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: 'q1', requires_user_interaction: true } });
  }
  if (text === 'TOOL') {
    out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/x' } }] } });
    out({ type: 'user', session_id: id, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    return say('read it');
  }
  if (text === 'ROTATE') { id = '${'11111111-2222-4333-8444-555555555555'}'; out({ type: 'system', subtype: 'init', session_id: id, model: 'x', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', cwd: process.cwd() }); return say('rotated'); }
  if (text === 'LIMIT') {
    out({ type: 'rate_limit_event', session_id: id, rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
    out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] } });
    return out({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your session limit", session_id: id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  }
  if (text === 'SLOW') { setTimeout(() => { if (!stopped) say('slow answer'); }, 6000); return; }
  say('answer to ' + text);
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    appendFileSync(join(homedir(), 'stdin.jsonl'), line + '\\n');
    if (m.type === 'control_request' && m.request && m.request.subtype === 'interrupt') { stopped = true; out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id } }); result(); continue; }
    if (m.type === 'control_response') { say(m.response.response.behavior === 'allow' ? 'allowed' : 'denied'); continue; }
    if (m.type === 'user') { const c0 = m.message.content; turn(typeof c0 === 'string' ? c0 : c0.map((p) => p.text || '').join('')); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
writeFileSync(join(app.home, '.local', 'bin', 'claude'), standin);
chmodSync(join(app.home, '.local', 'bin', 'claude'), 0o755);

const page = (dir, bg, fg) => {
  writeFileSync(join(dir, 'style.css'), `body{margin:0;background:${bg};color:${fg}}#host{height:100vh}`);
  writeFileSync(join(dir, 'chat.js'), `import { dc } from '/__dc/sdk.js'; dc.mountEmbed(document.getElementById('host'), 'chat');`);
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>Demo</title><link rel="stylesheet" href="/style.css"></head>
<body><div id="host"></div><script type="module" src="/chat.js"></script></body></html>`);
};

async function windowUrl(slug) {
  const file = JSON.parse(readFileSync(join(app.home, '.dreamcontext', 'desktop-server.json'), 'utf-8'));
  const r = await fetch(`${app.base}/api/apps/launch-window`, {
    method: 'POST', headers: { authorization: `Bearer ${file.launchToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectRoot: realpathSync(app.proj), slug }),
  });
  if (!r.ok) throw new Error(`launch-window ${r.status}: ${await r.text()}`);
  return (await r.json()).url;
}

const frameOf = async (p) => {
  for (let i = 0; i < 60; i++) {
    const f = p.frames().find((x) => x !== p.mainFrame() && x.url().includes('embed='));
    if (f && await f.locator('textarea, [contenteditable="true"]').first().isVisible().catch(() => false)) return f;
    await p.waitForTimeout(250);
  }
  return null;
};
const see = async (f, where, text, timeout = 8000) => {
  const ok = await f.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
  if (!ok) app.findings.push(`${where}: "${text}" is not drawn`);
  return ok;
};
const send = async (f, text) => {
  const box = f.locator('textarea, [contenteditable="true"]').first();
  await box.fill(text);
  await box.press('Enter');
};
const records = () => {
  const dir = join(app.home, '.dreamcontext', 'apps', 'chats');
  return existsSync(dir) ? readdirSync(dir).filter((x) => /^[0-9a-f-]{36}\.json$/.test(x)) : [];
};
const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const near = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= 2);

try {
  writeFileSync(join(app.proj, '_dream_context', 'marker.txt'), 'x');
  cli('apps', 'new', 'demo', '--name', 'Demo Ads');
  cli('apps', 'new', 'lite', '--name', 'Lite');
  const root = (s) => join(`${app.proj}-apps`, s);
  page(join(root('demo'), 'public'), '#101214', '#e8e8e8');
  page(join(root('lite'), 'public'), '#fafaf7', '#14161a');
  writeFileSync(join(root('demo'), 'public', 'readme.txt'), 'app file');
  const writes = [];

  await app.look('/?vault=proj', async (p, w) => {
    const where = `chat@${w.name}`;
    p.on('request', (r) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && p.frames().some((f) => f === r.frame() && f.url().includes('embed='))) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await p.addInitScript(() => {
      if (location.search.includes('embed=')) {
        const read = () => { if (document.documentElement && !window.__firstBg) window.__firstBg = getComputedStyle(document.documentElement).backgroundColor; };
        requestAnimationFrame(read);
      }
    });
    await p.goto(await windowUrl('demo'), { waitUntil: 'domcontentloaded' });
    const f = await frameOf(p);
    if (!f) { app.findings.push(`${where}: the composer never came`); return; }

    // First 30 seconds.
    await see(f, where, 'Demo Ads');
    for (const text of ['Open in the main app', 'Ana uygulamada aç']) if (await f.getByText(text).count()) app.findings.push(`${where}: "${text}" is drawn`);
    if (!await f.locator('.app-chat-history').isVisible()) app.findings.push(`${where}: no history button`);

    // Theme.
    const bg = await f.evaluate(() => [getComputedStyle(document.querySelector('.embed-root')).backgroundColor, window.__firstBg]);
    if (!near(rgb(bg[0]), [16, 18, 20])) app.findings.push(`${where}: frame background ${bg[0]}`);
    if (bg[1] && !near(rgb(bg[1]), [16, 18, 20])) app.findings.push(`${where}: first paint ${bg[1]}`);

    // The bubble, before any reply.
    await f.evaluate(() => {
      window.__t = {};
      document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__t.key = performance.now(); }, true);
      new MutationObserver(() => { if (!window.__t.seen && document.body.innerText.includes('merhaba dunya')) window.__t.seen = performance.now(); }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const box = f.locator('textarea, [contenteditable="true"]').first();
    await box.pressSequentially('merhaba dunya');
    await f.evaluate(() => { window.__t.seen = 0; });
    await box.press('Enter');
    await see(f, where, 'answer to merhaba dunya');
    const t = await f.evaluate(() => window.__t);
    console.log(`${where}: bubble ${t.seen && t.key ? Math.round(t.seen - t.key) : '?'} ms after Enter`);
    if (!(t.seen - t.key < 100)) app.findings.push(`${where}: the bubble took ${t.seen - t.key} ms`);

    // Work stream, tool step, question, permission.
    await send(f, 'TOOL'); await see(f, where, 'read it');
    await send(f, 'ASK'); await see(f, where, 'Which one?');
    await f.locator('.chat-surveycard-opt:visible').first().click({ timeout: 8000 }).catch(async (e) => {
      await p.screenshot({ path: join(app.shots, `question-${w.name}.png`) });
      console.log((await f.evaluate(() => document.body.innerText)).slice(-500));
      throw e;
    });
    await p.waitForTimeout(300);
    await f.getByRole('button', { name: /^(Send|Submit|Done|Answer|Gönder|Yanıtla|Bitir)/ }).first().click({ timeout: 1500 }).catch(() => {});
    await see(f, where, 'allowed');

    const dialogs = [];
    let accept = true;
    const onDialog = (d) => { dialogs.push(d.message()); return accept ? d.accept() : d.dismiss(); };
    p.on('dialog', onDialog);
    await send(f, 'PERM');
    await see(f, where, 'grep -r TOKEN');
    if (await f.getByText('Always allow').count()) app.findings.push(`${where}: "Always allow" is drawn`);
    if (await f.getByText('Run here').count()) app.findings.push(`${where}: "Run here" is drawn`);
    await f.getByRole('button', { name: /^Allow|^İzin/ }).first().click();
    await see(f, where, 'allowed');
    accept = false;
    await send(f, 'BIDI');
    await see(f, where, 'echo safe');
    await f.getByRole('button', { name: /^Allow|^İzin/ }).first().click();
    await p.waitForTimeout(300);
    if (await f.getByText('denied', { exact: true }).count()) app.findings.push(`${where}: Cancel on the alert answered the card`);
    await f.getByRole('button', { name: /^Deny|^Reddet/ }).first().click();
    await see(f, where, 'denied');
    if (dialogs[0] !== 'grep -r TOKEN .') app.findings.push(`${where}: the alert said ${JSON.stringify(dialogs[0])}`);
    if (!/^echo safe\s+danger$/.test(dialogs[1] ?? '')) app.findings.push(`${where}: bidi survived: ${JSON.stringify(dialogs[1])}`);
    accept = true;
    await send(f, 'EDIT'); await p.waitForTimeout(500);
    await f.getByRole('button', { name: /^Allow|^İzin/ }).first().click();
    await send(f, 'MCP'); await p.waitForTimeout(800);
    await f.getByRole('button', { name: /^Allow|^İzin/ }).first().click();
    await p.waitForTimeout(300);
    if (dialogs[2] !== 'Write /tmp/a.txt (5 characters)') app.findings.push(`${where}: edit alert ${JSON.stringify(dialogs[2])}`);
    if (!/^MCP meta \/ pause/.test(dialogs[3] ?? '')) app.findings.push(`${where}: mcp alert ${JSON.stringify(dialogs[3])}`);
    await send(f, 'LONG'); await p.waitForTimeout(800);
    if (await f.getByRole('button', { name: /^Allow|^İzin/ }).count()) app.findings.push(`${where}: a 700 char command offers Allow`);
    await f.getByRole('button', { name: /^Deny|^Reddet/ }).first().click();
    p.off('dialog', onDialog);
    await p.waitForTimeout(400);

    // A limit: a plain error, and the next message is not held.
    await send(f, 'LIMIT');
    await see(f, where, 'session limit');
    await p.waitForTimeout(500);
    await send(f, 'after limit'); await see(f, where, 'answer to after limit');

    // Stop.
    await send(f, 'SLOW');
    await p.waitForTimeout(500);
    const stop = f.locator('button[aria-label*="Stop" i], button[title*="Stop" i], button[aria-label*="Durdur" i]').first();
    if (await stop.count()) await stop.click(); else app.findings.push(`${where}: no stop button`);
    await p.waitForTimeout(800);
    await send(f, 'after stop'); await see(f, where, 'answer to after stop');

    // A second session beside it, then a reload that makes nothing new.
    await f.locator('.app-chat-new').click();
    await p.waitForTimeout(800);
    const f2 = await frameOf(p);
    await send(f2, 'ikinci'); await see(f2, where, 'answer to ikinci');
    const before = records().length;
    await p.goto(await windowUrl('demo'), { waitUntil: 'domcontentloaded' });
    const f3 = await frameOf(p);
    if (f3) {
      await p.waitForTimeout(800);
      const rows = await f3.locator('.app-chat-tab').count();
      if (rows < 2) app.findings.push(`${where}: a reload shows ${rows} row(s)`);
      if (records().length !== before) app.findings.push(`${where}: a reload made a record`);
      const refused = await f3.evaluate(() => { try { new WebSocket('ws://127.0.0.1:1/api/agent/terminal'); return false; } catch { return true; } });
      if (!refused) app.findings.push(`${where}: a non-app WebSocket opened`);
    }
  }, { name: 'app-chat' });

  // Everything the frame wrote.
  const allowed = /^POST \/api\/apps\/(demo|lite)\/(say|chats\/close|chats\/title)$|^POST \/api\/apps\/embed-check$|^POST \/api\/agent\/drop$/;
  for (const x of new Set(writes)) { console.log(`frame write: ${x}`); if (!allowed.test(x)) app.findings.push(`the frame wrote ${x}`); }

  // A light app stays light; the shortest window keeps its composer.
  await app.look('/?vault=proj', async (p, w) => {
    await p.goto(await windowUrl('lite'), { waitUntil: 'domcontentloaded' });
    const f = await frameOf(p);
    if (!f) { app.findings.push(`lite@${w.name}: no composer`); return; }
    const bg = await f.evaluate(() => getComputedStyle(document.querySelector('.embed-root')).backgroundColor);
    if (!near(rgb(bg), [250, 250, 247])) app.findings.push(`lite@${w.name}: frame background ${bg}`);
    await p.setViewportSize({ width: w.width, height: 560 });
    await p.waitForTimeout(400);
    const clip = await f.evaluate(() => {
      const c = document.querySelector('textarea, [contenteditable="true"]').getBoundingClientRect();
      const s = document.querySelector('.app-chat-strip').getBoundingClientRect();
      return { bottom: c.bottom, top: s.top, h: window.innerHeight };
    });
    if (clip.bottom > clip.h || clip.top < 0) app.findings.push(`lite@${w.name}: clipped at 560: ${JSON.stringify(clip)}`);
  }, { name: 'app-chat-lite' });

  // An app moved to its own assistant, from a scratch copy of its migration branch.
  if (process.env.DC_YUK_COPY) {
    cli('apps', 'new', 'yuk-izleme', '--name', 'Yük İzleme');
    cpSync(process.env.DC_YUK_COPY, root('yuk-izleme'), { recursive: true, filter: (x) => !x.endsWith('.git') });
    const asked = cli('apps', 'do', 'yuk-izleme', 'ask', '--input', '{"q":"yük nasıl"}');
    if (!asked.includes('makine rahat')) app.findings.push(`yuk dc.ask: ${asked.slice(0, 200)}`);
    await app.look('/?vault=proj', async (p, w) => {
      await p.goto(`${await windowUrl('yuk-izleme')}`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);
      await p.locator('.view-btn[data-view="desk"]').click();
      const f = await frameOf(p);
      if (!f) { app.findings.push(`yuk@${w.name}: no composer`); return; }
      await see(f, `yuk@${w.name}`, 'Yük İzleme');
      await send(f, 'selam'); await see(f, `yuk@${w.name}`, 'answer to selam');
      const c = await f.evaluate(() => [getComputedStyle(document.querySelector('.embed-root')).backgroundColor, document.documentElement.getAttribute('data-theme')]);
      console.log(`yuk@${w.name}: frame ${c.join(' ')}`);
    }, { name: 'yuk-izleme' });
  }

  // The envelope, read off the stand-in's argv.
  const spawns = () => readFileSync(join(app.home, 'argv.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.includes('--input-format'));
  const argvs = spawns();
  const a = argvs[0];
  const count = (x) => a.filter((v) => v === x).length;
  const expects = [
    [a[a.indexOf('--permission-mode') + 1] === 'default', 'starts at default'],
    [a[a.indexOf('--setting-sources') + 1] === 'project', 'project settings only'],
    [count('--disallowedTools') === 1, 'exactly one deny flag'],
    [a.includes('--strict-mcp-config'), 'strict MCP'],
    [!a.includes('--agents'), 'no roster'],
    [count('--add-dir') === 2, 'two add-dirs'],
    [a.includes('--settings'), 'a settings file'],
  ];
  for (const [ok, what] of expects) if (!ok) app.findings.push(`spawn: ${what} failed: ${a.join(' ').slice(0, 300)}`);

  // Other ways in, from this process: the server's own gates.
  const chatsDir = join(app.home, '.dreamcontext', 'apps', 'chats');
  const id = records().find((x) => JSON.parse(readFileSync(join(chatsDir, x), 'utf-8')).slug === 'demo').slice(0, -5);
  const { WebSocket } = await import('ws');
  const open = (url, origin = app.base) => new Promise((res) => {
    const ws = new WebSocket(url, { headers: { origin } });
    ws.on('open', () => { res('open'); ws.close(); });
    ws.on('unexpected-response', (_r, m) => res(m.statusCode));
    ws.on('error', () => res('error'));
  });
  const wsBase = app.base.replace('http', 'ws');
  const n0 = argvs.length;
  const fromMain = await open(`${wsBase}/api/agent/chat?vault=proj&resume=${id}&bypass=1&mode=super&tool=codex&lean=1&prompt=hi`);
  await new Promise((r) => setTimeout(r, 1500));
  const after = spawns();
  if (fromMain !== 'open') app.findings.push(`main History open answered ${fromMain}`);
  if (after.length > n0) {
    const b = after[after.length - 1];
    if (b[b.indexOf('--permission-mode') + 1] !== 'default') app.findings.push(`main History spawn left the envelope: ${b.join(' ').slice(0, 200)}`);
  }
  const term = await open(`${wsBase}/api/agent/terminal?vault=proj&resume=${id}`);
  if (term !== 403) app.findings.push(`terminal resume answered ${term}`);
  const fileUrl = `${app.base}/api/agent/file?path=${encodeURIComponent(join(realpathSync(`${app.proj}-apps`), 'demo', 'public', 'readme.txt'))}`;
  const withSession = await fetch(`${fileUrl}&session=${id}`, { headers: { 'x-dreamcontext-vault': 'proj' } });
  if (withSession.status !== 200) app.findings.push(`the app's own file with its session answered ${withSession.status}`);
  const noSession = await fetch(fileUrl, { headers: { 'x-dreamcontext-vault': 'proj' } });
  if (noSession.status === 200) app.findings.push('the app file opened with no session');
} finally {
  process.exitCode = await app.finish();
}
