#!/usr/bin/env node
/**
 * A skipped card reaches the agent, in the real app (card-feedback.ts).
 *
 *   npm run build && dreamcontext builder heavy -- node scripts/verify/chat-card-feedback.mjs
 *
 * The real server (dist/), the real `/ws/agent-chat`, a real browser; `claude` is a scripted
 * stand-in (no tokens) that does what Gemini and Codex did on 3 Nov 2026: says "I dropped the
 * terminal card above" and writes the run card with a two-line command. Checks:
 *   1. the chat shows the owner the skip note, and no run card;
 *   2. the server writes the agent ONE hidden turn naming the skip and the one-line rule, which
 *      never shows as an owner bubble;
 *   3. the agent's answer to it (a one-line card) is drawn with its ▶ Run;
 *   4. one hidden turn per owner turn, never more.
 * Screenshots at 390 and 1440 px; console errors and failed requests are findings.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'chat-card-feedback', build: true });
const LOG = join(app.home, 'received.jsonl');
const STANDIN = `#!${process.execPath}
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const F = '\\u0060\\u0060\\u0060';
let buf = '';
let n = 0;
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    const text = ((o.message && o.message.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(text) + '\\n');
    n++;
    out({ type: 'system', subtype: 'init', session_id: 'verify-feedback', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    const fed = text.startsWith('<dreamcontext-card-feedback>');
    const two = F + 'dream-view\\n' + JSON.stringify({ type: 'run', id: 'ls-pwd', command: 'ls\\npwd' }) + '\\n' + F;
    const one = F + 'dream-view\\n' + JSON.stringify({ type: 'run', id: 'ls-pwd', command: 'ls && pwd', why: 'it lists the files, then the folder' }) + '\\n' + F;
    const reply = !fed ? 'I dropped the terminal card above, click the play button.\\n\\n' + two
      : 'That card was not drawn: it had two lines. Here it is on one line.\\n\\n' + one;
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }] }, parent_tool_use_id: null, session_id: 'verify-feedback' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-feedback' });
  }
});
`;
const bin = join(app.home, '.local', 'bin', 'claude');
writeFileSync(bin, STANDIN);
chmodSync(bin, 0o755);
const received = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };

let sent = false;
await app.look('/?vault=proj', async (page, w) => {
  const vis = (sel) => page.locator(`${sel}:visible`);
  await page.waitForTimeout(3000);
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
  const before = received().length;
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('Open a terminal card for ls then pwd');
  await page.keyboard.press('Enter');
  sent = true;
  const got = await until(() => received().length >= before + 2, 20_000);
  if (!got) { app.findings.push(`${w.name}: the agent never got a second (feedback) turn`); return; }
  const fb = received()[before + 1];
  if (!fb.startsWith('<dreamcontext-card-feedback>') || !/spans several lines/.test(fb) || !/ONE line/.test(fb)) app.findings.push(`${w.name}: the feedback turn says the wrong thing: ${fb.slice(0, 200)}`);
  await until(async () => (await page.getByText('Here it is on one line', { exact: false }).count()) > 0, 15_000);
  await page.waitForTimeout(800);
  const pane = page.locator('.agent-surface');
  if (!(await pane.getByText('A run card was skipped', { exact: false }).count())) app.findings.push(`${w.name}: the owner was not shown the skip note`);
  if (await pane.getByText('dreamcontext-card-feedback', { exact: false }).count()) app.findings.push(`${w.name}: the hidden turn shows in the chat`);
  if (!(await pane.getByText('ls && pwd', { exact: true }).count())) app.findings.push(`${w.name}: the corrected one-line run card is not drawn`);
  await pane.getByText('ls && pwd', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
}, { name: 'feedback' });

// No second feedback for an answer to feedback, even when it repeats the mistake.
const all = received();
const feedbacks = all.filter((t) => t.startsWith('<dreamcontext-card-feedback>')).length;
const owner = all.filter((t) => !t.startsWith('<')).length;
if (!sent || feedbacks !== owner) app.findings.push(`expected one feedback per owner turn: ${owner} owner turns, ${feedbacks} feedback turns`);
console.log(`agent received ${all.length} turns: ${owner} from the owner, ${feedbacks} hidden feedback`);
process.exit(await app.finish());
