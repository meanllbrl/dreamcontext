import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_UPDATER_PUBKEY, parseMinisignPubkey, verifyMinisign } from '../../src/lib/minisign-pubkey.js';

/**
 * The CLI's install paths check every app build against ONE key (plan npmsiz-beta C10). The
 * fixture under tests/fixtures/release-updater-sig was signed by `tauri signer sign` with a
 * throwaway key, so the verifier is checked against tauri's real .sig format.
 */
const ROOT = join(__dirname, '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'release-updater-sig');
const DATA = readFileSync(join(FIX, 'example-setup.exe'));
const SIG = readFileSync(join(FIX, 'example-setup.exe.sig'), 'utf-8');
const PUB = readFileSync(join(FIX, 'throwaway.key.pub'), 'utf-8');

describe('APP_UPDATER_PUBKEY', () => {
  it('is exactly the pubkey the app\'s own updater trusts (tauri.conf.json): drift = red', () => {
    const conf = JSON.parse(readFileSync(join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf-8'));
    expect(APP_UPDATER_PUBKEY).toBe(conf.plugins.updater.pubkey);
    expect(() => parseMinisignPubkey(APP_UPDATER_PUBKEY)).not.toThrow();
  });
});

describe('verifyMinisign', () => {
  it('accepts tauri\'s .sig over the bytes with the key that made it', () => {
    expect(verifyMinisign(DATA, SIG, PUB)).toBe(true);
  });

  it('refuses a signature another key made (the app key vs the throwaway one)', () => {
    expect(verifyMinisign(DATA, SIG)).toBe(false);
    expect(verifyMinisign(DATA, SIG, APP_UPDATER_PUBKEY)).toBe(false);
  });

  it('refuses changed bytes, a cut signature and garbage, and never throws', () => {
    expect(verifyMinisign(Buffer.concat([DATA, Buffer.from('x')]), SIG, PUB)).toBe(false);
    expect(verifyMinisign(DATA, SIG.slice(0, 40), PUB)).toBe(false);
    expect(verifyMinisign(DATA, '', PUB)).toBe(false);
    expect(verifyMinisign(DATA, 'not base64 at all !!!', PUB)).toBe(false);
    expect(verifyMinisign(DATA, SIG, 'not a key')).toBe(false);
  });

  it('refuses a signature whose trusted comment was edited (the global signature covers it)', () => {
    const lines = Buffer.from(SIG.trim(), 'base64').toString('utf-8').split('\n');
    lines[2] = `${lines[2]} edited`;
    const forged = Buffer.from(lines.join('\n'), 'utf-8').toString('base64');
    expect(verifyMinisign(DATA, forged, PUB)).toBe(false);
  });
});
