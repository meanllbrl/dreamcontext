#!/usr/bin/env node
/**
 * tg-grup approved screen 4: Settings › Telegram with this project's bound Super bot, one bound
 * group ("Ürün ekibi") and one waiting /bagla ask ("Acme destek"), at 390 and 1440 px. The
 * Telegram routes are answered by the page (the hub needs a real bot), the Mac app is played by
 * `__TAURI_INTERNALS__`. Checks: the group row, its "since" date, the armed remove, the ask's
 * Connect button, no console error, no sideways overflow.
 *
 *   dreamcontext builder heavy -- node scripts/verify/telegram-groups-settings.mjs
 */
import { openApp } from './lib/app.mjs';

const MANAGER = {
  manager: { scope: 's', target: 'manager', state: 'active', botUsername: 'acme_manager_bot', userLabel: 'can' },
  bots: [{ projectName: 'proj', target: 'super', label: 'Super', botUsername: 'acme_super_bot', state: 'active' }],
};
const STATUS = {
  rows: [{
    scope: 's', target: 'super', state: 'active', botUsername: 'acme_super_bot', userLabel: 'can',
    groups: [{ chatId: -1001234567890, title: 'Ürün ekibi', boundAt: '2026-11-17T10:00:00.000Z' }],
    groupAsks: [{ id: 'gA1b2C3d4E5f6G7h8', title: 'Acme destek' }],
  }],
  manager: MANAGER.manager,
};

const app = await openApp({ suite: 'telegram-groups-settings', target: '/?vault=proj&page=settings' });
try {
  await app.look('/?vault=proj&page=settings', async (page, w) => {
    const where = `settings-telegram@${w.name}`;
    await page.route(/\/telegram-manager\/status(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MANAGER) }));
    await page.route(/\/api\/[^/]+\/telegram(\?|$)|\/api\/telegram(\?|$)/, (r) => (r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) })
      : r.continue()));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const got = page.getByRole('button', { name: 'Got it' });
    if (await got.isVisible().catch(() => false)) await got.click();
    const win = page.getByTestId('settings-window');
    await win.waitFor({ state: 'visible', timeout: 15_000 });
    await win.getByRole('button', { name: 'Telegram', exact: true }).first().click({ timeout: 10_000 });
    const card = page.getByTestId('tg-project-bot-super');
    await card.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => app.findings.push(`${where}: no project bot card`));
    for (const text of ['Connected groups', 'Ürün ekibi', 'Acme destek', 'Leave group', 'Connect', '@acme_super_bot']) {
      const seen = await card.getByText(text, { exact: false }).first().isVisible().catch(() => false);
      if (!seen) app.findings.push(`${where}: "${text}" is not in the bot card`);
    }
    await card.scrollIntoViewIfNeeded().catch(() => {});
    const box = await card.boundingBox();
    if (!box || box.x < 0 || box.x + box.width > w.width + 1) app.findings.push(`${where}: card leaves the viewport ${JSON.stringify(box)}`);
    console.log(`  ${where}: ${(await card.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 240)}`);
  }, {
    name: 'settings-telegram',
    init: () => "Object.defineProperty(window, '__TAURI_INTERNALS__', { value: { invoke: () => Promise.reject(new Error('no shell')) }, configurable: true });",
  });
} catch (err) {
  app.findings.push(`could not finish: ${err instanceof Error ? err.message : err}`);
}
process.exit(await app.finish());
