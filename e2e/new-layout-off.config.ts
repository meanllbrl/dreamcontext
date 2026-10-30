import { defineConfig, devices } from '@playwright/test';

/**
 * The new shell's OFF pixel lock (task codex-tarzi-yeni-kabuk W1, AC 2). No webServer: the spec
 * runs against a dashboard the caller started on a SCRATCH HOME with fictional projects
 * (`DASH_URL`), never the developer's real ~/.dreamcontext. Baselines were written by the merged
 * base before any shell code (super/yeni-kabuk @a5a80264) with --update-snapshots.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'new-layout-off.spec.ts',
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/new-layout-off/{arg}{ext}',
  use: { baseURL: process.env.DASH_URL || 'http://127.0.0.1:45781', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium' }],
});
