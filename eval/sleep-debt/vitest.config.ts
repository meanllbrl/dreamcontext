import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Runner for `npm run verify:sleep-debt` only. Separate from the root config on purpose: the
 * root `include` is `tests/**`, so this real-transcript script never runs under `npm test`.
 */
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['eval/sleep-debt/**/*.run.ts'],
    testTimeout: 600_000,
  },
});
