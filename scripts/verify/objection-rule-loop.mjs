#!/usr/bin/env node
/**
 * The objection → rule loop, end to end, on a COPY of a real brain (task
 * uyku-yeni-isi-alt-gorev-modeline-gore-…, the parent's third criterion).
 *
 *   npm run build && node scripts/verify/objection-rule-loop.mjs <brain-project-dir> <task> <target> "<note>"
 *
 * Copies the brain's text (tasks, knowledge, core, overrides, config; never assets, tmp,
 * embeddings, lab or whiteboards) into a scratch project with a fake HOME, then, with THIS
 * repo's build and THIS repo's agents/sleep-tasks.md:
 *   1. objects to <task> as a sub-task of <target> (`tasks object`),
 *   2. runs `sleep start` (its brief must name the unlearned objection),
 *   3. runs ONE real sleep-tasks round (`claude -p --agent sleep-tasks`, the eval's flags: no
 *      orchestration tools, edits only inside the scratch project),
 *   4. runs `sleep done --asks` with the round's "Owner asks:" line,
 * and checks: a rule in knowledge/patterns/task-filing-rules.md rests on the objection, nothing
 * is left unlearned, the task page reads the rule ("Sleep learned", screenshots at 1440/390), and
 * the cycle's history summary carries the asks line. The real brain is never written: the
 * scratch settings deny edits there, and its files are compared before and after.
 *
 * Exit 1 on any FAIL. Costs one specialist round.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [brainProject, TASK, TARGET, NOTE] = process.argv.slice(2);
if (!brainProject || !TASK || !TARGET || !NOTE) {
  console.error('usage: objection-rule-loop.mjs <brain-project-dir> <task> <target> "<note>"');
  process.exit(2);
}
const PORT = process.env.PORT || '4829';
const URL = `http://127.0.0.1:${PORT}`;
const SHOTS = join(REPO, 'tmp', 'verify-objection-loop');
rmSync(SHOTS, { recursive: true, force: true });
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? ` — ${detail}` : ''}`);
};

// ─── The copy ────────────────────────────────────────────────────────────────

const realCtx = join(brainProject, '_dream_context');
const scratch = mkdtempSync(join(tmpdir(), 'dc-loop-'));
const proj = join(scratch, 'proj');
const ctx = join(proj, '_dream_context');
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
for (const d of [proj, join(home, '.dreamcontext'), bin]) mkdirSync(d, { recursive: true });
const SKIP = new Set(['tmp', '.embeddings', 'lab', 'whiteboards', '.git']);
cpSync(realCtx, ctx, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(realCtx.length + 1);
    const top = rel.split('/')[0];
    if (SKIP.has(top)) return false;
    if (rel.startsWith('state/assets')) return false;
    return true;
  },
});
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'copy', path: proj }] }, null, 2));
// The cycle reads no sessions: this round is about the objection, not a month of transcripts.
const sleepJson = join(ctx, 'state', '.sleep.json');
const sleepState = existsSync(sleepJson) ? JSON.parse(readFileSync(sleepJson, 'utf-8')) : {};
writeFileSync(sleepJson, JSON.stringify({ ...sleepState, sessions: [], bookmarks: [], sleep_started_at: null, debt: 0 }, null, 2));

// The specialist as THIS repo ships it, its skills with this repo's references, no hooks.
const claudeDir = join(proj, '.claude');
mkdirSync(join(claudeDir, 'agents'), { recursive: true });
cpSync(join(REPO, 'agents', 'sleep-tasks.md'), join(claudeDir, 'agents', 'sleep-tasks.md'));
for (const sk of ['dreamcontext', 'dreamcontext-agent-core']) {
  const src = join(brainProject, '.claude', 'skills', sk);
  if (existsSync(src)) cpSync(src, join(claudeDir, 'skills', sk), { recursive: true });
}
for (const f of readdirSync(join(REPO, 'skill', 'references'))) {
  cpSync(join(REPO, 'skill', 'references', f), join(claudeDir, 'skills', 'dreamcontext', 'references', f));
}
const realDirs = ['state', 'knowledge', 'core'].map((d) => join(realCtx, d)).concat([join(brainProject, '.claude')]);
writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
  permissions: { defaultMode: 'acceptEdits', deny: realDirs.flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`]) },
}, null, 2) + '\n');
writeFileSync(join(bin, 'dreamcontext'), `#!/bin/sh\nHOME='${home}' exec '${process.execPath}' '${distIndex(REPO)}' "$@"\n`);
chmodSync(join(bin, 'dreamcontext'), 0o755);

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('DREAMCONTEXT_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') continue;
  env[k] = v;
}
env.PATH = `${bin}:${process.env.PATH ?? ''}`;
env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
const dc = (...args) => spawnSync(join(bin, 'dreamcontext'), args, { cwd: proj, env, encoding: 'utf-8' });

// Fingerprint the real brain's text before anything runs.
const fingerprint = (dir) => {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) { if (!['assets', 'archive'].includes(name)) walk(p); } else if (/\.(md|json)$/.test(name)) h.update(p).update(readFileSync(p));
    }
  };
  for (const sub of ['state', 'knowledge', 'core']) if (existsSync(join(dir, sub))) walk(join(dir, sub));
  return h.digest('hex');
};
const realBefore = fingerprint(realCtx);

let serverProc;
let browser;
try {
  // ── 1. The objection ────────────────────────────────────────────────────────
  const obj = dc('tasks', 'object', TASK, '--as', 'subtask-of', '--target', TARGET, '--note', NOTE);
  check('the objection applies in the copy', obj.status === 0, (obj.stdout + obj.stderr).trim().split('\n')[0]);
  const ledger = JSON.parse(readFileSync(join(ctx, 'state', '.task-objections.json'), 'utf-8'));
  const record = ledger.find((r) => r.task === TASK && r.applied);
  check('one applied record', !!record, record?.id);

  // ── 2. sleep start names it ─────────────────────────────────────────────────
  const start = dc('sleep', 'start', '--json');
  let startJson = {};
  try { startJson = JSON.parse(start.stdout); } catch { /* reported below */ }
  check('sleep start lists the objection as unlearned', startJson.filingRules?.unlearned?.includes(record?.id), JSON.stringify(startJson.filingRules ?? null));

  // ── 3. One real sleep-tasks round ───────────────────────────────────────────
  const brief = [
    `Sleep cycle. Epoch: ${startJson.epoch}. Depth: ${startJson.depth}.`,
    'Sessions this cycle: none (state/.sleep.json has no sessions to read).',
    `sleep start reported task filing rules: ${JSON.stringify(startJson.filingRules)}.`,
    'Run your protocol on what there is. Step 2.6 applies: read the rules file and `dreamcontext tasks objections --unlearned --json`,',
    'and learn from the owner\'s objections through `dreamcontext tasks rules set|merge`. End with your sleep-tasks report.',
  ].join('\n');
  writeFileSync(join(SHOTS, 'brief.md'), brief);
  const fmText = readFileSync(join(claudeDir, 'agents', 'sleep-tasks.md'), 'utf-8');
  const model = /^model:\s*(.+)$/m.exec(fmText)?.[1]?.trim();
  const effort = /^effort:\s*(.+)$/m.exec(fmText)?.[1]?.trim();
  const args = ['-p', brief, '--agent', 'sleep-tasks', ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    '--output-format', 'json', '--permission-mode', 'acceptEdits', '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--allowedTools', 'Bash Read Glob Grep',
    '--disallowedTools', 'Agent Task Skill Workflow WebFetch WebSearch TaskCreate TaskUpdate TaskStop CronCreate CronDelete SendMessage RemoteTrigger PushNotification EnterWorktree ExitWorktree Monitor'];
  const t0 = Date.now();
  const round = spawnSync('claude', args, { cwd: proj, env, encoding: 'utf-8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(SHOTS, 'sleep-tasks.stdout.json'), round.stdout || round.stderr || '');
  let report = '';
  let cost = null;
  try { const o = JSON.parse(round.stdout); report = o.result ?? ''; cost = o.total_cost_usd ?? null; } catch { report = round.stdout ?? ''; }
  writeFileSync(join(SHOTS, 'report.md'), report);
  check('the sleep-tasks round finished', round.status === 0, `${Math.round((Date.now() - t0) / 1000)}s, $${cost ?? '?'}`);

  // ── 4. sleep done --asks ────────────────────────────────────────────────────
  // The report may set the label in bold ("**Owner asks:** 0 → …") and say "new task".
  const m = /Owner asks:\**\s*(\d+)\s*→\s*criterion\s*(\d+)\s*·\s*subtask\s*(\d+)\s*·\s*(?:new\s+)?task\s*(\d+)[^\n]*?not placed\s*(\d+)/i.exec(report);
  const asks = m ? `criterion=${m[2]},subtask=${m[3]},task=${m[4]},unplaced=${m[5]}` : 'criterion=0,subtask=0,task=0,unplaced=0';
  check('the report carries an "Owner asks:" line', !!m, m ? m[0] : 'not found; passing zeros');
  const done = dc('sleep', 'done', 'Objection loop on a copy: rules learned from the owner\'s objection.', '--asks', asks);
  check('sleep done takes --asks', done.status === 0, (done.stdout + done.stderr).split('\n').find((l) => /Owner asks/.test(l)) ?? '');

  // ── Checks ─────────────────────────────────────────────────────────────────
  const rulesPath = join(ctx, 'knowledge', 'patterns', 'task-filing-rules.md');
  const rulesText = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf-8') : '';
  writeFileSync(join(SHOTS, 'task-filing-rules.md'), rulesText);
  check('a rule in task-filing-rules.md rests on the objection', rulesText.includes(record?.id ?? '∅'), rulesText.split('\n').filter((l) => /^## R/.test(l)).join(' | '));
  const unlearned = dc('tasks', 'objections', '--unlearned', '--json');
  check('nothing is left unlearned', unlearned.status === 0 && JSON.parse(unlearned.stdout || '[]').length === 0, unlearned.stdout.trim().slice(0, 120));
  const history = JSON.parse(readFileSync(join(ctx, 'state', '.sleep-history.json'), 'utf-8'));
  const newest = Array.isArray(history) ? history[0] : history?.entries?.[0];
  check('the cycle\'s history summary carries the asks line', /Owner asks: \d+ →/.test(newest?.summary ?? ''), newest?.summary);

  // The task page reads the rule.
  serverProc = spawn(process.execPath, [distIndex(REPO), 'dashboard', '--no-open', '--port', PORT], { cwd: proj, env: { ...env, HOME: home, DREAMCONTEXT_DESKTOP: '1' }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${URL}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 500)); } }
  check('server boots', up);
  const api = await fetch(`${URL}/api/tasks/${TASK}`, { headers: { 'X-Dreamcontext-Vault': 'copy' } }).then((r) => r.json());
  check('GET /api/tasks/:slug reads the rule', !!api.task?.objection?.rule, JSON.stringify(api.task?.objection?.rule ?? null));
  const parentName = (await fetch(`${URL}/api/tasks/${TARGET}`, { headers: { 'X-Dreamcontext-Vault': 'copy' } }).then((r) => r.json())).task?.name ?? TARGET;
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    await markAnnouncementsSeen(context, URL);
    const page = await context.newPage();
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(`${URL}/?vault=copy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    for (let i = 0; i < 3 && (await page.locator('.announcements-modal-scrim').count()); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(300); }
    const nav = page.locator('.sidebar-item', { hasText: 'Tasks' }).first();
    if (await nav.isVisible().catch(() => false)) await nav.click();
    await page.waitForTimeout(1500);
    // A real brain may open on a narrower saved view: show every task, then narrow by the
    // parent's name. The task now sits under its parent: open its sub-task list, then the row.
    await page.getByText('All Tasks', { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    await page.locator('input[aria-label="Search tasks"]').fill(parentName.slice(0, 40)).catch(() => {});
    await page.waitForTimeout(900);
    const parentCard = page.locator(`.bd-card[data-task-slug="${TARGET}"]`).first();
    await parentCard.scrollIntoViewIfNeeded().catch(() => {});
    await parentCard.locator('.bd-sub-chip').first().click().catch(() => {});
    await page.waitForTimeout(400);
    // The title corner: the middle of a row may be another control.
    await page.locator('.bd-sub-row', { hasText: api.task?.name ?? TASK }).first().click({ position: { x: 24, y: 14 } }).catch(() => {});
    await page.waitForTimeout(900);
    const learned = await page.locator('[data-testid="objection-learned"]').innerText().catch(() => '');
    check(`@${width} the task page shows "Sleep learned"`, /Sleep learned · R\d+:/.test(learned), learned);
    await page.screenshot({ path: join(SHOTS, `learned-${width}.png`) });
    check(`@${width} no console errors`, errors.length === 0, errors.slice(0, 3).join(' || '));
    await context.close();
  }
} catch (e) {
  check('run finished', false, e.message);
} finally {
  await browser?.close().catch(() => {});
  serverProc?.kill();
  check('the real brain is untouched', fingerprint(realCtx) === realBefore);
  console.log(`artifacts: ${SHOTS}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
