#!/usr/bin/env node
// Vendor T3 Code's provider layer into src/vendor/t3/ (plan r5 §1-2).
//
//   node scripts/sync-t3.mjs <t3-checkout> <commit> [--report]
//
// Walks the import graph from the entry files below, copies exactly that
// closure with paths unchanged, adds the MIT header to every file, keeps our
// stub files at the cut seams, re-applies src/vendor/t3/patches/*.patch and
// writes VENDORED.md + vendor-manifest.json (the drift test reads the manifest).
// A T3 upgrade = re-run at a new commit, re-run T3's tests, fix only the bridge.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src/vendor/t3');
const STUBS = path.join(DEST, '_stubs');
const PATCHES = path.join(DEST, 'patches');

export const LICENSE_HEADER =
  '/*! @license MIT — vendored from T3 Code (https://github.com/pingdotgg/t3code), Copyright (c) 2026 T3 Tools Inc. See src/vendor/t3/LICENSE. */\n';
export const SCHEMA_ATTRIBUTION =
  '/*! Generated from the openai/codex app-server JSON schema (https://github.com/openai/codex), Apache-2.0. */\n';

// Whole packages (src/** minus tests unless listed under TESTS).
const WHOLE = [
  'packages/contracts/src',
  'packages/provider-core/src',
  'packages/effect-codex-app-server/src',
  'packages/effect-codex-app-server/scripts',
  'packages/provider-testing/src',
];

// Closure roots: the two drivers, the registry, the adapters, text generation.
const ENTRIES = [
  'apps/server/src/provider/ProviderRegistry.ts',
  'apps/server/src/provider/ProviderInstanceRegistry.ts',
  'apps/server/src/provider/Drivers/ClaudeDriver.ts',
  'apps/server/src/provider/Drivers/CodexDriver.ts',
  'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts',
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts',
  'apps/server/src/orchestration-v2/Adapters/ProviderTextDeltaCoalescer.ts',
  'apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts',
  'apps/server/src/orchestration-v2/Adapters/claudeWorkflowProgress.ts',
  'apps/server/src/textGeneration/ClaudeTextGeneration.ts',
  'apps/server/src/textGeneration/CodexTextGeneration.ts',
];

// T3's own tests we run in our suite (plan §1 tests row).
const TESTS = [
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts',
  'apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts',
  'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts',
  'apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts',
  'apps/server/src/provider/Drivers/CodexHomeLayout.test.ts',
  // Not ProviderInstanceRegistry.test.ts: it builds T3's full adapter
  // infrastructure (Cursor SDK, native keyring). tests/unit/t3-bridge/registry.test.ts covers ours.
];

// Cut seams (plan §2): T3 app modules replaced by our stub at the same path.
// The stub source lives in src/vendor/t3/_stubs/<same path>; the reason is the
// stub's first comment line. The walk never enters a stubbed file's imports.
export const STUBBED = [
  'apps/server/src/provider/CodexManagedRuntime.ts',
  'apps/server/src/provider/Drivers/CodexManagedProvider.ts',
  'apps/server/src/provider/CodexManagedTokenBroker.ts',
  'apps/server/src/environment/ServerEnvironment.ts',
  'apps/server/src/serverSettings.ts',
  'apps/server/src/usage/CodexUsageHistory.ts',
  'apps/server/src/preview/PortScanner.ts',
  // Test-only seams: T3's orchestrator replay harness pulls T3's whole server
  // (every driver, git, terminal, SQLite, native modules). The few T3 adapter
  // tests that drive the orchestrator are excluded by name (T3_ORCHESTRATOR_TESTS).
  'apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts',
  'apps/server/src/orchestration-v2/testkit/OrchestratorScenario.ts',
  'apps/server/src/orchestration-v2/Orchestrator.ts',
  'apps/server/src/orchestration-v2/EffectWorker.ts',
  ...['orchestrator', 'thread', 'worktree', 'project', 'environment', 'previewControls', 'html'].map(
    (k) => `apps/server/src/mcp/toolkits/${k}/tools.ts`,
  ),
];

// Imports of these resolve to an npm dependency (recorded, not copied).
const isExternal = (spec) =>
  !spec.startsWith('.') && !spec.startsWith('@t3tools/') && !spec.startsWith('effect-codex-app-server');

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function readExportsMap(src, pkgDir) {
  const pj = JSON.parse(fs.readFileSync(path.join(src, pkgDir, 'package.json'), 'utf8'));
  return { name: pj.name, exports: pj.exports ?? {} };
}

