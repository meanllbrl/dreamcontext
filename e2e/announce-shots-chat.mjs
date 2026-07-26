/**
 * Capture the LIVE Chat-view screenshots for the announcement stories.
 *
 * Split out from `announce-shots.mjs` because this one spends a real Claude turn:
 * it opens a fresh chat session in the agent overlay, sends one read-only prompt,
 * and photographs the conversation as it renders — tool cards, markdown, and the
 * structured question card. There is no way to fake this shot; the whole claim of
 * the announcement is that the app renders a real session natively.
 *
 * It WAITS on the DOM rather than on a stopwatch: a chat session's first turn
 * includes the SessionStart brain preload, which on a real vault can take 90s
 * before a single token appears, and the model here is Opus at high effort. So
 * each milestone below polls for the element that proves it happened.
 *
 * Prereq: a dashboard on the real vault (see announce-shots.mjs) and a signed-in
 * Claude CLI. The prompt is deliberately read-only.
 *
 *   node e2e/announce-shots-chat.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';

const PROMPT = process.env.PROMPT ?? [
  'Read package.json and tell me in one short paragraph what dreamcontext gives a developer.',
  'Then use your AskUserQuestion tool to ask me which agent screen I want as my default.',
  'Do not write or edit any files.',
].join(' ');

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel, target = page) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', rel);
}

/** Poll for a selector, logging progress; resolves false on timeout instead of throwing. */
async function until(label, selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(selector).count()) {
      console.log(`  · ${label} after ${Math.round((timeoutMs - (deadline - Date.now())) / 1000)}s`);
      return true;
    }
    await page.waitForTimeout(2500);
  }
  console.log(`  · ${label} — TIMED OUT after ${Math.round(timeoutMs / 1000)}s`);
  return false;
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Open the agent overlay with the user's double-tap hotkey (Ctrl ×2).
console.log('opening the agent overlay');
for (let i = 0; i < 2; i++) {
  await page.keyboard.down('Control');
  await page.keyboard.up('Control');
  await page.waitForTimeout(90);
}
await page.waitForTimeout(1500);

// The ＋ New split button's menu — proof that the Claude entry point is a chat now.
const caret = page.locator('.agent-add-caret').first();
if (await caret.count()) {
  await caret.click();
  await page.waitForTimeout(600);
  await shot('chat-is-the-default/new-menu.png');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

// A fresh chat session.
console.log('starting a chat session');
await page.locator('.agent-add-btn').first().click();
await page.waitForTimeout(4000);
await shot('native-agent-chat/empty.png');

const composer = page.locator('.chat-pane textarea').first();
await composer.click();
await composer.fill(PROMPT);
await page.waitForTimeout(300);
await composer.press('Enter');
console.log('sent — waiting on the DOM');

// Milestone 1: the first tool card (the engine is running and rendering natively).
await until('first tool card', '.chat-toolcard', 240_000);
await page.waitForTimeout(2500);
await shot('native-agent-chat/tools.png');

// Milestone 2: prose from Claude.
await until('assistant prose', '.chat-msg-assistant-body', 180_000);
await page.waitForTimeout(2000);
await shot('native-agent-chat/answer.png');

// Milestone 3: the question card — the headline claim of the whole view.
if (await until('question card', '.chat-surveycard', 240_000)) {
  await page.locator('.chat-surveycard').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shot('native-agent-chat/question.png');
  await shot('chat-is-the-default/chat.png');
} else {
  await shot('chat-is-the-default/chat.png');
}

// A close crop of the question card alone, for a split block.
const card = page.locator('.chat-surveycard').first();
if (await card.count()) await shot('native-agent-chat/question-card.png', card);

await b.close();
console.log('done');
