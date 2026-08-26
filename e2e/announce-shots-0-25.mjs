/**
 * Capture the v0.25.0 announcement screenshots — the chat-surface release.
 *
 * Run against a dashboard serving MAIN's build (the bits 0.25.0 ships) over the
 * real vault, in desktop mode:
 *   DREAMCONTEXT_DESKTOP=1 node /tmp/dc-publish-gate/dist/index.js dashboard --no-open -p 45777
 *   node e2e/announce-shots-0-25.mjs
 *
 * Deterministic scenes only — the composer and its popovers render on a fresh
 * conversation without spending a live turn. Back up
 * `_dream_context/state/.agent-sessions.json` before running (opening tabs
 * rewrites the saved roster) and restore it after — the announcements skill's
 * first hard rule.
 *
 * COLLECT-DON'T-FAIL-FAST: a scene that can't be found is reported and skipped
 * — the story includes only what was actually captured (every claim gets a
 * screenshot, or it doesn't go in).
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const ROOT = process.env.SHOT_ROOT ?? 'dashboard/public/announcements/shots';
const ID = 'v0-25-0';

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const captured = [];
async function shot(name) {
  const path = join(ROOT, ID, `${name}.png`);
  mkdirSync(dirname(path), { recursive: true });
  await page.screenshot({ path });
  captured.push(name);
  console.log('  ✓', name);
}

async function crop(name, selector, opts = {}) {
  try {
    const box = await page.locator(selector).locator('visible=true').first().boundingBox();
    if (!box) throw new Error('no box');
    const pad = opts.pad ?? 12;
    const clip = {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - (opts.padTop ?? pad)),
      width: Math.min(1600, box.width + pad * 2),
      height: Math.min(opts.maxHeight ?? 620, box.height + pad + (opts.padTop ?? pad)),
    };
    const path = join(ROOT, ID, `${name}.png`);
    mkdirSync(dirname(path), { recursive: true });
    await page.screenshot({ path, clip });
    captured.push(name);
    console.log('  ✓', name);
  } catch (err) {
    console.log('  ! skipped', name, '-', err.message.split('\n')[0]);
  }
}

// The What's New popup arrives on its own schedule, shrugs off Escape, and —
// being React state — re-mounts if you rip its node out of the DOM. Dismiss it
// the way a reader does: the "Got it" button (which also writes the read state,
// so it stays gone for the rest of the run).
async function dismissScrims() {
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.count()) {
    await gotIt.first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  // NO Escape here: the agent surface itself is an overlay, and a stray Escape
  // closes the launcher this script just opened (the 90s-timeout bug).
}

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await dismissScrims();

// ── Reach the composer. The agent surface may already be mounted with a tab
// (the real vault's roster); only click the dock when no composer is visible. ──
// Reaching the composer is stateful (a prior run's roster changes the landing):
// composer already visible → done; launcher visible → Start chat; else the
// "Agent" bubble opens the launcher first. "Start chat" spawns a real session
// whose composer we photograph — no message is ever sent.
for (let i = 0; i < 3; i += 1) {
  if (await page.locator('.chat-cmp, .chat-composer').locator('visible=true').count()) break;
  await dismissScrims();
  const startChat = page.getByRole('button', { name: /Start chat/ }).locator('visible=true');
  if (await startChat.count()) {
    await startChat.first().click();
    break;
  }
  const bubble = page.getByText('Agent', { exact: true }).locator('visible=true');
  if (await bubble.count()) {
    await bubble.last().click({ force: true });
  }
  await page.waitForTimeout(2500);
}

// The composer is the release — the spawn includes the SessionStart brain
// preload, so wait on the DOM, not a stopwatch.
await page.waitForSelector('.chat-cmp, .chat-composer', { timeout: 90000 });
await page.waitForTimeout(2500);

// Hero: the whole chat surface with the composer + shelf at rest.
await shot('chat-surface');

// The composer close-up (shelf included when present — it docks to the composer).
await crop('composer', '.chat-cmp-card, .chat-cmp', { maxHeight: 420, padTop: 96 });

// One-at-a-time upward menus: open each trigger, shoot, Escape.
async function popover(name, triggerSel, popSel) {
  try {
    await page.locator(triggerSel).locator('visible=true').first().click();
    await page.waitForSelector(popSel, { timeout: 4000 });
    await page.waitForTimeout(500);
    await crop(name, popSel, { maxHeight: 560, pad: 20 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } catch (err) {
    console.log('  ! skipped', name, '-', err.message.split('\n')[0]);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}

// Mode + permission trigger (Basic / Plan / Develop, J.A.R.V.I.S 'Soon').
await popover('mode-menu', '.chat-cmp-perm-wrap .chat-cmp-modeltrigger', '.chat-cmp-modemenu');
// Combined model + effort trigger with the effort slider.
await popover('model-effort', '.chat-cmp-model-wrap .chat-cmp-modeltrigger', '.chat-cmp-modelmenu');
// Usage popover (context + 5-hour + weekly, read from Claude Code's own cache).
await popover('usage', '.chat-cmp-usagebtn', '.chat-cmp-usagemenu, .chat-cmp-modelmenu, [role="menu"]');

// The pinned shelf, if this fresh session already carries facts (branch tag).
await crop('shelf', '.pin-shelf', { maxHeight: 260, pad: 16 });

await b.close();
console.log('captured:', captured.join(', ') || '(none)');
