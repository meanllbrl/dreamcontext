#!/usr/bin/env node
// Assembles the in-app updater's latest.json from the per-platform entries the release builds
// leave behind (.github/workflows/desktop-release.yml). Each build job writes one
// `platform-<key>.json` = {"key", "signature", "url"}; the `publish` job runs this once, after
// every build, so exactly one writer produces latest.json and no platform races another.
// Before it writes anything it checks every entry's signature over the asset in the same
// folder against the updater pubkey the app ships with (desktop/src-tauri/tauri.conf.json), so
// a payload the installed apps would refuse is never published.
//
//   node scripts/release-latest-json.mjs <version> <dir> > latest.json
//   node scripts/release-latest-json.mjs <version> <dir> --dry-run   # each entry's own `pubkey`
//
// A dry run signs with a throwaway key per build job, so each entry carries that key's pubkey
// and is checked against it; a release never reads a pubkey from an entry.
//
// The output is byte-for-byte what the macOS job's jq used to print for a Mac-only release
// (2-space indent, keys version · notes · pub_date · platforms, a trailing newline), with any
// other platform merged in after darwin-aarch64.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Platforms in the order latest.json lists them; the Mac entry first, as it always was. */
export const PLATFORM_ORDER = ['darwin-aarch64', 'windows-x86_64'];

const KEY = /^(darwin|windows|linux)-(aarch64|x86_64|i686|armv7)$/;

/** Reject an entry the updater could not use: a wrong key, an empty signature, a non-release URL. */
export function checkEntry(entry, tag) {
  if (!entry || typeof entry !== 'object') throw new Error('platform entry is not an object');
  const { key, signature, url } = entry;
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error(`unknown platform key: ${key}`);
  if (typeof signature !== 'string' || signature.trim() === '') throw new Error(`${key}: empty signature`);
  const prefix = `https://github.com/`;
  if (typeof url !== 'string' || !url.startsWith(prefix) || !url.includes(`/releases/download/${tag}/`)) {
    throw new Error(`${key}: ${url} is not an asset of release ${tag}`);
  }
}

/** latest.json text for `version` from the platform entries, in PLATFORM_ORDER. */
export function buildLatestJson(version, entries, pubDate = new Date()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be X.Y.Z, got ${version}`);
  const tag = `v${version}`;
  const seen = new Set();
  for (const e of entries) {
    checkEntry(e, tag);
    if (seen.has(e.key)) throw new Error(`${e.key} appears twice`);
    seen.add(e.key);
  }
  if (!seen.has('darwin-aarch64')) throw new Error('the macOS entry (darwin-aarch64) is missing');
  const rank = (k) => (PLATFORM_ORDER.includes(k) ? PLATFORM_ORDER.indexOf(k) : PLATFORM_ORDER.length);
  const sorted = [...entries].sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  const platforms = {};
  for (const { key, signature, url } of sorted) platforms[key] = { signature, url };
  const pub_date = pubDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return JSON.stringify({ version, notes: '', pub_date, platforms }, null, 2) + '\n';
}

const b64 = (text) => Buffer.from(text.trim(), 'base64');
const lines = (b64text) => b64(b64text).toString('utf-8').split('\n').map((l) => l.replace(/\r$/, ''));
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/** The Ed25519 key and key id in a tauri updater pubkey (base64 of a minisign public key file). */
export function parsePubkey(pubkeyB64) {
  const raw = b64(lines(pubkeyB64)[1] ?? '');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign public key');
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

/** True when `signatureB64` (a tauri .sig: base64 of a minisign signature file) signs `data`
 *  with `pubkeyB64`: the key id matches, the signature covers the bytes (BLAKE2b-512 prehash for
 *  `ED`, the raw bytes for legacy `Ed`), and the global signature covers the trusted comment. */
export function verifyMinisign(data, signatureB64, pubkeyB64) {
  const { keyId, key } = parsePubkey(pubkeyB64);
  const [, sigLine, trusted, globalLine] = lines(signatureB64);
  const sig = b64(sigLine ?? '');
  if (sig.length !== 74 || !trusted?.startsWith('trusted comment: ')) return false;
  const alg = sig.subarray(0, 2).toString('latin1');
  if (!sig.subarray(2, 10).equals(keyId) || (alg !== 'ED' && alg !== 'Ed')) return false;
  const signed = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  if (!verify(null, signed, key, sig.subarray(10))) return false;
  const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf-8');
  return verify(null, Buffer.concat([sig.subarray(10), comment]), key, b64(globalLine ?? ''));
}

/** Throw unless each entry's signature verifies over its asset (the URL's file name in `dir`). */
export function verifyEntries(entries, dir, pubkeyFor) {
  for (const e of entries) {
    const file = join(dir, basename(new URL(e.url).pathname));
    if (!verifyMinisign(readFileSync(file), e.signature, pubkeyFor(e))) {
      throw new Error(`${e.key}: the signature does not verify over ${basename(file)} with the updater pubkey`);
    }
  }
}

/** The pubkey every installed app checks updates against. */
export function appPubkey(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const conf = JSON.parse(readFileSync(join(root, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8'));
  return conf.plugins.updater.pubkey;
}

/** Every `platform-*.json` in `dir`. */
export function readEntries(dir) {
  return readdirSync(dir)
    .filter((f) => /^platform-.+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, dir, flag] = process.argv.slice(2);
  if (!version || !dir || (flag !== undefined && flag !== '--dry-run')) {
    console.error('usage: release-latest-json.mjs <version> <dir> [--dry-run]');
    process.exit(2);
  }
  const entries = readEntries(dir);
  const out = buildLatestJson(version, entries);
  const released = appPubkey();
  verifyEntries(entries, dir, (e) => (flag === '--dry-run' ? e.pubkey : released));
  process.stdout.write(out);
}
