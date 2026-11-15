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
//   node scripts/release-latest-json.mjs <version> <dir> [--dry-run] --channel stable|beta > latest.json
//   node scripts/release-latest-json.mjs pick-beta <candidate latest.json> [<current beta.json>] > beta.json
//   node scripts/release-latest-json.mjs verify <vX.Y.Z> <dir>       # promote: the release is whole
//   node scripts/release-latest-json.mjs gate stable|beta|promote <vX.Y.Z>     # before any run touches a release
//   node scripts/release-latest-json.mjs latest-after <kind> <vX.Y.Z> <before> # releases/latest after it
//   node scripts/release-latest-json.mjs fetch-feed <url> <out>     # 404 = no feed; any other failure fails
//
// A dry run signs with a throwaway key per build job, so each entry carries that key's pubkey
// and is checked against it; a release never reads a pubkey from an entry.
//
// The beta feed (plan npmsiz-beta C10): `--channel` prints the same latest.json and ALSO writes
// `<dir>/beta.json`, the feed the app's Beta switch reads from the `channel-beta` prerelease: the
// NEWER of this release's latest.json and the beta.json published today (`<dir>/current-beta.json`
// when the job fetched one), so every publish, beta or stable, leaves beta.json naming the newest
// of both. Without `--channel` the output is byte for byte what it was.
//
// The output is byte-for-byte what the macOS job's jq used to print for a Mac-only release
// (2-space indent, keys version · notes · pub_date · platforms, a trailing newline), with any
// other platform merged in after darwin-aarch64.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A published latest.json / beta.json, checked: a plain version and every platform entry an
 *  asset of that version's release. Throws on anything else. */
export function parseFeed(text) {
  const feed = JSON.parse(text);
  if (!feed || typeof feed !== 'object' || typeof feed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(feed.version)) {
    throw new Error('the feed has no plain X.Y.Z version');
  }
  if (!feed.platforms || typeof feed.platforms !== 'object' || Object.keys(feed.platforms).length === 0) {
    throw new Error(`feed ${feed.version} lists no platform`);
  }
  for (const [key, p] of Object.entries(feed.platforms)) checkEntry({ key, ...(p ?? {}) }, `v${feed.version}`);
  return feed;
}

