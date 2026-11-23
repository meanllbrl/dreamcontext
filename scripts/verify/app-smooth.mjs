#!/usr/bin/env node
/**
 * How smooth the app is where the owner feels it: moving between pages, and typing in the
 * composer. Real dashboard (the built one), scratch HOME, fictional projects, a scripted `claude`
 * stand-in (no tokens spent). Before and after a change run the same script, so the tables compare.
 *
 *   node scripts/verify/app-smooth.mjs --tag before --out tmp/perf [--repo <dir holding dist/>]
 *        [--brain <dir>]    # copy a real `_dream_context` into the scratch project (read only):
 *                           # real task, knowledge, board and insight volume. Default: synthetic.
 *        [--rounds 5] [--cpu 1] [--keys 60]
 *        [--trace]          # a Chromium trace of the typing, and how much of the window it painted
 *        [--stream]         # also: the same page changes while a chat is streaming an answer
 *        [--walk]           # first: the owner's own steps (2026-11-22), with a filmstrip of each
 *        [--video]
 *
 * What it prints (ms, median unless said):
 *   pages     click on a rail row -> `first`: the first frame the page (or Chat) is on screen;
 *             `content`: the first frame that holds 90% of the elements the page ends with;
 *             `long`: the longest main-thread task after the click; `gap`: the longest frame gap.
 *   typing    per key: React commits, components rendered (and which, on an unminified build),
 *             style recalcs, layouts, the main thread's script time, and the slowest keystroke.
 *
 * `renders` come from React's own commit hook (the DevTools global hook, installed before the
 * app loads): a fiber counts when React ran it in that commit. On a minified build the names are
 * mangled; point --repo at an unminified build to read them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const REPO = resolve(arg('repo', '.'));
const OUT = resolve(arg('out', 'tmp/perf'));
const TAG = arg('tag', 'after');
const ROUNDS = Number(arg('rounds', 5));
const CPU = Number(arg('cpu', 1));
const KEYS = Number(arg('keys', 60));
const BRAIN = arg('brain', '');
const PORT = Number(arg('port', 46400 + Math.floor(Math.random() * 500)));
const CLI = join(REPO, 'dist', 'index.js');
const SCRATCH = join(tmpdir(), `dc-app-smooth-${TAG}-${process.pid}`);
const HOME = join(SCRATCH, 'home');
mkdirSync(OUT, { recursive: true });

/** Answers as `claude`: an init frame, then silence. Nothing streams, so typing is measured alone.
 *  With --stream, the first message it is sent starts an answer that never stops streaming: a
 *  window with a working agent in it, which is where a page change must still land. */
const STANDIN = `#!${process.execPath}
const STREAM = ${flag('stream')};
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : ''; };
const sid = at('--session-id') || at('--resume') || 'v-' + process.pid;
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] });
let streaming = false;
let fed = '';
process.stdin.on('data', (chunk) => {
  // Only the message the script types starts it: the app's own first frames must not.
  fed = (fed + chunk).slice(-4000);
  if (!STREAM || streaming || !fed.includes('akis baslat')) return;
  streaming = true;
  const ev = (event) => out({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event });
  ev({ type: 'message_start', message: { id: 'msg_stream', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  // A word every 40 ms, a new paragraph every second, for two minutes at most.
  let n = 0;
  const timer = setInterval(() => { n++; if (n > 3000) { clearInterval(timer); return; } ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: n % 25 ? 'akar ' : '\\n\\n' } }); }, 40);
});
process.stdin.on('end', () => process.exit(0));
`;

const env = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('DREAMCONTEXT_'))), HOME, DREAMCONTEXT_DESKTOP: '1' });
const dc = (cwd, ...a) => spawnSync(process.execPath, [CLI, ...a], { cwd, env: env(), encoding: 'utf-8' });

/** A transcript shaped like a working session: turns of prose, tool calls and results. */
function transcript(id, turns) {
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
  return `${rows.join('\n')}\n`;
}

