import { test, expect } from '@playwright/test';

// Absolute path to this repo — a real vault (contains _dream_context/).
const REPO = process.env.REPO_PATH || process.cwd();

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
  await expect(page.locator('.sidebar-item')).toHaveCount(9);
});

test('installed packs are shown correctly (req 3)', async ({ page }) => {
  await page.locator('.sidebar-item', { hasText: 'Packs' }).first().click();
  await expect(page.locator('.packs-card').first()).toBeVisible();
  // All 11 catalog entries render; 10 are actually installed on disk (biv is not).
  await expect(page.locator('.packs-card')).toHaveCount(11);
  const pills = await page.locator('.packs-installed-pill').count();
  expect(pills).toBeGreaterThanOrEqual(7); // regression guard: was 1 (config-based) before the fix
});

test('can open a new vault easily (req 4)', async ({ page }) => {
  await page.locator('.sidebar-item', { hasText: 'Settings' }).first().click();
  const block = page.locator('.settings-vault-open');
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();

  const pathInput = page.locator('.settings-vault-add-input--path');
  await expect(pathInput).toBeVisible();
  // Name is optional — only the path is required to add.
  await pathInput.fill(REPO);
  await page.locator('.settings-vault-add-btn').click();

  // The added vault appears in the list (name auto-derived from the path basename).
  const derivedName = REPO.split('/').filter(Boolean).pop()!;
  const row = page.locator('.settings-vault-item', { hasText: derivedName });
  await expect(row).toBeVisible({ timeout: 5000 });

  // Clean up so the global registry is left as we found it.
  await row.locator('.settings-vault-remove-btn').click();
  await expect(page.locator('.settings-vault-item', { hasText: derivedName })).toHaveCount(0);
});
