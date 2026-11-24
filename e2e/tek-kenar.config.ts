import { defineConfig, devices } from '@playwright/test';

/**
 * Tek kenar çubuğu's e2e (AC2, AC3, AC5, AC6, AC7). No webServer: the spec starts its own scratch
 * HOME, API and Vite through the verify harness (scripts/verify/lib/app.mjs).
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'tek-kenar.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'chromium' }],
});
