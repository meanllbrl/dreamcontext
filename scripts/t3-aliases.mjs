// Where the vendored T3 packages resolve (src/vendor/t3/packages/*). Every T3
// export map is "./x" -> "./src/x.ts", so one rule per package covers them all;
// tsconfig.json "paths" mirrors it and tests/unit/vendor-t3-drift.test.ts pins both.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = path.join(ROOT, 'src/vendor/t3/packages');

export const T3_PACKAGES = {
  '@t3tools/contracts': 'contracts',
  '@t3tools/provider-core': 'provider-core',
  '@t3tools/shared': 'shared',
  '@t3tools/provider-testing': 'provider-testing',
  'effect-codex-app-server': 'effect-codex-app-server',
};

// Our bridge reaches T3's server modules (the drivers, adapters, registry) by this name, so no
// file of ours imports a vendored path with a `.ts` extension. T3's own files never use it.
const SERVER = path.join(ROOT, 'src/vendor/t3/apps/server/src');

const SPEC = /^(@t3tools\/(?:contracts|provider-core|shared|provider-testing|server)|effect-codex-app-server)(?:\/(.+))?$/;

/** The file a T3 package specifier resolves to, or null when it is not one. */
export function resolveT3(spec) {
  const m = SPEC.exec(spec);
  if (!m) return null;
  if (m[1] === '@t3tools/server') return m[2] ? path.join(SERVER, `${m[2]}.ts`) : null;
  return path.join(PKGS, T3_PACKAGES[m[1]], 'src', `${m[2] ?? 'index'}.ts`);
}

/** esbuild/tsup plugin. */
export const t3EsbuildPlugin = {
  name: 't3-vendor',
  setup(build) {
    build.onResolve({ filter: SPEC }, (args) => ({ path: resolveT3(args.path) }));
  },
};

/** Vite/vitest plugin. `vite-plus/test` is T3's own vitest re-export. */
export const t3VitePlugin = {
  name: 't3-vendor',
  enforce: 'pre',
  resolveId(id) {
    return resolveT3(id);
  },
};

export const t3ViteAliases = [{ find: /^vite-plus\/test$/, replacement: 'vitest' }];
