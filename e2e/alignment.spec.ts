/**
 * alignment.spec.ts
 *
 * Viewport-matrix alignment tests for the dreamcontext dashboard.
 *
 * Covers AC1–AC6 (no horizontal overflow, sidebar responsive width, Council
 * bar/count within title column, Settings hint alignment, master-detail stacked
 * at 768, no undefined transition token).
 *
 * Regenerates screenshots to e2e/shots/align/ for visual confirmation.
 */

import { test, expect, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
mkdirSync(join(__dirname, 'shots', 'align'), { recursive: true });

type Viewport = { width: number; height: number; label: string };
const VIEWPORTS: Viewport[] = [
  { width: 1440, height: 900, label: '1440' },
  { width: 768, height: 1024, label: '768' },
  { width: 390, height: 844, label: '390' },
];

// The 10 navigable pages via sidebar text.
// About uses 'What is this?' — the .sidebar-item--about button label.
type PageEntry = { page: string; label: string };
const PAGES: PageEntry[] = [
  { page: 'brain', label: 'Brain' },
  { page: 'tasks', label: 'Tasks' },
  { page: 'knowledge', label: 'Knowledge' },
  { page: 'features', label: 'Features' },
  { page: 'core', label: 'Core Files' },
  { page: 'council', label: 'Council' },
  { page: 'sleep', label: 'Sleep State' },
  { page: 'packs', label: 'Packs' },
  { page: 'settings', label: 'Settings' },
  { page: 'about', label: 'What is this?' },
];

// Master-detail pages that should stack at <=1024px.
const MASTER_DETAIL_PAGES = ['knowledge', 'core', 'features'];

// Transition duration in ms — sidebar width animation is 240ms (--transition-normal).
const TRANSITION_WAIT = 260;

async function setupPage(page: Page, viewport: Viewport): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  // Set a known localStorage baseline: expanded sidebar user preference.
  // At <=1024px the sidebar will still be forced-collapsed by matchMedia regardless.
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', '0');
    localStorage.setItem('dreamcontext.dashboard.activePage', 'brain');
  });
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await page.waitForTimeout(TRANSITION_WAIT);
}

async function navigateTo(page: Page, label: string): Promise<void> {
  const btn = page.locator('.sidebar-item', { hasText: label }).first();
  await btn.click();
  // Wait for width transition to settle before geometry asserts.
  await page.waitForTimeout(TRANSITION_WAIT);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  // Allow <=1px rounding tolerance.
  expect(overflow, 'horizontal overflow detected').toBeLessThanOrEqual(1);
}

// ─── AC1 + AC2 + AC5: viewport matrix ────────────────────────────────────────

for (const vp of VIEWPORTS) {
  test(`[${vp.label}] no horizontal overflow on any page`, async ({ page }) => {
    await setupPage(page, vp);

    for (const { label, page: pageSlug } of PAGES) {
      await navigateTo(page, label);
      await noHorizontalOverflow(page);
      // Screenshot each page at this viewport.
      await page.screenshot({
        path: join(__dirname, 'shots', 'align', `${pageSlug}-${vp.label}.png`),
        fullPage: false,
      });
    }
  });
}

// ─── AC2: sidebar responsive width ───────────────────────────────────────────

test('sidebar is wide at 1440 and collapses to rail at 768', async ({ page }) => {
  const sidebarWidth = async () => {
    const box = await page.locator('.sidebar').boundingBox();
    return box ? box.width : 0;
  };

  // 1440: sidebar should be expanded (user pref = 0, forced = false at >1024px).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('dreamcontext.dashboard.sidebarCollapsed', '0'));
  await page.reload();
  await page.locator('.sidebar').waitFor();
  await expect.poll(sidebarWidth, { timeout: 2000 }).toBeGreaterThan(150);

  // 768: sidebar should auto-collapse to rail even with user pref = expanded.
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(TRANSITION_WAIT);
  await expect.poll(sidebarWidth, { timeout: 2000 }).toBeLessThanOrEqual(60);

  // 390: sidebar should also be rail-collapsed.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(TRANSITION_WAIT);
  await expect.poll(sidebarWidth, { timeout: 2000 }).toBeLessThanOrEqual(60);
});

