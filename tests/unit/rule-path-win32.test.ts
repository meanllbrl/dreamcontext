/**
 * The spelling of a real path inside a Claude Code permission rule, pinned on every host.
 *
 * Claude Code turns a Windows path into POSIX form before it matches a rule (`C:\Users\x` is
 * `/c/Users/x`; read off its own binary: the Git Bash path conversion, and its absolute rules spelled
 * `//c/...`). A deny written `Read(/C:\Users\x\.ssh/**)` (what the envelopes wrote on Windows before)
 * matches nothing, so the credential denies of the light job, the app assistant and the board scope
 * were no denies at all there. Not run against a real Windows claude yet.
 */
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { absRule, credentialHomeDirs, forbiddenPathReason, rulePath } from '../../src/lib/automations/board-scope.js';

describe('rulePath on Windows', () => {
  it('a drive path becomes /<drive>/..., forward slashes, the drive in lower case', () => {
    expect(rulePath(win32.join('C:\\Users\\robin', '.ssh'), 'win32')).toBe('/c/Users/robin/.ssh');
    expect(rulePath('D:/work/acme app', 'win32')).toBe('/d/work/acme app');
    expect(rulePath('C:\\', 'win32')).toBe('/c');
    expect(rulePath('C:\\p/**', 'win32')).toBe('/c/p/**');
  });
  it('a rooted path without a drive keeps its root, with forward slashes', () => {
    expect(rulePath(win32.join('/home/fixture', '.ssh'), 'win32')).toBe('/home/fixture/.ssh');
  });
  it('is the path itself on macOS and Linux, a backslash included', () => {
    expect(rulePath('/Users/robin/.ssh', 'darwin')).toBe('/Users/robin/.ssh');
    expect(rulePath('/home/a\\b', 'linux')).toBe('/home/a\\b');
  });
});

describe('the rule built from it', () => {
  it('is root-anchored with //, as on macOS', () => {
    const p = rulePath(win32.join('C:\\Users\\robin', '.aws'), 'win32');
    expect(`Read(/${p}/**)`).toBe('Read(//c/Users/robin/.aws/**)');
  });
  it('absRule on this host spells a POSIX path exactly as before', () => {
    if (process.platform === 'win32') return; // the host spelling is the win32 one, pinned above
    expect(absRule('Read', '/Users/robin/.ssh')).toBe('Read(//Users/robin/.ssh/**)');
    expect(absRule('Read', '/Users/robin/.npmrc', '')).toBe('Read(//Users/robin/.npmrc)');
  });
});

describe('forbiddenPathReason on Windows', () => {
  it('passes an ordinary Windows path: its backslashes are separators, not rule quoting', () => {
    expect(forbiddenPathReason('home folder', 'C:\\Users\\robin', 'win32')).toBeNull();
    expect(forbiddenPathReason('app', 'C:\\Users\\robin\\proj-apps\\yuk', 'win32')).toBeNull();
  });
  it('still refuses rule syntax in a Windows path', () => {
    for (const p of ['C:\\Users\\robin (old)', 'C:\\a,b', 'C:\\x*', 'C:\\a#b']) expect([p, forbiddenPathReason('app', p, 'win32')]).not.toEqual([p, null]);
  });
  it('refuses a network path: no drive to anchor a rule on', () => {
    expect(forbiddenPathReason('home folder', '\\\\server\\share\\robin', 'win32')).toContain('network path');
    expect(forbiddenPathReason('home folder', '//server/share/robin', 'win32')).toContain('network path');
  });
  it('still refuses a backslash on macOS and Linux, where it is part of a name', () => {
    expect(forbiddenPathReason('app', '/Users/robin/a\\b', 'darwin')).toContain('"\\"');
    expect(forbiddenPathReason('app', '/home/robin/a\\b', 'linux')).toContain('"\\"');
  });

  it('denies the Windows homes of gh and gcloud credentials, and adds nothing off Windows', () => {
    const win = credentialHomeDirs('win32');
    expect(win).toContain('AppData/Roaming/GitHub CLI');
    expect(win).toContain('AppData/Roaming/gcloud');
    expect(rulePath(win32.join('C:\\Users\\robin', 'AppData/Roaming/gcloud'), 'win32')).toBe('/c/Users/robin/AppData/Roaming/gcloud');
    expect(credentialHomeDirs('darwin')).not.toContain('AppData/Roaming/gcloud');
    expect(credentialHomeDirs('linux')).toContain('.config/gcloud');
  });
});
