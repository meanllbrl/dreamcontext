#!/usr/bin/env node
// A release build carries no test feed setting (plan npmsiz-beta C10). Tests build the app with
// `tauri build --config` (a loopback endpoint, a test pubkey, sometimes
// `dangerousInsecureTransportProtocol`) and a compile-time `DREAMCONTEXT_TEST_BETA_URL`; none of
// that may reach a published app, whose two feed URLs and one pubkey are fixed. Run by every
// release build job before it builds, with the `--config` values it passes:
//
//   node scripts/check-release-settings.mjs [<config json or file> ...]
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STABLE_FEED = 'https://github.com/meanllbrl/dreamcontext/releases/latest/download/latest.json';

/** Every reason this build would ship a test setting; empty = clean. */
export function releaseSettingProblems({ env = process.env, root = ROOT, extraConfigs = [] } = {}) {
  const problems = [];
  if (env.DREAMCONTEXT_TEST_BETA_URL !== undefined) problems.push('DREAMCONTEXT_TEST_BETA_URL is set: it would compile a test beta feed into the app');
  const dir = join(root, 'desktop', 'src-tauri');
  const confs = readdirSync(dir).filter((f) => /^tauri(\..+)?\.conf\.json$/.test(f)).map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf-8') }));
  for (const raw of extraConfigs) {
    const text = existsSync(raw) ? readFileSync(raw, 'utf-8') : raw;
    confs.push({ name: `--config ${raw.length > 60 ? raw.slice(0, 60) + '…' : raw}`, text });
  }
  for (const { name, text } of confs) {
    if (text.includes('dangerousInsecureTransportProtocol')) problems.push(`${name} sets dangerousInsecureTransportProtocol`);
    let conf;
    try { conf = JSON.parse(text); } catch { problems.push(`${name} is not JSON`); continue; }
    const updater = conf?.plugins?.updater;
    if (updater === undefined) continue;
    if (name === 'tauri.conf.json') {
      if (JSON.stringify(updater.endpoints) !== JSON.stringify([STABLE_FEED])) problems.push(`tauri.conf.json's updater endpoint is not the stable feed ${STABLE_FEED}`);
      // The CLI checks every downloaded app build against src/lib/minisign-pubkey.ts: one key.
      const cliKey = readFileSync(join(root, 'src', 'lib', 'minisign-pubkey.ts'), 'utf-8');
      if (typeof updater.pubkey !== 'string' || !cliKey.includes(`'${updater.pubkey}'`)) problems.push("tauri.conf.json's updater pubkey is not the key src/lib/minisign-pubkey.ts trusts");
    } else if (updater.endpoints !== undefined || updater.pubkey !== undefined) {
      problems.push(`${name} overrides the updater ${updater.endpoints !== undefined ? 'endpoints' : 'pubkey'}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = releaseSettingProblems({ extraConfigs: process.argv.slice(2) });
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`);
    console.error('A release build carries no test feed setting. Remove it and build again.');
    process.exit(1);
  }
  console.log('✓ no test feed setting: the stable endpoint, the app pubkey and no test beta URL');
}
