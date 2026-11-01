#!/usr/bin/env node
/**
 * Super looks busy when it is not, and could not be turned off (owner 2026-11-01).
 *
 *   npm run build && node scripts/verify/super-turn-off.mjs
 *
 * The built app (live chat needs it), a scratch HOME and vault, a scripted `claude` (no tokens).
 *   T1  a child the record calls `working` with no process behind it: the Super row shows no ring.
 *   T2  a child that really works: the ring counts it, and only it.
 *   T3  Turn off asks first and names the running child; Cancel changes nothing.
 *   T4  confirming turns it off: the record says so, the child's process lives, and its chat is
 *       on screen as an ordinary chat. The Super row stays, with no ring.
 *   T5  the same row turns it on again, the same session, the child back on the stage.
 * Exit 0 iff all pass. Screenshots: tmp/verify-super-turn-off/.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { openApp } from './lib/app.mjs';
import { distIndex, markAnnouncementsSeen } from './lib/measure.mjs';

const REPO = join(import.meta.dirname, '..', '..');
const app = await openApp({ suite: 'super-turn-off', build: true });
const REPORTS = join(app.home, 'reports.ndjson');
const RECORD = join(app.proj, '_dream_context', 'state', '.super-agent.json');
const CLI = distIndex(REPO);

// The first child this stand-in starts works for ever: a tool in flight, no `result`.
writeFileSync(join(app.home, '.local', 'bin', 'claude'), `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const argv = process.argv.slice(2);
if (!argv.includes('stream-json')) { process.stdout.write('{}\\n'); process.exit(0); }
const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : ''; };
const convo = at('--resume') || at('--session-id') || '';
let brief = '';
try { brief = readFileSync(at('--append-system-prompt-file'), 'utf-8'); } catch {}
const role = /(^|\\n)# Mode: Super Agent\\s*\\n/.test(brief) ? 'super' : 'child';
const report = (o) => appendFileSync(${JSON.stringify(REPORTS)}, JSON.stringify({ role, convo, pid: process.pid, ...o }) + '\\n');
report({ kind: 'spawn' });
let inited = false;
function turn(text) {
  if (!inited) { inited = true; out({ type: 'system', subtype: 'init', session_id: 'v-' + process.pid, model: 'claude-opus-5-5', cwd: process.cwd(), permissionMode: 'auto', slash_commands: [] }); }
  if (role === 'child') {
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + process.pid, name: 'Bash', input: { command: 'sleep 9999', description: 'Works for a long time' } }] } });
    return;
  }
  if (text.includes('START-CHILD')) {
    const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}, 'super', 'delegate', '--prompt', 'Keep working', '--brief', 'Busy child', '--mode', 'plan'], { env: process.env, encoding: 'utf-8', timeout: 60000 });
    report({ kind: 'delegate', status: r.status, out: (r.stdout || '') + (r.stderr || '') });
  }
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'SUPER ok' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'v-' + process.pid });
}
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const content = (o.message && o.message.content) || [];
    const blocks = typeof content === 'string' ? [content] : content.filter((b) => b.type === 'text').map((b) => b.text);
    if (blocks.length) turn(blocks[0]);
  }
});
process.stdin.on('end', () => process.exit(0));
`);
chmodSync(join(app.home, '.local', 'bin', 'claude'), 0o755);
writeFileSync(join(app.home, '.dreamcontext', 'launcher-ui.json'), JSON.stringify({ view: 'list', shell: 'new', drawerOpen: true, drawerExpanded: ['proj'], projectOrder: ['proj'], lastVault: 'proj' }));

const checks = [];
const ok = (name, pass, detail = '') => { checks.push({ name, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` — ${detail}`}`); };
const record = () => JSON.parse(readFileSync(RECORD, 'utf-8'));
const reports = () => (existsSync(REPORTS) ? readFileSync(REPORTS, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await markAnnouncementsSeen(context, app.base);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
const until = async (test, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await test()) return true; await page.waitForTimeout(150); } return false; };
const shot = (name) => page.screenshot({ path: join(app.shots, `${name}.png`) });
const row = page.locator('[data-testid="drawer-super-row"]').first();
const ring = () => row.locator('[data-testid="super-working-ring"]').count();
const ringNumber = async () => ((await ring()) ? (await row.locator('[data-testid="super-working-ring"]').innerText()).trim() : '');
const turnOff = page.locator('[data-testid="super-turn-off-btn"]');

try {
  await page.goto(`${app.base}/?vault=proj`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="ns-rail-chat"]').first().click({ timeout: 30_000 });
  await row.click({ timeout: 20_000 });
  if (!await until(() => page.getByTestId('super-centre').isVisible())) throw new Error('the stage never came up');
  await until(() => { try { return !!record().session; } catch { return false; } });
  await page.waitForTimeout(1500);

  // The owner's record: a child row `working`, nothing running it (a process that never registered).
  const dead = randomUUID();
  const r = record();
  r.children[dead] = { sessionId: dead, brief: 'Ended: never started', startedAt: Date.now() - 600_000, row: 'working' };
  r.containers.push({ id: `c-${dead.slice(0, 8)}`, kind: 'chat', ref: dead, title: 'Ended: never started', x: 0.8, y: 0.5, w: 0.2, h: 0.3 });
  writeFileSync(RECORD, JSON.stringify(r));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await until(() => page.getByTestId('super-centre').isVisible());
  await page.waitForTimeout(2500);
  await shot('1-idle');
  ok('T1 no ring on the Super row with no process behind the row', (await ring()) === 0, `ring reads "${await ringNumber()}"`);
  ok('T1 the header has a Turn off button beside New session', (await turnOff.count()) === 1 && await turnOff.isVisible());

  await page.locator('.super-centre textarea').first().fill('START-CHILD');
  await page.keyboard.press('Enter');
  ok('T2 a real child is running', await until(() => reports().some((x) => x.role === 'child' && x.kind === 'spawn'), 30_000), JSON.stringify(reports().slice(-3)));
  ok('T2 the ring counts the running child, only it', await until(async () => (await ringNumber()) === '1', 15_000), `ring reads "${await ringNumber()}"`);
  await shot('2-running-child');

  if (await turnOff.count()) {
    await turnOff.click();
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog')).first();
    await dialog.waitFor({ timeout: 5000 });
    const said = await dialog.innerText();
    await shot('3-confirm');
    ok('T3 the dialog says the running session keeps running', /1 session/.test(said) && /keep/i.test(said), said);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(500);
    ok('T3 Cancel changes nothing', record().enabled === true && await page.getByTestId('super-centre').isVisible());

    await turnOff.click();
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Turn off' }).click();
    ok('T4 the record is off', await until(() => record().enabled === false));
    await page.waitForTimeout(2500);
    await shot('4-off');
    const child = reports().find((x) => x.role === 'child' && x.kind === 'spawn');
    ok('T4 the child process lives', alive(child.pid));
    ok('T4 the stage has left', (await page.getByTestId('super-centre').count()) === 0);
    ok('T4 the child is on screen as a chat', await page.getByText('Busy child').first().isVisible().catch(() => false));
    ok('T4 the Super row is still there', await row.isVisible());
    ok('T4 no ring on a Super that is off', (await ring()) === 0);
    const before = record().session;
    await row.click();
    ok('T5 the row turns it on again', await until(() => record().enabled === true));
    ok('T5 the stage is back', await until(() => page.getByTestId('super-centre').isVisible()));
    ok('T5 the same session', record().session === before);
    await page.waitForTimeout(2000);
    await shot('5-on-again');
    ok('T5 the running child is back on the ring', await until(async () => (await ringNumber()) === '1', 8000), `ring reads "${await ringNumber()}"`);
  }
  ok('no page crash', errors.length === 0, errors.join(' | '));
} catch (err) {
  ok(`could not finish: ${err instanceof Error ? err.message : err}`, false);
  await shot('failed').catch(() => {});
}
await browser.close();
for (const x of reports()) if (x.pid && alive(x.pid)) { try { process.kill(x.pid, 'SIGTERM'); } catch { /* gone */ } }
await app.stop();
console.log(`screens: ${app.shots}`);
const failed = checks.filter((c) => !c.pass).length;
console.log(`${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