/** A fictional project's volume when no real brain is copied: tasks and knowledge files. */
function syntheticBrain(root) {
  const state = join(root, 'state');
  const knowledge = join(root, 'knowledge');
  mkdirSync(knowledge, { recursive: true });
  const statuses = ['todo', 'in_progress', 'in_review', 'completed', 'completed', 'completed'];
  const body = 'Kullanıcı sepete ürün eklerken toplam yanlış hesaplanıyor; indirim iki kez uygulanıyor ve fiş yanlış çıkıyor. '.repeat(12);
  for (let i = 0; i < 600; i++) {
    const slug = `ornek-gorev-${String(i).padStart(3, '0')}`;
    writeFileSync(join(state, `${slug}.md`), `---\nid: task_${i}\nname: 'Örnek görev ${i}: sepet toplamı doğru hesaplanır'\ndescription: 'Örnek görev ${i}'\npriority: ${['low', 'medium', 'high', 'critical'][i % 4]}\nurgency: medium\nstatus: ${statuses[i % statuses.length]}\ncreated_at: '2026-01-${String((i % 27) + 1).padStart(2, '0')}'\nupdated_at: '2026-02-${String((i % 27) + 1).padStart(2, '0')}'\ntags: ['layer:frontend']\nparent_task: null\nrelated_feature: null\nversion: 0.1.${i % 9}\n---\n\n## Why\n\n${body}\n\n## Acceptance Criteria\n\n- [x] Toplam doğru\n- [ ] Fiş doğru\n\n## Changelog\n\n### 2026-01-01 - Created\n- Task created.\n${`\n### 2026-01-02 - Session Update\n- ${body}\n`.repeat(i % 5)}`);
  }
  for (let i = 0; i < 150; i++) {
    writeFileSync(join(knowledge, `ornek-bilgi-${i}.md`), `---\nname: ornek-bilgi-${i}\ndescription: 'Örnek bilgi ${i}: sepet hesabı nasıl çalışır'\ntype: knowledge\ndate: '2026-01-01'\ntags: ['topic:sepet']\n---\n\n## Özet\n\n${body}\n`);
  }
}

const superRecord = (session) => ({ v: 1, session, enabled: true, containers: [], groups: [], view: { mode: 'float' }, children: {}, queue: [], notes: {}, away: { since: null, events: 0 }, dismissed: [], pool: [], ownerBatches: [], team: [] });

function project(name, chats, brain) {
  const p = join(SCRATCH, name);
  const root = join(p, '_dream_context');
  if (brain) {
    // The real brain is only read: its bulk that no page lists (scratch, media, mail) stays behind.
    const skip = new Set(['tmp', 'marketing', 'inbox', 'workspace']);
    cpSync(brain, root, { recursive: true, filter: (src) => !(dirname(src) === resolve(brain) && skip.has(basename(src))) });
    for (const f of ['.agent-sessions.json', '.super-agent.json']) rmSync(join(root, 'state', f), { force: true });
  }
  mkdirSync(join(root, 'state'), { recursive: true });
  if (!brain && name === 'acme') syntheticBrain(root);
  spawnSync('git', ['-C', p, 'init', '-q']);
  dc(p, 'vaults', 'add', name, p);
  const superId = randomUUID();
  writeFileSync(join(root, 'state', '.super-agent.json'), JSON.stringify(superRecord(superId)));
  const sessions = chats.map((c, i) => ({ title: c.title, kind: 'chat', sessionId: c.id, pane: i, active: true, window: `w${i}`, size: 1, bypass: true }));
  const windows = chats.map((c, i) => ({ id: `w${i}`, name: c.title, activePane: i }));
  writeFileSync(join(root, 'state', '.agent-sessions.json'), JSON.stringify({ sessions, activePane: 0, chatPermissionMode: 'auto', windows, generation: 1 }));
  return { name, p, superId };
}

function seed() {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
  mkdirSync(join(HOME, '.local', 'bin'), { recursive: true });
  writeFileSync(join(HOME, '.local', 'bin', 'claude'), STANDIN);
  chmodSync(join(HOME, '.local', 'bin', 'claude'), 0o755);
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom', chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true }));
  writeFileSync(join(HOME, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['acme', 'globex'], projectOrder: ['acme', 'globex'], lastVault: 'acme' }));
  const chatsA = [{ title: 'Alpha', id: randomUUID() }, { title: 'Beta', id: randomUUID() }, { title: 'Delta', id: randomUUID() }];
  const chatsG = [{ title: 'Gamma', id: randomUUID() }];
  const A = project('acme', chatsA, BRAIN ? resolve(BRAIN) : '');
  const G = project('globex', chatsG, '');
  const dir = join(HOME, '.claude', 'projects', 'scratch-proj');
  mkdirSync(dir, { recursive: true });
  [A.superId, ...chatsA.map((c) => c.id), G.superId, ...chatsG.map((c) => c.id)]
    .forEach((id, i) => writeFileSync(join(dir, `${id}.jsonl`), transcript(id, 80 + i * 40)));
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

/** In the page before the app loads: React's commit hook, long tasks, event timing, a frame log. */
const PROBE = `(() => {
  const R = window.__react = { on: false, commits: 0, rendered: 0, mounted: 0, names: {} };
  const COMPONENT = new Set([0, 1, 11, 14, 15]);
  const nameOf = (f) => { const t = f.type; if (!t) return '?'; if (typeof t === 'function') return t.displayName || t.name || 'anon'; return t.displayName || t.type?.displayName || t.type?.name || t.render?.displayName || t.render?.name || 'anon'; };
  const walk = (root) => {
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      if (COMPONENT.has(f.tag) && (f.flags & 1)) {
        if (f.alternate) { R.rendered++; const n = nameOf(f); R.names[n] = (R.names[n] || 0) + 1; } else R.mounted++;
      }
      if (f.sibling) stack.push(f.sibling);
      // A subtree React did not touch keeps the previous tree's child pointer: nothing ran in it.
      if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(), checkDCE() {},
    inject(r) { this.renderers.set(1, r); return 1; },
    onCommitFiberRoot(_id, root) { if (!R.on) return; R.commits++; try { walk(root.current); } catch (e) { R.error = String(e); } },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {}, onScheduleFiberRoot() {},
  };
  window.__reactStart = () => { R.commits = 0; R.rendered = 0; R.mounted = 0; R.names = {}; R.on = true; };
  window.__reactStop = () => { R.on = false; return { commits: R.commits, rendered: R.rendered, mounted: R.mounted, names: R.names, error: R.error }; };

  const P = window.__probe = { longs: [], events: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longs.push({ at: e.startTime, ms: Math.round(e.duration) }); }).observe({ entryTypes: ['longtask'] });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) P.events.push({ name: e.name, at: e.startTime, total: Math.round(e.duration), proc: Math.round(e.processingEnd - e.processingStart) }); }).observe({ type: 'event', durationThreshold: 16, buffered: false });

  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; };
  const live = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length > 0) ?? null;
  window.__sample = () => {
    const inst = document.querySelector('.project-instance:not([hidden])');
    // The rail is drawn in the window's slot, outside the instance: read the one on screen.
    const chat = live('[data-testid="ns-tab-chat"]')?.dataset.on === 'true';
    const region = chat ? [...(inst?.querySelectorAll('.agent-surface, .agent-host') ?? [])].find(shown) : inst?.querySelector('.shell-main');
    // The project just left can stay painted over the new one for a moment (useInstanceHold):
    // while it does, the new one is not what the owner sees.
    const held = !!document.querySelector('.project-instance[hidden][data-holding="hold"]');
    return { inst: inst?.dataset.instance ?? null, page: inst?.dataset.page ?? null, chat, held,
      on: live('.ns-tab-btn[data-on="true"]')?.dataset.testid ?? null,
      n: region ? region.getElementsByTagName('*').length : 0 };
  };
  window.__arm = () => new Promise((armed) => {
    const log = []; window.__log = log; window.__clickAt = 0; window.__run = true;
    P.longs.length = 0; P.events.length = 0;
    window.addEventListener('pointerdown', () => { window.__clickAt = performance.now(); }, { capture: true, once: true });
    // Read AFTER the frame: a task posted from the rAF runs past paint.
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { log.push({ t: performance.now(), ...window.__sample() }); if (window.__run) requestAnimationFrame(tick); };
    const tick = () => ch.port2.postMessage(0);
    requestAnimationFrame(tick); armed();
  });
  window.__disarm = () => { window.__run = false; return { log: window.__log, clickAt: window.__clickAt, longs: P.longs.filter((l) => l.at >= window.__clickAt - 5), events: P.events.slice() }; };
})();`;

const wait = (p, ms) => p.waitForTimeout(ms);
const med = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const max = (a) => a.filter((x) => x !== null && x !== undefined).reduce((m, x) => Math.max(m, x), 0);

/** One click, read into numbers. `isTarget(frame)` says the destination is on screen. */
async function hop(p, name, click, isTarget, hold = 1500) {
  await p.evaluate(() => window.__arm());
  await click();
  await wait(p, hold);
  const { log, clickAt, longs, events } = await p.evaluate(() => window.__disarm());
  const after = log.filter((f) => f.t >= clickAt);
  const seen = (f) => !f.held && isTarget(f);
  const first = after.find(seen);
  if (!first && process.env.SMOOTH_DEBUG) console.error('MISS', name, JSON.stringify(after.at(-1)));
  const final = after.at(-1)?.n ?? 0;
  const content = after.find((f) => seen(f) && f.n >= final * 0.9);
  const gap = Math.round(after.slice(1).reduce((m, f, i) => Math.max(m, f.t - after[i].t), 0));
  const click1 = events.filter((e) => e.name === 'click' || e.name === 'pointerup').reduce((m, e) => Math.max(m, e.total), 0);
  return {
    hop: name, first: first ? Math.round(first.t - clickAt) : null, content: content ? Math.round(content.t - clickAt) : null,
    long: max(longs.map((l) => l.ms)), longSum: longs.reduce((s, l) => s + l.ms, 0), gap, click: click1, els: final,
  };
}

async function metrics(cdp) {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

/** How much of the window each key painted, from a trace's Paint events. */
function paintShare(file, keys, view) {
  const events = JSON.parse(readFileSync(file, 'utf-8'));
  const list = Array.isArray(events) ? events : events.traceEvents;
  const paints = list.filter((e) => e.name === 'Paint' && e.args?.data?.clip);
  let area = 0; let big = 0;
  for (const e of paints) {
    const c = e.args.data.clip;
    const a = Math.abs((c[2] - c[0]) * (c[5] - c[1]));
    area += a;
    if (a >= view * 0.5) big++;
  }
  return { paints: paints.length, paintsPerKey: +(paints.length / keys).toFixed(2), windowSharePerKey: +((area / keys) / view).toFixed(3), halfWindowPaints: big };
}

async function typing(p, cdp, text) {
  const ta = p.locator('.project-instance:not([hidden]) textarea.chat-cmp-input').filter({ visible: true }).first();
  await ta.click();
  await wait(p, 600);
  // Warm the field (the first key lays out a taller box), then measure a clean run.
  await p.keyboard.type('a ', { delay: 60 });
  await wait(p, 600);
  await p.evaluate(() => { window.__probe.events.length = 0; window.__probe.longs.length = 0; window.__reactStart(); });
  const m0 = await metrics(cdp);
  await p.keyboard.type(text, { delay: 60 });
  await wait(p, 700); // the debounced saves the typing queued land inside the window
  const m1 = await metrics(cdp);
  const react = await p.evaluate(() => window.__reactStop());
  const ev = await p.evaluate(() => ({ events: window.__probe.events.slice(), longs: window.__probe.longs.slice() }));
  const keyEvents = ev.events.filter((e) => /^(keydown|keypress|input|keyup|beforeinput)$/.test(e.name));
  const n = text.length;
  const d = (k) => m1[k] - m0[k];
  const top = Object.entries(react.names).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}×${(v / n).toFixed(1)}`);
  // Clear the box so the next run starts from the same state.
  await p.keyboard.press('ControlOrMeta+a'); await p.keyboard.press('Backspace'); await wait(p, 600);
  return {
    keys: n,
    commitsPerKey: +(react.commits / n).toFixed(2),
    rendersPerKey: +(react.rendered / n).toFixed(1),
    distinctComponents: Object.keys(react.names).length,
    styleRecalcsPerKey: +(d('RecalcStyleCount') / n).toFixed(2),
    layoutsPerKey: +(d('LayoutCount') / n).toFixed(2),
    scriptMsPerKey: +((d('ScriptDuration') * 1000) / n).toFixed(2),
    styleLayoutMsPerKey: +(((d('RecalcStyleDuration') + d('LayoutDuration')) * 1000) / n).toFixed(2),
    taskMsPerKey: +((d('TaskDuration') * 1000) / n).toFixed(2),
    slowKeyEvents: keyEvents.length, slowestKeyMs: max(keyEvents.map((e) => e.total)),
    longTasks: ev.longs.length, top, reactError: react.error ?? null,
  };
}

async function main() {
  seed();
  const srv = await server();
  const browser = await chromium.launch();
  const report = { tag: TAG, cpu: CPU, rounds: ROUNDS, brain: BRAIN ? 'real copy' : 'synthetic', repo: REPO, pages: {}, typing: {} };
  try {
    const view = { width: 1440, height: 900 };
    const ctx = await browser.newContext({ viewport: view, colorScheme: 'light', recordVideo: flag('video') ? { dir: join(OUT, `video-${TAG}`), size: view } : undefined });
    const p = await ctx.newPage();
    p.setDefaultTimeout(15000);
    const errs = [];
    p.on('console', (m) => { if (m.type() === 'error' && !/WebSocket|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 200)); });
    p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await p.addInitScript(PROBE);
    await p.route('**/api/onboarding/readiness**', async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ json: { ...j, ready: true } }); });
    await p.goto(`http://127.0.0.1:${PORT}/?vault=acme`);
    await wait(p, 5000);
    const got = p.getByRole('button', { name: 'Got it' });
    if (await got.isVisible().catch(() => false)) await got.click();
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Performance.enable');
    await p.screenshot({ path: join(OUT, `${TAG}-start.png`) });
    // The Chat row waits for the machine's capabilities; on a loaded Mac that can take a while.
    if (!(await p.locator('[data-testid="ns-tab-chat"]').filter({ visible: true }).first().waitFor({ timeout: 90000 }).then(() => true, () => false))) {
      const ids = await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.dataset.testid))].slice(0, 60));
      throw new Error(`the rail's Chat row never came up (see ${TAG}-start.png); test ids: ${ids.join(', ')}; errors: ${errs.join(' | ')}`);
    }

    // Before the walk too: the owner's own steps are measured at the same speed as the laps.
    if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });

    const rail = (id) => p.locator(`[data-testid="ns-tab-${id}"]`).filter({ visible: true }).first();
    const row = (vault, text) => p.locator(`[data-drawer-project="${vault}"] .ns-dr-child`).filter({ hasText: text }).first();
    // One open project in the left panel (wb-sol-panel): a closed project's chat rows show after its
    // header is pressed, so the owner's real two presses are what is measured.
    const rowOpen = (vault, text) => ({ click: async () => {
      const child = row(vault, text);
      if (!(await child.isVisible().catch(() => false))) await p.locator(`[data-drawer-project="${vault}"] [data-testid="drawer-project-row"]`).first().click();
      await child.click();
    } });
    const onPage = (page) => (f) => !f.chat && f.page === page && f.n > 0;
    const onChat = (f) => f.chat && f.n > 50;
    const lap = [
      ['chat→tasks', () => rail('tasks').click(), onPage('tasks')],
      ['tasks→lab', () => rail('lab').click(), onPage('lab')],
      ['lab→whiteboards', () => rail('whiteboards').click(), onPage('whiteboards')],
      ['whiteboards→apps', () => rail('apps').click(), onPage('apps')],
      ['apps→tasks', () => rail('tasks').click(), onPage('tasks')],
      ['tasks→chat', () => rail('chat').click(), onChat],
    ];
    // ── the owner's own walk (2026-11-22), in his order, before anything else is mounted ──
    // Chat in project A; open closed project B from the left panel; Tasks; back to A's Tasks.
    const film = async (name, click, is, hold = 2500) => {
      // The hop's numbers, then the same click again is not possible (it changed the screen), so
      // the filmstrip is shot on the way: frames at ~0/80/200/500 ms and the settled screen.
      await p.evaluate(() => window.__arm());
      await click();
      const shots = [];
      for (const at of [0, 80, 200, 500]) { const t0 = Date.now(); await p.screenshot({ path: join(OUT, `${TAG}-walk-${name}-${at}.png`) }); shots.push(Date.now() - t0); await wait(p, Math.max(0, at === 0 ? 40 : at === 80 ? 80 : 250)); }
      await wait(p, hold);
      const { log, clickAt, longs } = await p.evaluate(() => window.__disarm());
      await p.screenshot({ path: join(OUT, `${TAG}-walk-${name}-end.png`) });
      const after = log.filter((f) => f.t >= clickAt);
      const seen = (f) => !f.held && is(f);
      const first = after.find(seen); const final = after.at(-1)?.n ?? 0;
      const content = after.find((f) => seen(f) && f.n >= final * 0.9);
      // Every change of the element count after the first frame is a visible step of the screen.
      let steps = 0; for (let i = 1; i < after.length; i++) if (first && after[i].t > first.t && Math.abs(after[i].n - after[i - 1].n) > 20) steps++;
      return { hop: name, first: first ? Math.round(first.t - clickAt) : null, content: content ? Math.round(content.t - clickAt) : null, long: max(longs.map((l) => l.ms)), longSum: longs.reduce((a, l) => a + l.ms, 0), gap: Math.round(after.slice(1).reduce((m, f, i) => Math.max(m, f.t - after[i].t), 0)), steps, els: final };
    };
    if (flag('walk')) {
      await rail('chat').click(); await wait(p, 2500);
      await rowOpen('acme', 'Alpha').click().catch(() => {}); await wait(p, 3000);
      await p.screenshot({ path: join(OUT, `${TAG}-walk-1-chat-A.png`) });
      report.walk = [];
      const instNow = () => p.evaluate(() => window.__sample().inst);
      let was = await instNow();
      report.walk.push(await film('2-open-closed-B', () => rowOpen('globex', 'Gamma').click(), (f) => f.inst !== null && f.inst !== was && f.chat && f.n > 50, 5000));
      report.walk.push(await film('3-B-chat-to-tasks', () => rail('tasks').click(), onPage('tasks')));
      // Back to A's Tasks from the left panel: the drawer button brings the panel over the page.
      const drawerBtn = p.locator('[data-testid="ns-drawer-toggle"], .ns-tb-btn').filter({ visible: true }).first();
      await drawerBtn.click().catch(() => {}); await wait(p, 600);
      await p.screenshot({ path: join(OUT, `${TAG}-walk-5-panel-over-tasks.png`) });
      was = await instNow();
      // The floating panel closes on a page; the other project is picked from the title bar.
      await p.keyboard.press('Escape'); await wait(p, 400);
      await p.locator('[data-testid="ns-picker-btn"]').filter({ visible: true }).first().click(); await wait(p, 500);
      const aRow = p.locator('[data-testid="ns-picker-acme"]').filter({ visible: true }).first();
      report.walk.push(await film('6-B-tasks-to-A-tasks', () => aRow.click(), (f) => f.inst !== null && f.inst !== was, 4000));
      report.walk.push(await film('16-whiteboards-first-open', () => rail('whiteboards').click(), onPage('whiteboards'), 5000));
      for (const h of report.walk) process.stdout.write(`WALK ${h.hop}: first ${h.first} content ${h.content} long ${h.long} (sum ${h.longSum}) gap ${h.gap} steps ${h.steps} els ${h.els}\n`);
      if (flag('walk-only')) { report.errors = errs; await ctx.close(); writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(report, null, 1)); return; }
    }
    // Open the chat first, then one lap that mounts everything: what a first visit costs.
    await rail('chat').click(); await wait(p, 2500);
    await rowOpen('acme', 'Alpha').click().catch(() => {}); await wait(p, 2500);
    await p.screenshot({ path: join(OUT, `${TAG}-chat.png`) });
    report.firstVisit = [];
    for (const [name, click, is] of lap) {
      report.firstVisit.push(await hop(p, name, click, is, 4000));
      await p.screenshot({ path: join(OUT, `${TAG}-${name.split('→')[1]}.png`) });
    }
    const rows = [];
    for (let r = 0; r < ROUNDS; r++) for (const [name, click, is] of lap) rows.push(await hop(p, name, click, is));
    // Project switch from the drawer, both ways, with the chat open.
    const sw = [
      ['acme→globex (chat)', () => rowOpen('globex', 'Gamma').click(), (f) => f.chat && f.inst !== null && f.n > 50],
      ['globex→acme (chat)', () => rowOpen('acme', 'Alpha').click(), (f) => f.chat && f.inst !== null && f.n > 50],
    ];
    await rowOpen('globex', 'Gamma').click().catch(() => {}); await wait(p, 4000);
    await rowOpen('acme', 'Alpha').click().catch(() => {}); await wait(p, 3000);
    for (let r = 0; r < ROUNDS; r++) {
      for (const [name, click, is] of sw) {
        const before = await p.evaluate(() => window.__sample().inst);
        const h = await hop(p, name, click, (f) => is(f) && f.inst !== before);
        rows.push(h);
      }
    }
    for (const name of [...lap, ...sw].map((x) => x[0])) {
      const of = rows.filter((x) => x.hop === name);
      report.pages[name] = { first: med(of.map((x) => x.first)), firstMax: max(of.map((x) => x.first)), content: med(of.map((x) => x.content)), contentMax: max(of.map((x) => x.content)), long: med(of.map((x) => x.long)), longMax: max(of.map((x) => x.long)), longSum: med(of.map((x) => x.longSum)), gap: med(of.map((x) => x.gap)), gapMax: max(of.map((x) => x.gap)), click: med(of.map((x) => x.click)), els: med(of.map((x) => x.els)), missed: of.filter((x) => x.first === null).length };
    }
    report.rows = rows;

    // ── typing ─────────────────────────────────────────────────────────────────────────
    const text = 'Merhaba, bu bir akıcılık ölçümüdür: yazarken ekranın geri kalanı kıpırdamasın. '.repeat(4).slice(0, KEYS);
    const runs = [];
    for (let r = 0; r < Math.max(2, Math.min(ROUNDS, 3)); r++) runs.push(await typing(p, cdp, text));
    const pick = (k) => med(runs.map((x) => x[k]));
    report.typing = { keys: text.length, commitsPerKey: pick('commitsPerKey'), rendersPerKey: pick('rendersPerKey'), distinctComponents: pick('distinctComponents'), styleRecalcsPerKey: pick('styleRecalcsPerKey'), layoutsPerKey: pick('layoutsPerKey'), scriptMsPerKey: pick('scriptMsPerKey'), styleLayoutMsPerKey: pick('styleLayoutMsPerKey'), taskMsPerKey: pick('taskMsPerKey'), slowKeyEvents: pick('slowKeyEvents'), slowestKeyMs: max(runs.map((x) => x.slowestKeyMs)), longTasks: max(runs.map((x) => x.longTasks)), top: runs[0].top, runs };
    await p.screenshot({ path: join(OUT, `${TAG}-typed.png`) });

    if (flag('trace')) {
      const file = join(OUT, `${TAG}-typing.trace.json`);
      const ta = p.locator('.project-instance:not([hidden]) textarea.chat-cmp-input').filter({ visible: true }).first();
      await ta.click(); await p.keyboard.type('a ', { delay: 60 }); await wait(p, 600);
      await browser.startTracing(p, { path: file, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
      await p.keyboard.type(text, { delay: 60 }); await wait(p, 700);
      await browser.stopTracing();
      report.paint = paintShare(file, text.length, view.width * view.height);
    }
    // ── a chat streaming while pages change (--stream) ──────────────────────────────────
    if (flag('stream')) {
      // Last: once it streams, nothing after it in this window is measured alone.
      await rail('chat').click(); await wait(p, 1500);
      const box = p.locator('.project-instance:not([hidden]) textarea.chat-cmp-input').filter({ visible: true }).first();
      await box.click(); await p.keyboard.type('akis baslat', { delay: 20 }); await p.keyboard.press('Enter');
      await wait(p, 2500);
      await p.screenshot({ path: join(OUT, `${TAG}-streaming.png`) });
      const busyLap = [lap[0], lap[1], ['lab→tasks', () => rail('tasks').click(), onPage('tasks')], lap[lap.length - 1]];
      const busy = [];
      for (let r = 0; r < ROUNDS; r++) for (const [name, click, is] of busyLap) busy.push(await hop(p, name, click, is));
      report.busy = {};
      for (const name of busyLap.map((x) => x[0])) {
        const of = busy.filter((x) => x.hop === name);
        report.busy[name] = { first: med(of.map((x) => x.first)), firstMax: max(of.map((x) => x.first)), content: med(of.map((x) => x.content)), long: med(of.map((x) => x.long)), longMax: max(of.map((x) => x.long)), missed: of.filter((x) => x.first === null).length };
      }
      report.busyRows = busy;
    }

    report.errors = errs;
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
    rmSync(SCRATCH, { recursive: true, force: true });
  }
  writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(report, null, 1));
  const line = (o) => process.stdout.write(`${o}\n`);
  if (flag('walk-only')) return;
  line(`${TAG}  cpu×${CPU}  rounds ${ROUNDS}  brain: ${report.brain}  build: ${existsSync(CLI) ? REPO : 'MISSING'}`);
  line('PAGES (ms, median; max in brackets)');
  line('first visit   ' + report.firstVisit.map((h) => `${h.hop} first ${h.first} content ${h.content} long ${h.long}`).join(' | '));
  for (const [k, v] of Object.entries(report.pages)) line(`${k.padEnd(22)} first ${v.first} [${v.firstMax}]  content ${v.content} [${v.contentMax}]  long ${v.long} [${v.longMax}] sum ${v.longSum}  gap ${v.gap} [${v.gapMax}]  click ${v.click}  els ${v.els}${v.missed ? `  MISSED ${v.missed}` : ''}`);
  if (report.busy) {
    line('BUSY (a chat streaming; ms, median, max in brackets)');
    for (const [k, v] of Object.entries(report.busy)) line(`${k.padEnd(22)} first ${v.first} [${v.firstMax}]  content ${v.content}  long ${v.long} [${v.longMax}]${v.missed ? `  MISSED ${v.missed}` : ''}`);
  }
  const t = report.typing;
  line(`TYPING (${t.keys} keys)  commits/key ${t.commitsPerKey}  renders/key ${t.rendersPerKey}  components ${t.distinctComponents}  style recalcs/key ${t.styleRecalcsPerKey}  layouts/key ${t.layoutsPerKey}  script ms/key ${t.scriptMsPerKey}  style+layout ms/key ${t.styleLayoutMsPerKey}  task ms/key ${t.taskMsPerKey}  keys over 16 ms ${t.slowKeyEvents}  slowest ${t.slowestKeyMs}  long tasks ${t.longTasks}`);
  line(`rendered per key: ${t.top.join('  ')}`);
  if (report.paint) line(`PAINT  paints/key ${report.paint.paintsPerKey}  window share/key ${report.paint.windowSharePerKey}  paints over half the window ${report.paint.halfWindowPaints}`);
  if (report.errors?.length) line(`console errors: ${JSON.stringify(report.errors.slice(0, 8))}`);
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
