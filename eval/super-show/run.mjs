#!/usr/bin/env node
/**
 * eval:super-show — does the REAL Super Agent show a set as cards instead of telling it as a list
 * (jarvis plan r9, AC11b)? Optional and PAID (real `claude` turns), never in CI.
 *
 * Each run: a fresh synthetic vault (gold.json; tasks and whiteboards made through this
 * worktree's CLI), a scratch HOME (so the owner's ~/.dreamcontext is never touched) with the
 * owner's real Claude config (`CLAUDE_CONFIG_DIR`) and real `claude` on PATH beside a
 * `dreamcontext` shim running THIS worktree's dist/index.js, the dashboard on a free port, the
 * hand-over done in the window, the prompt typed into the super composer. When the super chat
 * settles, the stage is read from `state/.super-agent.json` and the answer from the centre's last
 * reply, and `scorer.ts` decides. The summary is appended to RESULTS.md (date, model, passes).
 *
 *   npm run build && npm run eval:super-show            # every prompt, gold.runs times (vite-node)
 *   PROMPTS=tasks-tr RUNS=1 npm run eval:super-show     # a smoke run
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ enabled: true, chatView: true, screenMigrated: true, chatPermissionMode: 'auto', superAgent: true, renderer: 'dom' }));
  writeFileSync(join(bin, 'dreamcontext'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, 'dreamcontext'), 0o755);
  const env = {
    ...process.env, HOME: home, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(REAL_HOME, '.claude'), DREAMCONTEXT_DESKTOP: '1',
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
    await page.goto(`http://127.0.0.1:${port}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) await nav.click().catch(() => {});
    await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0, 20000);
    const first = page.locator('.chat-cmp-input:visible').first();
    await first.fill('Say "ready" and nothing else.');
    await page.keyboard.press('Enter');
    await until(page, async () => (await page.locator('[data-testid="super-handover-btn"]:visible').count()) > 0, 60000);
    await page.waitForTimeout(8000);
    await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
    await until(page, async () => !!recordOf(run)?.session, 30000);
    // The hand-over event turn first: wait until the super chat settles.
    await until(page, async () => (await page.locator('.super-centre[data-status="idle"]').count()) > 0, 180000);
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
    await until(page, async () => (await page.locator('.super-centre[data-status="idle"]').count()) > 0, 300000);
    await page.waitForTimeout(2000);
    const answer = await page.locator('.super-centre .chat-assistant-text, .super-centre [data-item-kind="text"]').last().innerText().catch(() => '');
    await page.screenshot({ path: join(OUT, `${prompt.id}-${n}.png`) });
    const rec = recordOf(run) ?? { containers: [], groups: [] };
    const gold = prompt.gold === 'insights' ? GOLD.insights.map(([s]) => s) : GOLD.tasks.open.map(([name]) => slug(name));
    const notGold = prompt.gold === 'insights' ? [] : GOLD.tasks.done.map(([name]) => slug(name));
    const v = scoreShow(
      { kind: prompt.kind, gold, notGold, titles: gold.map((s) => run.titles[s]), ...(preOpen.length ? { preOpen } : {}) },
      { containers: rec.containers, groups: rec.groups ?? [], answer },
    );
    return { ...v, answer: answer.slice(0, 400) };
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
for (const prompt of GOLD.prompts.filter((p) => !ONLY.length || ONLY.includes(p.id))) {
  let passed = 0;
  for (let n = 1; n <= RUNS; n += 1) {
    let v;
    try { v = await once(pw, prompt, n); } catch (err) { v = { pass: false, failed: [`crashed: ${err?.message ?? err}`], answer: '' }; }
    if (v.pass) passed += 1;
    console.log(`${prompt.id} #${n}: ${v.pass ? 'PASS' : `FAIL ${v.failed.join('; ')}`}`);
  }
  const need = Math.min(GOLD.threshold, RUNS);
  if (passed < need) allOk = false;
  lines.push(`| ${prompt.id} | \`${prompt.text}\` | ${passed}/${RUNS} | ${passed >= need ? 'PASS' : 'FAIL'} |`);
}
const model = process.env.EVAL_MODEL || 'the chat default';
const head = `\n## ${new Date().toISOString().slice(0, 10)} — model: ${model}, runs per prompt: ${RUNS}\n\n| prompt | text | passed | verdict |\n|---|---|---|---|\n`;
appendFileSync(join(HERE, 'RESULTS.md'), head + lines.join('\n') + '\n');
console.log(`\n${allOk ? 'PASS' : 'FAIL'} (RESULTS.md updated)`);
process.exit(allOk ? 0 : 1);
