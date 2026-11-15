#!/usr/bin/env node
/**
 * A conditional routine is approved where its script is read (kosullu-otomasyon, criterion 6).
 *
 *   npm run build && dreamcontext builder heavy -- node scripts/verify/kosullu-onay.mjs
 *
 * The real server (dist/), a real browser, the real CLI; `claude` is a scripted stand-in (no
 * tokens) whose reply carries the routine's `automation` card. The project has a member,
 * Northwind orders, and its routine `nw-orders` set up from inside an agent session
 * (CLAUDECODE=1), so it waits for the owner. Checks, at 390 and 1440 px:
 *   C1  the Sleepy chat card shows the whole script, which answer wakes the agent and the
 *       plain-shell sentence, with Approve;
 *   C2  the AI Team approve row draws the same block above the review;
 *   C3  Approve on the chat card stamps it: the routine is approved on this Mac;
 *   no console errors, no failed requests (the harness collects them).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';
import { cleanEnv } from './lib/super-scratch.mjs';

const SCRIPT = '# new orders since the last check?\ntest -s orders/new.csv && cat orders/new.csv';
const SLUG = 'nw-orders';
const app = await openApp({ suite: 'kosullu-onay', build: true });
const CLI = join(process.cwd(), 'dist', 'index.js');
const dc = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: app.proj, env: cleanEnv(app.home, extra), encoding: 'utf-8' });

for (const [what, r] of [
  ['member', dc(['agents', 'create', 'northwind', '--title', 'Northwind orders', '--prompt', 'Summarises the new bakery orders.'])],
  ['routine', dc(['automations', 'create', SLUG, '--title', 'New orders', '--agent', 'northwind', '--job', 'Summarise the new orders.', '--days', 'daily', '--at', '09:00', '--condition', SCRIPT], { CLAUDECODE: '1' })],
]) {
  if (r.status !== 0) { app.findings.push(`setup ${what} failed: ${(r.stderr || r.stdout).slice(0, 300)}`); process.exit(await app.finish()); }
}

const F = '\\u0060\\u0060\\u0060';
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-kosullu', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    const card = '${F}dream-view\\n' + JSON.stringify({ type: 'automation', slug: '${SLUG}' }) + '\\n${F}';
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'The routine is set up; it checks first.\\n\\n' + card }] }, parent_tool_use_id: null, session_id: 'verify-kosullu' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-kosullu' });
  }
});
`;
const bin = join(app.home, '.local', 'bin', 'claude');
writeFileSync(bin, STANDIN);
chmodSync(bin, 0o755);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const approvedHere = () => /approval: approved/.test(dc(['automations', 'show', SLUG]).stdout);

const checkBlock = async (where, block) => {
  if (!(await block.count())) { app.findings.push(`${where}: no condition block`); return; }
  const text = await block.innerText();
  if (!text.includes('test -s orders/new.csv && cat orders/new.csv') || !text.includes('# new orders since the last check?')) app.findings.push(`${where}: the script is not whole: ${text.slice(0, 200)}`);
  if (!/plain command/.test(text)) app.findings.push(`${where}: no plain-shell sentence`);
  if (!/wakes only when this script ends with 0/.test(text)) app.findings.push(`${where}: no wake sentence`);
  const pre = block.locator('pre').first();
  const clipped = await pre.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  if (clipped) app.findings.push(`${where}: the script box is clipped`);
};

// C2: the AI Team row, before anything is approved.
await app.look('/?vault=proj', async (page, w) => {
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  if (w.name === 'phone') {
    // The phone's side menu opens from the top bar's leftmost button.
    await page.mouse.click(30, 20);
    await page.waitForTimeout(600);
  }
  // The project's Team in the side menu opens to its members; the member opens its stage.
  const team = page.getByText(/^Team$/).first();
  if (!(await until(async () => (await team.count()) > 0 && await team.isVisible(), 10_000))) { app.findings.push(`${w.name}: no Team in the side menu`); return; }
  await team.click();
  await page.waitForTimeout(800);
  const member = page.getByText('Northwind orders', { exact: false }).first();
  if (!(await until(async () => (await member.count()) > 0 && await member.isVisible(), 10_000))) { app.findings.push(`${w.name}: the member is not listed under Team`); return; }
  await member.click();
  await page.waitForTimeout(1500);
  // A routine's approve row lives in the member's Profile (the AI Team member window).
  const profile = page.locator('[data-testid="super-member-profile"]:visible').first();
  if (await profile.count()) { await profile.click(); await page.waitForTimeout(1200); }
  const row = page.locator(`[data-approval-item="routine:${SLUG}"]`);
  if (!(await until(async () => (await row.count()) > 0, 10_000))) { app.findings.push(`${w.name}: no AI Team approve row for ${SLUG}`); return; }
  await row.getByRole('button', { name: /Review/ }).click();
  await until(async () => (await row.locator('[data-condition-script]').count()) > 0, 10_000);
  await checkBlock(`ai-team@${w.name}`, row.locator('[data-condition-script]'));
  const order = await row.evaluate((el) => {
    const b = el.querySelector('[data-condition-script]'); const p = el.querySelector('.aiteam-approval-pre');
    return !!b && !!p && (b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  if (!order) app.findings.push(`ai-team@${w.name}: the script is not above the review`);
  await row.locator('[data-condition-script]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
}, { name: 'aiteam' });

// C1 + C3: the chat card, then its Approve (on the desktop width, the second pass).
await app.look('/?vault=proj', async (page, w) => {
  const vis = (sel) => page.locator(`${sel}:visible`);
  await page.waitForTimeout(2500);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
  if (!(await page.locator('.agent-surface.expanded').count())) {
    for (const sel of ['.agent-fab', '.agent-overlay-head', '.agent-surface']) {
      const el = page.locator(sel).first();
      if (await el.count()) { await el.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500); }
      if (await page.locator('.agent-surface.expanded').count()) break;
    }
  }
  if (!(await vis('.chat-cmp-input').count())) await page.getByRole('button', { name: /Start chat/ }).click().catch(() => {});
  if (!(await until(async () => (await vis('.chat-cmp-input').count()) > 0, 20_000))) { app.findings.push(`${w.name}: no composer`); return; }
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('Set up the new orders check');
  await page.keyboard.press('Enter');
  const card = page.locator('.chat-autocard[data-view-kind="automation"]').last();
  if (!(await until(async () => (await card.locator('[data-condition-script]').count()) > 0, 20_000))) { app.findings.push(`chat@${w.name}: the card has no condition block`); return; }
  await checkBlock(`chat@${w.name}`, card.locator('[data-condition-script]'));
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  if (w.name === 'desktop') {
    await page.screenshot({ path: join(app.shots, 'kosullu-chat-card-before-approve.png') });
    const approve = card.locator('.chat-btn.primary');
    if (!(await approve.count())) { app.findings.push('chat@desktop: no Approve'); return; }
    await approve.click();
    if (!(await until(() => approvedHere(), 15_000))) app.findings.push(`chat@desktop: Approve did not stamp it: ${dc(['automations', 'show', SLUG]).stdout.slice(0, 300)}`);
    await until(async () => /approved/i.test(await card.innerText()), 10_000);
    await page.waitForTimeout(400);
  }
}, { name: 'chat' });

console.log(`approved here after the chat Approve: ${approvedHere()}`);
process.exit(await app.finish());
