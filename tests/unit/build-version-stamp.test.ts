/**
 * The build must stamp its own version into the bundle.
 *
 * This is the guard on the tsup half of the .app-reports-0.0.0 fix: the runtime
 * fallback in `readDreamcontextVersionFromDisk()` is only as good as the `define`
 * that feeds it, and a `define` is easy to drop in a config refactor without
 * anything failing loudly. The behavioural proof lives in
 * tests/integration/bundled-cli-version.test.ts; this catches the cause directly
 * (and without needing a build).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

describe('tsup build-version stamp', () => {
  it('defines process.env.DREAMCONTEXT_BUILD_VERSION as the package version', async () => {
    const config = (await import('../../tsup.config.js')).default as {
      define?: Record<string, string>;
    };
    const pkgVersion = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ).version as string;

    expect(config.define?.['process.env.DREAMCONTEXT_BUILD_VERSION']).toBe(
      JSON.stringify(pkgVersion),
    );
  });

  it('reads the stamp at the exact expression esbuild substitutes', () => {
    // esbuild replaces this expression TEXTUALLY. Rewriting it (destructuring
    // process.env, aliasing the key, reading it via a computed index) silently
    // breaks the substitution and quietly restores the 0.0.0 sentinel.
    const source = readFileSync(join(REPO_ROOT, 'src', 'lib', 'manifest.ts'), 'utf-8');
    expect(source).toContain('process.env.DREAMCONTEXT_BUILD_VERSION');
  });
});