// ─── AC3: Council bar/count within title column ───────────────────────────────

test('[1440] Council bar/count share the same column as the title', async ({ page }) => {
  await setupPage(page, VIEWPORTS[0]);
  await navigateTo(page, 'Council');

  const titleBox = await page.locator('.page-title').boundingBox();
  const barBox = await page.locator('.council-hall-bar').boundingBox();
  const countBox = await page.locator('.council-hall-count').first().boundingBox();

  expect(titleBox, 'page-title not found').toBeTruthy();
  expect(barBox, 'council-hall-bar not found').toBeTruthy();

  if (titleBox && barBox) {
    const titleRight = titleBox.x + titleBox.width;
    const barRight = barBox.x + barBox.width;
    // The bar's right edge should not exceed the title's right edge significantly.
    expect(barRight - titleRight, 'council-hall-bar extends beyond title column').toBeLessThanOrEqual(4);
  }

  if (countBox && titleBox) {
    const titleRight = titleBox.x + titleBox.width;
    // The count must not float to the viewport right edge — it should be within the content column.
    expect(countBox.x + countBox.width, 'council-hall-count floats to viewport edge').toBeLessThanOrEqual(
      titleRight + 4,
    );
  }
});

// ─── AC4: Settings hint alignment ────────────────────────────────────────────

for (const vp of [VIEWPORTS[0], VIEWPORTS[2]] as const) {
  test(`[${vp.label}] Settings hint left-aligns under checkbox label text`, async ({ page }) => {
    await setupPage(page, vp);
    await navigateTo(page, 'Settings');

    const hint = page.locator('.settings-field-hint').first();
    const label = page.locator('.settings-checkbox-label').first();
    const checkbox = page.locator('.settings-checkbox').first();

    await hint.waitFor();
    await label.waitFor();
    await checkbox.waitFor();

    const hintBox = await hint.boundingBox();
    const checkboxBox = await checkbox.boundingBox();

    expect(hintBox, 'settings-field-hint not found').toBeTruthy();
    expect(checkboxBox, 'settings-checkbox not found').toBeTruthy();

    if (hintBox && checkboxBox) {
      // The hint element has padding-left applied; its *content* starts at hintBox.x + paddingLeft.
      // That content left edge should align with the label text (= right edge of the checkbox).
      const hintPaddingLeft = await hint.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
      const hintContentLeft = hintBox.x + hintPaddingLeft;
      const expectedLeft = checkboxBox.x + checkboxBox.width;
      // Allow ±4px rounding tolerance.
      expect(hintContentLeft, 'hint content left edge does not align with label text').toBeGreaterThanOrEqual(
        expectedLeft - 4,
      );
    }
  });
}

// ─── AC5: Master-detail stacks at 768 ────────────────────────────────────────

for (const pageSlug of MASTER_DETAIL_PAGES) {
  test(`[768] ${pageSlug} master-detail stacks to column`, async ({ page }) => {
    await setupPage(page, VIEWPORTS[1]); // 768
    const entry = PAGES.find((p) => p.page === pageSlug)!;
    await navigateTo(page, entry.label);

    const layout = page.locator(`.${pageSlug}-layout`).first();
    await layout.waitFor();

    const flexDir = await layout.evaluate((el) => getComputedStyle(el).flexDirection);
    expect(flexDir, `${pageSlug}-layout should flex column at 768`).toBe('column');
  });
}

// ─── AC6: No undefined --transition-base token (CSS check) ───────────────────

test('no transition-base token usage in compiled CSS', async ({ page }) => {
  await page.goto('/');
  // Collect all loaded stylesheets and check none contain --transition-base.
  const hasToken = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = Array.from(sheet.cssRules);
        for (const rule of rules) {
          if (rule.cssText.includes('--transition-base')) return true;
        }
      } catch {
        // Cross-origin sheets — skip.
      }
    }
    return false;
  });
  expect(hasToken, '--transition-base token found in compiled CSS').toBe(false);
});