const versionParts = (v) => v.split('.').map(Number);
/** -1 / 0 / 1 for two plain X.Y.Z versions. */
export function compareVersions(a, b) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The beta.json to publish: the candidate (this release's latest.json) unless the beta.json
 * published today names a strictly newer version, which is then kept as it is. A current one
 * that does not parse is ignored (the candidate replaces it); the candidate itself must parse.
 */
export function pickBetaJson(candidateText, currentText) {
  const candidate = parseFeed(candidateText);
  if (currentText) {
    let current = null;
    try { current = parseFeed(currentText); } catch { current = null; }
    if (current && compareVersions(current.version, candidate.version) > 0) return currentText;
  }
  return candidateText;
}

/**
 * `releases/latest` only moves forward: a stable publish or a promote of `tag` is refused unless
 * it is strictly newer than the current latest tag. `sameOk` admits the same tag (a stable
 * publish re-run, e.g. adding Windows later). Throws with the reason.
 */
export function checkForward(tag, latestTag, { sameOk = false } = {}) {
  for (const t of [tag, latestTag]) {
    if (!/^v\d+\.\d+\.\d+$/.test(t ?? '')) throw new Error(`not a plain vX.Y.Z tag: ${t}`);
  }
  const c = compareVersions(tag.slice(1), latestTag.slice(1));
  if (c > 0 || (c === 0 && sameOk)) return;
  throw new Error(`${tag} is not newer than the stable ${latestTag}: releases/latest only moves forward`);
}

const PUBLISH_KINDS = ['stable', 'beta', 'promote'];
const TAG_STATES = ['none', 'prerelease', 'release'];

/**
 * THE gate of every run that can touch releases/latest, before anything is written. `kind`:
 * stable (publish, marked latest), beta (publish, a prerelease) or promote (beta → stable);
 * `tagState`: what GitHub holds for `tag` today (none, a prerelease, or a normal release).
 *   stable   moves latest forward only; the same tag passes (a re-run adding Windows).
 *   beta     never touches an existing normal release: publishing a prerelease over it would
 *            take it off releases/latest and move the stable feed back.
 *   promote  only an existing prerelease, strictly newer than latest.
 */
export function checkPublish(kind, tag, latestTag, tagState) {
  if (!PUBLISH_KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  if (!TAG_STATES.includes(tagState)) throw new Error(`unknown tag state ${tagState}`);
  if (kind === 'stable') return checkForward(tag, latestTag, { sameOk: true });
  if (kind === 'promote') {
    if (tagState !== 'prerelease') throw new Error(`${tag} is not a beta (prerelease) release`);
    return checkForward(tag, latestTag);
  }
  for (const t of [tag, latestTag]) {
    if (!/^v\d+\.\d+\.\d+$/.test(t ?? '')) throw new Error(`not a plain vX.Y.Z tag: ${t}`);
  }
  if (tagState === 'release' || tag === latestTag) {
    throw new Error(`${tag} is already a stable release: a beta never re-cuts it (re-run it as stable)`);
  }
}

/**
 * What GitHub holds today: the releases/latest tag, and `tag`'s state (none on a 404, else
 * prerelease or release). Any other answer throws: the gate never guesses.
 */
export async function readReleaseState(repo, tag, { apiBase = 'https://api.github.com', token, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const get = async (path) => {
    const res = await fetchImpl(`${apiBase}/repos/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return await res.json();
  };
  const latest = await get('/releases/latest');
  if (!latest || typeof latest.tag_name !== 'string') throw new Error('no releases/latest to compare against');
  const own = await get(`/releases/tags/${encodeURIComponent(tag)}`);
  const state = own === null ? 'none' : own.prerelease === true ? 'prerelease' : own.prerelease === false ? 'release' : null;
  if (!state) throw new Error(`${tag}'s release has no prerelease flag`);
  return { latest: latest.tag_name, state };
}

/** After the run: releases/latest is the tag (stable, promote) or exactly what it was (beta). */
export function checkLatestAfter(kind, tag, before, after) {
  if (!PUBLISH_KINDS.includes(kind)) throw new Error(`unknown kind ${kind}`);
  // An empty "before" means the gate's answer was lost: never compare against it.
  for (const t of [tag, before, after]) {
    if (!/^v\d+\.\d+\.\d+$/.test(t ?? '')) throw new Error(`not a plain vX.Y.Z tag: ${t}`);
  }
  const want = kind === 'beta' ? before : tag;
  if (after !== want) throw new Error(`releases/latest is ${after} after the ${kind} run of ${tag}; it must be ${want}`);
}

/**
 * The feed published today, for `assemble` and `promote`: 200 → its text, 404 → null (no beta
 * feed yet, this release starts it). Anything else (a 5xx, a timeout, a network error) throws:
 * treating it as "absent" would let beta.json fall back to an older build.
 */
export async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`fetching ${url} returned HTTP ${res.status}`);
  return await res.text();
}

/**
 * Promote's gate: a release is whole when its latest.json names `tag`, every platform's asset
 * is in `dir` and its signature verifies against the app's pubkey, and the Mac payload's
 * `.sha256` and `.sig` and the DMG are there. Throws with the first thing missing.
 */
export function verifyRelease(tag, dir, pubkey = appPubkey()) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`the tag must be a plain vX.Y.Z, got ${tag}`);
  let text;
  try { text = readFileSync(join(dir, 'latest.json'), 'utf-8'); } catch { throw new Error(`${tag} carries no latest.json`); }
  const feed = parseFeed(text);
  if (`v${feed.version}` !== tag) throw new Error(`latest.json names ${feed.version}, not ${tag}`);
  if (!feed.platforms['darwin-aarch64']) throw new Error('latest.json has no darwin-aarch64 entry');
  const entries = Object.entries(feed.platforms).map(([key, p]) => ({ key, ...p }));
  for (const e of entries) {
    const name = basename(new URL(e.url).pathname);
    try { readFileSync(join(dir, name)); } catch { throw new Error(`${tag} is missing ${name}`); }
  }
  verifyEntries(entries, dir, () => pubkey);
  const mac = basename(new URL(feed.platforms['darwin-aarch64'].url).pathname);
  for (const name of [`${mac}.sha256`, `${mac}.sig`, 'dreamcontext-beta_aarch64.dmg']) {
    try { readFileSync(join(dir, name)); } catch { throw new Error(`${tag} is missing ${name}`); }
  }
  return feed;
}

/** Every `platform-*.json` in `dir`. */
export function readEntries(dir) {
  return readdirSync(dir)
    .filter((f) => /^platform-.+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
}

const USAGE = [
  'usage: release-latest-json.mjs <version> <dir> [--dry-run] [--channel stable|beta]',
  '       release-latest-json.mjs pick-beta <candidate latest.json> [<current beta.json>]',
  '       release-latest-json.mjs verify <vX.Y.Z> <dir>',
  '       release-latest-json.mjs gate stable|beta|promote <vX.Y.Z>            # prints releases/latest before',
  '       release-latest-json.mjs latest-after stable|beta|promote <vX.Y.Z> <latest before>',
  '       release-latest-json.mjs fetch-feed <url> <out file>',
].join('\n');

/** The default form's flags: `--dry-run` and `--channel <c>`, each at most once. Null = bad usage. */
export function parseFlags(rest) {
  const flags = { dryRun: false, channel: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run' && !flags.dryRun) flags.dryRun = true;
    else if (rest[i] === '--channel' && flags.channel === null && (rest[i + 1] === 'stable' || rest[i + 1] === 'beta')) flags.channel = rest[++i];
    else return null;
  }
  return flags;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [first, ...args] = process.argv.slice(2);
  if (first === 'pick-beta') {
    const [candidate, current] = args;
    if (!candidate || args.length > 2) { console.error(USAGE); process.exit(2); }
    let currentText = null;
    if (current) { try { currentText = readFileSync(current, 'utf-8'); } catch { currentText = null; } }
    process.stdout.write(pickBetaJson(readFileSync(candidate, 'utf-8'), currentText));
  } else if (first === 'verify') {
    const [tag, dir] = args;
    if (!tag || !dir || args.length > 2) { console.error(USAGE); process.exit(2); }
    const feed = verifyRelease(tag, dir);
    console.log(`✓ ${tag}: latest.json present, ${Object.keys(feed.platforms).join(' + ')} signed by the app key, every asset there`);
  } else if (first === 'gate' || first === 'latest-after') {
    // In Actions: GITHUB_REPOSITORY, GITHUB_API_URL and GH_TOKEN come from the runner and the step.
    const [kind, tag, before] = args;
    if (args.length !== (first === 'gate' ? 2 : 3)) { console.error(USAGE); process.exit(2); }
    const opts = { apiBase: process.env.GITHUB_API_URL || undefined, token: process.env.GH_TOKEN };
    try {
      const { latest, state } = await readReleaseState(process.env.GITHUB_REPOSITORY ?? '', tag, opts);
      if (first === 'gate') {
        checkPublish(kind, tag, latest, state);
        console.error(`✓ ${kind} ${tag} (${state}) may run; releases/latest is ${latest}`);
        process.stdout.write(`${latest}\n`); // the "before" the run's latest-after check compares with
      } else {
        checkLatestAfter(kind, tag, before, latest);
        console.log(`✓ releases/latest is ${latest}`);
      }
    } catch (e) { console.error(`::error::${e.message}`); process.exit(1); }
  } else if (first === 'fetch-feed') {
    const [url, out] = args;
    if (!url || !out || args.length > 2) { console.error(USAGE); process.exit(2); }
    let text;
    try { text = await fetchFeed(url); } catch (e) { console.error(`::error::${e.message}; not treated as "no feed yet"`); process.exit(1); }
    rmSync(out, { force: true });
    if (text === null) console.log(`no feed at ${url} yet (404)`);
    else writeFileSync(out, text);
  } else {
    const [dir, ...rest] = args;
    const flags = parseFlags(rest);
    if (!first || !dir || !flags) { console.error(USAGE); process.exit(2); }
    const entries = readEntries(dir);
    const out = buildLatestJson(first, entries);
    const released = appPubkey();
    verifyEntries(entries, dir, (e) => (flags.dryRun ? e.pubkey : released));
    if (flags.channel) {
      let currentText = null;
      try { currentText = readFileSync(join(dir, 'current-beta.json'), 'utf-8'); } catch { currentText = null; }
      writeFileSync(join(dir, 'beta.json'), pickBetaJson(out, currentText));
    }
    process.stdout.write(out);
  }
}
