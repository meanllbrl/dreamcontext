#!/usr/bin/env node
/**
 * An AI Team member writes to the project's Super Agent on its own (`super team tell`, owner
 * 2026-11-19: "git Super'e haber ver dediğimde ben yazamıyorum cevabını duyuyorum").
 *
 *   npm run build && node scripts/verify/super-member-tell.mjs            (ENGINES=chromium)
 *
 * The real dashboard server (scratch HOME, DREAMCONTEXT_DESKTOP=1), the real dashboard and chat
 * WebSockets, a real AI Team member (`dreamcontext agents create`) and the real CLI run from INSIDE
 * each Super's own process. `claude` is a scripted stand-in (lib/super-scratch.mjs, no tokens
 * spent): it plays main Super (logging every `[super events]` turn) and the member's own Super.
 *
 *   T1  main's own `super team tell` is refused 403 member_only.
 *   T2  the member's Super, in the turn of a job main gave it, runs `super team tell --for <item>`
 *       and a plain `super team tell` (no job named): both exit 0.
 *   T3  main gets each as ONE `[super events]` item, event=member-note member=scout (for=<item> on
 *       the first), the member's words inside the untrusted fence, with the member-note rule.
 *   T4  neither note is a question or card on the owner's bar.
 *
 * REPORT_OUT=<file>: the main Super's event turns that carried the notes are written there.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, freePort, readJson, readNd, startServer as startDashboard, superStandin, toMainStage } from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-super-member-tell-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const PROJ = join(SCRATCH, 'acme-app');
const CLI = join(REPO, 'dist', 'index.js');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBER = 'scout';
const NOTE_FOR = 'Heads-up on your job: the pricing step lost 4% on Tuesday.';
const NOTE_PLAIN = 'The funnel export moved to a new folder; tell me if you need it.';
const ENGINES = (process.env.ENGINES || 'chromium').split(',').map((s) => s.trim()).filter(Boolean);

const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) {
      report({ kind: 'handover' });
      report({ kind: 'main-tell', step: cli('super', 'team', 'tell', 'main tries to tell itself') });
      return 'arranged';
    }
    if (text.startsWith('[super events]')) { report({ kind: 'events', text }); return 'noted'; }
    if (text.startsWith('[super')) return 'noted';
    if (text.includes('GO-TEAM')) {
      const step = cli('super', 'team', 'ask', ${JSON.stringify(MEMBER)}, 'Look at this week\\'s signup funnel.', '--brief', 'Funnel check');
      report({ kind: 'team', step });
      return 'asked the team';
    }
    return 'ok';`,
  member: `
    const req = /- item=(\\S+) event=request/.exec(text);
    if (req) {
      report({ kind: 'request-delivered', slug, item: req[1] });
      report({ kind: 'tell-for', item: req[1], step: cli('super', 'team', 'tell', ${JSON.stringify(NOTE_FOR)}, '--for', req[1]) });
      report({ kind: 'tell-plain', step: cli('super', 'team', 'tell', ${JSON.stringify(NOTE_PLAIN)}) });
      return 'I told the Super Agent.';
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
  ]) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

const reports = () => readNd(REPORTS);
const record = () => readJson(RECORD, { queue: [], team: [] });
const one = (kind) => reports().find((r) => r.kind === kind);

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
/** Every main event turn line about a member-note, with its whole turn. */
const noteLines = () => reports().filter((r) => r.kind === 'events')
  .flatMap((r) => r.text.split('\n').filter((l) => l.startsWith('- item=') && l.includes(' event=member-note ')).map((line) => ({ line, text: r.text })));

