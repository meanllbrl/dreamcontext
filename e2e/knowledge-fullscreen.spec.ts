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

  // Pane render first (lazy excalidraw bundle). The svg attaches at its natural
  // export size and is scaled to fit two rAFs later — wait until it fits its
  // stage before measuring, or a large board's pre-fit natural width would
  // poison the comparison below.
  const paneSvg = page.locator('.excalidraw-stage svg');
  await paneSvg.waitFor({ timeout: 15_000 });
  const naturalWidth = await paneSvg.evaluate(el => parseFloat((el as SVGElement).style.width));
  const paneStage = (await page.locator('.excalidraw-stage').boundingBox())!;
  await expect
    .poll(async () => (await paneSvg.boundingBox())!.width, { timeout: 5000 })
    .toBeLessThanOrEqual(paneStage.width + 1);
  const paneWidth = (await paneSvg.boundingBox())!.width;

  await page.locator('.core-expand-btn').click();
  const fsSvg = page.locator('.fullscreen-overlay .excalidraw-stage svg');
  await fsSvg.waitFor({ timeout: 15_000 });

  if (naturalWidth > paneWidth + 1) {
    // Board was downscaled to fit the pane — the larger canvas must give it room.
    await expect
      .poll(async () => (await fsSvg.boundingBox())!.width, { timeout: 5000 })
      .toBeGreaterThan(paneWidth);
  } else {
    // Board already rendered at natural size (fit scale caps at 1) — it must
    // stay there, not shrink, in full-screen.
    await expect
      .poll(async () => (await fsSvg.boundingBox())!.width, { timeout: 5000 })
      .toBeGreaterThanOrEqual(paneWidth - 1);
  }
});
