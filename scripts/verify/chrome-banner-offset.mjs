#!/usr/bin/env node
/**
 * Banners over the title bar must not hide the chat's tab row.
 *
 *   npm run build && node scripts/verify/chrome-banner-offset.mjs
 *
 * Owner report 2026-10-10 (two screenshots): with the stale-server or the update banner up,
 * the Chat surface lost its session tabs and its new-chat button. The banners stack ABOVE the
 * title bar and push it down, but the expanded Agent overlay is `position: fixed` at
 * `--header-height` from the viewport top, so the bar sat over its first row.
 *
 * WHAT IT PROVES (real server, real bundle, real Chromium):
 *   B0  with no banner, the chat tab is the topmost element at its own centre (baseline)
 *   B1  the REAL StaleServerBanner renders (the health route reports an older server)
 *   B2  the overlay starts at or below the title bar's bottom edge
 *   B3  the chat tab and the new-chat button are the topmost elements at their centres —
 *       nothing (the bar, the banner) is painted over them
 *
 * Mutation: `MUTATE=1` restores the pre-fix offset; B2, B3a and B3b must then fail.
 *
 * The surface is gated on node-pty / the claude CLI; a machine without either fails the
 * precondition instead of every check below.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = process.env.PORT || '4797';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const home = mkdtempSync(join(tmpdir(), 'dc-banner-'));
const vaultDir = join(home, 'scratch-a');
mkdirSync(join(vaultDir, '_dream_context', 'state'), { recursive: true });
writeFileSync(join(vaultDir, '_dream_context', 'state', '.config.json'), JSON.stringify({ platforms: [] }, null, 2));
mkdirSync(join(home, '.dreamcontext'), { recursive: true });
writeFileSync(join(home, '.dreamcontext', 'vaults.json'),
  JSON.stringify({ version: 1, vaults: [{ name: 'scratch-a', path: vaultDir }] }, null, 2));
// One dormant saved tab (no sessionId, so no `claude` is ever spawned).
writeFileSync(join(vaultDir, '_dream_context', 'state', '.agent-sessions.json'), JSON.stringify({
  sessions: [{ title: 'Chat 1', bypass: false, minimized: false, size: 1, kind: 'chat' }],
}, null, 2));

const server = spawn(process.execPath, ['dist/index.js', 'dashboard', '--no-open', '--port', PORT], {
  env: { ...process.env, HOME: home, DREAMCONTEXT_DESKTOP: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${URL}/api/health`); if (r.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/** Is the element the topmost thing painted at its own centre? */
const onTop = (page, selector) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, why: 'missing' };
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: !!hit && el.contains(hit), top: Math.round(r.top), hit: hit ? hit.className || hit.tagName : null };
}, selector);

const dismissAnnouncements = async (page) => {
  const scrim = page.locator('.announcements-modal-scrim');
  await scrim.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  for (let i = 0; i < 4 && await scrim.count(); i += 1) {
    await page.locator('.announcements-modal-close').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
  }
};

const openOverlay = async (page) => {
  await page.locator('.agent-dock-chip').first().click({ timeout: 20000 });
  await page.waitForSelector('.agent-surface.expanded', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('.agent-tab', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500); // the 320ms zoom-in animation
};

let browser;
try {
  if (!(await waitForServer())) {
    check('server boots', false, `no /api/health after 30s. log tail: ${serverLog.slice(-400)}`);
  } else {
    const caps = await fetch(`${URL}/api/agent/capabilities`).then((r) => r.json()).catch(() => null);
    check('precondition: the agent surface can render on this machine',
      !!caps?.desktop && (!!caps?.embeddedTerminal || !!caps?.claudeCli), `caps=${JSON.stringify(caps)}`);

    browser = await chromium.launch();

    // ── B0: baseline, no banner ──
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(`${URL}/?vault=scratch-a`, { waitUntil: 'domcontentloaded' });
      await dismissAnnouncements(page);
      await openOverlay(page);
      const tab = await onTop(page, '.agent-tab');
      check('B0 no banner: the chat tab is on top', tab.ok, JSON.stringify(tab));
      await page.close();
    }

    // ── B1-B3: the real stale-server banner ──
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route('**/api/health', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, version: '0.0.1' } });
    });
    await page.goto(`${URL}/?vault=scratch-a`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.stale-server-banner', { timeout: 15000 }).catch(() => {});
    const bannerH = await page.locator('.window-chrome-banners').evaluate((el) => el.offsetHeight).catch(() => 0);
    check('B1 the stale-server banner renders above the bar', bannerH > 0, `banners height=${bannerH}px`);

    // MUTATE=1 pins the banner offset at 0: `--header-height` is back to the bare 42px it was
    // before the fix, so B2/B3 must FAIL. Proves the checks can see the bug at all.
    if (process.env.MUTATE) {
      await page.addStyleTag({ content: ':root { --chrome-banners-height: 0px !important; }' });
    }
    await dismissAnnouncements(page);
    await openOverlay(page);

    const geom = await page.evaluate(() => {
      const bar = document.querySelector('.window-chrome-bar')?.getBoundingClientRect();
      const surf = document.querySelector('.agent-surface.expanded')?.getBoundingClientRect();
      return { barBottom: bar ? Math.round(bar.bottom) : null, surfaceTop: surf ? Math.round(surf.top) : null };
    });
    check('B2 the overlay starts below the title bar',
      geom.barBottom !== null && geom.surfaceTop !== null && geom.surfaceTop >= geom.barBottom - 1, JSON.stringify(geom));

    const tab = await onTop(page, '.agent-tab');
    check('B3a the chat tab is not covered', tab.ok, JSON.stringify(tab));
    const newBtn = await onTop(page, '.agent-add-btn');
    check('B3b the new-chat button is not covered', newBtn.ok, JSON.stringify(newBtn));

    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  }
} catch (err) {
  check('run completes', false, String(err?.stack || err));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