function makeResolver(src) {
  const pkgs = new Map();
  for (const dir of fs.readdirSync(path.join(src, 'packages'))) {
    const pj = path.join(src, 'packages', dir, 'package.json');
    if (!fs.existsSync(pj)) continue;
    const { name, exports } = readExportsMap(src, `packages/${dir}`);
    pkgs.set(name, { dir: `packages/${dir}`, exports });
  }
  return (spec, fromRel) => {
    if (spec.startsWith('.')) {
      return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    }
    const m = spec.match(/^(@[^/]+\/[^/]+|[^@/][^/]*)(\/.*)?$/);
    const pkg = m && pkgs.get(m[1]);
    if (!pkg) return null;
    const sub = m[2] ? `.${m[2]}` : '.';
    const entry = pkg.exports[sub];
    const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
    if (!target) throw new Error(`unresolved export ${spec} (from ${fromRel})`);
    return path.posix.normalize(path.posix.join(pkg.dir, target));
  };
}

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|vi\.mock\(\s*["']([^"']+)["']/gm;

export function importSpecs(text) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT_RE)) out.add(m[1] ?? m[2] ?? m[3]);
  return [...out];
}

function walkDir(src, rel) {
  const out = [];
  const abs = path.join(src, rel);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkDir(src, r));
    else if (/\.(ts|json|mjs)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(r);
  }
  return out;
}

export function closure(src, { tests = true } = {}) {
  const resolve = makeResolver(src);
  const files = new Set();
  const externals = new Map();
  const stubHits = new Map();
  const parent = new Map();
  const queue = [...WHOLE.flatMap((d) => walkDir(src, d)), ...ENTRIES, ...(tests ? TESTS : [])];
  while (queue.length) {
    const rel = queue.pop();
    if (files.has(rel)) continue;
    files.add(rel);
    if (!rel.endsWith('.ts')) continue;
    // A stub's own imports are part of the closure; the upstream file's are not.
    const text = STUBBED.includes(rel)
      ? fs.readFileSync(path.join(STUBS, rel), 'utf8')
      : fs.readFileSync(path.join(src, rel), 'utf8');
    for (const spec of importSpecs(text)) {
      if (isExternal(spec)) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!name.startsWith('node:')) externals.set(name, (externals.get(name) ?? 0) + 1);
        continue;
      }
      const target = resolve(spec, rel);
      if (!target) continue;
      if (!fs.existsSync(path.join(src, target))) throw new Error(`missing ${target} (from ${rel})`);
      if (STUBBED.includes(target)) stubHits.set(target, [...(stubHits.get(target) ?? []), rel]);
      if (!parent.has(target)) parent.set(target, rel);
      queue.push(target);
    }
  }
  return { files: [...files].sort(), externals, stubHits, parent };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function vendoredText(rel, upstream) {
  const attribution = rel.endsWith('/_generated/schema.gen.ts') ? SCHEMA_ATTRIBUTION : '';
  return rel.endsWith('.ts') || rel.endsWith('.mjs') ? LICENSE_HEADER + attribution + upstream : upstream;
}

