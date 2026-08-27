/**
 * Verify the v0.26.1 What's New story renders in the real app: the feed card, the
 * story page, and every screenshot it references actually loading.
 *
 * A broken shot path renders as NOTHING (no error, no box), so the only honest check
 * is naturalWidth > 0 on each image the story pulls.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://127.0.0.1:45777';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1500, height: 1100 }, colorScheme: 'dark' });

const failed = [];
p.on('response', (r) => {
  if (r.status() >= 400 && /announcements/.test(r.url())) failed.push(`${r.status()} ${r.url()}`);
});

await p.goto(`${BASE}/?vault=dreamcontext`, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
const gotIt = p.getByRole('button', { name: 'Got it' });
if (await gotIt.count()) { await gotIt.first().click().catch(() => {}); await p.waitForTimeout(800); }

// The feed lives behind the sidebar item, not at /announcements.
await p.getByRole('button', { name: 'Announcements' }).first().click();
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/ann-feed.png' });

const card = p.getByText('Your projects stop being alone').first();
console.log('feed card present:', (await card.count()) > 0);
if (await card.count()) { await card.click(); await p.waitForTimeout(2500); }

const imgs = (await p.evaluate(() =>
  [...document.querySelectorAll('img')]
    .map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth }))
)).filter((i) => /announcements/.test(i.src || ''));

console.log('story images:');
for (const i of imgs) console.log(`  ${i.w > 0 ? '✓' : '✗ BROKEN'} ${i.w}px  ${i.src}`);
console.log('failed asset requests:', failed.length ? failed : 'none');

await p.screenshot({ path: '/tmp/ann-story.png', fullPage: true });
await b.close();
