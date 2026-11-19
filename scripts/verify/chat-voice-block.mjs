#!/usr/bin/env node
/**
 * A `dream-voice` block is a voice-message card in the Mac chat, in the real app.
 *
 *   npm run build && dreamcontext builder heavy -- node scripts/verify/chat-voice-block.mjs
 *
 * `claude` is a scripted stand-in (no tokens) that answers with two `dream-voice` blocks. Checks:
 * two cards are drawn (never a code block), none scrolls sideways, and play reaches
 * POST /api/agent/voice/summary exactly once (the route is stubbed: no voice key in the scratch HOME).
 * Env: VOICE_SHOTS=<dir> VOICE_TAG=before|after write light and dark screenshots there.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp } from './lib/app.mjs';


const app = await openApp({ suite: 'chat-voice-block', build: true });
const STANDIN = `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const F = '\\u0060\\u0060\\u0060';
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'control_request') { out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response: {} } }); continue; }
    if (o.type !== 'user') continue;
    out({ type: 'system', subtype: 'init', session_id: 'verify-voice', model: 'claude-opus-5', cwd: process.cwd(), permissionMode: 'bypassPermissions', slash_commands: [] });
    const long = 'Bugün üç iş bitti: sesli blok kartı, sunucu rotası ve testler. Yarın tarayıcıda deneyip ekran görüntülerini göndereceğim. Kartta bekleyen bir onay yok, ama istersen sesli özeti yine buradan dinleyebilirsin. ' .repeat(2);
    const reply = 'Sesli özetler hazır.\\n\\n' + F + 'dream-voice Günlük özet\\n' + long + '\\n' + F + '\\n' + F + 'dream-voice Kısa not\\nKart seni bekliyor, onayını bekliyorum.\\n' + F + '\\n\\nBitti.';
    out({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: reply }] }, parent_tool_use_id: null, session_id: 'verify-voice' });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'DONE', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 10 }, session_id: 'verify-voice' });
  }
});
`;
const bin = join(app.home, '.local', 'bin', 'claude');
writeFileSync(bin, STANDIN);
chmodSync(bin, 0o755);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const OUT = process.env.VOICE_SHOTS || app.shots;
const tag = process.env.VOICE_TAG || 'after';

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
  await vis('.chat-cmp-input').first().click();
  await vis('.chat-cmp-input').first().fill('Sesli özet ver');
  await page.keyboard.press('Enter');
  await until(async () => (await page.getByText('Bitti.', { exact: true }).count()) > 0, 20_000);
  await page.waitForTimeout(800);
  const cards = await page.locator('[data-testid="chat-voice-card"]').count();
  if (tag === 'after' && cards !== 2) app.findings.push(`${w.name}: expected 2 voice cards, got ${cards}`);
  if (tag === 'after') {
    const over = await page.evaluate(() => [...document.querySelectorAll('.chat-voice')].some((e) => e.scrollWidth > e.clientWidth + 1));
    if (over) app.findings.push(`${w.name}: a voice card scrolls sideways`);
    if (w.name === 'desktop') {
      // The scratch HOME has no voice key: stub the route (a tiny silent WAV) and assert the tap reached it.
      let asked = 0;
      const wav = Buffer.alloc(44 + 480);
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + 480, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
      wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(480, 40);
      await page.route('**/api/agent/voice/summary', (r) => { asked++; return r.fulfill({ status: 200, contentType: 'audio/wav', body: wav }); });
      await page.locator('.chat-voice-play').first().click();
      await until(async () => asked > 0, 5000);
      if (asked !== 1) app.findings.push(`${w.name}: play asked the summary route ${asked} times, expected 1`);
      await page.waitForTimeout(3000);
      const phase = await page.locator('[data-testid="chat-voice-card"]').first().getAttribute('data-phase');
      if (phase !== 'idle' && phase !== 'playing') app.findings.push(`${w.name}: the card is stuck in phase ${phase} after play`);
    }
  }
  await page.getByText('Sesli özetler hazır.', { exact: false }).first().scrollIntoViewIfNeeded().catch(() => {});
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${tag}-${w.name}-${theme}.png`) });
  }
}, { name: 'voice' });
process.exit(await app.finish());
