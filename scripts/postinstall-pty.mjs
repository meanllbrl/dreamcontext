#!/usr/bin/env node
// Runs after `npm i -g dreamcontext` (and any install of it). node-pty 1.1.0's registry tarball
// ships macOS `spawn-helper` as 0644 and its own postinstall never touches prebuilds/, so every
// install lands a helper that cannot execute: loading node-pty works, then every spawn dies with
// `posix_spawnp failed`. Give +x back here so a fresh install works with no manual chmod.
// Never fails an install: node-pty is optional, a missing or read-only copy is skipped silently.
// (An install with --ignore-scripts skips this; the server repairs the same files at run time.)
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixSpawnHelpers(root) {
  const candidates = [join(root, 'build', 'Release', 'spawn-helper')];
  const prebuilds = join(root, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const d of readdirSync(prebuilds)) candidates.push(join(prebuilds, d, 'spawn-helper'));
  }
  let fixed = 0;
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const mode = statSync(p).mode;
      if ((mode & 0o111) !== 0o111) { chmodSync(p, mode | 0o755); fixed++; }
    } catch { /* read-only or racing: leave it */ }
  }
  return fixed;
}

function main() {
  if (process.platform === 'win32') return;
  try {
    const pkg = createRequire(import.meta.url).resolve('node-pty/package.json');
    fixSpawnHelpers(dirname(pkg));
  } catch { /* node-pty is optional and may be absent */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch { /* never fail an install */ }
}
