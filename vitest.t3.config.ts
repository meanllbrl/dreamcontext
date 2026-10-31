import { defineConfig } from 'vitest/config';
import { t3ViteAliases, t3VitePlugin } from './scripts/t3-aliases.mjs';

/**
 * T3 Code's own adapter tests, run unchanged on the vendored provider layer
 * (plan r5 §1). `npm run test:t3`. Separate from vitest.config.ts so the
 * vendored tests keep T3's runtime settings (Effect's vitest, T3's aliases).
 *
 * Excluded by name: the few T3 tests that drive T3's own orchestrator, which is
 * not vendored (it needs T3's whole server: every driver, git, terminal, SQLite).
 * Our bridge is the orchestrator here; tests/unit/t3-bridge covers it.
 */
export const T3_ORCHESTRATOR_TESTS = [
  // ClaudeAdapterV2.test.ts: replays a transcript through OrchestratorV2.
  'persists a todo_list from inline Claude task-tool frames',
  // ClaudeAdapterV2.test.ts: compares against T3's own MCP server toolkits.
  'matches the read-only allowlist to the orchestrator toolkit annotations',
  // CodexAdapterV2.test.ts: drive OrchestratorV2 + its effect worker.
  "stops a completed run's background command without a client-supplied run",
  'Stop ends a background command no Codex process tracks any more',
  'handles terminal Codex capacity failures when retries recover',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [t3VitePlugin],
  resolve: { alias: t3ViteAliases },
  test: {
    include: [
      'src/vendor/t3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts',
      'src/vendor/t3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts',
      'src/vendor/t3/apps/server/src/provider/Drivers/CodexHomeLayout.test.ts',
    ],
    testNamePattern: new RegExp(`^(?!.*(?:${T3_ORCHESTRATOR_TESTS.map(escape).join('|')}))`),
    pool: 'forks',
    testTimeout: 60_000,
  },
});
