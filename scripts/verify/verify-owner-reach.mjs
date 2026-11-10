#!/usr/bin/env node
/**
 * Live walk of uye-bildirim (plan criterion 14): the two cases of the owner's screenshots, end to
 * end through the REAL server, the real chat processes it spawns and the real hook command.
 *
 *   npm run build && node scripts/verify/verify-owner-reach.mjs
 *
 *   (1) A member's `super ask` (Rota) reaches main's queue as a `member` mirror, the bar's data
 *       (`GET /api/super/state`) carries it, `POST /api/super/owner-answer` refuses it without the
 *       owner key (403 owner_page_only), answers it with the key, the answer reaches Rota's Super,
 *       both items close, and a second answer is told it was answered already (409).
 *   (2) Rota's own session has a script call refused (a recorded classifier refusal fed through the
 *       stand-in's stream): an own `owner` item with wait kind `refusal` in Rota's record and its
 *       mirror in main. Allow once through the answer route writes a `once` grant and one server
 *       turn into Rota's live process; the stand-in "runs" the call through the real
 *       `dreamcontext hook pre-tool-use` (its own child, so the server's binding of the stand-in's
 *       pid is the hook's parent) and gets `allow`, runs the script, the job goes on, the grant is
 *       consumed and the item closes.
 *
 * Scratch only: a fake HOME (the grants store, bindings and agent settings live there), another
 * port, a scripted stand-in `claude` (lib/super-scratch.mjs, no tokens), the owner key handed to
 * the server the way the shell hands it (DREAMCONTEXT_OWNER_KEY_STDIN + one line on stdin, read by
 * `receiveOwnerKey`). Never the installed app, never the real ~/.dreamcontext. The scratch folder
 * and the server go at exit; the log and a result file are kept in tmp/verify/owner-reach/.
 * Fixture names are fictional (pattern synthetic-fixtures-for-published-artifacts).
 *
 * One PASS/FAIL line per step; exit non-zero on any FAIL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markAnnouncementsSeen } from './lib/measure.mjs';
import {
  cleanEnv, freePort, openMember, pageFetch, readJson, readNd, sayOnStage, stage, stageComposer, superStandin, until,
} from './lib/super-scratch.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH = join(tmpdir(), `dreamcontext-verify-owner-reach-${process.pid}`);
const HOME = join(SCRATCH, 'home');
const VAULT = 'acme-storefront';
const PROJ = join(SCRATCH, VAULT);
const CLI = join(REPO, 'dist', 'index.js');
const OUT = join(REPO, 'tmp', 'verify', 'owner-reach');
const REPORTS = join(SCRATCH, 'reports.ndjson');
const MAIN_RECORD = join(PROJ, '_dream_context', 'state', '.super-agent.json');
const MEMBERS_DIR = join(PROJ, '_dream_context', 'state', '.super', 'members');
const ONCE_DIR = join(HOME, '.dreamcontext', 'grants', 'once');
const OWNER_KEY = randomBytes(32).toString('hex');

/** The refused script: a plain `node <file>` in the project (no test runner, no verify path, so
 *  the heavy-step gate leaves it alone and only the grant decides). */
const SCRIPT_REL = 'tools/weekly-total.mjs';
const SCRIPT_OUT = join(PROJ, 'tools', 'weekly-total.txt');
const CMD = `node ${SCRIPT_REL}`;
const ANSWER = 'UYE-CEVAP yuzde 20';

