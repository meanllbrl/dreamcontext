#!/usr/bin/env node
// Stages the node-pty the desktop bundle ships (plan npmsiz-beta C1):
//
//   node scripts/stage-bundled-pty.mjs <darwin-arm64|win32-x64> [out dir]
//
// Source: the lockfile-pinned node_modules/node-pty that `npm ci` installed (its integrity is the
// lockfile's). Copies only what loading it needs: package.json, LICENSE, lib/**/*.js without tests
// and source maps, and prebuilds/<platform>/. Every source must be a regular file (a link stops
// the script); the output folder is created fresh. The output is a gitignored build input; the
// release job signs it (scripts/sign-bundled-runtime.sh) before `tauri build`.
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PTY_PLATFORMS = ['darwin-arm64', 'win32-x64'];

function regular(path) {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
}

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`a link is not allowed: ${p}`);
    if (st.isDirectory()) walk(p, keep, out);
    else if (st.isFile() && keep(p)) out.push(p);
  }
  return out;
}

/** The files to ship, relative to the package root, sorted. */
export function ptyFiles(src, platform) {
  if (!PTY_PLATFORMS.includes(platform)) throw new Error(`unknown platform: ${platform}`);
  const files = ['package.json', 'LICENSE'].map((f) => join(src, f));
  files.forEach(regular);
  files.push(...walk(join(src, 'lib'), (p) => p.endsWith('.js') && !p.endsWith('.test.js')));
  const pre = walk(join(src, 'prebuilds', platform), () => true);
  if (pre.length === 0) throw new Error(`no prebuilds for ${platform}`);
  files.push(...pre);
  return files.map((f) => relative(src, f)).sort();
}

export function stageBundledPty(platform, { src = join(ROOT, 'node_modules/node-pty'), out = join(ROOT, 'desktop/src-tauri/resources/native/node-pty') } = {}) {
  const files = ptyFiles(src, platform);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true, mode: 0o755 });
  for (const rel of files) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    cpSync(join(src, rel), join(out, rel), { dereference: false, preserveTimestamps: true });
    // The registry tarball ships spawn-helper 0644 and nothing sets +x on install; the signed
    // bundle is read-only (a DMG mount, a translocated copy), so it must leave here executable.
    if (basename(rel) === 'spawn-helper') chmodSync(join(out, rel), 0o755);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, out] = process.argv.slice(2);
  try {
    const files = stageBundledPty(platform, out ? { out: resolve(out) } : {});
    console.log(`staged ${files.length} node-pty file(s) for ${platform}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
