#!/usr/bin/env node
/**
 * A finished AI Team job reaches the Super Agent as ONE event, on the REQUEST route (plan-r10 1,
 * Wave 3; task super-agent-bir-ai-team-ajanina-is-verdiginde-ajanin-isi-bitince-super-e-olay-gelir).
 * `super team ask` no longer starts a headless `say` run: it is a `request` item in the member's
 * own Super, closed by its `super team done`. (`say` cannot be pinned from outside the unit tests,
 * so the headless chain's events are covered there, not here.)
 *
 *   npm run build && node scripts/verify/super-team-event.mjs            (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard and chat
 * WebSockets, real AI Team members (`dreamcontext agents create`) and the real CLI run from INSIDE
 * each Super's own process. `claude` is a scripted stand-in (lib/super-scratch.mjs, no tokens
 * spent): it plays main Super (logging every `[super events]` turn and answering a member's
 * question with `super team answer`) and each member's own Super (DREAMCONTEXT_MEMBER_SUPER).
 *
 *   E1  the owner asks main for a team job (his turn): the window spawns the member's Super, which
 *       closes the request with `super team done`; main gets ONE `[super events]` item for that
 *       job, event=done, from=member-super, awaited=owner, with the member's result fenced. Nothing
 *       more for it after that.
 *   E2  a job the member could not do: it closes it saying so; ONE event=done with that result; a
 *       second `team done` on the same request is refused 409 already_done and adds nothing.
 *   E3  every team job on main's record is settled (done, none open) and every team item done.
 *   E4  a member's Super asks MAIN about the job (`super ask --for <item>`), main answers with
 *       `super team answer`, the answer reaches the member as a `[super events]` reply (never a
 *       user message), it asks a second time the same way, then closes the job. Main gets exactly
 *       three items for the job, in order: question, question, done awaited=owner; the owner's
 *       summary never shows the member asking (main-handed work is between member and main).
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, freePort, readJson, readNd, startServer as startDashboard, superStandin, toMainStage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-team-event-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const MEMBER_ANSWER = 'Signups fell 4% on Tuesday; the drop is all on the pricing step.';
const ASKER = 'clerk';
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super events]')) {
      report({ kind: 'events', text });
      // A member's question about a job main gave it: main answers it itself (never the owner).
      for (const m of text.matchAll(/- item=(\\S+) team=\\S+ member=\\S+ event=question/g)) {
        const second = /Question 2/.test(text);
        const step = cli('super', 'team', 'answer', m[1], second ? 'GO-ANSWER-2 yes, publish part 2' : 'GO-ANSWER-1 yes, publish part 1');
        report({ kind: 'answer', item: m[1], step });
      }
      return 'noted';
    }
    if (text.startsWith('[super')) return 'noted';
    if (text.includes('GO-TEAM')) {
      const asker = text.includes('GO-TEAM-ASK');
      const job = asker ? 'ASK-TWICE: publish the two parts, asking before each.' : text.includes('GO-TEAM-FAIL') ? 'FAILME: look at the funnel.' : 'Look at this week\\'s signup funnel and name the step that dropped.';
      const step = cli('super', 'team', 'ask', asker ? ${JSON.stringify(ASKER)} : ${JSON.stringify(MEMBER)}, job, '--brief', asker ? 'Publish parts' : 'Funnel check');
      report({ kind: 'team', step });
      return 'asked the team';
    }
    return 'ok';`,
  member: `
    const req = /- item=(\\S+) event=request/.exec(text);
    if (req) {
      report({ kind: 'request-delivered', slug, item: req[1], text: text.slice(0, 2000) });
      globalThis.request = req[1];
      if (text.includes('ASK-TWICE')) {
        const step = cli('super', 'ask', 'Question 1: publish part 1?', '--for', req[1], '--options', 'Yes|No', '--no-show');
        report({ kind: 'member-ask', n: 1, step });
        return 'I asked the Super Agent about part 1.';
      }
      const fail = text.includes('FAILME');
      const result = fail ? 'Could not reach the funnel data.' : ${JSON.stringify(MEMBER_ANSWER)};
      const step = cli('super', 'team', 'done', req[1], result);
      report({ kind: 'team-done', slug, item: req[1], step });
      if (fail) report({ kind: 'team-done-again', slug, item: req[1], step: cli('super', 'team', 'done', req[1], result) });
      return result;
    }
    if (/event=reply/.test(text)) {
      report({ kind: 'reply-delivered', slug, text: text.slice(0, 2000) });
      const item = globalThis.request;
      if (text.includes('GO-ANSWER-1')) {
        const step = cli('super', 'ask', 'Question 2: publish part 2?', '--for', item, '--options', 'Yes|No', '--no-show');
        report({ kind: 'member-ask', n: 2, step });
        return 'I asked about part 2.';
      }
      if (text.includes('GO-ANSWER-2')) {
        const step = cli('super', 'team', 'done', item, 'Published both parts.');
        report({ kind: 'team-done', slug, item, step });
        return 'Published both parts.';
      }
    }
    return 'ok';`,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off',
    superAgent: true,
  }, null, 2)}\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  for (const [what, r] of [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', 'acme-app', PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent', dc('agents', 'create', MEMBER, '--title', 'Scout', '--prompt', 'Reads the product funnel and names what moved.')],
    ['asker', dc('agents', 'create', ASKER, '--title', 'Clerk', '--prompt', 'Publishes parts, asking before each.')],
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

const reports = () => readNd(REPORTS);
const record = () => readJson(RECORD, { queue: [], team: [] });
const memberRecord = (slug) => readJson(join(PROJ, '_dream_context', 'state', '.super', 'members', `${slug}.json`), null);

const result = { pass: 0, fails: [] };
const ok = (label, cond, detail) => {
  if (cond) { result.pass++; console.log(`  ✓ ${label}`); }
  else { result.fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${String(detail).slice(0, 1200)}` : ''}`); }
  return !!cond;
};
const until = async (page, fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(200); }
  return false;
};

async function openChat(page, base) {
  await page.goto(`${base}/?vault=acme-app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
}
async function sayToSuper(page, text) {
  const input = page.locator('[data-testid="super-surface"]:visible [data-super-slot="centre"] .chat-cmp-input, [data-super-slot="centre"] .chat-cmp-input:visible').first();
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
}
const countOf = (kind) => reports().filter((r) => r.kind === kind).length;
/** Every `- item=… team=<job>` line main was given for one team job, across all its event turns. */
const teamLines = (job) => reports().filter((r) => r.kind === 'events')
  .flatMap((r) => r.text.split('\n').filter((l) => l.startsWith('- item=') && l.includes(` team=${job} `)).map((line) => ({ line, text: r.text })));

