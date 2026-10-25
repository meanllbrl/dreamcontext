import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error — plain .mjs release script, no type declarations
import { buildLatestJson, verifyMinisign, appPubkey, PLATFORM_ORDER } from '../../scripts/release-latest-json.mjs';
import { WIN_SETUP_ASSET } from '../../src/lib/app-windows.js';

/**
 * scripts/release-latest-json.mjs is the one writer of the in-app updater's latest.json
 * (.github/workflows/desktop-release.yml, job `assemble`). The fixture under
 * tests/fixtures/release-updater-sig was signed by `tauri signer sign` with a throwaway key, so
 * the verifier is checked against tauri's real .sig format, not against a signer of our own.
 */

const ROOT = join(__dirname, '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'release-updater-sig');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const SIG = readFileSync(join(FIX, 'example-setup.exe.sig'), 'utf-8');
const PUB = readFileSync(join(FIX, 'throwaway.key.pub'), 'utf-8');
const DATA = readFileSync(join(FIX, 'example-setup.exe'));
const AT = new Date('2026-10-25T12:00:00.123Z');
const REPO = 'https://github.com/example-owner/example-repo/releases/download';

const mac = { key: 'darwin-aarch64', signature: 'c2lnLW1hYw==', url: `${REPO}/v1.2.3/dreamcontext-beta_1.2.3_aarch64.app.tar.gz` };
const win = { key: 'windows-x86_64', signature: 'c2lnLXdpbg==', url: `${REPO}/v1.2.3/${WIN_SETUP_ASSET}` };

/** What the macOS job's jq printed before the merge, for the same inputs. */
const jqMacOnly = (sig: string, url: string, date: string) =>
  `{\n  "version": "1.2.3",\n  "notes": "",\n  "pub_date": "${date}",\n  "platforms": {\n    "darwin-aarch64": {\n      "signature": "${sig}",\n      "url": "${url}"\n    }\n  }\n}\n`;

describe('buildLatestJson', () => {
  it('a Mac-only release is byte-for-byte the old jq output', () => {
    expect(buildLatestJson('1.2.3', [mac], AT)).toBe(jqMacOnly(mac.signature, mac.url, '2026-10-25T12:00:00Z'));
  });

  it('merges windows-x86_64 after darwin-aarch64, whatever order the files came in', () => {
    const json = JSON.parse(buildLatestJson('1.2.3', [win, mac], AT));
    expect(Object.keys(json)).toEqual(['version', 'notes', 'pub_date', 'platforms']);
    expect(Object.keys(json.platforms)).toEqual(['darwin-aarch64', 'windows-x86_64']);
    expect(json.platforms['windows-x86_64']).toEqual({ signature: win.signature, url: win.url });
    expect(PLATFORM_ORDER[0]).toBe('darwin-aarch64');
  });

  it('never writes an entry pubkey (a dry run carries one) into latest.json', () => {
    const out = buildLatestJson('1.2.3', [{ ...mac, pubkey: PUB }], AT);
    expect(out).not.toContain('pubkey');
  });

  it('refuses a release without the Mac entry, a duplicate, an empty signature or a foreign URL', () => {
    expect(() => buildLatestJson('1.2.3', [win], AT)).toThrow(/darwin-aarch64/);
    expect(() => buildLatestJson('1.2.3', [mac, mac], AT)).toThrow(/twice/);
    expect(() => buildLatestJson('1.2.3', [mac, { ...win, signature: ' ' }], AT)).toThrow(/empty signature/);
    expect(() => buildLatestJson('1.2.3', [mac, { ...win, url: `${REPO}/v9.9.9/${WIN_SETUP_ASSET}` }], AT)).toThrow(/not an asset of release v1.2.3/);
    expect(() => buildLatestJson('1.2.3', [mac, { ...win, url: `https://evil.example/v1.2.3/${WIN_SETUP_ASSET}` }], AT)).toThrow(/not an asset/);
    expect(() => buildLatestJson('1.2.3', [mac, { ...win, key: 'windows-x64' }], AT)).toThrow(/unknown platform key/);
    expect(() => buildLatestJson('v1.2.3', [mac], AT)).toThrow(/X\.Y\.Z/);
  });
});

describe('verifyMinisign (tauri .sig format)', () => {
  it('accepts the tauri-signed fixture with its key', () => {
    expect(verifyMinisign(DATA, SIG, PUB)).toBe(true);
  });

  it('refuses changed bytes, another key, and a tampered trusted comment', () => {
    expect(verifyMinisign(Buffer.concat([DATA, Buffer.from('x')]), SIG, PUB)).toBe(false);
    expect(verifyMinisign(DATA, SIG, appPubkey(ROOT))).toBe(false);
    const text = Buffer.from(SIG, 'base64').toString('utf-8').replace('file:example-setup.exe', 'file:other.exe');
    expect(verifyMinisign(DATA, Buffer.from(text).toString('base64'), PUB)).toBe(false);
  });

  it('the app pubkey parses (the key every installed app checks updates against)', () => {
    expect(() => verifyMinisign(DATA, SIG, appPubkey(ROOT))).not.toThrow();
  });
});

describe('the release script end to end', () => {
  function stage(entries: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'dc-release-json-'));
    writeFileSync(join(dir, WIN_SETUP_ASSET), DATA);
    writeFileSync(join(dir, 'dreamcontext-beta_1.2.3_aarch64.app.tar.gz'), DATA);
    entries.forEach((e: any) => writeFileSync(join(dir, `platform-${e.key}.json`), JSON.stringify(e)));
    return dir;
  }
  const run = (args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'release-latest-json.mjs'), ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('--dry-run checks each entry against its own pubkey and prints both platforms', () => {
    const dir = stage([{ ...mac, signature: SIG, pubkey: PUB }, { ...win, signature: SIG, pubkey: PUB }]);
    try {
      const json = JSON.parse(run(['1.2.3', dir, '--dry-run']));
      expect(Object.keys(json.platforms)).toEqual(['darwin-aarch64', 'windows-x86_64']);
      expect(json.platforms['windows-x86_64'].signature).toBe(SIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a release refuses a payload signed by any key but the app pubkey, even if the entry names it', () => {
    const dir = stage([{ ...mac, signature: SIG, pubkey: PUB }]);
    try {
      expect(() => run(['1.2.3', dir])).toThrow(/does not verify/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('desktop-release.yml and the CLI agree on the Windows asset', () => {
  const wf = read('.github/workflows/desktop-release.yml');

  it('the workflow publishes the installer the CLI downloads, with its .sha256 and .sig', () => {
    expect(wf).toContain(WIN_SETUP_ASSET);
    expect(wf).toContain(`${WIN_SETUP_ASSET}.sha256`);
    expect(wf).toContain(`${WIN_SETUP_ASSET}.sig`);
  });

  it('only the assemble job writes latest.json, and a dry run never reaches the publish job', () => {
    expect(wf.match(/release-latest-json\.mjs/g)?.length).toBe(1);
    expect(wf).not.toMatch(/platforms: \{"darwin-aarch64"/);
    const publish = wf.slice(wf.indexOf('\n  publish:'));
    expect(publish).toMatch(/if: \$\{\{ !cancelled\(\) && needs\.assemble\.result == 'success' && !inputs\.dry_run \}\}/);
  });

  it('the Windows build is updater-signed and compiled with the in-app updater', () => {
    const win = wf.slice(wf.indexOf('\n  build-windows:'), wf.indexOf('\n  assemble:'));
    expect(win).toContain('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}');
    expect(win).toContain("DREAMCONTEXT_UPDATER: '1'");
    expect(win).toContain('createUpdaterArtifacts');
  });
});
