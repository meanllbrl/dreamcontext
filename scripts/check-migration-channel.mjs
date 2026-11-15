#!/usr/bin/env node
// Beta brain safety (plan npmsiz-beta C12a). A beta build must not carry a brain migration a
// stable teammate's CLI cannot read: the migration would rewrite a shared brain into a shape the
// stable release does not know. So a BETA publish fails while the migration registry holds a
// step whose version is above the current stable release, unless the owner explicitly allows it
// for this one publish (the workflow's `allow-migration-in-beta` input, logged in the notes).
//
//   node scripts/check-migration-channel.mjs --stable <X.Y.Z> [--allow]
//
// The registry's versions are read from src/migrations/<X.Y.Z>[-suffix].ts, one file per step
// (tests/unit/check-migration-channel.test.ts holds the file names to the REGISTRY itself).
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+$/;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** -1 / 0 / 1 for two plain X.Y.Z versions. */
function compare(a, b) {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The version of every migration step in `dir` (`0.23.0.ts`, `0.23.0-soul-split.ts` → 0.23.0). */
export function migrationVersions(dir = join(ROOT, 'src', 'migrations')) {
  return readdirSync(dir)
    .map((f) => /^(\d+\.\d+\.\d+)(?:-[a-z0-9-]+)?\.ts$/.exec(f)?.[1])
    .filter(Boolean);
}

/** The steps above `stable`; `{ ok, above }` where ok = none, or the owner allowed them. */
export function checkMigrationChannel({ stable, allow = false, versions = migrationVersions() }) {
  if (!SEMVER.test(stable ?? '')) throw new Error(`--stable must be a plain X.Y.Z, got ${stable}`);
  const above = [...new Set(versions.filter((v) => compare(v, stable) > 0))].sort(compare);
  return { ok: above.length === 0 || allow, above };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--stable');
  const stable = i >= 0 ? args[i + 1] : undefined;
  const allow = args.includes('--allow');
  const known = new Set(['--stable', stable, '--allow']);
  if (!stable || args.some((a) => !known.has(a))) {
    console.error('usage: check-migration-channel.mjs --stable <X.Y.Z> [--allow]');
    process.exit(2);
  }
  const { ok, above } = checkMigrationChannel({ stable, allow });
  if (above.length === 0) {
    console.log(`✓ no migration step above stable ${stable}: a stable teammate reads every brain this beta writes`);
  } else if (ok) {
    console.log(`::warning::beta carries migration step(s) above stable ${stable}: ${above.join(', ')} (allowed by the owner for this publish; say so in the release notes)`);
  } else {
    console.error(`::error::This beta carries migration step(s) above stable ${stable}: ${above.join(', ')}. A stable teammate's CLI cannot read a brain they rewrite. Ship the migration in a stable release, or re-run with allow-migration-in-beta if you mean it.`);
    process.exit(1);
  }
}