async function run(engineName, base) {
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

  console.log(`── ${engineName}: T1 main cannot tell itself`);
  ok(tag('T1 main\'s `super team tell` is refused 403 member_only'), await until(page, async () => !!one('main-tell'), 20000)
    && one('main-tell').step.status !== 0 && /member_only/.test(one('main-tell').step.out), JSON.stringify(one('main-tell')));
  await page.waitForTimeout(1500);

  console.log(`── ${engineName}: T2 the member's Super tells main`);
  await sayToSuper(page, 'GO-TEAM');
  ok(tag('T2 the member\'s Super gets main\'s job'), await until(page, async () => !!one('request-delivered'), 60000));
  ok(tag('T2 `super team tell --for <item>` from the member exits 0'), await until(page, async () => one('tell-for')?.step?.status === 0, 30000), JSON.stringify(one('tell-for')));
  ok(tag('T2 a plain `super team tell` from the member exits 0'), await until(page, async () => one('tell-plain')?.step?.status === 0, 30000), JSON.stringify(one('tell-plain')));

  console.log(`── ${engineName}: T3 main hears each once`);
  ok(tag('T3 main gets both member-note events'), await until(page, async () => noteLines().length >= 2, 60000), JSON.stringify(record().queue).slice(0, 900));
  await page.waitForTimeout(6000);
  const lines = noteLines();
  const forItem = one('tell-for')?.item ?? '';
  const withFor = lines.filter((x) => x.line.includes(` for=${forItem}`));
  const plain = lines.filter((x) => !/ for=/.test(x.line));
  ok(tag('T3 exactly two, never repeated'), lines.length === 2, lines.map((x) => x.line).join('\n'));
  ok(tag('T3 the --for one names the member and the job'), withFor.length === 1 && / member=scout /.test(`${withFor[0].line} `), withFor.map((x) => x.line).join('\n'));
  ok(tag('T3 the plain one names the member and no job'), plain.length === 1 && / member=scout( |$)/.test(plain[0].line), plain.map((x) => x.line).join('\n'));
  const fenced = (t, words) => new RegExp(`<untrusted-project-output[^>]*>\\s*It tells you: ${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
  ok(tag('T3 the member\'s words are fenced as its data'), fenced(withFor[0]?.text ?? '', NOTE_FOR) && fenced(plain[0]?.text ?? '', NOTE_PLAIN), (withFor[0]?.text ?? '').slice(0, 1500));
  ok(tag('T3 the turn carries the member-note rule'), lines.every((x) => x.text.includes('event=member-note is an AI Team member telling YOU something on its own')));

  console.log(`── ${engineName}: T4 nothing on the owner's bar`);
  const notes = (record().queue ?? []).filter((q) => q.kind === 'member-note');
  ok(tag('T4 both notes are on main\'s record, told, never escalated to him'), notes.length === 2 && notes.every((q) => q.state !== 'escalated' && q.state !== 'pending'), JSON.stringify(notes));
  if (process.env.REPORT_OUT) {
    const turns = [...new Set(lines.map((x) => x.text))];
    writeFileSync(process.env.REPORT_OUT, `# Main Super's event turns carrying member notes (${engineName}, ${new Date().toISOString()})\n\n${turns.map((t) => `\`\`\`\n${t}\n\`\`\``).join('\n\n')}\n\n## Member CLI calls\n\n\`\`\`json\n${JSON.stringify({ mainTell: one('main-tell')?.step, tellFor: one('tell-for')?.step, tellPlain: one('tell-plain')?.step }, null, 2)}\n\`\`\`\n`);
  }
  await browser.close();
}

async function main() {
  for (const engine of ENGINES) {
    let srv = null;
    try {
      setupScratch();
      const port = await freePort();
      srv = await startDashboard({ cli: CLI, cwd: PROJ, home: HOME, port, logFile: join(SCRATCH, 'server.log') });
      await run(engine, `http://127.0.0.1:${port}`);
    } catch (e) { ok(`[${engine}] ran to the end`, false, e?.stack ?? e); }
    finally { srv?.kill(); spawnSync('pkill', ['-f', SCRATCH]); }
  }
  console.log(`\n${result.pass} passed ${result.fails.length} failed${result.fails.length ? `:\n  - ${result.fails.join('\n  - ')}` : ''}`);
  if (process.env.KEEP_SCRATCH) console.log(`scratch kept: ${SCRATCH}`); else rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(result.fails.length ? 1 : 0);
}
main();
