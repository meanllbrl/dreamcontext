#!/usr/bin/env node
/**
 * Settings → System → "Other apps' data" (Full Disk Access row), on the dev server against a
 * scratch vault:
 *
 *   dreamcontext builder heavy -- node scripts/verify/fda-row.mjs
 *
 * The scratch HOME has no TCC database, so the real server answers `fullDiskAccess: null` and the
 * row hides. "off" and "on" are the real capabilities answer with that one field set, so the row
 * draws both states the Mac can send. Each at 390 and 1440 px, light and dark; console errors,
 * failed requests and sideways overflow are findings. Screenshots in tmp/verify-fda-row*.
 */
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'fda-row' });
const ROUTE = '**/api/agent/capabilities';
const STATUS = { off: 'Asks each time', on: 'Allowed for good (Full Disk Access)' };

try {
  // Hidden when the server cannot tell (the scratch HOME's real answer).
  await app.look('/?vault=proj&page=settings', async (page, w) => {
    const win = page.getByTestId('settings-window');
    await win.waitFor({ state: 'visible', timeout: 15_000 });
    await win.getByRole('button', { name: 'System', exact: true }).first().click({ timeout: 10_000 });
    await page.locator('.sysdep').first().waitFor({ timeout: 15_000 });
    if (await page.getByText('Other apps’ data').count()) app.findings.push(`hidden@${w.name}: row drawn while the server cannot tell`);
  }, { name: 'fda-hidden' });

  for (const theme of ['light', 'dark']) {
    for (const state of ['off', 'on']) {
      await app.look('/?vault=proj&page=settings', async (page, w) => {
        const where = `${state}-${theme}@${w.name}`;
        let opened = 0;
        await page.route(ROUTE, async (r) => {
          const real = await r.fetch();
          const body = { ...(await real.json()), desktop: true, platform: 'darwin', fullDiskAccess: state === 'on' };
          await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        });
        await page.route('**/api/agent/open-full-disk-access', (r) => { opened += 1; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"opened":true}' }); });
        await page.reload({ waitUntil: 'domcontentloaded' });
        const got = page.getByRole('button', { name: 'Got it' });
        if (await got.isVisible().catch(() => false)) await got.click();
        const win = page.getByTestId('settings-window');
        await win.waitFor({ state: 'visible', timeout: 15_000 });
        await win.getByRole('button', { name: 'System', exact: true }).first().click({ timeout: 10_000 });
        const row = page.locator('.sysdep-row', { hasText: 'Other apps’ data' });
        await row.waitFor({ timeout: 15_000 });
        await row.scrollIntoViewIfNeeded();
        const status = (await row.locator('.sysdep-status').innerText()).trim();
        if (status !== STATUS[state]) app.findings.push(`${where}: status reads "${status}", expected "${STATUS[state]}"`);
        const btn = row.getByRole('button', { name: 'Open Settings' });
        const hasBtn = await btn.count();
        if (state === 'off' && !hasBtn) app.findings.push(`${where}: no Open Settings button`);
        if (state === 'on' && hasBtn) app.findings.push(`${where}: Open Settings button while on`);
        if (state === 'off') {
          await btn.click();
          await page.waitForTimeout(300);
          if (opened !== 1) app.findings.push(`${where}: button posted ${opened} times`);
          if (await row.locator('.sysdep-error').count()) app.findings.push(`${where}: error after a good open`);
        }
        const box = await row.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > w.width + 1) app.findings.push(`${where}: row leaves the viewport ${JSON.stringify(box)}`);
        console.log(`  ${where}: "${status}" button=${hasBtn ? 'yes' : 'no'}`);
      }, {
        name: `fda-${state}-${theme}`,
        init: () => `try { localStorage.setItem('dreamcontext-theme', '${theme}'); } catch {}`,
      });
    }
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
