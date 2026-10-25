import { defineConfig } from 'vitest/config';
import { WINDOWS_SKIPS } from './tests/windows-skip';
import { fileURLToPath } from 'node:url';

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
      marked: fileURLToPath(new URL('./dashboard/node_modules/marked/', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // On Windows only, the explicit, commented skip list (tests/windows-skip.ts).
    exclude: ['node_modules', 'dist', 'e2e', 'dashboard', ...(process.platform === 'win32' ? WINDOWS_SKIPS.filter((s) => !s.test).map((s) => s.file) : [])],
    // Windows starts a process several times slower (Defender scans every node.exe a test
    // spawns): the CLI-spawning tests get room there; elsewhere vitest's 5s default holds.
    ...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
    // Insulates the suite from a spawned parent: a builder that runs `npm test` must not have
    // its own spawn marker or pane boundary leak into the hook processes the tests launch.
    // windows-home: on win32 only, a HOME a test sets is mirrored into USERPROFILE (what
    // os.homedir() reads there), so the suite's home isolation holds on Windows too.
    setupFiles: ['tests/setup/isolate-spawn-env.ts', 'tests/setup/windows-home.ts', 'tests/setup/windows-skips.ts'],
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
    // Many tests drive the real binary (`node dist/index.js`) several times. One spawn costs
    // ~0.25 s of CPU but 1.5-2 s of wall time on a box that also runs the suite's own forks and
    // parallel agent sessions (measured: load average 76 on 8 cores), so vitest's 5 s default
    // timed out ~60 tests that pass alone. A timeout here only guards against a hang; no test
    // asserts speed through it.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    ...(isCI ? { poolOptions: { forks: { minForks: 1, maxForks: 2 } } } : {}),
  },
});
