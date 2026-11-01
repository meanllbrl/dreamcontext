#!/usr/bin/env node
/**
 * Build a dreamcontext App bundle by hand, through the real src/lib/apps/bundle.ts, for
 * proving the app runner before the Apps server exists (dreamcontext-apps plan r19, W1).
 *
 *   node scripts/dev/make-app-bundle.mjs --runner <path/to/app-runner> \
 *     --app-bundle-id com.dreamcontext.fakeshell [--home <dir>] [--project <dir>] \
 *     [--vault demo] [--slug fixture-app] [--name "Fixture App"] [--icon <png|icns>]
 *
 * Prints the BundleResult as JSON. `--home` defaults to $HOME (the bundle lands in
 * <home>/Applications/Dreamcontext Apps/).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};

const out = await build({
  entryPoints: [join(root, 'src/lib/apps/bundle.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const runner = opt('runner', join(root, 'desktop/src-tauri/binaries/app-runner-aarch64-apple-darwin'));
const result = mod.ensureAppBundle(
  {
    home: opt('home', process.env.HOME),
    projectRoot: resolve(opt('project', process.cwd())),
    vault: opt('vault', 'demo'),
    slug: opt('slug', 'fixture-app'),
    name: opt('name', 'Fixture App'),
    iconPath: opt('icon', null),
    runnerPath: resolve(runner),
    appBundleId: opt('app-bundle-id', 'com.dreamcontext.fakeshell'),
  },
);
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
