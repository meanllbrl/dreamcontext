import { test, expect, type Page } from '@playwright/test';

/**
 * With "New layout" OFF the app is pixel-identical to the base (task codex-tarzi-yeni-kabuk W1,
 * AC 2): the launcher list, Tasks, the chat expanded, AI Team and Settings → This machine, at
 * 1440 and 1140, dark and light, fixed clock, animations off, 0 pixels of difference. The one
 * thing W1 adds while OFF, the "New layout" row itself, is taken out on Settings.
 *
 *   DASH_URL=http://127.0.0.1:<port> npx playwright test -c e2e/new-layout-off.config.ts
 */
const VAULT = process.env.OFF_VAULT || 'acme';
const SIZES = [[1440, 900], [1140, 800]] as const;
const THEMES = ['dark', 'light'] as const;

async function open(page: Page, url: string, theme: string) {
  await page.clock.install({ time: new Date('2026-10-30T09:00:00Z') });
  await page.addInitScript((t) => {
    try { localStorage.setItem('dreamcontext-theme', t); } catch { /* ignore */ }
  }, theme);
  await page.goto(url);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  const got = page.getByRole('button', { name: 'Got it' });
  if (await got.isVisible().catch(() => false)) { await got.click(); await page.waitForTimeout(400); }
}

const SHOT = { maxDiffPixels: 0, animations: 'disabled' as const, caret: 'hide' as const };

for (const [w, h] of SIZES) {
  for (const theme of THEMES) {
    test.describe(`${w} ${theme}`, () => {
      test.use({ viewport: { width: w, height: h } });

      test('launcher list', async ({ page }) => {
        await open(page, '/', theme);
        await expect(page).toHaveScreenshot(`launcher-${w}-${theme}.png`, SHOT);
      });

      test('tasks', async ({ page }) => {
        await open(page, `/?vault=${VAULT}&page=tasks`, theme);
        await expect(page).toHaveScreenshot(`tasks-${w}-${theme}.png`, SHOT);
      });

      test('chat expanded', async ({ page }) => {
        await open(page, `/?vault=${VAULT}&page=tasks`, theme);
        await page.locator('.sidebar-item--launcher').first().click();
        await page.waitForTimeout(800);
        await expect(page).toHaveScreenshot(`chat-${w}-${theme}.png`, SHOT);
      });

      test('ai team', async ({ page }) => {
        await open(page, `/?vault=${VAULT}&page=automations`, theme);
        await expect(page).toHaveScreenshot(`aiteam-${w}-${theme}.png`, SHOT);
      });

      test('settings this machine', async ({ page }) => {
        await open(page, `/?vault=${VAULT}&page=settings`, theme);
        await page.getByRole('button', { name: /Dependencies/ }).first().click();
        await page.waitForTimeout(800);
        // The row W1 adds is taken out of the page (not masked: a mask paints a box the base
        // never had), so everything else must still match the base exactly.
        await page.addStyleTag({ content: '[data-testid="new-layout-setting"] { display: none !important; }' });
        await expect(page).toHaveScreenshot(`settings-machine-${w}-${theme}.png`, SHOT);
      });
    });
  }
}
