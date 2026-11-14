/**
 * Release CI fails a build carrying any test feed setting (plan npmsiz-beta C10): a compile-time
 * test beta URL, `dangerousInsecureTransportProtocol`, or an updater endpoint / pubkey override.
 */
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs release script, no type declarations
import { STABLE_FEED, releaseSettingProblems } from '../../scripts/check-release-settings.mjs';

const ROOT = join(__dirname, '..', '..');
const RELEASE_CONFIG = '{"bundle":{"createUpdaterArtifacts":true}}';

/** A copy of the repo's tauri configs and the CLI key file, to plant a setting in. */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-release-settings-'));
  cpSync(join(ROOT, 'desktop', 'src-tauri'), join(root, 'desktop', 'src-tauri'), { recursive: true, filter: (p) => !p.includes('/target') && !p.includes('/gen/') && !p.includes('/icons') && !p.endsWith('.rs') });
  cpSync(join(ROOT, 'src', 'lib', 'minisign-pubkey.ts'), join(root, 'src', 'lib', 'minisign-pubkey.ts'));
  return root;
}

describe('releaseSettingProblems', () => {
  it('the repo as it is, with the release build\'s own --config, is clean', () => {
    expect(releaseSettingProblems({ env: {}, extraConfigs: [RELEASE_CONFIG] })).toEqual([]);
  });

  it('a compile-time test beta URL fails the build', () => {
    expect(releaseSettingProblems({ env: { DREAMCONTEXT_TEST_BETA_URL: 'http://127.0.0.1:9/beta.json' } }).join()).toMatch(/DREAMCONTEXT_TEST_BETA_URL/);
  });

  it('a test --config (loopback endpoint, test pubkey, insecure transport) fails the build', () => {
    const p = releaseSettingProblems({ env: {}, extraConfigs: [JSON.stringify({ plugins: { updater: { endpoints: ['http://127.0.0.1:9/latest.json'], pubkey: 'dGVzdA==', dangerousInsecureTransportProtocol: true } } })] }).join('\n');
    expect(p).toMatch(/dangerousInsecureTransportProtocol/);
    expect(p).toMatch(/overrides the updater/);
  });

  it('a changed endpoint, a foreign pubkey or a platform config override in the repo fail the build', () => {
    const root = fakeRoot();
    try {
      const conf = join(root, 'desktop', 'src-tauri', 'tauri.conf.json');
      const base = readFileSync(conf, 'utf-8');
      writeFileSync(conf, base.replace(STABLE_FEED, 'https://example.test/latest.json'));
      expect(releaseSettingProblems({ env: {}, root }).join()).toMatch(/not the stable feed/);
      const parsed = JSON.parse(base);
      parsed.plugins.updater.pubkey = 'dW50cnVzdGVkIGNvbW1lbnQ6IGZvcmVpZ24K';
      writeFileSync(conf, JSON.stringify(parsed));
      expect(releaseSettingProblems({ env: {}, root }).join()).toMatch(/pubkey is not the key/);
      writeFileSync(conf, base);
      const win = join(root, 'desktop', 'src-tauri', 'tauri.windows.conf.json');
      const w = JSON.parse(readFileSync(win, 'utf-8'));
      w.plugins = { updater: { endpoints: ['https://example.test/latest.json'] } };
      writeFileSync(win, JSON.stringify(w));
      expect(releaseSettingProblems({ env: {}, root }).join()).toMatch(/tauri\.windows\.conf\.json overrides the updater/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
