import { defineConfig } from 'tsup';
import { chmodSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The version to stamp INTO the bundle, read from package.json at build time.
 *
 * `readDreamcontextVersionFromDisk()` finds the version by probing for a
 * package.json relative to the running file. That resolves for an npm install
 * (`node_modules/dreamcontext/dist/index.js` → `../package.json`) but NOT for
 * the Tauri .app, which ships `Contents/Resources/dist/index.js` with no
 * package.json at ANY candidate path — so every probe missed and the lookup
 * fell through to the '0.0.0' sentinel. '0.0.0' sorts below every migration
 * version, so `pendingMigrations` / `unfinishedAgentTasks` returned nothing and
 * no migration could ever fire through the bundled CLI — which is exactly the
 * first-run-before-npm-install path `resolve_cli` falls back to.
 *
 * A stamp is the artifact's own identity, so it can never be missing.
 *
 * Deliberately NOT solved by copying a package.json into dist/: that would make
 * Node resolve dist/ as its own package (needing `"type": "module"` just to
 * keep the ESM output ESM), and it would make agent-terminal.ts's
 * `cliPackageRoot()` treat the signed, read-only .app bundle as a valid
 * `npm install node-pty` target.
 */
function versionToStamp(): string {
  const pkgPath = resolve(process.cwd(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  if (pkg.name !== 'dreamcontext' || typeof pkg.version !== 'string') {
    // Fail the BUILD rather than ship an artifact that can't name itself.
    throw new Error(`tsup: ${pkgPath} is not the dreamcontext package — cannot stamp a build version.`);
  }
  return pkg.version;
}

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  splitting: false,
  // esbuild substitutes this expression with the literal version, so the
  // built dist/index.js carries its own version with no disk lookup. Read by
  // `readDreamcontextVersionFromDisk()` as the fallback when no package.json is
  // reachable. Running from src/ (tsx/vitest) has no stamp — and needs none,
  // since the repo-root package.json is always two levels up from src/lib/.
  define: {
    'process.env.DREAMCONTEXT_BUILD_VERSION': JSON.stringify(versionToStamp()),
  },
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
    // Pure-JS WebSocket server for the agent terminal's PTY bridge — bundle it so
    // the .app (which ships dist/ without node_modules) can require it.
    'ws',
  ],
  // node-pty is a NATIVE module — it cannot be bundled. It's an optionalDependency,
  // loaded via dynamic import() with graceful degradation (the agent terminal falls
  // back to "Open in Terminal"). Kept external so tsup never tries to inline the .node.
  // @huggingface/transformers ships onnxruntime-node native binaries — same deal:
  // optionalDependency, dynamic import() in embedder.ts, degrades to BM25-only recall.
  external: ['node-pty', '@huggingface/transformers'],
  onSuccess: async () => {
    cpSync('src/templates', 'dist/templates', { recursive: true });
    cpSync('agents', 'dist/agents', { recursive: true });
    cpSync('skill-packs', 'dist/skill-packs', { recursive: true });
    // askpass.cjs must ship as a real standalone file (git execs it directly as
    // the GIT_ASKPASS helper) — it can't be bundled into dist/index.js. Copied
    // to dist/git-sync/ so credentials.ts's runtime path resolution (relative to
    // its own bundled import.meta.url, i.e. dist/) finds it — see credentials.ts.
    cpSync('src/lib/git-sync/askpass.cjs', 'dist/git-sync/askpass.cjs');
    // cpSync preserves the SOURCE mode — enforce the executable bit instead of
    // inheriting it. git execs GIT_ASKPASS directly; a non-executable helper
    // fails every authenticated fetch/push with a bare "Permission denied".
    chmodSync('dist/git-sync/askpass.cjs', 0o755);
    if (existsSync('hooks')) {
      cpSync('hooks', 'dist/hooks', { recursive: true });
    }
    // Copy pre-built dashboard into dist (if it exists)
    if (existsSync('dashboard/dist')) {
      cpSync('dashboard/dist', 'dist/dashboard', { recursive: true });
    }
  },
});
