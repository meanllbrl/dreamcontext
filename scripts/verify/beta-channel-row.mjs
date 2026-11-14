#!/usr/bin/env node
/**
 * Settings → Dependencies → "Beta program" (plan npmsiz-beta, W1 criterion 5), on the dev server
 * against a scratch vault:
 *
 *   dreamcontext builder heavy -- node scripts/verify/beta-channel-row.mjs
 *
 * "off" is the real server's answer (no channel record in the scratch HOME). "on" and "stays
 * until stable catches up" are the same GET answered with those views, so the row draws every
 * state the server can send. Each state at 390 and 1440 px, light and dark; console errors,
 * failed requests and sideways overflow are findings. Screenshots in tmp/verify/beta-channel-row*.
 */
import { openApp } from './lib/app.mjs';

const app = await openApp({ suite: 'beta-channel-row' });
const ROUTE = '**/api/launcher/update-channel';
const VIEWS = {
  off: null,
  on: { channel: 'beta', appVersion: '0.42.3', stableVersion: null, staysUntilStable: false, desktop: true },
  stays: { channel: 'stable', appVersion: '0.42.3', stableVersion: '0.42.1', staysUntilStable: true, desktop: true },
};
const LINES = {
  off: 'Off: the app updates from stable releases.',
  on: 'On: the app updates from beta releases.',
  stays: 'Off. This version (0.42.3) stays until a stable release passes it; nothing is downgraded.',
};

try {
  for (const theme of ['light', 'dark']) {
    for (const [state, view] of Object.entries(VIEWS)) {
      await app.look('/?vault=proj&page=settings', async (page, w) => {
        const where = `${state}-${theme}@${w.name}`;
        if (view) {
          await page.route(ROUTE, (r) => (r.request().method() === 'GET'
            ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) })
            : r.continue()));
          await page.reload({ waitUntil: 'domcontentloaded' });
        }
        const got = page.getByRole('button', { name: 'Got it' });
        if (await got.isVisible().catch(() => false)) await got.click();
        const win = page.getByTestId('settings-window');
        await win.waitFor({ state: 'visible', timeout: 15_000 });
        await win.getByRole('button', { name: 'System', exact: true }).first().click({ timeout: 10_000 });
        const row = page.locator('.setting-row', { hasText: 'Beta program' });
        await row.waitFor({ timeout: 10_000 });
        await row.scrollIntoViewIfNeeded();
        const status = page.getByTestId('update-channel-status');
        await status.waitFor({ timeout: 10_000 });
        const line = (await status.innerText()).trim();
        if (line !== LINES[state]) app.findings.push(`${where}: line reads "${line}", expected "${LINES[state]}"`);
        const sw = row.getByRole('switch');
        const on = await sw.isChecked();
        if (on !== (state === 'on')) app.findings.push(`${where}: switch is ${on ? 'on' : 'off'}`);
        if (await sw.isDisabled()) app.findings.push(`${where}: switch is disabled in the desktop app`);
        const box = await row.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > w.width + 1) app.findings.push(`${where}: row leaves the viewport ${JSON.stringify(box)}`);
        console.log(`  ${where}: "${line}" switch=${on ? 'on' : 'off'}`);
      }, {
        name: `beta-${state}-${theme}`,
        init: () => `try { localStorage.setItem('dreamcontext-theme', '${theme}'); } catch {}`,
      });
    }
  }
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
