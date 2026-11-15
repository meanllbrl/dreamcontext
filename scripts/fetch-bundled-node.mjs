#!/usr/bin/env node
// Puts the pinned official Node binary into the desktop bundle's resources (plan npmsiz-beta C1):
//
//   node scripts/fetch-bundled-node.mjs darwin-arm64   → desktop/src-tauri/resources/runtime/bin/node
//   node scripts/fetch-bundled-node.mjs win-x64        → desktop/src-tauri/resources/runtime/node.exe
//
// The archive comes from the pin in assets/runtime-pins.json (nodejs.org, https only) and its
// size and sha256 are checked BEFORE anything is unpacked. Only the one binary and Node's
// LICENSE are taken out, into a fresh 0700 folder, and each must be a regular file (no link, no
// path outside the folder). `runtime-pin.json` beside the binary records the archive pin and the
// binary's own sha256: the Windows verifier compares the shipped node.exe with it (on the Mac the
// re-signing changes the bytes, so the Mac verifier checks the signature instead).
//
// Options: --archive <file> (a local copy of the pinned archive, still checked against the pin),
// --pins <file> and --out <dir> (tests). The output folder is gitignored.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 200 * 1024 * 1024;

/** What each supported platform takes from its archive, and where it lands under `out`. */
export const TARGETS = {
  'darwin-arm64': { pinGroup: 'node', binary: 'bin/node', dest: 'bin/node', mode: 0o755 },
  'win-x64': { pinGroup: 'nodeWindows', binary: 'node.exe', dest: 'node.exe', mode: 0o755 },
};

/** The pin for `platform`, checked: a plain file name, a sha256, a size and an https base. */
export function pinFor(pins, platform) {
  const t = TARGETS[platform];
  if (!t) throw new Error(`unsupported platform ${platform} (supported: ${Object.keys(TARGETS).join(', ')})`);
  const version = pins.node?.version;
  const base = pins.node?.base;
  const entry = pins[t.pinGroup]?.files?.[platform];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('the pins carry no plain node.version');
  if (typeof base !== 'string' || !base.startsWith('https://nodejs.org/dist/v')) throw new Error('the node pin base must be https://nodejs.org/dist/v…');
  if (!entry || !/^node-v[\d.]+-[a-z0-9-]+\.(tar\.gz|zip)$/.test(entry.file ?? '') || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || !(entry.size > 0)) {
    throw new Error(`no complete pin for ${platform}`);
  }
  const stem = entry.file.replace(/\.(tar\.gz|zip)$/, '');
  return { version, url: base + entry.file, file: entry.file, sha256: entry.sha256, size: entry.size, stem, ...t };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The archive bytes, checked against the pin (size first, then sha256). Throws on any mismatch. */
export function checkArchive(buf, pin) {
  if (buf.length !== pin.size) throw new Error(`${pin.file}: ${buf.length} bytes, the pin says ${pin.size}`);
  const got = sha256(buf);
  if (got !== pin.sha256) throw new Error(`${pin.file}: sha256 ${got} does not match the pin ${pin.sha256}`);
}

async function download(url) {
  if (!url.startsWith('https://')) throw new Error(`refusing a non-https download: ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status !== 200) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error(`${url} is ${len} bytes, over the ${MAX_BYTES} cap`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`${url} is over the ${MAX_BYTES} cap`);
  return buf;
}

/** A path inside `dir` that is a regular file (lstat: a link is refused). */
function regularInside(dir, rel) {
  const p = resolve(dir, rel);
  if (!p.startsWith(resolve(dir) + sep)) throw new Error(`${rel} is outside the unpack folder`);
  const st = lstatSync(p);
  if (!st.isFile()) throw new Error(`${rel} in the archive is not a regular file`);
  return p;
}

/**
 * Unpacks `members` of the checked archive into a fresh 0700 folder with the system tar (bsdtar on
 * macOS and Windows reads .zip too) and returns that folder. Only the named members are asked for.
 */
function unpack(archivePath, members) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-node-unpack-'));
  chmodSync(dir, 0o700);
  execFileSync('tar', ['-xf', archivePath, '-C', dir, ...members], { stdio: ['ignore', 'ignore', 'pipe'] });
  return dir;
}

/** Fetch (or read), check, unpack and place the binary. Returns what it wrote. */
export async function fetchBundledNode(platform, { pinsPath = join(ROOT, 'assets/runtime-pins.json'), out = join(ROOT, 'desktop/src-tauri/resources/runtime'), archive = null } = {}) {
  const pin = pinFor(JSON.parse(readFileSync(pinsPath, 'utf-8')), platform);
  const buf = archive ? readFileSync(archive) : await download(pin.url);
  checkArchive(buf, pin);
  const work = mkdtempSync(join(tmpdir(), 'dc-node-archive-'));
  chmodSync(work, 0o700);
  let unpacked = null;
  try {
    const archivePath = join(work, pin.file);
    writeFileSync(archivePath, buf);
    const binMember = `${pin.stem}/${pin.binary}`;
    const licMember = `${pin.stem}/LICENSE`;
    unpacked = unpack(archivePath, [binMember, licMember]);
    const bin = regularInside(unpacked, binMember);
    const lic = regularInside(unpacked, licMember);
    const binSha = sha256(readFileSync(bin));
    // Into place through a temp name in the same folder, so a half-written binary never ships.
    const dest = join(out, pin.dest);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    try {
      copyFileSync(bin, tmp);
      chmodSync(tmp, pin.mode);
      renameSync(tmp, dest);
    } finally { rmSync(tmp, { force: true }); }
    // Only this platform's binary stays: a folder that also held the other platform's would ship it.
    for (const t of Object.values(TARGETS)) if (t.dest !== pin.dest) rmSync(join(out, t.dest), { force: true });
    copyFileSync(lic, join(out, 'LICENSE-node'));
    const record = { platform, version: pin.version, archive: pin.file, archiveSha256: pin.sha256, binary: pin.dest, binarySha256: binSha };
    writeFileSync(join(out, 'runtime-pin.json'), JSON.stringify(record, null, 2) + '\n');
    return { dest, ...record };
  } finally {
    rmSync(work, { recursive: true, force: true });
    if (unpacked) rmSync(unpacked, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]];
    if (!v || !['--archive', '--pins', '--out'].includes(k)) {
      console.error('usage: fetch-bundled-node.mjs darwin-arm64|win-x64 [--archive <file>] [--pins <file>] [--out <dir>]');
      process.exit(2);
    }
    opts[k === '--pins' ? 'pinsPath' : k.slice(2)] = resolve(v);
  }
  try {
    const r = await fetchBundledNode(platform, opts);
    console.log(`✓ Node ${r.version} ${platform} → ${r.dest} (sha256 ${r.binarySha256})`);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
