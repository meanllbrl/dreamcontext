import { defineConfig } from 'vitest/config';
import { t3ViteAliases, t3VitePlugin } from './scripts/t3-aliases.mjs';
import { fileURLToPath } from 'node:url';

// T3's adapter tests spawn its fake ACP agent (a .ts file) with the current Node; T3 runs Node 26,
// we run 20+. The register hook transpiles vendored .ts and resolves T3's package names (test-only).
const T3_NODE_REGISTER = fileURLToPath(new URL('./scripts/t3-node-register.mjs', import.meta.url));
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import ${T3_NODE_REGISTER}`].filter(Boolean).join(' ');

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

/**
 * Excluded by name: T3 pins Node 26.12, the bridge child runs on 22.16+ (src/lib/t3-bridge/node-floor.ts).
 * Each was run on Node 26.13 too (W5, 2026-11-01): the two stderr tests pass there and fail on 22.16.
 */
export const T3_NODE_FLOOR_TESTS = [
  // Node 22 pipes hand stderr over in 8 KB chunks; the test wants 16-32 KB. Logging only.
  'drains large stderr output and keeps auth-sized logging chunks',
  // On Node 22.16 the pending request hangs instead of failing when onStderr rejects. A real gap for
  // Antigravity sign-in errors, open in the W5 task until the live smoke shows what the user sees.
  'fails a pending request when the stderr handler rejects the runtime',
  // T3 runs its .ts mock agent natively; ours rides NODE_OPTIONS, which a sanitized env drops by design.
  'does not restore ambient variables to a sanitized child environment',
];

// antigravityUsageReader reads Antigravity's state through node:sqlite (Node 22.5+). The bridge child
// always runs on 22.16+, so the test only runs where the code can.
const [major, minor] = process.versions.node.split('.').map(Number);
const HAS_NODE_SQLITE = major > 22 || (major === 22 && minor >= 5);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [t3VitePlugin],
  resolve: { alias: t3ViteAliases },
  test: {
    include: [
      'src/vendor/t3/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts',
      'src/vendor/t3/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts',
      'src/vendor/t3/apps/server/src/provider/Drivers/CodexHomeLayout.test.ts',
      // W5 lane A: Antigravity over ACP.
      'src/vendor/t3/apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.test.ts',
      'src/vendor/t3/apps/server/src/provider/AntigravityAuth.test.ts',
      'src/vendor/t3/apps/server/src/provider/AntigravityInstallation.test.ts',
      'src/vendor/t3/apps/server/src/provider/Drivers/AntigravitySkills.test.ts',
      ...(HAS_NODE_SQLITE ? ['src/vendor/t3/apps/server/src/provider/Drivers/antigravityUsageReader.test.ts'] : []),
      'src/vendor/t3/apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts',
      'src/vendor/t3/apps/server/src/provider/acp/AntigravityAcpSupport.test.ts',
      'src/vendor/t3/apps/server/src/provider/acp/AntigravityProtocol.test.ts',
      'src/vendor/t3/apps/server/src/provider/antigravityAuthSupport.test.ts',
      'src/vendor/t3/apps/server/src/provider/antigravityCallback.test.ts',
      'src/vendor/t3/apps/server/src/provider/antigravityUsageLimits.test.ts',
    ],
    testNamePattern: new RegExp(`^(?!.*(?:${[...T3_ORCHESTRATOR_TESTS, ...T3_NODE_FLOOR_TESTS].map(escape).join('|')}))`),
    pool: 'forks',
    testTimeout: 60_000,
  },
});
