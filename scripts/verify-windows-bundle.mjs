#!/usr/bin/env node
// The security gate on a built Windows install (plan npmsiz-beta C1 +Windows), run by the release
// job on the installed folder before anything is published:
//
//   node scripts/verify-windows-bundle.mjs <installdir>
//
// Fails (exit 1, one line per defect) unless:
//   - runtime/node.exe matches the binary pin fetch-bundled-node.mjs recorded (runtime/runtime-pin.json)
//   - runtime/node.exe carries a VALID Authenticode signature by the OpenJS Foundation (Windows only:
//     PowerShell's Get-AuthenticodeSignature, called with an argv array and no shell)
//   - every file matches rt-manifest.json (no file missing, changed or added under its parts)
//
// Written in Node rather than PowerShell so its pin and manifest checks are tested on every OS; the
// signature check runs where Windows can answer it, and `--skip-authenticode` exists for the
// fixture test on other systems only (the release job never passes it).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareWithManifest } from './gen-rt-manifest.mjs';

/** The signer's subject must carry exactly the RDN `O=OpenJS Foundation` (not a longer name, not text inside a CN). */
export function isOpenJsSubject(subject) {
  return String(subject ?? '').split(/,\s*(?=[A-Z]+=)/).some((rdn) => rdn.trim() === 'O=OpenJS Foundation');
}

/** The Authenticode status and signer subject of a file, from PowerShell (Windows only). */
export function authenticode(file, run = execFileSync) {
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    // The path arrives as an argument, never pasted into the script text.
    '$s = Get-AuthenticodeSignature -LiteralPath $args[0]; [pscustomobject]@{status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress',
    file,
  ];
  const out = run('powershell.exe', ps, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(String(out));
}

/** Every defect of the install at `dir`. `signature` answers the Authenticode question (injectable). */
export function verifyWindowsInstall(dir, { signature = (f) => authenticode(f) } = {}) {
  const problems = [];
  const node = join(dir, 'runtime', 'node.exe');
  let pin = null;
  try { pin = JSON.parse(readFileSync(join(dir, 'runtime', 'runtime-pin.json'), 'utf-8')); } catch { problems.push('runtime/runtime-pin.json is missing or not JSON'); }
  let bytes = null;
  try { bytes = readFileSync(node); } catch { problems.push('runtime/node.exe is missing'); }
  if (pin && bytes) {
    if (!/^[a-f0-9]{64}$/.test(pin.binarySha256 ?? '')) problems.push('runtime-pin.json has no binarySha256');
    else if (createHash('sha256').update(bytes).digest('hex') !== pin.binarySha256) problems.push('runtime/node.exe does not match its pin');
  }
  if (bytes && signature) {
    let s = null;
    try { s = signature(node); } catch (e) { problems.push(`runtime/node.exe: the Authenticode check failed to run (${e.message})`); }
    if (s) {
      if (s.status !== 'Valid') problems.push(`runtime/node.exe: Authenticode status ${s.status}`);
      else if (!isOpenJsSubject(s.subject)) problems.push(`runtime/node.exe: signed by "${s.subject}", not the OpenJS Foundation`);
    }
  }
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(join(dir, 'rt-manifest.json'), 'utf-8')); } catch { problems.push('rt-manifest.json is missing or not JSON'); }
  if (manifest) problems.push(...compareWithManifest(dir, manifest));
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const skip = args.includes('--skip-authenticode');
  const [dir] = args.filter((a) => a !== '--skip-authenticode');
  if (!dir || args.length > 2 || (args.length === 2 && !skip)) {
    console.error('usage: verify-windows-bundle.mjs <installdir>');
    process.exit(2);
  }
  if (!skip && process.platform !== 'win32') {
    console.error('::error::the Authenticode check needs Windows');
    process.exit(2);
  }
  const problems = verifyWindowsInstall(resolve(dir), skip ? { signature: null } : {});
  for (const p of problems) console.log(`DEFECT: ${p}`);
  if (problems.length) process.exit(1);
  console.log('✓ node.exe matches its pin and is signed by the OpenJS Foundation; every file matches rt-manifest.json');
}