async function teamJob(page, word, tag, slug) {
  const before = countOf('team');
  await sayToSuper(page, word);
  await until(page, async () => countOf('team') > before, 30000);
  const step = reports().filter((r) => r.kind === 'team')[before]?.step;
  ok(tag(`${word}: super team ask goes through as a request`), step?.status === 0 && typeof step?.json?.job === 'string' && typeof step?.json?.request === 'string', step?.out);
  ok(tag(`${word}: the member's Super gets it`), await until(page, async () =>
    reports().some((r) => r.kind === 'request-delivered' && r.slug === slug && r.item === step?.json?.request), 60000),
    JSON.stringify(memberRecord(slug)?.queue ?? null).slice(0, 500));
  return { job: step?.json?.job ?? '', request: step?.json?.request ?? '' };
}

async function run(engineName, base, port) {
  const { chromium, webkit } = await import('playwright');
  const browserType = engineName === 'webkit' ? webkit : chromium;
  const browser = await browserType.launch();
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const tag = (s) => `[${engineName}] ${s}`;

  console.log(`\n── ${engineName}: hand over`);
  await openChat(page, base);
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await toMainStage(page);
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  ok(tag('handed over'), await until(page, async () => reports().some((r) => r.kind === 'handover'), 90000));
  await page.waitForTimeout(1500);

  console.log(`── ${engineName}: E1 a team job the owner asked for ends`);
  const j1 = await teamJob(page, 'GO-TEAM', tag, MEMBER);
  ok(tag('E1 the member closes it with `super team done`'), await until(page, async () => reports().some((r) => r.kind === 'team-done' && r.item === j1.request && r.step?.status === 0), 30000));
  ok(tag('E1 main gets an event for the finished job'), await until(page, async () => teamLines(j1.job).length > 0, 60000), JSON.stringify(record().queue).slice(0, 800));
  await page.waitForTimeout(8000);
  const l1 = teamLines(j1.job);
  ok(tag('E1 exactly ONE event for it, never a second'), l1.length === 1, l1.map((x) => x.line).join('\n'));
  ok(tag('E1 it is event=done from the member\'s Super, awaited=owner, naming the member'),
    /event=done/.test(l1[0]?.line ?? '') && /from=member-super/.test(l1[0]?.line ?? '') && /awaited=owner/.test(l1[0]?.line ?? '') && / member=scout /.test(l1[0]?.line ?? ''), l1[0]?.line);
  ok(tag('E1 its turn carries the member\'s result, fenced'), /<untrusted-project-output[^>]*>\s*Answer: Signups fell 4%/.test(l1[0]?.text ?? ''), l1[0]?.text);

  console.log(`── ${engineName}: E2 a job the member could not do`);
  const j2 = await teamJob(page, 'GO-TEAM-FAIL', tag, MEMBER);
  ok(tag('E2 main gets an event for it'), await until(page, async () => teamLines(j2.job).length > 0, 60000), JSON.stringify(record().queue).slice(0, 800));
  const again = reports().find((r) => r.kind === 'team-done-again' && r.item === j2.request)?.step;
  ok(tag('E2 a second `team done` on it is refused 409 already_done'), again && again.status !== 0 && /already_done/.test(again.out), again?.out);
  await page.waitForTimeout(8000);
  const l2 = teamLines(j2.job);
  ok(tag('E2 exactly ONE event, event=done, with what the member said'), l2.length === 1 && /event=done/.test(l2[0].line) && /Could not reach the funnel data/.test(l2[0].text), l2.map((x) => x.line).join('\n'));

  console.log(`── ${engineName}: E3 the record`);
  const jobs = (record().team ?? []).filter((j) => [j1.job, j2.job].includes(j.id));
  ok(tag('E3 both team jobs settled, none open'), jobs.length === 2 && jobs.every((j) => j.outcome === 'done' && !j.open), JSON.stringify(jobs));
  const items = (record().queue ?? []).filter((q) => q.team && [j1.job, j2.job].includes(q.team));
  ok(tag('E3 their team items on main\'s record, all settled'), items.length === 2 && items.every((q) => q.state === 'done'), JSON.stringify(items));

  console.log(`── ${engineName}: E4 a member asks main, twice, then finishes`);
  const j4 = await teamJob(page, 'GO-TEAM-ASK', tag, ASKER);
  const kinds = () => teamLines(j4.job).map((x) => /event=(\w+)/.exec(x.line)?.[1]);
  const asks = () => reports().filter((r) => r.kind === 'member-ask');
  ok(tag('E4 the member\'s Super asks main (`super ask --for <item>`)'), await until(page, async () => asks().length >= 1 && asks()[0].step?.status === 0, 30000), JSON.stringify(asks()).slice(0, 600));
  ok(tag('E4 main gets event=question for it'), await until(page, async () => kinds().join() === 'question', 60000), JSON.stringify(kinds()));
  ok(tag('E4 main answers it with `super team answer`'), await until(page, async () => reports().some((r) => r.kind === 'answer' && r.step?.status === 0), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'answer')).slice(0, 600));
  const replies = () => reports().filter((r) => r.kind === 'reply-delivered' && r.slug === ASKER);
  ok(tag('E4 the answer reaches the member as a [super events] reply, never a user message'), await until(page, async () => replies().length >= 1, 60000)
    && replies()[0].text.startsWith('[super events]') && /GO-ANSWER-1/.test(replies()[0].text), replies()[0]?.text?.slice(0, 500));
  ok(tag('E4 PROOF: it asks a second question about the same job'), await until(page, async () => asks().length === 2 && asks()[1].step?.status === 0, 30000), JSON.stringify(asks()).slice(0, 600));
  ok(tag('E4 main gets event=question for the second one'), await until(page, async () => kinds().join() === 'question,question', 60000), JSON.stringify(kinds()));
  const second = teamLines(j4.job)[1]?.text ?? '';
  ok(tag('E4 …with the second question\'s own words, fenced'), /<untrusted-project-output[^>]*>\s*Question: Question 2/.test(second), second);
  ok(tag('E4 main gets the one done after it'), await until(page, async () => kinds().join() === 'question,question,done', 90000), JSON.stringify(kinds()));
  await page.waitForTimeout(15000);
  const l4 = teamLines(j4.job);
  ok(tag('E4 exactly three items, in order; the done is awaited=owner with the result'), kinds().join() === 'question,question,done'
    && /awaited=owner/.test(l4[2]?.line ?? '') && /Answer: Published both parts\./.test(l4[2]?.text ?? ''), l4.map((x) => x.line).join('\n'));
  const summary = await (await fetch(`http://127.0.0.1:${port}/api/agent/sessions?summary=1`, { headers: { 'X-Dreamcontext-Vault': 'acme-app' } })).json().catch(() => ({}));
  const clerk = (summary.members ?? []).find((m) => m.slug === ASKER);
  ok(tag('E4 the owner\'s summary never showed the member asking (main-handed work)'), !!clerk && clerk.asking === false && clerk.unread === 0, JSON.stringify(clerk));
  await browser.close();
}

async function main() {
  for (const engine of ENGINES) {
    let srv = null;
    try {
      setupScratch();
      const port = await freePort();
      srv = await startDashboard({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
      await run(engine, `http://127.0.0.1:${port}`, port);
    } catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv?.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
  console.log(`\n${result.pass} passed ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${SCRATCH}`); else rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
