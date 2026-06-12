import { test, expect } from '@playwright/test';

/**
 * Full-screen mode for the knowledge document viewer (#21).
 * Runs against this repo's own _dream_context, which ships at least one
 * root-level markdown knowledge doc and a diagrams/*.excalidraw board.
 */
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('.sidebar-item', { hasText: 'Knowledge' }).first().click();
  await page.locator('.knowledge-card').first().waitFor();
});

test('expand button opens a dialog overlay; Esc closes and preserves tab state', async ({ page }) => {
  await page.locator('.knowledge-card').first().click();
  const expand = page.locator('.core-expand-btn');
  await expect(expand).toBeVisible();
  await expand.click();

  const dialog = page.locator('[role="dialog"].fullscreen-overlay');
  await expect(dialog).toBeVisible();
  expect(await dialog.getAttribute('aria-label')).toBeTruthy();
  // Body scroll locked while open.
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');

  // Tabs usable inside the overlay: switch to the raw File view.
  await dialog.locator('.core-tab', { hasText: 'File' }).click();
  await expect(dialog.locator('pre.core-viewer-content')).toBeVisible();

  // Esc exits; scroll unlocks; the File tab selection carries back to the pane.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await expect(page.locator('.knowledge-detail pre.core-viewer-content')).toBeVisible();
});

test('close button exits; list/search state untouched', async ({ page }) => {
  await page.locator('.knowledge-search').fill('a');
  await page.locator('.knowledge-card').first().click();
  await page.locator('.core-expand-btn').click();

  const dialog = page.locator('[role="dialog"].fullscreen-overlay');
  await expect(dialog).toBeVisible();
  await dialog.locator('.fullscreen-overlay-close').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.knowledge-search')).toHaveValue('a');
  await expect(page.locator('.knowledge-card--active')).toBeVisible();
});

test('excalidraw board re-fits to the full-screen canvas', async ({ page }) => {
  const folder = page.locator('.knowledge-folder-header', { hasText: 'Diagrams' });
  test.skip(!(await folder.count()), 'no diagrams folder in this vault');
  await folder.first().click();
  await page.locator('.knowledge-card', { hasText: '.excalidraw' }).first().click();

  // Pane render first (lazy excalidraw bundle), then expand.
  await page.locator('.excalidraw-stage svg').waitFor({ timeout: 15_000 });
  const paneBox = (await page.locator('.excalidraw-stage svg').boundingBox())!;
  await page.locator('.core-expand-btn').click();

  const fsSvg = page.locator('.fullscreen-overlay .excalidraw-stage svg');
  await fsSvg.waitFor({ timeout: 15_000 });
  // The svg re-fits to the larger canvas instead of staying pane-sized.
  await expect
    .poll(async () => (await fsSvg.boundingBox())!.width, { timeout: 5000 })
    .toBeGreaterThan(paneBox.width);
});
