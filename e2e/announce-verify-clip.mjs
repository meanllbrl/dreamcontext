/**
 * Prove an announcement clip actually PLAYS, rather than merely being present.
 *
 * A dead player is silent: no console error, no failed request, a poster that
 * looks fine. So this asserts on the media element's own state — readyState,
 * currentTime advancing, dimensions — and photographs it mid-playback.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777 &
 *   node e2e/announce-verify-clip.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const OUT = process.env.OUT ?? '/tmp/announce-verify';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const ranges = [];
page.on('response', (r) => {
  if (r.url().includes('.mp4')) ranges.push(`${r.status()} ${r.headers()['content-range'] ?? 'full'}`);
});

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'domcontentloaded' });
await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2500);
await page.addStyleTag({ content: '.agent-dock { display: none !important; }' });

const modal = page.locator('.announcements-modal');
if (await modal.count()) {
  await page.locator('.announcements-modal-close').click();
  await page.waitForTimeout(600);
}

await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.locator('.announcements-hero').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
await page.locator('.announcement-story-teaser').first().click();

const video = page.locator('.announcement-reader video').first();
await video.waitFor({ timeout: 15000 });
await video.scrollIntoViewIfNeeded();
await page.waitForTimeout(4000);

const state = await video.evaluate((el) => ({
  src: el.getAttribute('src'),
  readyState: el.readyState,
  networkState: el.networkState,
  videoWidth: el.videoWidth,
  videoHeight: el.videoHeight,
  duration: Number(el.duration?.toFixed(2)),
  currentTime: Number(el.currentTime?.toFixed(2)),
  paused: el.paused,
  muted: el.muted,
  loop: el.loop,
  error: el.error ? `${el.error.code}: ${el.error.message}` : null,
}));

await page.waitForTimeout(1500);
const advanced = await video.evaluate((el) => Number(el.currentTime?.toFixed(2)));
await page.screenshot({ path: join(OUT, 'clip-playing.png') });

console.log(JSON.stringify(state, null, 2));
console.log('currentTime advanced to:', advanced);
console.log('mp4 responses:', ranges.join(' | ') || 'none');

const ok =
  state.error === null &&
  state.readyState >= 3 &&        // HAVE_FUTURE_DATA — enough decoded to play on
  state.videoWidth > 0 &&
  advanced > state.currentTime;   // it is actually moving, not just loaded
console.log(ok ? 'PASS — the clip is playing' : 'FAIL — the clip is not playing');

await b.close();
process.exit(ok ? 0 : 1);
