#!/usr/bin/env node
/**
 * eval:super-show — does the REAL Super Agent show a set as cards instead of telling it as a list
 * (jarvis plan r9, AC11b)? Optional and PAID (real `claude` turns), never in CI.
 *
 * Each run: a fresh synthetic vault (gold.json; tasks and whiteboards made through this
 * worktree's CLI), a scratch HOME (so the owner's ~/.dreamcontext is never touched) linking the
 * owner's real ~/.claude (sign-in) and real `claude` on PATH beside a
 * `dreamcontext` shim running THIS worktree's dist/index.js, the dashboard on a free port, the
 * hand-over done in the window, the prompt typed into the super composer. When the super chat
 * settles, the stage is read from `state/.super-agent.json` and the answer from the centre's last
 * reply, and `scorer.ts` decides. The summary is appended to RESULTS.md (date, model, passes).
 *
 *   npm run build && npm run eval:super-show            # every prompt, gold.runs times (vite-node)
 *   PROMPTS=tasks-tr RUNS=1 npm run eval:super-show     # a smoke run
 *   EVAL_MODEL=claude-sonnet-5-5 EVAL_EFFORT=medium …     # the model every chat starts on
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const CLI = join(REPO, 'dist', 'index.js');
const GOLD = JSON.parse(readFileSync(join(HERE, 'gold.json'), 'utf-8'));
const RUNS = Number(process.env.RUNS || GOLD.runs);
const ONLY = (process.env.PROMPTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const REAL_HOME = homedir();
const CLAUDE_BIN = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf-8' }).stdout.trim();
const OUT = join(REPO, 'tmp', 'eval-super-show');

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function makeRun(id) {
  const root = join(tmpdir(), `dreamcontext-eval-super-show-${process.pid}-${id}`);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, 'home');
  const proj = join(root, 'acme-app');
  const bin = join(root, 'bin');
  for (const d of [join(home, '.dreamcontext'), join(proj, '_dream_context', 'state'), join(proj, '_dream_context', 'lab', 'insights'), bin]) mkdirSync(d, { recursive: true });
  // The model every new chat (the super one included) starts on: EVAL_MODEL / EVAL_EFFORT, else
  // the app's own default.
  writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({
    enabled: true, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', superAgent: true, renderer: 'dom',
    chatDefaultModel: process.env.EVAL_MODEL || '', chatDefaultEffort: process.env.EVAL_EFFORT || '',
  }));
  writeFileSync(join(bin, 'dreamcontext'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, 'dreamcontext'), 0o755);
  // Claude's sign-in: the keychain item is found only WITHOUT CLAUDE_CONFIG_DIR, so the scratch
  // HOME points at the owner's real ~/.claude (a link) and a COPY of ~/.claude.json (never written
  // back). The owner's ~/.dreamcontext is never touched: it is the scratch one.
  try { symlinkSync(join(REAL_HOME, '.claude'), join(home, '.claude')); } catch { /* exists */ }
  try { copyFileSync(join(REAL_HOME, '.claude.json'), join(home, '.claude.json')); } catch { /* none */ }
  // The keychain claude signs in from is found through HOME/Library/Keychains: link only that.
  try { mkdirSync(join(home, 'Library'), { recursive: true }); symlinkSync(join(REAL_HOME, 'Library', 'Keychains'), join(home, 'Library', 'Keychains')); } catch { /* exists */ }
  const { CLAUDE_CONFIG_DIR: _cfg, ...base } = process.env;
  const env = {
    ...base, HOME: home, DREAMCONTEXT_DESKTOP: '1',
    PATH: [bin, dirname(CLAUDE_BIN), dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
  };
  const dc = (...a) => spawnSync(process.execPath, [CLI, ...a], { cwd: proj, env, encoding: 'utf-8' });
  spawnSync('git', ['-C', proj, 'init', '-q']);
  if (dc('vaults', 'add', 'acme-app', proj).status !== 0) throw new Error('vaults add failed');
  const titles = {};
  for (const [name, status] of [...GOLD.tasks.open, ...GOLD.tasks.done]) {
    dc('tasks', 'create', name, '-w', `${name}: synthetic eval task.`);
    if (status !== 'todo') dc('tasks', 'status', slug(name), status, 'eval fixture');
    titles[slug(name)] = name;
  }
  for (const [s, title] of GOLD.insights) {
    writeFileSync(join(proj, '_dream_context', 'lab', 'insights', `${s}.md`), `---\ntitle: '${title}'\ndescription: null\ncategory: Growth\nrender: number\nunit: users\nsource:\n  adapter: manual\nrefresh:\n  ttl_minutes: 1440\ncreated_at: '2026-10-21'\nupdated_at: '2026-10-21'\n---\n## Meaning\n\n${title}, synthetic.\n`);
    titles[s] = title;
  }
  for (const w of GOLD.whiteboards) dc('whiteboard', 'create', w);
  return { root, home, proj, env, titles };
}

