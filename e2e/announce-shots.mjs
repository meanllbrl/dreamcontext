/**
 * Capture the product screenshots that announcement STORIES are built from.
 *
 * Announcements stopped being drawings in 0.22 — they are landing pages made of
 * real app screenshots — so the shots have to come from the real dashboard
 * driven like a user, not from a mockup. This script does the deterministic
 * half (pages, panels, menus); the live-Claude conversation shots have their own
 * script (`announce-shots-chat.mjs`) because they cost a real model turn.
 *
 * Run against a dashboard started on the REAL vault:
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots.mjs
 *
 * Output lands directly in `dashboard/public/announcements/shots/<id>/<name>.png`,
 * which is where the story documents point.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = 'dashboard/public/announcements/shots';
const VIEW = { width: 1600, height: 1000 };

const b = await chromium.launch();
const page = await b.newPage({ viewport: VIEW, deviceScaleFactor: 2, colorScheme: 'dark' });

async function shot(rel, target = page) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  await target.screenshot({ path });
  console.log('  ✓', rel);
}

async function nav(label) {
  await page.locator('.sidebar-item', { hasText: label }).first().click();
  await page.waitForTimeout(1100);
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);

// ── The task board (dashboard highlights + task manager context) ─────────────
console.log('tasks');
await nav('Tasks');
await shot('dashboard-highlights/board.png');

// ── Task detail + its pinned Task Manager session ────────────────────────────
// The Task Manager button boots a real Claude session scoped to that task — it
// starts IDLE (the pin prompt is deferred to the first message), so opening it
// for a screenshot costs nothing but a process.
console.log('task detail');
const card = page.locator('.bd-card').first();
if (await card.count()) {
  await card.click();
  await page.waitForTimeout(1600);
  await shot('task-manager/detail.png');
  const tmBtn = page.locator('.detail-header-actions button', { hasText: 'Task Manager' }).first();
  if (await tmBtn.count()) {
    await tmBtn.click();
    await page.waitForTimeout(6000);
    await shot('task-manager/pane.png');
  }
}
await page.locator('.modal-close').first().click();
await page.waitForTimeout(900);

// ── Sleep Cycle ──────────────────────────────────────────────────────────────
console.log('sleep');
await nav('Sleep Cycle');
await shot('dashboard-highlights/sleep.png');

// ── Settings → Agents: the Chat/Terminal(legacy) screen picker ───────────────
console.log('settings → agents');
await nav('Settings');
// `hasText` is a case-insensitive SUBSTRING match, and the Platforms row's
// description ("Which AI coding agents this project uses") contains "agents" —
// anchor on the label so the picker section is the one that actually opens.
await page.locator('.settings-nav-item').filter({ hasText: /^Agents/ }).first().click();
await page.waitForTimeout(1000);
await shot('chat-is-the-default/settings.png');

await b.close();
console.log('done');
