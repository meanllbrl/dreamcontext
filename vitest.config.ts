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
    // `forks` (process IPC rather than worker threads) and the teardown margin
    // date from the v0.11.0 CI-red episode and are kept because they are cheap
    // and the suite is process-heavy either way.
    //
    // They were ALSO documented here as the mitigation for the spurious
    // "Timeout calling onTaskUpdate" unhandled error — a run where every test
    // passed still exited 1. That framing was wrong, and the record is corrected
    // rather than left to mislead the next person: on vitest 3.2.4 the failure
    // survived this pool, survived the CI fork cap, survived a low-chatter
    // reporter, and survived removing all three CPU-bound files (396 files in
    // 80s, still one error). birpc's timeout is a hardcoded 60s with no vitest
    // config knob, and in an 80s run that means an `onTaskUpdate` whose reply
    // never arrived at all — a lost RPC in vitest itself, not starvation and not
    // anything this repo could tune. Upgrading to vitest 4 removed it outright.
    //
    // The CI fork cap is therefore no longer load-bearing for that bug. It stays
    // for now because a 2-vCPU runner has little to gain from more forks, but it
    // is safe to revisit.
    pool: 'forks',
    teardownTimeout: 60_000,
    ...(isCI ? { poolOptions: { forks: { minForks: 1, maxForks: 2 } } } : {}),
  },
});