async function startServer(run, port) {
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], { cwd: run.proj, env: run.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(run.root, 'server.log'), { flags: 'a' });
  srv.stdout.pipe(log);
  srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard did not come up');
}

const until = async (page, fn, ms) => {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(500); }
  return false;
};
// Has the turn that starts at the LAST node matching `startSel` (optionally containing `text`)
// written its reply, with the centre idle? The reply is an assistant body after that node; the
// centre must stay idle across three looks a second apart, so a turn that has not started yet
// (idle between the event and its first token) is not mistaken for a settled one.
const replied = (page, startSel, text) => page.evaluate(({ startSel, text }) => {
  const root = document.querySelector('.super-centre');
  if (!root || root.getAttribute('data-status') !== 'idle') return false;
  const nodes = [...root.querySelectorAll(`${startSel}, .chat-msg-assistant-body`)];
  let at = -1;
  nodes.forEach((n, i) => { if (n.matches(startSel) && (!text || (n.textContent ?? '').includes(text))) at = i; });
  return at >= 0 && nodes.slice(at + 1).some((n) => n.classList.contains('chat-msg-assistant-body') && (n.innerText ?? '').trim());
}, { startSel, text });
async function settled(page, startSel, text, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    let ok = true;
    for (let i = 0; i < 3 && ok; i++) { ok = await replied(page, startSel, text).catch(() => false); if (ok) await page.waitForTimeout(1000); }
    if (ok) return true;
    await page.waitForTimeout(500);
  }
  return false;
}
const recordOf = (run) => { try { return JSON.parse(readFileSync(join(run.proj, '_dream_context', 'state', '.super-agent.json'), 'utf-8')); } catch { return null; } };

