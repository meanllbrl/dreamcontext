import { defineConfig } from 'tsup';
import { cpSync, existsSync } from 'node:fs';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  splitting: false,
  banner: {
    // Shebang + a createRequire shim: bundled CJS deps (commander, gray-matter…)
    // call require() for node builtins; ESM output has no require, so provide one.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __dcCreateRequire } from 'module';",
      "const require = __dcCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  // Bundle all runtime deps INTO dist/index.js so the CLI is self-contained.
  // The Tauri .app ships dist/ but NOT node_modules, so anything left external
  // (e.g. nanoid) would fail with ERR_MODULE_NOT_FOUND at runtime. All 7 deps
  // are pure JS and bundle cleanly.
  noExternal: [
    'commander',
    'chalk',
    'gray-matter',
    '@inquirer/prompts',
    'fast-glob',
    'nanoid',
    'boxen',
  ],
  onSuccess: async () => {
    cpSync('src/templates', 'dist/templates', { recursive: true });
    cpSync('agents', 'dist/agents', { recursive: true });
    cpSync('skill-packs', 'dist/skill-packs', { recursive: true });
    if (existsSync('hooks')) {
      cpSync('hooks', 'dist/hooks', { recursive: true });
    }
    // Copy pre-built dashboard into dist (if it exists)
    if (existsSync('dashboard/dist')) {
      cpSync('dashboard/dist', 'dist/dashboard', { recursive: true });
    }
  },
});
