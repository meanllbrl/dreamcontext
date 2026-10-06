#!/usr/bin/env node
// Published-tarball shrinkwrap (D26). The repo's lockfile stays package-lock.json;
// `npm pack` / `npm publish` run `prepack`, which derives npm-shrinkwrap.json from it
// (dev entries kept but flagged `dev`, so consumer installs omit them), and `postpack`, which
// deletes it again. Every install of the published package — above all the hands-free
// cloud's `npm i <tgz> --ignore-scripts --omit=optional` — then gets the exact
// dependency tree the release was built with instead of the newest version in range.
//
//   node scripts/shrinkwrap.mjs write    # prepack: derive + write npm-shrinkwrap.json
//   node scripts/shrinkwrap.mjs remove   # postpack: delete it
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHRINKWRAP_FILE = 'npm-shrinkwrap.json';
const DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const ROOT_KEEP = ['name', 'version', 'license', 'dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin', 'engines', 'os', 'cpu'];

export class ShrinkwrapSyncError extends Error {}

function sameSpecs(a = {}, b = {}) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Every reason package-lock.json does not describe package.json; empty when in sync. */
export function lockSyncProblems(pkg, lock) {
  const problems = [];
  if (!lock || lock.lockfileVersion < 2 || !lock.packages) {
    return [`package-lock.json must be lockfileVersion 2 or 3 with a "packages" map (got ${lock?.lockfileVersion})`];
  }
  const root = lock.packages[''];
  if (!root) return ['package-lock.json has no root ("") package entry'];
  if (lock.name !== pkg.name || root.name !== pkg.name) {
    problems.push(`name: package.json "${pkg.name}", package-lock.json "${root.name ?? lock.name}"`);
  }
  for (const field of DEP_FIELDS) {
    if (!sameSpecs(pkg[field], root[field])) {
      problems.push(`${field}: package.json ${JSON.stringify(pkg[field] ?? {})} != package-lock.json ${JSON.stringify(root[field] ?? {})}`);
    }
  }
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry) problems.push(`${field}.${name}: no node_modules/${name} entry in package-lock.json`);
      else if (entry.dev) problems.push(`${field}.${name}: package-lock.json flags node_modules/${name} as dev`);
    }
  }
  return problems;
}

/**
 * Derive the shrinkwrap object from package.json + package-lock.json. Throws
 * ShrinkwrapSyncError naming every mismatch when the lock is out of sync.
 * Dev entries stay, flagged `dev` exactly as the lock flags them: the published
 * package.json still lists devDependencies, and `npm ci` refuses a shrinkwrap that
 * does not cover them even under --omit=dev. npm omits `dev` entries on every
 * consumer install, and `optional` ones under --omit=optional.
 */
export function deriveShrinkwrap(pkg, lock) {
  const problems = lockSyncProblems(pkg, lock);
  if (problems.length) {
    throw new ShrinkwrapSyncError(
      `package-lock.json is out of sync with package.json; run \`npm install\` and commit the lock before packing:\n  - ${problems.join('\n  - ')}`,
    );
  }
  const root = lock.packages[''];
  const outRoot = {};
  for (const k of ROOT_KEEP) if (root[k] !== undefined) outRoot[k] = root[k];
  outRoot.version = pkg.version;
  const packages = { '': outRoot };
  for (const [path, entry] of Object.entries(lock.packages)) {
    // Workspace / linked-folder entries point inside this repo and mean nothing in the tarball.
    if (path === '' || entry.link || !path.split('/').includes('node_modules')) continue;
    packages[path] = entry;
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: lock.lockfileVersion, requires: true, packages };
}

export function writeShrinkwrap(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  const shrinkwrap = deriveShrinkwrap(pkg, lock);
  writeFileSync(join(dir, SHRINKWRAP_FILE), JSON.stringify(shrinkwrap, null, 2) + '\n');
  return shrinkwrap;
}

export function removeShrinkwrap(dir) {
  rmSync(join(dir, SHRINKWRAP_FILE), { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.cwd();
  const mode = process.argv[2];
  try {
    if (mode === 'write') {
      const sw = writeShrinkwrap(dir);
      console.error(`shrinkwrap: wrote ${SHRINKWRAP_FILE} (${Object.keys(sw.packages).length - 1} packages, ${Object.values(sw.packages).filter((e) => e.dev).length} flagged dev)`);
    } else if (mode === 'remove') {
      removeShrinkwrap(dir);
    } else {
      console.error('usage: node scripts/shrinkwrap.mjs write|remove');
      process.exit(2);
    }
  } catch (err) {
    removeShrinkwrap(dir);
    console.error(`shrinkwrap: ${err.message}`);
    process.exit(1);
  }
}