function main() {
  const [srcArg, commit, ...flags] = process.argv.slice(2);
  if (!srcArg || !commit) {
    console.error('usage: node scripts/sync-t3.mjs <t3-checkout> <commit> [--report]');
    process.exit(2);
  }
  const src = path.resolve(srcArg);
  const head = sh(src, 'rev-parse', 'HEAD').trim();
  if (!head.startsWith(commit)) throw new Error(`checkout is at ${head}, expected ${commit}`);
  const { files, externals, stubHits, parent } = closure(src, { tests: !flags.includes('--no-tests') });
  const lines = files.reduce((n, f) => n + fs.readFileSync(path.join(src, f), 'utf8').split('\n').length, 0);

  if (flags.includes('--report')) {
    console.log(`closure: ${files.length} files, ${lines} lines`);
    for (const [s, from] of stubHits) console.log(`stub ${s} <- ${from.length} importers`);
    console.log('externals:', [...externals.keys()].sort().join(' '));
    const dirs = new Map();
    for (const f of files) {
      const d = f.split('/').slice(0, 4).join('/');
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    for (const [d, n] of [...dirs].sort()) console.log(`  ${n}\t${d}`);
    const why = flags[flags.indexOf('--why') + 1];
    if (flags.includes('--why')) {
      for (const f of files.filter((x) => x.startsWith(why))) {
        const chain = [f];
        while (parent.has(chain.at(-1))) chain.push(parent.get(chain.at(-1)));
        console.log(chain.reverse().map((c) => c.replace('apps/server/src/', '')).join(' > '));
      }
    }
    return;
  }

  // Fresh tree: keep only ours (_stubs, patches, docs we write below).
  for (const top of ['apps', 'packages']) fs.rmSync(path.join(DEST, top), { recursive: true, force: true });
  const manifest = { commit: head, files: {}, stubs: {}, patches: [] };
  for (const rel of files) {
    const out = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (STUBBED.includes(rel)) {
      const stub = path.join(STUBS, rel);
      if (!fs.existsSync(stub)) throw new Error(`stub missing: ${path.relative(ROOT, stub)}`);
      const text = fs.readFileSync(stub, 'utf8');
      const reason = text.match(/^\/\/ T3 STUB: (.+)$/m)?.[1];
      if (!reason) throw new Error(`stub without a "// T3 STUB: <reason>" line: ${rel}`);
      fs.writeFileSync(out, text);
      manifest.stubs[rel] = { reason, sha256: sha256(text) };
      continue;
    }
    const text = vendoredText(rel, fs.readFileSync(path.join(src, rel), 'utf8'));
    fs.writeFileSync(out, text);
    manifest.files[rel] = sha256(text);
  }
  for (const pkg of ['contracts', 'provider-core', 'shared', 'effect-codex-app-server', 'provider-testing']) {
    const pj = path.join(src, 'packages', pkg, 'package.json');
    const { name, exports } = readExportsMap(src, `packages/${pkg}`);
    fs.writeFileSync(path.join(DEST, 'packages', pkg, 'package.json'), JSON.stringify({ name, exports }, null, 2) + '\n');
    void pj;
  }

  // In-file patches (plan §2.5/§2.7): each patch's first line is "# reason: …".
  const patches = fs.existsSync(PATCHES) ? fs.readdirSync(PATCHES).filter((f) => f.endsWith('.patch')).sort() : [];
  for (const p of patches) {
    const file = path.join(PATCHES, p);
    const reason = fs.readFileSync(file, 'utf8').match(/^# reason: (.+)$/m)?.[1];
    if (!reason) throw new Error(`patch without a "# reason:" line: ${p}`);
    execFileSync('git', ['apply', '--directory=src/vendor/t3', file], { cwd: ROOT, stdio: 'inherit' });
    const touched = [...fs.readFileSync(file, 'utf8').matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    for (const rel of touched) manifest.files[rel] = sha256(fs.readFileSync(path.join(DEST, rel)));
    manifest.patches.push({ file: p, reason, touches: touched });
  }
  if (patches.length > 3) throw new Error(`${patches.length} in-file patches: more than 3 means the bridge is in the wrong place (plan §2.7)`);

  fs.copyFileSync(path.join(src, 'LICENSE'), path.join(DEST, 'LICENSE'));
  manifest.externals = Object.fromEntries([...externals].sort());
  fs.writeFileSync(path.join(DEST, 'vendor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(
    path.join(DEST, 'VENDORED.md'),
    [
      '# Vendored: T3 Code provider layer',
      '',
      `Source: https://github.com/pingdotgg/t3code at \`${head}\`, MIT (see \`LICENSE\`).`,
      'Written by `node scripts/sync-t3.mjs <t3-checkout> <commit>`. Never edit a file here by hand:',
      'a behaviour change is a new `patches/*.patch` with a `# reason:` line, re-applied by the script.',
      '`tests/unit/vendor-t3-drift.test.ts` fails when a file differs from `vendor-manifest.json`.',
      '',
      `Files: ${Object.keys(manifest.files).length} copied (${lines} upstream lines), ${Object.keys(manifest.stubs).length} stubs, ${manifest.patches.length} patches.`,
      '',
      '## Stubs (cut seams, plan §2)',
      '',
      ...Object.entries(manifest.stubs).map(([f, s]) => `- \`${f}\`: ${s.reason}`),
      '',
      '## Patches',
      '',
      ...(manifest.patches.length ? manifest.patches.map((p) => `- \`${p.file}\` (${p.touches.join(', ')}): ${p.reason}`) : ['- none']),
      '',
      '## npm dependencies the closure imports',
      '',
      ...Object.keys(manifest.externals).map((e) => `- \`${e}\``),
      '',
      '## Files',
      '',
      ...Object.keys(manifest.files).map((f) => `- \`${f}\``),
      '',
    ].join('\n'),
  );
  console.log(`vendored ${Object.keys(manifest.files).length} files + ${Object.keys(manifest.stubs).length} stubs, ${manifest.patches.length} patches`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
