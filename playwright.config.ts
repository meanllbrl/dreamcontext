import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the dreamcontext control-panel dashboard.
 * Boots the built dashboard server and runs specs in e2e/ against it.
 * Run: `npm run build` then `npx playwright test`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.DASH_URL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/index.js dashboard --no-open --port 4173',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
