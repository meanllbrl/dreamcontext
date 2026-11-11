#!/usr/bin/env node
/**
 * The Apps page in a real Chromium, on the shared harness (scripts/verify/lib/app.mjs: scratch
 * vault, fake HOME, Vite dev server), at 390 and 1440 px (dreamcontext-apps plan r19, W2):
 *   1. empty: "No apps yet" and the one action, "Ask Claude for an app";
 *   2. after `dreamcontext apps new demo`: the card with its name, state and agent; in a browser
 *      (not the Mac app) it says "Opens in the Mac app" and offers no Launch.
 *   3. a PNG icon draws, and an app whose icon is the logo as .icns shows its letter and says so.
 * Console errors, failed requests and sideways overflow are findings.
 *
 *   dreamcontext builder heavy --max-wait 1200 -- node scripts/verify/apps.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApp } from './lib/app.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const app = await openApp({ suite: 'apps' });
// What makes the page believe it is in the Mac app (dashboard/src/lib/desktop.ts).
const DESKTOP_FLAG = `window.__TAURI_INTERNALS__ = { invoke: async () => null, transformCallback: () => 0, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } } }; window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };`;

async function goApps(page, w) {
  if (w.width <= 600) {
    await page.locator('[aria-label="More"]').first().click({ timeout: 10_000 });
    await page.getByText('Apps', { exact: true }).first().click({ timeout: 10_000 });
  } else {
    await page.locator('[aria-label="Apps"]').first().click({ timeout: 10_000 });
  }
  // Let the chat surface's close transition finish before anything is judged or captured.
  await page.waitForTimeout(1500);
}

async function expectText(page, w, text) {
  const seen = await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
  if (!seen) app.findings.push(`apps@${w.name}: "${text}" is not on the page`);
}

try {
  await app.look('/?vault=proj', async (page, w) => {
    await goApps(page, w);
    await expectText(page, w, 'No apps yet');
    await expectText(page, w, 'Ask Claude for an app');
  }, { name: 'apps-empty' });

  const made = spawnSync(join(REPO, 'node_modules', '.bin', 'vite-node'), ['--root', REPO, join(REPO, 'src', 'cli', 'index.ts'), 'apps', 'new', 'demo', '--name', 'Demo Ads'], {
    cwd: app.proj, env: { ...process.env, HOME: app.home }, encoding: 'utf-8',
  });
  if (made.status !== 0) app.findings.push(`apps new failed: ${(made.stdout + made.stderr).slice(-300)}`);

  // An app from before icons were its own: the logo as .icns. Its manifest stays as it was.
  const legacy = spawnSync(join(REPO, 'node_modules', '.bin', 'vite-node'), ['--root', REPO, join(REPO, 'src', 'cli', 'index.ts'), 'apps', 'new', 'legacy', '--name', 'Yük İzleme'], {
    cwd: app.proj, env: { ...process.env, HOME: app.home }, encoding: 'utf-8',
  });
  if (legacy.status !== 0) app.findings.push(`apps new legacy failed: ${(legacy.stdout + legacy.stderr).slice(-300)}`);
  const legacyRoot = join(`${app.proj}-apps`, 'legacy');
  copyFileSync(join(REPO, 'assets', 'notify-icon.icns'), join(legacyRoot, 'icon.icns'));
  writeFileSync(join(legacyRoot, 'dreamcontext-app.json'), JSON.stringify({ slug: 'legacy', name: 'Yük İzleme', icon: 'icon.icns' }));

  await app.look('/?vault=proj', async (page, w) => {
    await goApps(page, w);
    await expectText(page, w, 'Demo Ads');
    await expectText(page, w, 'Stopped');
    await expectText(page, w, 'Opens in the Mac app');
    if (await page.getByRole('button', { name: 'Launch' }).count()) app.findings.push(`apps@${w.name}: a browser tab offers Launch`);
  }, { name: 'apps-card' });

  // The card as the Mac app draws it: the desktop flag on, /icon answered from the app's file
  // (the real route is gated to the desktop server and covered by apps-routes.test.ts).
  await app.look('/?vault=proj', async (page, w) => {
    await page.addInitScript(DESKTOP_FLAG);
    await page.route('**/api/apps/*/icon**', (route) => route.fulfill({ path: join(`${app.proj}-apps`, 'demo', 'icon.png'), contentType: 'image/png' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await goApps(page, w);
    await expectText(page, w, 'Yük İzleme');
    await expectText(page, w, 'dreamcontext logo');
    const logos = await page.locator('img.app-card__logo').evaluateAll((els) => els.map((e) => e.naturalWidth));
    if (logos.length !== 1 || logos[0] === 0) app.findings.push(`apps@${w.name}: expected the one PNG icon drawn, got widths ${JSON.stringify(logos)}`);
    if (await page.locator('.app-card__logo--blank').count() !== 1) app.findings.push(`apps@${w.name}: the .icns app did not fall back to its first letter`);
  }, { name: 'apps-icons' });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
