/**
 * Verification pass for the full-window image viewer: opens the newest release
 * in the reader, clicks a screenshot, and proves the viewer (a) covers the whole
 * window, (b) zooms on wheel, (c) pans while zoomed, (d) resets on double-click,
 * and (e) closes on Esc without also closing the reader underneath.
 *
 *   DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45788 &
 *   node e2e/image-viewer-verify.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45788';
const OUT = process.env.OUT ?? '/tmp/image-viewer-verify';
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });

const fail = (msg) => { console.error(`FAIL  ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok    ${msg}`);

await page.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'domcontentloaded' });
await page.locator('.sidebar-item').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
// The unread-release popup owns the screen on first load — dismiss it.
const popupClose = page.locator('.announcements-modal-close, .announcements-modal button').first();
if (await popupClose.count()) { await popupClose.click().catch(() => {}); await page.waitForTimeout(400); }
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(300);

await page.locator('.sidebar-item--announcements').click();
await page.waitForTimeout(1200);

// Open the newest release into the reader.
await page.locator('.announcements-hero-title').click();
await page.waitForTimeout(1800);
if (!(await page.locator('.announcement-reader').count())) fail('reader did not open');
else ok('reader open');

// Click the first screenshot in the story.
const shot = page.locator('.ann-story-shot-btn').first();
await shot.waitFor({ timeout: 15000 });
await shot.click();
await page.waitForTimeout(700);

const viewer = page.locator('.image-viewer');
if (!(await viewer.count())) { fail('viewer did not open'); await b.close(); process.exit(1); }
ok('viewer open');

// (a) Covers the whole window — this is the "complete full screen" claim.
const box = await viewer.boundingBox();
const vp = page.viewportSize();
if (box.x !== 0 || box.y !== 0 || box.width !== vp.width || box.height !== vp.height) {
  fail(`viewer is not edge-to-edge: ${JSON.stringify(box)} vs ${JSON.stringify(vp)}`);
} else ok('viewer covers the full window');

await page.screenshot({ path: `${OUT}/1-fit.png` });
const levelText = async () => (await page.locator('.image-viewer-level').innerText()).trim();
console.log(`      zoom at fit: ${await levelText()}`);

const transform = async () => page.locator('.image-viewer-img').evaluate((el) => el.style.transform);
const scaleOf = (t) => Number(/scale\(([-\d.]+)\)/.exec(t)?.[1] ?? '1');
const panOf = (t) => (/translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(t) ?? []).slice(1, 3).map(Number);

// (b) Wheel zooms.
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(300);
const zoomedT = await transform();
if (scaleOf(zoomedT) <= 1.01) fail(`wheel did not zoom (scale ${scaleOf(zoomedT)})`);
else ok(`wheel zoomed to scale ${scaleOf(zoomedT).toFixed(2)} (${await levelText()})`);
await page.screenshot({ path: `${OUT}/2-zoomed.png` });

// (c) Drag pans while zoomed.
await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.move(560, 360, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(250);
const pannedT = await transform();
const [px, py] = panOf(pannedT);
const [zx, zy] = panOf(zoomedT);
if (px === zx && py === zy) fail('drag did not pan');
else ok(`drag panned by (${(px - zx).toFixed(0)}, ${(py - zy).toFixed(0)})`);
await page.screenshot({ path: `${OUT}/3-panned.png` });

// A drag must NOT be read as a backdrop click.
if (!(await page.locator('.image-viewer').count())) fail('drag closed the viewer');
else ok('drag did not close the viewer');

// (d) ＋ button and double-click-to-fit.
await page.locator('.image-viewer-btn').last().click();
await page.waitForTimeout(250);
ok(`＋ button → ${await levelText()}`);
await page.mouse.dblclick(720, 450);
await page.waitForTimeout(300);
if (scaleOf(await transform()) > 1.01) fail('double-click did not reset to fit');
else ok(`double-click reset to fit (${await levelText()})`);

// (e) Esc closes the viewer only — the reader must survive.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
if (await page.locator('.image-viewer').count()) fail('Esc did not close the viewer');
else ok('Esc closed the viewer');
if (!(await page.locator('.announcement-reader').count())) fail('Esc also closed the reader underneath');
else ok('reader survived the Esc');
await page.screenshot({ path: `${OUT}/4-back-in-reader.png` });

// Second Esc leaves the reader.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
if (await page.locator('.announcement-reader').count()) fail('second Esc did not close the reader');
else ok('second Esc closed the reader');

await b.close();
console.log(process.exitCode ? '\nFAILED' : '\nALL CHECKS PASSED');