async function once(pw, prompt, n) {
  // Run through vite-node (`npm run eval:super-show`), which loads the TypeScript scorer.
  const { scoreShow } = await import(join(HERE, 'scorer.ts'));
  const run = makeRun(`${prompt.id}-${n}`);
  const port = await freePort();
  const server = await startServer(run, port);
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    // Cost and model, read from the chats' own stream: every `result` frame carries its cost.
    const meter = { cost: 0, models: new Set() };
    page.on('websocket', (ws) => ws.on('framereceived', (f) => {
      const t = typeof f.payload === 'string' ? f.payload : '';
      if (!t.includes('"total_cost_usd"') && !t.includes('"model"')) return;
      try {
        const o = JSON.parse(t);
        if (o.type === 'result' && typeof o.total_cost_usd === 'number') meter.cost += o.total_cost_usd;
        if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') meter.models.add(o.model);
      } catch { /* not a frame we read */ }
    }));
    await page.goto(`http://127.0.0.1:${port}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // The way verify:super-jarvis opens the Chat surface (the same app, the same steps).
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
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
    if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 60000);
    const first = page.locator('.chat-cmp-input:visible').first();
    await first.fill('Say "ready" and nothing else.');
    await page.keyboard.press('Enter');
    await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 60000);
    await page.waitForTimeout(8000);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await until(page, async () => !!recordOf(run)?.session, 30000);
    // The hand-over event turn first (its chip drawn, the super chat settled), so the prompt's
    // turn is not interleaved with it.
    await until(page, async () => (await page.locator('[data-testid="super-event-chip"]').count()) > 0, 180000);
    // Wait for the hand-over turn's OWN reply (not only its chip): a prompt sent before it lands
    // is read as that turn's answer (2026-10-21 re-run: two harness misses).
    if (!(await settled(page, '[data-testid="super-event-chip"]', '', 300000))) throw new Error('the hand-over turn never replied');
    await page.waitForTimeout(2000);
    let preOpen = [];
    if (prompt.capacity) {
      // 12 ungrouped floating cards, some of them finished tasks (the owner's full stage).
      const rec = recordOf(run);
      const done = GOLD.tasks.done.map(([name]) => slug(name));
      const cards = [...done.map((ref) => ({ kind: 'task', ref })), ...Array.from({ length: 12 - done.length }, (_, i) => ({ kind: 'knowledge', ref: `note-${i}` }))]
        .map((c, i) => ({ id: `${c.kind}-pre${i}`, kind: c.kind, ref: c.ref, shape: 'square', place: 'float' }));
      writeFileSync(join(run.proj, '_dream_context', 'state', '.super-agent.json'), JSON.stringify({ ...rec, containers: cards, groups: [] }));
      preOpen = cards.map((c) => c.id);
    }
    const input = page.locator('[data-testid="super-surface"] .chat-cmp-input:visible').first();
    await input.fill(prompt.text);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    await settled(page, '.chat-msg-user-row', prompt.text, 300000);
    await page.waitForTimeout(2000);
    // The reply to THIS prompt: the assistant text right after the prompt's bubble in the centre
    // (an event turn's reply, e.g. the hand-over's, can land before or after it).
    const answer = await page.evaluate((prompt) => {
      const root = document.querySelector('.super-centre') ?? document;
      // The turn runs from the prompt's bubble to the next owner message or server event chip;
      // its answer is the LAST assistant text in it (earlier ones are interim narration).
      const nodes = [...root.querySelectorAll('.chat-msg-user-row, .chat-msg-assistant-body, [data-testid="super-event-chip"]')];
      const at = nodes.findIndex((n) => n.classList.contains('chat-msg-user-row') && (n.textContent ?? '').includes(prompt));
      if (at < 0) return '';
      const rest = nodes.slice(at + 1);
      const end = rest.findIndex((n) => !n.classList.contains('chat-msg-assistant-body'));
      const turn = end < 0 ? rest : rest.slice(0, end);
      return (turn.at(-1)?.innerText ?? '').trim();
    }, prompt.text).catch(() => '');
    if (!answer) throw new Error('no reply to the prompt was found in the centre');
    await page.screenshot({ path: join(OUT, `${prompt.id}-${n}.png`) });
    const rec = recordOf(run) ?? { containers: [], groups: [] };
    const gold = prompt.gold === 'insights' ? GOLD.insights.map(([s]) => s) : GOLD.tasks.open.map(([name]) => slug(name));
    const notGold = prompt.gold === 'insights' ? [] : GOLD.tasks.done.map(([name]) => slug(name));
    const v = scoreShow(
      { kind: prompt.kind, gold, notGold, titles: gold.map((s) => run.titles[s]), ...(preOpen.length ? { preOpen } : {}) },
      { containers: rec.containers, groups: rec.groups ?? [], answer },
    );
    return { ...v, answer: answer.slice(0, 400), cost: meter.cost, models: [...meter.models] };
  } catch (err) {
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: join(OUT, `${prompt.id}-${n}-crash.png`) }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.kill();
  }
}

mkdirSync(OUT, { recursive: true });
if (!existsSync(CLI)) { console.error('dist/index.js missing: npm run build first'); process.exit(2); }
if (!CLAUDE_BIN) { console.error('no `claude` on the login PATH'); process.exit(2); }
const pw = await import('@playwright/test');
const lines = [];
let allOk = true;
let cost = 0;
const models = new Set();
for (const prompt of GOLD.prompts.filter((p) => !ONLY.length || ONLY.includes(p.id))) {
  let passed = 0;
  let promptCost = 0;
  for (let n = 1; n <= RUNS; n += 1) {
    let v;
    try { v = await once(pw, prompt, n); } catch (err) { v = { pass: false, failed: [`crashed: ${err?.message ?? err}`], answer: '', cost: 0, models: [] }; }
    if (v.pass) passed += 1;
    cost += v.cost ?? 0;
    promptCost += v.cost ?? 0;
    for (const m of v.models ?? []) models.add(m);
    console.log(`${prompt.id} #${n}: ${v.pass ? 'PASS' : `FAIL ${v.failed.join('; ')}`} ($${(v.cost ?? 0).toFixed(3)}) answer: ${JSON.stringify(v.answer).slice(0, 200)}`);
  }
  const need = Math.min(GOLD.threshold, RUNS);
  if (passed < need) allOk = false;
  lines.push(`| ${prompt.id} | \`${prompt.text}\` | ${passed}/${RUNS} | ${passed >= need ? 'PASS' : 'FAIL'} | $${promptCost.toFixed(2)} |`);
}
const model = `${[...models].join(', ') || process.env.EVAL_MODEL || 'the chat default'}${process.env.EVAL_EFFORT ? ` / ${process.env.EVAL_EFFORT}` : ''}`;
const head = `\n## ${new Date().toISOString().slice(0, 10)} — model: ${model}, runs per prompt: ${RUNS}, threshold ${GOLD.threshold}/${GOLD.runs}, total cost $${cost.toFixed(2)}\n\n| prompt | text | passed | verdict | cost |\n|---|---|---|---|---|\n`;
appendFileSync(join(HERE, 'RESULTS.md'), head + lines.join('\n') + '\n');
console.log(`\n${allOk ? 'PASS' : 'FAIL'} (RESULTS.md updated)`);
process.exit(allOk ? 0 : 1);
