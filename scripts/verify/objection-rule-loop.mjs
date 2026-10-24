#!/usr/bin/env node
/**
 * The objection → rule loop, end to end, on a COPY of a real brain (task
 * uyku-yeni-isi-alt-gorev-modeline-gore-…, the parent's third criterion).
 *
 *   npm run build && node scripts/verify/objection-rule-loop.mjs <brain-project-dir> <task> <target> "<note>"
 *
 * Copies what the round reads (task files, core, knowledge, people, overrides, the sleep and
 * filing ledgers, the setup config with a local task backend; never secrets, peers, sessions
 * or the brain repo) into a scratch project, isolated as the sleep eval's scratch vault is,
 * then, with THIS repo's build and THIS repo's agents/sleep-tasks.md:
 *   1. objects to <task> as a sub-task of <target> (`tasks object`),
 *   2. runs `sleep start` (its brief must name the unlearned objection),
 *   3. runs ONE real sleep-tasks round (`claude -p --agent sleep-tasks`, the eval's flags: no
 *      orchestration tools, Bash in the sandbox, every tool call recorded),
 *   4. runs `sleep done --asks` with the round's "Owner asks:" line,
 * and checks: the round wrote a rule through `tasks rules set|merge` that rests on the
 * objection, nothing is left unlearned, the task page reads the rule ("Sleep learned",
 * screenshots at 1440/390), and the cycle's history summary carries the round's asks line. The
 * real brain is never written: no tool call names it, the shim refused nothing, and none of
 * its files (nor its .claude) changed size or mtime during the run.
 *
 * Exit 1 on any FAIL. Costs one specialist round.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [brainArg, TASK, TARGET, NOTE] = process.argv.slice(2);
const brainProject = brainArg ? resolve(brainArg) : '';
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
// Isolation mirrors the sleep eval's scratch vault (src/lib/sleep-eval/scratch.ts): only what
// the round reads is copied (no secrets, peers, brain repo or sessions), the task backend is
// local, the CLI runs through a shim that pins HOME inside the scratch project and refuses
// every outward verb, and the specialist's Bash runs in Claude Code's sandbox with writes to
// the real brain denied.

const realCtx = join(brainProject, '_dream_context');
const scratch = mkdtempSync(join(tmpdir(), 'dc-loop-'));
const proj = join(scratch, 'proj');
const ctx = join(proj, '_dream_context');
const home = join(proj, '.eval-home');
const bin = join(scratch, 'bin');
const shimLog = join(proj, '.eval-shim.log');
for (const d of [join(ctx, 'state'), join(home, '.dreamcontext'), bin]) mkdirSync(d, { recursive: true });
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return fallback; } };

for (const sub of ['core', 'knowledge', 'people', 'overrides']) {
  if (existsSync(join(realCtx, sub))) cpSync(join(realCtx, sub), join(ctx, sub), { recursive: true });
}
// The board: every task file, live and archived.
for (const name of readdirSync(join(realCtx, 'state'))) {
  if (name.endsWith('.md') && !name.startsWith('.')) cpSync(join(realCtx, 'state', name), join(ctx, 'state', name));
}
if (existsSync(join(realCtx, 'state', 'archive'))) cpSync(join(realCtx, 'state', 'archive'), join(ctx, 'state', 'archive'), { recursive: true });
// The ledgers the round reads, and nothing else from state.
for (const name of ['.sleep-history.json', '.task-declined.json', '.task-tombstones.json', '.active-version.json', '.sleep-flags.json']) {
  if (existsSync(join(realCtx, 'state', name))) cpSync(join(realCtx, 'state', name), join(ctx, 'state', name));
}
// The setup config with every outward path cut (scratch.ts sanitizeSetupConfig).
const config = readJson(join(realCtx, 'state', '.config.json'), {});
for (const k of ['github', 'clickup', 'brainRepo', 'linkedRepos', 'cloudTaskManagement', 'shareable', 'recallCloud']) delete config[k];
config.taskBackend = 'local';
config.setupVersion = readJson(join(REPO, 'package.json'), {}).version;
writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify(config, null, 2) + '\n');
// The cycle reads no sessions: this round is about the objection, not a month of transcripts.
const sleepState = readJson(join(realCtx, 'state', '.sleep.json'), {});
writeFileSync(join(ctx, 'state', '.sleep.json'), JSON.stringify({ ...sleepState, sessions: [], bookmarks: [], sleep_started_at: null, debt: 0 }, null, 2));
writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ version: 1, vaults: [{ name: 'copy', path: proj }] }, null, 2));
// The local embedding model, read-only, so the filing bar's neighbor check runs as it does for real.
const models = join(homedir(), '.dreamcontext', 'models');
if (existsSync(models)) symlinkSync(models, join(home, '.dreamcontext', 'models'));

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
// `//` = an absolute path in Claude Code permission rules; the sandbox applies them to Bash too.
const deny = [realCtx, join(brainProject, '.claude')].flatMap((d) => [`Edit(/${d}/**)`, `Write(/${d}/**)`]);
writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
  permissions: { defaultMode: 'acceptEdits', deny },
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
}, null, 2) + '\n');

// The eval's shim: outward-facing verbs never run (scratch.ts REFUSED_VERBS / REFUSED_PAIRS).
const REFUSED_VERBS = ['brain', 'cloud', 'window', 'notify', 'dashboard', 'app', 'update', 'upgrade', 'setup', 'init'];
const REFUSED_PAIRS = ['lab sync', 'automations run', 'tasks sync', 'tasks push', 'tasks pull', 'peer ask', 'peer send', 'peer mail', 'link add', 'link remove', 'link rm'];
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(join(bin, 'dreamcontext'), [
  '#!/bin/sh',
  'case "$1 $2" in',
  ...REFUSED_PAIRS.map((p) => `  ${sq(p)}*) echo "$*" >> ${sq(shimLog)}; echo "dreamcontext ${p} is recorded, not run, in the scratch copy."; exit 0 ;;`),
  'esac',
  'case "$1" in',
  `  ${REFUSED_VERBS.join('|')}) echo "$*" >> ${sq(shimLog)}; echo "dreamcontext $1 is disabled in the scratch copy." >&2; exit 1 ;;`,
  'esac',
  `HOME=${sq(home)} exec ${sq(process.execPath)} ${sq(distIndex(REPO))} "$@"`,
  '',
].join('\n'));
chmodSync(join(bin, 'dreamcontext'), 0o755);

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('DREAMCONTEXT_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') continue;
  if (/^(GH_|GITHUB_|CLICKUP_)/.test(k)) continue;
  env[k] = v;
}
env.PATH = `${bin}:${process.env.PATH ?? ''}`;
env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
const dc = (...args) => spawnSync(join(bin, 'dreamcontext'), args, { cwd: proj, env, encoding: 'utf-8' });

// Every file of the real brain and its .claude, by size and mtime: a write shows by path.
const snapshot = () => {
  const out = new Map();
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = join(d, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else out.set(p, `${st.size}:${st.mtimeMs}`);
    }
  };
  walk(realCtx);
  walk(join(brainProject, '.claude'));
  return out;
};
const realBefore = snapshot();

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
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--setting-sources', 'project', '--strict-mcp-config',
    '--no-session-persistence', '--allowedTools', 'Bash Read Glob Grep',
    '--disallowedTools', 'Agent Task Skill Workflow WebFetch WebSearch TaskCreate TaskUpdate TaskStop CronCreate CronDelete SendMessage RemoteTrigger PushNotification EnterWorktree ExitWorktree Monitor'];
  const t0 = Date.now();
  const round = spawnSync('claude', args, { cwd: proj, env, encoding: 'utf-8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  writeFileSync(join(SHOTS, 'sleep-tasks.stream.jsonl'), round.stdout || round.stderr || '');
  // The stream carries every tool call, so what the round DID is observed, not taken from its report.
  const events = (round.stdout ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const final = events.findLast((e) => e.type === 'result');
  const report = final?.result ?? '';
  const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
  writeFileSync(join(SHOTS, 'report.md'), report);
  writeFileSync(join(SHOTS, 'tool-calls.json'), JSON.stringify(calls.map((c) => ({ name: c.name, input: c.input })), null, 2));
  check('the sleep-tasks round finished', round.status === 0 && !!final && !final.is_error, `${Math.round((Date.now() - t0) / 1000)}s, $${final?.total_cost_usd ?? '?'}, ${calls.length} tool calls`);
  const ruleCalls = calls.filter((c) => c.name === 'Bash' && /dreamcontext\s+tasks\s+rules\s+(set|merge)\b/.test(c.input?.command ?? ''));
  check('the round wrote the rule through `tasks rules set|merge`', ruleCalls.length > 0, ruleCalls.map((c) => c.input.command.slice(0, 90)).join(' || '));
  const outward = calls.filter((c) => ['Bash', 'Edit', 'Write', 'NotebookEdit'].includes(c.name) && JSON.stringify(c.input ?? {}).includes(brainProject));
  check('no Bash, Edit or Write call of the round names the real brain', outward.length === 0, outward.map((c) => `${c.name}: ${JSON.stringify(c.input).slice(0, 90)}`).join(' || '));
  const shimText = existsSync(shimLog) ? readFileSync(shimLog, 'utf-8').trim() : '';
  check('the shim refused nothing outward (no sync, peer or app verb was tried)', shimText === '', shimText.split('\n').slice(0, 3).join(' || '));

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
  let unlearnedList = null;
  try { unlearnedList = JSON.parse(unlearned.stdout); } catch { /* not a list: FAIL below */ }
  check('nothing is left unlearned', unlearned.status === 0 && Array.isArray(unlearnedList) && unlearnedList.length === 0, unlearned.stdout.trim().slice(0, 120));
  const history = JSON.parse(readFileSync(join(ctx, 'state', '.sleep-history.json'), 'utf-8'));
  const newest = Array.isArray(history) ? history[0] : history?.entries?.[0];
  // Only the round's own line counts: the zeros passed when it had none prove nothing.
  check('the cycle\'s history summary carries the round\'s asks line', !!m && /Owner asks: \d+ →/.test(newest?.summary ?? ''), newest?.summary);

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
  // Another live session writing the real brain meanwhile shows here too: the paths say whose.
  const realAfter = snapshot();
  const changed = [...new Set([...realBefore.keys(), ...realAfter.keys()])].filter((p) => realBefore.get(p) !== realAfter.get(p));
  check('no file of the real brain or its .claude changed during the run', changed.length === 0, changed.slice(0, 8).map((p) => p.slice(brainProject.length + 1)).join(', '));
  console.log(`artifacts: ${SHOTS}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
