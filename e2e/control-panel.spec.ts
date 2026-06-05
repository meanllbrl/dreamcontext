import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('.sidebar').waitFor();
});

test('drawer collapses and expands (req 1)', async ({ page }) => {
  const sidebar = page.locator('.sidebar');
  const toggle = page.getByTestId('sidebar-collapse');
  await expect(toggle).toBeVisible();

  // Deterministic expanded baseline regardless of any persisted preference.
  await page.evaluate(() => localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', '0'));
  await page.reload();
  await sidebar.waitFor();
  const width = async () => (await sidebar.boundingBox())!.width;
  await expect.poll(width, { timeout: 2000 }).toBeGreaterThan(150); // ~220 expanded

  // Collapse → narrow + labels hidden.
  await toggle.click();
  await expect(sidebar).toHaveClass(/sidebar--collapsed/);
  await expect.poll(width, { timeout: 2000 }).toBeLessThan(100); // ~56 collapsed
  await expect(page.locator('.sidebar-item .sidebar-label').first()).toBeHidden();

  // Expand → restores (poll past the CSS width transition).
  await toggle.click();
  await expect(sidebar).not.toHaveClass(/sidebar--collapsed/);
  await expect.poll(width, { timeout: 2000 }).toBeGreaterThan(150);
});

test('tabs are grouped into sensible sections (req 2)', async ({ page }) => {
  const groups = (await page.locator('.sidebar-group-label').allInnerTexts()).map((s) => s.toLowerCase());
  expect(groups).toEqual(['workspace', 'control panel']);
  await expect(page.locator('.sidebar-nav .sidebar-item')).toHaveCount(9);
});

test('installed packs are shown correctly (req 3)', async ({ page }) => {
  await page.locator('.sidebar-item', { hasText: 'Packs' }).first().click();
  await expect(page.locator('.packs-card').first()).toBeVisible();
  // All 11 catalog entries render; 10 are actually installed on disk (biv is not).
  await expect(page.locator('.packs-card')).toHaveCount(11);
  const pills = await page.locator('.packs-installed-pill').count();
  expect(pills).toBeGreaterThanOrEqual(7); // regression guard: was 1 (config-based) before the fix
});

test('pack cards open a detail modal and close (req 4)', async ({ page }) => {
  await page.locator('.sidebar-item', { hasText: 'Packs' }).first().click();
  await page.locator('.packs-card').first().click();

  const modal = page.locator('.packs-modal-overlay');
  await expect(modal).toBeVisible();
  // A pack detail surfaces its sub-skills — the depth the read-only card lacked.
  await expect(page.locator('.packs-modal-subskills')).toBeVisible();

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

// business-idea-validation is the only catalog entry absent on disk in the repo,
// and .claude/ is gitignored, so installing/removing it never dirties the tree.
const BIV = 'business-idea-validation';

test.afterEach(async ({ page }) => {
  // Best-effort cleanup so an interrupted run never leaves an installed husk.
  await page.request.delete(`/api/packs/${BIV}`).catch(() => {});
});

test('install adds the Installed pill, remove takes it away (req 5)', async ({ page }) => {
  await page.locator('.sidebar-item', { hasText: 'Packs' }).first().click();
  await expect(page.locator('.packs-card').first()).toBeVisible();

  // Locate the business-idea-validation card; it must start uninstalled.
  const card = page.locator('.packs-card', { hasText: BIV }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.packs-installed-pill')).toHaveCount(0);

  // Install → the pill appears (React Query invalidation refreshes the list).
  await card.getByRole('button', { name: 'Install' }).click();
  await expect(card.locator('.packs-installed-pill')).toBeVisible();

  // Remove → the pill disappears again.
  await card.getByRole('button', { name: 'Remove' }).click();
  await expect(card.locator('.packs-installed-pill')).toHaveCount(0);
});

