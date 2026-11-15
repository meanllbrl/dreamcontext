#!/usr/bin/env node
// The sha256 of every file the app's runtime copy takes (plan npmsiz-beta C1, C4′):
//
//   node scripts/gen-rt-manifest.mjs <root> <out.json> <dir-or-file>...
//
// `root` is the folder the listed parts sit in (the bundle's resources); every part is walked and
// each regular file is recorded by its path relative to `root`, with forward slashes, sorted, so
// the same tree always gives the same bytes. A symlink, a socket or anything but a regular file or
// folder refuses the whole run: the manifest must describe exactly what a copy will hold.
// `install-launcher` and `scripts/verify-windows-bundle.mjs` compare files against it.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = 1;

/** { "<rel/path>": sha256 } for every regular file under each part. Throws on anything else. */
export function hashTree(root, parts) {
  const base = resolve(root);
  const files = {};
  const walk = (abs) => {
    const st = lstatSync(abs);
    const rel = relative(base, abs).split(sep).join('/');
    if (rel.startsWith('..') || rel === '') throw new Error(`${abs} is not inside ${base}`);
    if (st.isSymbolicLink()) throw new Error(`${rel} is a symlink: the manifest takes regular files only`);
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
      return;
    }
    if (!st.isFile()) throw new Error(`${rel} is not a regular file`);
    files[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  };
  if (parts.length === 0) throw new Error('name at least one part to record');
  for (const p of parts) walk(resolve(base, p));
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function buildManifest(root, parts) {
  return { version: MANIFEST_VERSION, files: hashTree(root, parts) };
}

/**
 * Compares the files under `root` with a manifest: every listed file present with its hash, and
 * no extra regular file under the listed parts' top folders. Returns the list of problems.
 */
export function compareWithManifest(root, manifest) {
  if (manifest?.version !== MANIFEST_VERSION || !manifest.files || typeof manifest.files !== 'object') return ['the manifest is not a version 1 manifest'];
  const problems = [];
  const tops = [...new Set(Object.keys(manifest.files).map((f) => f.split('/')[0]))];
  let actual;
  try { actual = hashTree(root, tops); } catch (e) { return [e.message]; }
  for (const [f, sha] of Object.entries(manifest.files)) {
    if (!(f in actual)) problems.push(`missing: ${f}`);
    else if (actual[f] !== sha) problems.push(`changed: ${f}`);
  }
  for (const f of Object.keys(actual)) if (!(f in manifest.files)) problems.push(`not in the manifest: ${f}`);
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, out, ...parts] = process.argv.slice(2);
  if (!root || !out || parts.length === 0) {
    console.error('usage: gen-rt-manifest.mjs <root> <out.json> <dir-or-file>...');
    process.exit(2);
  }
  try {
    const m = buildManifest(root, parts);
    writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
    console.log(`✓ ${Object.keys(m.files).length} files → ${out}`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
