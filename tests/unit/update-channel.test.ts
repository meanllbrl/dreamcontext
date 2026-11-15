import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUpdateChannel, setUpdateChannel, updateChannelPath } from '../../src/lib/update-channel.js';

/**
 * The update channel record (plan npmsiz-beta C10): one writer, a strict reader that matches the
 * Rust updater's (`read_channel` in desktop/src-tauri/src/updater.rs, tested there with the same
 * cases): only an exact `{"channel":"beta"}` is beta; everything else is the unchanged stable path.
 */
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-channel-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const writeRaw = (raw: string) => {
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  writeFileSync(updateChannelPath(home), raw);
};

describe('readUpdateChannel', () => {
  it('no record is stable; an exact beta record is beta', () => {
    expect(readUpdateChannel(home)).toBe('stable');
    writeRaw('{"channel":"beta"}\n');
    expect(readUpdateChannel(home)).toBe('beta');
  });

  it('stable, malformed and URL-bearing records stay stable', () => {
    for (const raw of [
      '{"channel":"stable"}', '{"channel":"BETA"}', '{"channel":true}',
      '{"channel":"beta","url":"https://evil.example/feed.json"}', '{"url":"https://evil.example/feed.json"}',
      '["beta"]', '"beta"', '{"channel": "be', '',
    ]) {
      writeRaw(raw);
      expect(readUpdateChannel(home), raw).toBe('stable');
    }
  });

  it.skipIf(process.platform === 'win32')('a symlinked record or a symlinked ~/.dreamcontext stays stable', () => {
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, '{"channel":"beta"}');
    mkdirSync(join(home, '.dreamcontext'));
    symlinkSync(elsewhere, updateChannelPath(home));
    expect(readUpdateChannel(home)).toBe('stable');

    const home2 = mkdtempSync(join(tmpdir(), 'dc-channel-dirlink-'));
    try {
      const real = join(home2, 'real');
      mkdirSync(real);
      writeFileSync(join(real, 'update-channel.json'), '{"channel":"beta"}');
      symlinkSync(real, join(home2, '.dreamcontext'));
      expect(readUpdateChannel(home2)).toBe('stable');
    } finally { rmSync(home2, { recursive: true, force: true }); }
  });
});

describe('setUpdateChannel', () => {
  it('writes exactly {"channel": …} through a temp file, leaving nothing else behind', () => {
    expect(setUpdateChannel('beta', home)).toBe('beta');
    expect(JSON.parse(readFileSync(updateChannelPath(home), 'utf-8'))).toEqual({ channel: 'beta' });
    expect(setUpdateChannel('stable', home)).toBe('stable');
    expect(JSON.parse(readFileSync(updateChannelPath(home), 'utf-8'))).toEqual({ channel: 'stable' });
    expect(readdirSync(join(home, '.dreamcontext'))).toEqual(['update-channel.json']);
  });

  it('refuses any other value', () => {
    expect(() => setUpdateChannel('nightly' as never, home)).toThrow(/stable.*beta/);
    expect(() => setUpdateChannel('https://evil.example' as never, home)).toThrow();
    expect(existsSync(updateChannelPath(home))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked ~/.dreamcontext and changes nothing there', () => {
    const real = join(home, 'real');
    mkdirSync(real);
    symlinkSync(real, join(home, '.dreamcontext'));
    expect(() => setUpdateChannel('beta', home)).toThrow(/not a plain folder/);
    expect(readdirSync(real)).toEqual([]);
  });

  it('refuses a folder at the record\'s path', () => {
    mkdirSync(updateChannelPath(home), { recursive: true });
    expect(() => setUpdateChannel('beta', home)).toThrow(/not a plain file/);
  });
});