// The stand-in bodies run inside the spawned `claude` process: `out`, `sid`, `cli`, `report` are
// its own (lib/super-scratch.mjs). The refusal frames are the shapes measured on Claude Code
// 2.1.322 (fixtures rules.jsonl, dontask.jsonl); the classifier kind itself was never reproduced
// on demand, so it carries the inferred `automode-blocked` marker (premise step 1).
const STANDIN = superStandin({
  reports: REPORTS,
  cli: CLI,
  main: `
    if (text.startsWith('[super handover]')) { report({ kind: 'handover' }); return 'arranged'; }
    if (text.startsWith('[super')) { report({ kind: 'main-event', text: text.slice(0, 3000) }); return 'noted'; }
    return 'ok';`,
  member: `
    const CMD = ${JSON.stringify(CMD)};
    if (text.includes(${JSON.stringify(ANSWER)})) { report({ kind: 'answer-reached', slug, text: text.slice(0, 2000) }); return 'Tamam, yuzde 20.'; }
    if (text.includes('GO-ASK')) {
      const step = cli('super', 'ask', 'Yillik planda indirim yuzde kac olsun?', '--options', '%10|%20', '--no-show');
      report({ kind: 'ask', slug, step });
      return 'Sana bir soru sordum.';
    }
    if (text.includes('GO-REFUSE')) {
      const tu = 'toolu_verify_refused_1';
      out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: 'msg_verify_refused', role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Bash', input: { command: CMD, description: 'Write the weekly total' } }] } });
      out({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: tu, decision_reason_type: 'classifier', message: 'Blocked by the auto mode classifier: it runs a script nobody asked for.', session_id: sid });
      out({ type: 'user', parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: 'Permission to use Bash has been denied.', is_error: true }] },
        tool_result_meta: [{ id: tu, non_execution_kind: 'automode-blocked', permission_decision: { decision: 'reject', source: 'config', reason_type: 'classifier' } }] });
      report({ kind: 'refused', slug, sid });
      return 'Haftalik toplam betigi reddedildi; sahibine kaldi.';
    }
    // The server's one turn after Allow once: it names the call; run it through the real hook.
    if (/allowed/i.test(text) && text.includes(CMD)) {
      let onceFiles = [];
      try { onceFiles = (await import('node:fs')).readdirSync(${JSON.stringify(ONCE_DIR)}); } catch {}
      report({ kind: 'allowed-turn', slug, onceFiles, text: text.slice(0, 1200) });
      const hookIn = { session_id: sid, hook_event_name: 'PreToolUse', cwd: process.cwd(), permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: CMD, description: 'Write the weekly total' } };
      const h = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'hook', 'pre-tool-use'], { input: JSON.stringify(hookIn), cwd: process.cwd(), env: process.env, encoding: 'utf-8', timeout: 30000 });
      let decision = null; let reason = '';
      try { const o = JSON.parse(h.stdout).hookSpecificOutput; decision = o.permissionDecision; reason = o.permissionDecisionReason || ''; } catch {}
      report({ kind: 'hook', slug, decision, reason: reason.slice(0, 400), status: h.status, stderr: (h.stderr || '').slice(0, 400) });
      if (decision !== 'allow') return 'Hook izin vermedi.';
      const tu = 'toolu_verify_run_1';
      out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: 'msg_verify_run', role: 'assistant', content: [{ type: 'tool_use', id: tu, name: 'Bash', input: { command: CMD, description: 'Write the weekly total' } }] } });
      const r = spawnSync('/bin/sh', ['-c', CMD], { cwd: process.cwd(), encoding: 'utf-8', timeout: 30000 });
      out({ type: 'user', parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu, content: (r.stdout || '').slice(0, 400), is_error: r.status !== 0 }] },
        tool_result_meta: [{ id: tu, permission_decision: { decision: 'accept', source: 'hook', reason_type: 'hook' } }] });
      report({ kind: 'ran', slug, status: r.status, stdout: (r.stdout || '').slice(0, 200) });
      return 'Haftalik toplam yazildi, devam ediyorum.';
    }
    return 'ok';`,
  child: `return 'ok';`,
});

const env = () => cleanEnv(HOME);
const dc = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: PROJ, env: env(), encoding: 'utf-8' });
const reports = () => readNd(REPORTS);
const mainRecord = () => readJson(MAIN_RECORD, null);
const memberRecord = (slug) => readJson(join(MEMBERS_DIR, `${slug}.json`), null);
const onceFiles = () => { try { return readdirSync(ONCE_DIR).filter((f) => !f.startsWith('.')); } catch { return []; } };

