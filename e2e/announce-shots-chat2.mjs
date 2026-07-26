/**
 * Second live-chat scene for the announcement stories: TOOL CARDS and INLINE
 * MEDIA — the two things the 0.21 chat view is really about.
 *
 * Sibling of `announce-shots-chat.mjs` (which captures the question-card scene).
 * The prompt runs one shell command and asks Claude to embed an image it does
 * not have to create, so the whole scene is read-only and finishes in a minute
 * or two instead of a full skill run.
 *
 * Selectors are scoped with `:visible`: every OTHER live session's pane is still
 * mounted in the surface's off-screen garage, so an unscoped `.chat-toolcard`
 * matches a card in a different conversation and the poll returns instantly on
 * something the camera can't see.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';

const PROMPT = [
  'Run `git log --oneline -5` and `wc -l dashboard/src/components/sleepy/ChatPane.tsx`.',
  'Then show me the image at dashboard/public/announcements/shots/native-agent-chat/question-card.png',
  'inline in your reply, with a one-line caption under it. Do not write or edit any files.',
].join(' ');

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel, target = page) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', rel);
}

async function until(label, selector, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await page.locator(selector).count()) {
      console.log(`  · ${label} after ${Math.round((Date.now() - started) / 1000)}s`);
      return true;
    }
    await page.waitForTimeout(2500);
  }
  console.log(`  · ${label} — TIMED OUT after ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

for (let i = 0; i < 2; i++) {
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await page.waitForTimeout(90);
}
await page.waitForTimeout(1500);

console.log('starting a chat session');
await page.locator('.agent-add-btn').first().click();
await page.waitForTimeout(4000);

const composer = page.locator('.chat-pane:visible textarea').first();
await composer.click();
await composer.fill(PROMPT);
await composer.press('Enter');
console.log('sent — waiting on the DOM');

await until('tool card', '.chat-pane:visible .chat-toolcard', 300_000);
await page.waitForTimeout(3000);
await shot('v0-21-0/tools.png');

// The inline image — the surface-briefing payoff: the agent EMBEDS what it
// references instead of naming a path you then have to go open.
if (await until('inline image', '.chat-pane:visible .chat-msg-assistant-body img', 300_000)) {
  await page.waitForTimeout(2500);
  await page.locator('.chat-pane:visible .chat-msg-assistant-body img').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shot('v0-21-0/inline-media.png');
}

await shot('v0-21-0/answer.png');
await b.close();
console.log('done');
