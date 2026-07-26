/**
 * Record a CLIP for an announcement: drive the real app, capture the session as
 * video, and emit the `.mp4` + its poster frame that a story's `clip` block
 * needs.
 *
 * Same principle as the screenshot passes — the announcement shows the product,
 * not a drawing of it — for the things whose value is motion: a pane opening,
 * an agent working, a transition you can't photograph.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777 &
 *   node e2e/announce-clip.mjs
 *
 * Playwright records webm; ffmpeg transcodes to h.264 mp4 (what WKWebView plays)
 * and pulls the poster. Keep clips SHORT — they ship in the npm package.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const OUT_DIR = 'dashboard/public/announcements/clips/v0-22-0';
const NAME = process.env.NAME ?? 'whats-new';
const SIZE = { width: 1280, height: 800 };

const raw = mkdtempSync(join(tmpdir(), 'announce-clip-'));
mkdirSync(OUT_DIR, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({
  viewport: SIZE,
  colorScheme: 'dark',
  // deviceScaleFactor is deliberately 1: the recording is already a video, and a
  // retina capture triples the bytes we ship for no visible gain at clip size.
  recordVideo: { dir: raw, size: SIZE },
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

// The take: land on What's New, let the release history settle, scroll down the
// version rail, then open the current release and scroll into its story.
await page.locator('.sidebar-item', { hasText: 'Announcements' }).first().click();
await page.locator('.announcements-hero').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1800);

const scroller = page.locator('.announcements-page').locator('xpath=ancestor-or-self::*[1]');
await scroller.evaluate((el) => {
  const target = el.closest('[class*="content"]') ?? document.scrollingElement ?? el;
  target.scrollTo({ top: 700, behavior: 'smooth' });
});
await page.waitForTimeout(2200);

await page.locator('.announcement-row').first().click();
await page.locator('.announcement-reader').first().waitFor({ timeout: 15000 });
await page.waitForTimeout(1800);
await page.locator('.announcement-reader').first().evaluate((el) => el.scrollTo({ top: 900, behavior: 'smooth' }));
await page.waitForTimeout(2400);

await page.close();       // flush the recording
await b.close();

const webm = readdirSync(raw).filter((f) => f.endsWith('.webm')).map((f) => join(raw, f))[0];
if (!webm) throw new Error('playwright produced no recording');

const mp4 = join(OUT_DIR, `${NAME}.mp4`);
const poster = join(OUT_DIR, `${NAME}.png`);

// Recording starts before the app has painted, so the opening seconds are a
// blank shell and a "Loading…" teaser. Drop them: the clip must open ON the
// subject, and its first frame is also the poster.
const TRIM_SECONDS = process.env.TRIM ?? '4';

// yuv420p + even dimensions: without both, Safari/WKWebView plays audio-only or
// refuses the file outright. faststart moves the moov atom to the front so the
// clip starts before it has fully downloaded.
execFileSync('ffmpeg', [
  '-y', '-ss', TRIM_SECONDS, '-i', webm,
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
  '-c:v', 'libx264', '-profile:v', 'high', '-crf', '30', '-preset', 'slow',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
  mp4,
], { stdio: 'inherit' });

// The poster is frame 1 of the FINAL clip, not a separate screenshot: a poster
// that doesn't line up with the first frame makes the video visibly jump the
// moment it starts playing.
execFileSync('ffmpeg', ['-y', '-i', mp4, '-frames:v', '1', '-update', '1', '-q:v', '2', poster], { stdio: 'inherit' });

rmSync(raw, { recursive: true, force: true });
console.log(`  ✓ ${mp4}  (${(statSync(mp4).size / 1024).toFixed(0)} KB)`);
console.log(`  ✓ ${poster} (${(statSync(poster).size / 1024).toFixed(0)} KB)`);
