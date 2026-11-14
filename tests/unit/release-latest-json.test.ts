import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
// @ts-expect-error — plain .mjs release script, no type declarations
import { buildLatestJson, verifyMinisign, appPubkey, PLATFORM_ORDER, pickBetaJson, verifyRelease, parseFeed, checkForward, fetchFeed, checkPublish, checkLatestAfter, readReleaseState } from '../../scripts/release-latest-json.mjs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
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
    // The writing form (`<version> <dir>`) runs once; promote only `verify`s and `pick-beta`s.
    expect(wf.match(/release-latest-json\.mjs "\$VERSION"/g)?.length).toBe(1);
    expect(wf.slice(wf.indexOf('\n  assemble:'), wf.indexOf('\n  publish:'))).toMatch(/release-latest-json\.mjs "\$VERSION"/);
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

// ─── The beta channel (plan npmsiz-beta C10, criterion 2) ─────────────────────

const feed = (version: string) => buildLatestJson(version, [
  { key: 'darwin-aarch64', signature: 'c2ln', url: `${REPO}/v${version}/dreamcontext-beta_${version}_aarch64.app.tar.gz` },
], AT);

describe('pickBetaJson: beta.json is the newer of beta and stable', () => {
  it('this release when it is newer, or when nothing is published yet', () => {
    expect(pickBetaJson(feed('1.3.0'), feed('1.2.9'))).toBe(feed('1.3.0'));
    expect(pickBetaJson(feed('1.3.0'), null)).toBe(feed('1.3.0'));
    expect(pickBetaJson(feed('1.3.0'), feed('1.3.0'))).toBe(feed('1.3.0'));
  });
  it('the published beta when it is newer (a stable hotfix below a running beta)', () => {
    expect(pickBetaJson(feed('1.2.4'), feed('1.3.0'))).toBe(feed('1.3.0'));
  });
  it('a published beta.json that does not parse is replaced; a broken candidate throws', () => {
    expect(pickBetaJson(feed('1.2.4'), '{not json')).toBe(feed('1.2.4'));
    expect(pickBetaJson(feed('1.2.4'), JSON.stringify({ version: '9.9.9', platforms: { 'darwin-aarch64': { signature: 's', url: 'https://evil.example/x' } } }))).toBe(feed('1.2.4'));
    expect(() => pickBetaJson('{}', null)).toThrow();
    expect(() => parseFeed(JSON.stringify({ version: '1.0.0', platforms: {} }))).toThrow(/no platform/);
  });
});

describe('verifyRelease: promote refuses a release that is not whole', () => {
  function stageRelease(over: { latest?: string | null; skip?: string[]; sig?: string } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'dc-promote-'));
    const name = 'dreamcontext-beta_1.2.3_aarch64.app.tar.gz';
    const files: Record<string, string | Buffer> = {
      [name]: DATA, [`${name}.sha256`]: 'x', [`${name}.sig`]: SIG, 'dreamcontext-beta_aarch64.dmg': 'dmg',
      [WIN_SETUP_ASSET]: DATA, [`${WIN_SETUP_ASSET}.sig`]: SIG,
    };
    for (const [f, b] of Object.entries(files)) if (!over.skip?.includes(f)) writeFileSync(join(dir, f), b);
    const latest = over.latest !== undefined ? over.latest : buildLatestJson('1.2.3', [
      { key: 'darwin-aarch64', signature: over.sig ?? SIG, url: `${REPO}/v1.2.3/${name}` },
      { key: 'windows-x86_64', signature: over.sig ?? SIG, url: `${REPO}/v1.2.3/${WIN_SETUP_ASSET}` },
    ], AT);
    if (latest !== null) writeFileSync(join(dir, 'latest.json'), latest);
    return dir;
  }
  const withDir = (dir: string, fn: (d: string) => void) => { try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

  it('passes a whole release signed by the trusted key', () => {
    withDir(stageRelease(), (d) => expect(verifyRelease('v1.2.3', d, PUB).version).toBe('1.2.3'));
  });
  it('refuses a release with no latest.json', () => {
    withDir(stageRelease({ latest: null }), (d) => expect(() => verifyRelease('v1.2.3', d, PUB)).toThrow(/no latest\.json/));
  });
  it('refuses a latest.json naming another version', () => {
    withDir(stageRelease(), (d) => expect(() => verifyRelease('v1.2.4', d, PUB)).toThrow(/names 1\.2\.3, not v1\.2\.4/));
  });
  it('refuses a missing asset (the payload, its .sha256, its .sig, the DMG)', () => {
    for (const f of [WIN_SETUP_ASSET, 'dreamcontext-beta_1.2.3_aarch64.app.tar.gz.sha256', 'dreamcontext-beta_1.2.3_aarch64.app.tar.gz.sig', 'dreamcontext-beta_aarch64.dmg']) {
      withDir(stageRelease({ skip: [f] }), (d) => expect(() => verifyRelease('v1.2.3', d, PUB), f).toThrow(/missing/));
    }
  });
  it('refuses a signature the app key did not make (every signature is re-verified)', () => {
    withDir(stageRelease(), (d) => expect(() => verifyRelease('v1.2.3', d)).toThrow(/does not verify/));
  });
});