const results = [];
function step(label, cond, detail) {
  results.push({ label, pass: !!cond, ...(cond ? {} : { detail: detail === undefined ? undefined : String(detail).slice(0, 900) }) });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${!cond && detail !== undefined ? `\n      ${String(detail).slice(0, 900)}` : ''}`);
  return !!cond;
}

function setupScratch() {
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const d of [join(HOME, '.dreamcontext'), join(HOME, '.local', 'bin'), join(PROJ, '_dream_context', 'state'), join(PROJ, 'tools'), OUT]) mkdirSync(d, { recursive: true });
  writeFileSync(join(HOME, '.dreamcontext', 'agent-ui.json'), `${JSON.stringify({
    enabled: true, restoreTabs: true, defaultAgent: 'claude', autoTitle: false, hotkey: 'Ctrl+A', renderer: 'dom',
    chatView: true, screenMigrated: true, chatPermissionMode: 'auto', chatDefaultModel: '', chatDefaultEffort: '', lightMode: 'off', superAgent: true,
  }, null, 2)}\n`);
  writeFileSync(join(PROJ, SCRIPT_REL), `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./weekly-total.txt', import.meta.url), 'total 42\\n');\nconsole.log('total 42');\n`);
  spawnSync('git', ['-C', PROJ, 'init', '-q'], { encoding: 'utf-8' });
  const bin = join(HOME, '.local', 'bin', 'claude');
  writeFileSync(bin, STANDIN);
  chmodSync(bin, 0o755);
  const steps = [
    ['vaults add', spawnSync(process.execPath, [CLI, 'vaults', 'add', VAULT, PROJ], { env: env(), encoding: 'utf-8' })],
    ['agent rota', dc('agents', 'create', 'rota', '--title', 'Rota', '--prompt', 'Fiyat ve paket kararlarini verir; haftalik toplami yazar.')],
  ];
  for (const [what, r] of steps) if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
}

