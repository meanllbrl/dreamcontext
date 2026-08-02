import { defineConfig } from 'vitest/config';

/**
 * Unit + integration tests live under tests/ as *.test.ts.
 * Playwright e2e specs live under e2e/ as *.spec.ts and are run by Playwright
 * (`npx playwright test`), NOT vitest — scope vitest to tests/ so its default
 * glob never sweeps up the Playwright specs.
 */
const isCI = !!process.env.CI;

export default defineConfig({
  resolve: {
    alias: {
      // A few tests exercise dashboard modules directly (markdown rendering, the chat view
      // spec). `marked` is a DASHBOARD dependency — the root package does not and should not
      // depend on it — so point the bare specifier at the dashboard's own copy rather than
      // hoisting the package up a level just to make a test resolve.
      marked: new URL('./dashboard/node_modules/marked/', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'e2e', 'dashboard'],
    // The suite has a few CPU-bound files (recall-capture-stress, recall-eval,
    // sleep-quality-eval) that run for tens of seconds. Under the default thread
    // pool on a contended CI runner, several of them oversubscribe the vCPUs and
    // starve the worker→main reporter RPC, which surfaces as a spurious
    // "Timeout calling onTaskUpdate" unhandled error that fails the run even
    // though every test passed. The `forks` pool uses process IPC (serviced by
    // libuv, not the blocked JS event loop) and is resistant to that starvation;
    // teardownTimeout adds margin. On CI we also cap concurrency so the heavy
    // files don't oversubscribe the runner — local dev keeps full parallelism.
    pool: 'forks',
    teardownTimeout: 60_000,
    ...(isCI ? { poolOptions: { forks: { minForks: 1, maxForks: 2 } } } : {}),
  },
});
