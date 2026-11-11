#!/usr/bin/env node
// Print a shipped-hash table for a guarded core skill or a retired pack (not shipped; a tool).
//
//   node scripts/gen-skill-shas.mjs <path-in-repo> [--history <old path>]... [--map <from>=<to>]... [--only <rel>]... [--name <CONST>]
//
// Walks `git log` for every path given, hashes each file at each commit that touched it, adds the
// working tree's current files under <path-in-repo>, and prints a TS table keyed by the file's path
// relative to its skill folder. Hashes use the guarded-skill rule (src/lib/core-guarded-skill.ts):
// a text file is read with CRLF as LF, a binary (any NUL byte) raw. `--map reference/=references/`
// renames a relative path prefix from the old layout; `--only <rel>` keeps just those paths. Generated example boards
// (`examples/*.excalidraw.md`) and `node_modules` are never part of a skill.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const args = process.argv.slice(2);
const main = args[0];
if (!main || main.startsWith('--')) {
  console.error('usage: node scripts/gen-skill-shas.mjs <path-in-repo> [--history <old path>]... [--map <from>=<to>]... [--name <CONST>]');
  process.exit(1);
}
const history = [];
const maps = [];
const only = [];
let name = 'SHIPPED_SHAS';
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--history') history.push(args[++i]);
  else if (args[i] === '--map') { const [from, to] = args[++i].split('='); maps.push([from, to ?? '']); }
  else if (args[i] === '--name') name = args[++i];
  else if (args[i] === '--only') only.push(args[++i]);
}

export function skillFileSha(buf) {
  if (buf.includes(0)) return createHash('sha256').update(buf).digest('hex');
  return createHash('sha256').update(buf.toString('utf-8').split('\r\n').join('\n'), 'utf-8').digest('hex');
}

const skipped = (rel) => (only.length > 0 && !only.includes(rel)) || rel.split('/').includes('node_modules') || /^examples\/[^/]*\.excalidraw\.md$/.test(rel) || rel.endsWith('.DS_Store');
const mapRel = (rel) => {
  for (const [from, to] of maps) if (rel.startsWith(from)) return to + rel.slice(from.length);
  return rel;
};
const git = (...a) => execFileSync('git', a, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

const table = new Map();
const add = (rel, sha) => {
  if (skipped(rel)) return;
  const list = table.get(rel) ?? [];
  if (!list.includes(sha)) list.push(sha);
  table.set(rel, list);
};

for (const root of [...history, main]) {
  const commits = git('log', '--format=%H', '--', root).toString('utf-8').split('\n').filter(Boolean).reverse();
  for (const c of commits) {
    const listing = git('ls-tree', '-r', '-z', '--full-tree', c, '--', root).toString('utf-8').split('\0').filter(Boolean);
    for (const line of listing) {
      const [meta, path] = line.split('\t');
      const [mode, type, blob] = meta.split(' ');
      if (type !== 'blob' || mode === '120000') continue; // a symlink never ships as a file
      const rel = mapRel(path.slice(root.length + 1));
      add(rel, skillFileSha(git('cat-file', 'blob', blob)));
    }
  }
}

function walk(dir, out) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}
try {
  for (const f of walk(main, [])) add(relative(main, f).split(sep).join('/'), skillFileSha(readFileSync(f)));
} catch {
  // the path is gone from the working tree (a retired pack): its history is the whole table
}

const lines = [...table.keys()].sort().map((rel) => `  '${rel}': [${table.get(rel).map((s) => `'${s}'`).join(', ')}],`);
console.log(`export const ${name}: Readonly<Record<string, readonly string[]>> = {\n${lines.join('\n')}\n};`);