/** The real dashboard server, given the owner key the way the desktop shell gives it. */
async function startServer(port) {
  const PATH = [join(HOME, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', dirname(process.execPath)].join(':');
  const srv = spawn(process.execPath, [CLI, 'dashboard', '--no-open', '-p', String(port)], {
    cwd: PROJ, env: { ...env(), PATH, DREAMCONTEXT_CLI: CLI, DREAMCONTEXT_OWNER_KEY_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  srv.stdin.end(`${OWNER_KEY}\n`);
  const log = createWriteStream(join(OUT, 'server.log'));
  srv.stdout.pipe(log); srv.stderr.pipe(log);
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return srv; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  srv.kill();
  throw new Error('dashboard server did not come up');
}

async function handOver(page, base) {
  await page.goto(`${base}/?vault=${VAULT}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    const nav = page.locator('aside a, aside button, nav a, nav button').filter({ hasText: /^\s*Chat\s*\d*\s*$/ }).first();
    if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  if (!(await page.locator('.chat-cmp-input:visible').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  await until(page, async () => (await page.locator('.chat-cmp-input:visible').count()) > 0);
  const input = page.locator('.chat-cmp-input:visible').first();
  await input.click(); await input.fill('hello'); await page.keyboard.press('Enter');
  await until(page, async () => reports().some((r) => r.kind === 'spawn' && r.role === 'child'), 20000);
  await page.locator('aside, nav').getByText('Super Agent', { exact: true }).first().click();
  await page.waitForTimeout(800);
  if (await page.locator('[data-testid="super-handover-btn"]:visible').count()) await page.locator('[data-testid="super-handover-btn"]:visible').first().click();
  return until(page, async () => reports().some((r) => r.kind === 'handover'), 90000);
}

const openItem = (rec, pred) => (rec?.queue ?? []).find((q) => q.state !== 'done' && pred(q));
const itemById = (rec, id) => (rec?.queue ?? []).find((q) => q.id === id);
const mirrorOf = (memberItemId) => openItem(mainRecord(), (q) => q.kind === 'member' && q.member === 'rota' && q.answers === memberItemId);
const answer = (page, body) => pageFetch(page, VAULT, 'POST', '/super/owner-answer', body);

async function caseAsk(page) {
  console.log('\n── case 1: a member\'s super ask reaches the owner and his answer reaches the member');
  await openMember(page, 'rota');
  step('Rota\'s stage opens', await until(page, async () => (await stage(page, 'm:rota').count()) > 0, 20000));
  await until(page, async () => (await stageComposer(page, 'm:rota')).isVisible(), 20000);
  await sayOnStage(page, 'm:rota', 'GO-ASK yillik plan');
  step('Rota\'s Super runs `super ask` (exit 0)', await until(page, async () =>
    reports().some((r) => r.kind === 'ask' && r.slug === 'rota' && r.step?.status === 0), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'ask')).slice(0, 600));
  const ask = () => openItem(memberRecord('rota'), (q) => q.kind === 'ask');
  step('an open `ask` item in Rota\'s record', await until(page, async () => !!ask(), 15000), JSON.stringify(memberRecord('rota')?.queue ?? null).slice(0, 600));
  const askId = ask()?.id;
  step('a `member` mirror of it in main\'s queue (of: ask)', await until(page, async () => mirrorOf(askId)?.of === 'ask', 15000),
    JSON.stringify(mainRecord()?.queue ?? null).slice(0, 600));
  const mirrorId = mirrorOf(askId)?.id;
  const st = await pageFetch(page, VAULT, 'GET', '/super/state');
  step('the bar\'s data (GET /api/super/state) carries the mirror', st.status === 200 && (st.json?.queue ?? []).some((q) => q.id === mirrorId && q.state !== 'done'),
    JSON.stringify({ status: st.status, queue: st.json?.queue?.map((q) => [q.id, q.kind, q.state]) }).slice(0, 600));

  const body = { record: 'main', item: mirrorId, answer: { kind: 'ask', text: ANSWER }, via: 'bar' };
  const refused = await answer(page, body);
  step('the answer route without the owner key: 403 owner_page_only', refused.status === 403 && refused.json?.error === 'owner_page_only', JSON.stringify(refused));
  step('…and nothing reached Rota', !reports().some((r) => r.kind === 'answer-reached'));
  // Chromium has no shell IPC here: the page's request gets the key the shell would give it.
  await page.route('**/api/super/owner-answer', (r) => r.continue({ headers: { ...r.request().headers(), 'x-dreamcontext-owner-key': OWNER_KEY } }));
  const answered = await answer(page, body);
  step('with the owner key: 200 answered', answered.status === 200 && answered.json?.ok === true && answered.json?.outcome === 'answered', JSON.stringify(answered));
  step('his words reach Rota\'s Super', await until(page, async () => reports().some((r) => r.kind === 'answer-reached' && r.slug === 'rota'), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'stdin-user' && r.slug === 'rota').slice(-3)));
  step('Rota\'s ask item closes', await until(page, async () => itemById(memberRecord('rota'), askId)?.state === 'done', 20000), JSON.stringify(itemById(memberRecord('rota'), askId)));
  step('main\'s mirror closes', await until(page, async () => itemById(mainRecord(), mirrorId)?.state === 'done', 20000), JSON.stringify(itemById(mainRecord(), mirrorId)));
  const again = await answer(page, body);
  step('a second answer: 409 already_answered', again.status === 409 && again.json?.error === 'already_answered', JSON.stringify(again));
}

async function caseRefusal(page) {
  console.log('\n── case 2: a refused script, Allow once, the script runs and the job goes on');
  const before = onceFiles().length;
  await sayOnStage(page, 'm:rota', 'GO-REFUSE haftalik toplam');
  step('Rota\'s stream carries the refused call', await until(page, async () => reports().some((r) => r.kind === 'refused' && r.slug === 'rota'), 45000));
  const own = () => openItem(memberRecord('rota'), (q) => q.kind === 'owner' && q.wait?.kind === 'refusal');
  step('an own `owner` item with wait kind refusal in Rota\'s record', await until(page, async () => !!own(), 20000),
    JSON.stringify(memberRecord('rota')?.queue ?? null).slice(0, 800));
  const item = own();
  step('…it is Rota\'s own (own: true, its session)', item?.own === true && item?.sessionId === memberRecord('rota')?.session, JSON.stringify(item));
  step('…it carries the tool and the whole command', item?.wait?.refusal?.tool === 'Bash' && String(item?.wait?.refusal?.input ?? '').includes(CMD) && item?.wait?.refusal?.whole === true,
    JSON.stringify(item?.wait));
  step('a `member` mirror in main\'s queue (of: owner)', await until(page, async () => mirrorOf(item?.id)?.of === 'owner', 15000), JSON.stringify(mainRecord()?.queue ?? null).slice(0, 800));
  const mirror = mirrorOf(item?.id);
  step('…offering Allow once', !mirror?.offer || (Array.isArray(mirror.offer.sizes) && mirror.offer.sizes.includes('once')), JSON.stringify(mirror?.offer));
  step('no once grant before his tap', onceFiles().length === before, JSON.stringify(onceFiles()));

  const res = await answer(page, { record: 'main', item: mirror?.id, answer: { kind: 'refusal', action: 'allow', size: 'once' }, via: 'bar' });
  step('Allow once through the answer route: 200 allowed (the process is live)', res.status === 200 && res.json?.ok === true && res.json?.outcome === 'allowed', JSON.stringify(res));
  step('one server turn reaches Rota\'s live process, naming the call', await until(page, async () => reports().some((r) => r.kind === 'allowed-turn' && r.slug === 'rota'), 45000),
    JSON.stringify(reports().filter((r) => r.kind === 'stdin-user' && r.slug === 'rota').slice(-3)));
  const turn = reports().find((r) => r.kind === 'allowed-turn');
  step('…the once grant was written before it ran', (turn?.onceFiles?.length ?? 0) > before, JSON.stringify(turn?.onceFiles));
  step('the real hook answers `allow` for the bound process', await until(page, async () => reports().some((r) => r.kind === 'hook' && r.decision === 'allow'), 30000),
    JSON.stringify(reports().filter((r) => r.kind === 'hook')));
  step('the script ran and the job went on (exit 0, its output on disk)', await until(page, async () => reports().some((r) => r.kind === 'ran' && r.status === 0), 30000) && existsSync(SCRIPT_OUT),
    JSON.stringify(reports().filter((r) => r.kind === 'ran')));
  step('the grant is consumed (none left)', await until(page, async () => onceFiles().length === before, 20000), JSON.stringify(onceFiles()));
  step('the refusal item closes', await until(page, async () => itemById(memberRecord('rota'), item?.id)?.state === 'done', 20000), JSON.stringify(itemById(memberRecord('rota'), item?.id)));
  step('main\'s mirror closes', await until(page, async () => itemById(mainRecord(), mirror?.id)?.state === 'done', 20000), JSON.stringify(itemById(mainRecord(), mirror?.id)));
  // An agent's own `claude` under the verify process (not under the bound pid) naming Rota's
  // conversation id with a forged member marker: no binding verifies it, so nothing is allowed.
  // The grant is spent by now, so this is a smoke row; the identity table (criterion 4) is the proof.
  const forged = spawnSync(process.execPath, [CLI, 'hook', 'pre-tool-use'], {
    input: JSON.stringify({ session_id: memberRecord('rota')?.session, hook_event_name: 'PreToolUse', cwd: PROJ, permission_mode: 'auto', tool_name: 'Bash', tool_input: { command: CMD } }),
    cwd: PROJ, env: { ...env(), DREAMCONTEXT_MEMBER_SUPER: 'rota' }, encoding: 'utf-8', timeout: 30000,
  });
  step('a hook call from outside the bound process, forged environment: no allow', !/"permissionDecision"\s*:\s*"allow"/.test(forged.stdout ?? ''), forged.stdout);
}

async function main() {
  if (!existsSync(join(REPO, 'dist', 'dashboard', 'index.html'))) throw new Error('dist/dashboard missing: run npm run build first');
  setupScratch();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = null;
  let browser = null;
  const stop = () => { try { srv?.kill('SIGTERM'); } catch { /* gone */ } };
  process.once('exit', () => { stop(); rmSync(SCRATCH, { recursive: true, force: true }); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(130));
  try {
    srv = await startServer(port);
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await markAnnouncementsSeen(context, base);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
    console.log('── setup: hand-over');
    if (!step('main Super handed over', await handOver(page, base))) return;
    await caseAsk(page);
    await caseRefusal(page);
    step('no page crash', errors.length === 0, errors.join('\n'));
  } finally {
    await browser?.close().catch(() => {});
    stop();
    writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), results, reports: reports() }, null, 2)}\n`);
  }
}

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length} passed ${failed.length} failed${failed.length ? `:\n  - ${failed.map((f) => f.label).join('\n  - ')}` : ''}`);
  console.log(`output kept in ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}).catch((err) => {
  console.log(`FAIL the walk stopped: ${err?.stack ?? err}`);
  process.exit(1);
});