describe('the release script: --channel', () => {
  function stage(entries: object[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'dc-release-chan-'));
    writeFileSync(join(dir, WIN_SETUP_ASSET), DATA);
    writeFileSync(join(dir, 'dreamcontext-beta_1.2.3_aarch64.app.tar.gz'), DATA);
    entries.forEach((e: any) => writeFileSync(join(dir, `platform-${e.key}.json`), JSON.stringify(e)));
    return dir;
  }
  const run = (args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'release-latest-json.mjs'), ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = [{ ...mac, signature: SIG, pubkey: PUB }, { ...win, signature: SIG, pubkey: PUB }];
  /** latest.json without its pub_date, which is the time of the run. */
  const dateless = (t: string) => t.replace(/"pub_date": "[^"]+"/, '"pub_date": "-"');

  it('with no --channel prints what it always printed, and writes no beta.json', () => {
    const dir = stage(entries);
    try {
      const out = run(['1.2.3', dir, '--dry-run']);
      expect(dateless(out)).toBe(dateless(buildLatestJson('1.2.3', entries, AT)));
      expect(() => readFileSync(join(dir, 'beta.json'))).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['beta', 'stable'])('channel %s: the same latest.json, plus a beta.json naming it when nothing newer is published', (channel) => {
    const dir = stage(entries);
    try {
      const out = run(['1.2.3', dir, '--dry-run', '--channel', channel]);
      expect(dateless(out)).toBe(dateless(buildLatestJson('1.2.3', entries, AT)));
      expect(readFileSync(join(dir, 'beta.json'), 'utf-8')).toBe(out);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('channel stable under a newer published beta: beta.json keeps naming the beta', () => {
    const dir = stage(entries);
    try {
      writeFileSync(join(dir, 'current-beta.json'), feed('1.3.0'));
      run(['1.2.3', dir, '--dry-run', '--channel', 'stable']);
      expect(JSON.parse(readFileSync(join(dir, 'beta.json'), 'utf-8')).version).toBe('1.3.0');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses an unknown channel or flag', () => {
    const dir = stage(entries);
    try {
      expect(() => run(['1.2.3', dir, '--channel', 'nightly'])).toThrow();
      expect(() => run(['1.2.3', dir, '--yes'])).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('desktop-release.yml: the two channels', () => {
  const wf = read('.github/workflows/desktop-release.yml');
  const doc = parseYaml(wf) as any;
  const steps = (job: string) => doc.jobs[job].steps as Array<{ name?: string; run?: string; with?: Record<string, unknown>; if?: string; uses?: string }>;
  const step = (job: string, name: RegExp) => steps(job).find((s) => name.test(s.name ?? ''))!;

  it('dispatch takes channel (required, no default), allow-migration-in-beta and promote', () => {
    const inputs = doc.on.workflow_dispatch.inputs;
    expect(inputs.channel).toMatchObject({ type: 'choice', required: true });
    expect([...inputs.channel.options].sort()).toEqual(['beta', 'stable']);
    expect(inputs.channel.default).toBeUndefined();
    expect(inputs['allow-migration-in-beta']).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.promote).toMatchObject({ type: 'boolean', default: false });
  });

  // Edge-case review W1 r1 (release-channel-isolation): a tag push meant stable, and a beta
  // needs a tag, so cutting a beta also published it to every stable user.
  it('no tag-push trigger: every run is a dispatch that names its channel, from the tag it publishes', () => {
    expect(Object.keys(doc.on)).toEqual(['workflow_dispatch']);
    for (const job of ['build-macos', 'build-windows']) {
      const resolve = step(job, /Resolve version/).run!;
      expect(resolve, job).toContain('CHANNEL="$INPUT_CHANNEL"');
      expect(resolve, job).not.toContain(':-stable');
      expect(resolve, job).toMatch(/GITHUB_REF_TYPE" != tag \] \|\| \[ "\$GITHUB_REF_NAME" != "\$TAG"/);
    }
  });

  // beta-feed-monotonic: beta.json is read in assemble and written in publish; two runs in flight
  // would interleave that read and write.
  it('publishes and promotes run one at a time, never cancelling the one in progress; dry runs do not wait', () => {
    expect(doc.concurrency).toEqual({ group: "desktop-release-${{ inputs.dry_run && github.run_id || 'publish' }}", 'cancel-in-progress': false });
  });

  it('beta.json is fetched only through fetch-feed (404 = none yet), never a curl that treats every failure as absent', () => {
    expect(wf).not.toMatch(/curl[^\n]*channel-beta/);
    expect(step('assemble', /write latest\.json and beta\.json/).run).toContain('release-latest-json.mjs fetch-feed "https://github.com/${GITHUB_REPOSITORY}/releases/download/channel-beta/beta.json" current-beta.json');
    expect(step('promote', /Mark it stable/).run).toContain('release-latest-json.mjs fetch-feed "https://github.com/$R/releases/download/channel-beta/beta.json" current-beta.json');
  });

  // stable-latest-monotonic (W1 r1 + r2): ONE gate before every publish and promote, and one
  // post-check of releases/latest after each.
  it('every publish runs the one gate before anything is written, and checks releases/latest after', () => {
    const names = steps('publish').map((s) => s.name ?? '');
    const gate = names.findIndex((n) => /^Gate - releases\/latest only moves forward/.test(n));
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(names.findIndex((n) => /Publish to GitHub Releases/.test(n)));
    expect(gate).toBeLessThan(names.findIndex((n) => /Rewrite beta\.json/.test(n)));
    const g = step('publish', /^Gate/);
    expect(g.if).toBeUndefined(); // every channel, not only stable
    expect(g.run).toContain('release-latest-json.mjs gate "$CHANNEL" "$TAG"');
    expect(step('publish', /Check where each feed points/).run).toContain('release-latest-json.mjs latest-after "$CHANNEL" "$TAG" "$BEFORE"');
    expect(wf).not.toMatch(/release-latest-json\.mjs forward/);
  });

  // W1 review r3: `echo "before=$(gate)"` lost the gate's exit code, so a refused publish went on.
  // Every call of the release script in the workflow is a plain command or an assignment.
  it('no release-script call sits inside another command\'s arguments (its exit code must stop the step)', () => {
    const calls = wf.split('\n').map((l) => l.trim()).filter((l) => l.includes('release-latest-json.mjs') && !l.startsWith('#') && !l.startsWith('name:'));
    expect(calls.length).toBeGreaterThan(5);
    for (const l of calls) {
      const plain = /^node (\.\.\/|src\/)?scripts\/release-latest-json\.mjs /.test(l) && !l.includes('$(');
      const assigned = /^[A-Z_]+="\$\(node (src\/)?scripts\/release-latest-json\.mjs [^$]*\)"$/.test(l.replace(/"\$[A-Z_]+"/g, 'X'));
      expect(plain || assigned, l).toBe(true);
    }
    expect(wf).not.toMatch(/ "\$\(cat before\.txt\)"/); // as an argument; the assignment is fine
  });

  it('the gate step fails when the gate refuses (run in bash -eo pipefail, as Actions does, with a refusing node)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-gate-step-'));
    try {
      writeFileSync(join(dir, 'node'), '#!/bin/sh\necho "::error::refused" >&2\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(dir, 'step.sh'), step('publish', /^Gate/).run!);
      const out = join(dir, 'out.txt');
      const res = (() => {
        try {
          execFileSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')], {
            env: { PATH: `${dir}:/usr/bin:/bin`, GITHUB_OUTPUT: out, CHANNEL: 'beta', TAG: 'v0.34.0' }, stdio: 'pipe',
          });
          return 0;
        } catch (e: any) { return e.status as number; }
      })();
      expect(res).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('promote gates before downloading and again right before the flip; beta.json is written before it, latest checked after', () => {
    expect(step('promote', /verify every asset/).run).toContain('release-latest-json.mjs gate promote "$TAG"');
    const run = step('promote', /Mark it stable/).run!;
    const at = (needle: string) => run.indexOf(needle);
    for (const n of ['gate promote "$TAG"', 'fetch-feed', 'pick-beta', 'gh release upload channel-beta']) {
      expect(at(n), n).toBeGreaterThan(-1);
      expect(at(n), n).toBeLessThan(at('gh release edit'));
    }
    expect(at('latest-after promote "$TAG"')).toBeGreaterThan(at('gh release edit'));
  });

  it('a beta publishes as a prerelease never marked latest; a stable one as latest', () => {
    const pub = step('publish', /Publish to GitHub Releases/).with!;
    expect(pub.prerelease).toBe("${{ needs.build-macos.outputs.channel == 'beta' }}");
    expect(pub.make_latest).toBe("${{ needs.build-macos.outputs.channel == 'beta' && 'false' || 'true' }}");
  });

  it('channel-beta is created once as a prerelease that is never latest, and beta.json is replaced on it', () => {
    const run = step('publish', /beta\.json on the channel-beta/).run!;
    expect(run).toMatch(/gh release create channel-beta[^\n]*--prerelease --latest=false/);
    expect(run).toContain('gh release upload channel-beta dist-release/beta.json --clobber');
  });

  it('after every publish: stable = releases/latest, a beta is not, channel-beta is a prerelease and never latest', () => {
    const run = step('publish', /Check where each feed points/).run!;
    expect(run).toContain('latest-after "$CHANNEL" "$TAG" "$BEFORE"');
    expect(run).toMatch(/channel-beta -R "\$R" --json isPrerelease/);
  });

  it('every release carries latest.json, beta included', () => {
    expect(step('publish', /List the files/).run).toContain('$OUT/latest.json');
  });

  it('a beta build refuses a migration above stable unless the owner allows it', () => {
    const s = step('build-macos', /Beta brain safety/);
    expect(s.if).toBe("${{ steps.ver.outputs.channel == 'beta' }}");
    expect(s.run).toContain('node scripts/check-migration-channel.mjs --stable "${STABLE_TAG#v}"');
    expect(s.run).toContain('--allow');
  });

  it('every build job refuses a test feed setting before it builds', () => {
    for (const job of ['build-macos', 'build-windows']) {
      const names = steps(job).map((s) => s.name ?? '');
      const check = names.findIndex((n) => /Refuse a test feed setting/.test(n));
      const build = names.findIndex((n) => /^Build|^Dry run/.test(n));
      expect(check, job).toBeGreaterThan(-1);
      expect(check, job).toBeLessThan(build);
    }
  });

  it('promote is dispatch-only, in the tag-only release environment, and verifies before it flips the flag', () => {
    const p = doc.jobs.promote;
    expect(p.if).toBe('${{ inputs.promote && !inputs.dry_run }}');
    expect(p.environment).toBe('release');
    expect(p.permissions).toEqual({ contents: 'write' });
    const names = steps('promote').map((s) => s.name ?? '');
    const verify = names.findIndex((n) => /verify every asset/.test(n));
    const flip = names.findIndex((n) => /Mark it stable/.test(n));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(flip);
    expect(step('promote', /verify every asset/).run).toContain('node scripts/release-latest-json.mjs verify "$TAG" dist-release');
    expect(step('promote', /Mark it stable/).run).toContain('gh release edit "$TAG" -R "$R" --prerelease=false --latest');
    // Builds and publish never run on a promote.
    for (const job of ['build-macos', 'build-windows']) expect(doc.jobs[job].if).toBe('${{ !inputs.promote }}');
  });

  it('only publish and promote hold a write token', () => {
    const writers = Object.entries(doc.jobs).filter(([, j]: [string, any]) => j.permissions?.contents === 'write').map(([k]) => k).sort();
    expect(writers).toEqual(['promote', 'publish']);
    expect(doc.permissions).toEqual({ contents: 'read' });
  });
});

describe('checkForward: releases/latest only moves forward', () => {
  it('passes a newer tag, and the same tag only with sameOk', () => {
    expect(() => checkForward('v0.34.0', 'v0.33.9')).not.toThrow();
    expect(() => checkForward('v1.0.0', 'v0.99.99')).not.toThrow();
    expect(() => checkForward('v0.34.0', 'v0.34.0', { sameOk: true })).not.toThrow();
    expect(() => checkForward('v0.34.0', 'v0.34.0')).toThrow(/only moves forward/);
  });
  it('refuses an older tag (promoting a stale beta, re-publishing an old stable)', () => {
    expect(() => checkForward('v0.33.0', 'v0.34.0')).toThrow(/not newer than the stable v0\.34\.0/);
    expect(() => checkForward('v0.33.0', 'v0.34.0', { sameOk: true })).toThrow(/only moves forward/);
    expect(() => checkForward('v0.9.0', 'v0.10.0')).toThrow();
  });
  it('refuses anything but plain vX.Y.Z on either side (a failed lookup prints an empty string)', () => {
    for (const [a, b] of [['v1.0.0', ''], ['v1.0.0', 'null'], ['1.0.0', 'v0.1.0'], ['v1.0.0', 'channel-beta']]) {
      expect(() => checkForward(a, b), `${a} ${b}`).toThrow(/plain vX\.Y\.Z/);
    }
  });
});

describe('checkPublish: the one gate of stable, beta and promote', () => {
  it('stable: forward or the same tag (a re-run); never back', () => {
    expect(() => checkPublish('stable', 'v0.35.0', 'v0.34.0', 'none')).not.toThrow();
    expect(() => checkPublish('stable', 'v0.34.0', 'v0.34.0', 'release')).not.toThrow();
    expect(() => checkPublish('stable', 'v0.33.0', 'v0.34.0', 'release')).toThrow(/only moves forward/);
  });
  // W1 r2 finding: v0.34.0 promoted, then re-dispatched as beta "to add Windows".
  it('beta: never over an existing normal release, nor over the current latest', () => {
    expect(() => checkPublish('beta', 'v0.34.0', 'v0.34.0', 'release')).toThrow(/already a stable release/);
    expect(() => checkPublish('beta', 'v0.33.0', 'v0.34.0', 'release')).toThrow(/already a stable release/);
    expect(() => checkPublish('beta', 'v0.35.0', 'v0.34.0', 'none')).not.toThrow();
    expect(() => checkPublish('beta', 'v0.35.0', 'v0.34.0', 'prerelease')).not.toThrow(); // a beta re-run
  });
  it('promote: only a prerelease, strictly newer than latest', () => {
    expect(() => checkPublish('promote', 'v0.35.0', 'v0.34.0', 'prerelease')).not.toThrow();
    expect(() => checkPublish('promote', 'v0.33.0', 'v0.34.0', 'prerelease')).toThrow(/only moves forward/);
    expect(() => checkPublish('promote', 'v0.35.0', 'v0.34.0', 'none')).toThrow(/not a beta/);
    expect(() => checkPublish('promote', 'v0.35.0', 'v0.34.0', 'release')).toThrow(/not a beta/);
  });
  it('refuses an unknown kind, state or tag', () => {
    expect(() => checkPublish('nightly', 'v1.0.0', 'v0.1.0', 'none')).toThrow(/unknown kind/);
    expect(() => checkPublish('beta', 'v1.0.0', 'v0.1.0', 'draft')).toThrow(/unknown tag state/);
    expect(() => checkPublish('beta', 'v1.0.0', '', 'none')).toThrow(/plain vX\.Y\.Z/);
  });
  it('after the run: stable and promote = the tag, beta = exactly what it was', () => {
    expect(() => checkLatestAfter('stable', 'v0.35.0', 'v0.34.0', 'v0.35.0')).not.toThrow();
    expect(() => checkLatestAfter('promote', 'v0.35.0', 'v0.34.0', 'v0.35.0')).not.toThrow();
    expect(() => checkLatestAfter('beta', 'v0.35.0', 'v0.34.0', 'v0.34.0')).not.toThrow();
    expect(() => checkLatestAfter('beta', 'v0.34.0', 'v0.34.0', 'v0.33.0')).toThrow(/must be v0\.34\.0/);
    expect(() => checkLatestAfter('stable', 'v0.35.0', 'v0.34.0', 'v0.34.0')).toThrow();
  });
  it('after the run: a lost "before" (empty) is refused, never compared against', () => {
    expect(() => checkLatestAfter('beta', 'v0.35.0', '', 'v0.34.0')).toThrow(/plain vX\.Y\.Z/);
    expect(() => checkLatestAfter('promote', 'v0.35.0', '', 'v0.35.0')).toThrow(/plain vX\.Y\.Z/);
  });
});

describe('readReleaseState and the gate CLI against a GitHub-shaped API', () => {
  async function api(routes: Record<string, [number, unknown]>) {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers.authorization ?? ''}`);
      const [status, body] = routes[req.url ?? ''] ?? [404, { message: 'Not Found' }];
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
  }
  const R = '/repos/example-owner/example-repo';
  it('latest + none / prerelease / release; a 5xx or no latest throws', async () => {
    const s = await api({
      [`${R}/releases/latest`]: [200, { tag_name: 'v0.34.0' }],
      [`${R}/releases/tags/v0.34.0`]: [200, { prerelease: false }],
      [`${R}/releases/tags/v0.35.0`]: [200, { prerelease: true }],
      [`${R}/releases/tags/v0.36.0`]: [502, {}],
    });
    try {
      const o = { apiBase: s.base, token: 'example-token' };
      expect(await readReleaseState('example-owner/example-repo', 'v0.34.0', o)).toEqual({ latest: 'v0.34.0', state: 'release' });
      expect(await readReleaseState('example-owner/example-repo', 'v0.35.0', o)).toEqual({ latest: 'v0.34.0', state: 'prerelease' });
      expect(await readReleaseState('example-owner/example-repo', 'v0.37.0', o)).toEqual({ latest: 'v0.34.0', state: 'none' });
      await expect(readReleaseState('example-owner/example-repo', 'v0.36.0', o)).rejects.toThrow(/HTTP 502/);
      await expect(readReleaseState('example-owner/other', 'v0.35.0', o)).rejects.toThrow(/no releases\/latest/);
      expect(s.seen[0]).toContain('Bearer example-token');
    } finally { await s.close(); }
  });
  it('the CLI: gate prints latest-before and exits 0, refuses with 1; latest-after compares', async () => {
    const s = await api({
      [`${R}/releases/latest`]: [200, { tag_name: 'v0.34.0' }],
      [`${R}/releases/tags/v0.34.0`]: [200, { prerelease: false }],
    });
    const cli = (args: string[]) => new Promise<{ code: number; out: string }>((r) => {
      execFile(process.execPath, [join(ROOT, 'scripts', 'release-latest-json.mjs'), ...args], {
        env: { ...process.env, GITHUB_REPOSITORY: 'example-owner/example-repo', GITHUB_API_URL: s.base, GH_TOKEN: 'example-token' },
      }, (e: any, out) => r({ code: e ? e.code : 0, out: String(out) }));
    });
    try {
      expect(await cli(['gate', 'stable', 'v0.35.0'])).toEqual({ code: 0, out: 'v0.34.0\n' });
      expect((await cli(['gate', 'beta', 'v0.34.0'])).code).toBe(1);
      expect((await cli(['gate', 'stable', 'v0.33.0'])).code).toBe(1);
      expect((await cli(['gate', 'stable'])).code).toBe(2);
      expect((await cli(['latest-after', 'beta', 'v0.35.0', 'v0.34.0'])).code).toBe(0);
      expect((await cli(['latest-after', 'stable', 'v0.35.0', 'v0.34.0'])).code).toBe(1);
    } finally { await s.close(); }
  });
});

describe('fetchFeed: only a real 404 means "no beta feed yet"', () => {
  async function serve(status: number, body = feed('1.3.0')): Promise<{ url: string; close: () => Promise<void> }> {
    const srv = createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: '/feed' }); res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(status === 200 ? body : 'x');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const { port } = srv.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) };
  }
  it('200 → the text (also through a redirect, as release downloads are); 404 → null', async () => {
    const ok = await serve(200);
    try {
      expect(await fetchFeed(`${ok.url}/feed`)).toBe(feed('1.3.0'));
      expect(await fetchFeed(`${ok.url}/redirect`)).toBe(feed('1.3.0'));
    } finally { await ok.close(); }
    const missing = await serve(404);
    try { expect(await fetchFeed(`${missing.url}/feed`)).toBeNull(); } finally { await missing.close(); }
  });
  it('a 5xx, a 403 or a network error throws instead of reading as absent', async () => {
    for (const status of [500, 502, 503, 403]) {
      const s = await serve(status);
      try { await expect(fetchFeed(`${s.url}/feed`), String(status)).rejects.toThrow(new RegExp(`HTTP ${status}`)); } finally { await s.close(); }
    }
    const gone = await serve(200); await gone.close();
    await expect(fetchFeed(`${gone.url}/feed`)).rejects.toThrow();
  });
  it('the CLI form: 404 leaves no file (and removes a stale one), a 5xx exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-fetch-feed-'));
    const out = join(dir, 'current-beta.json');
    const cli = (url: string) => new Promise<number>((r) => {
      execFile(process.execPath, [join(ROOT, 'scripts', 'release-latest-json.mjs'), 'fetch-feed', url, out], (e: any) => r(e ? e.code : 0));
    });
    try {
      const ok = await serve(200);
      try { expect(await cli(`${ok.url}/feed`)).toBe(0); expect(readFileSync(out, 'utf-8')).toBe(feed('1.3.0')); } finally { await ok.close(); }
      const missing = await serve(404);
      try { expect(await cli(`${missing.url}/feed`)).toBe(0); expect(() => readFileSync(out)).toThrow(); } finally { await missing.close(); }
      const bad = await serve(503);
      try { expect(await cli(`${bad.url}/feed`)).toBe(1); } finally { await bad.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
