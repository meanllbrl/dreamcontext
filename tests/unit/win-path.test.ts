import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GIT_BASH_VALUE, GIT_BASH_VAR, PATH_ENTRIES, cliPathOptOutPath, ensureWinEnv, parseRegRead,
  pathWithEntry, pathWithoutEntry, removeWinEnv, type EnvRegistry, type RegValue,
} from '../../src/lib/win-path.js';

/**
 * Plan npmsiz-beta C5′, criterion 11 (Windows half): a fake registry shows only the listed writes,
 * `Path` keeps its type and every other entry byte for byte, a second run adds nothing, removal
 * takes out exactly ours and keeps an entry another program added after us.
 */
class FakeRegistry implements EnvRegistry {
  values = new Map<string, RegValue>();
  log: string[] = [];
  read(name: string) { return this.values.get(name.toLowerCase()) ?? null; }
  write(name: string, v: RegValue) { this.log.push(`write ${name}`); this.values.set(name.toLowerCase(), { ...v }); }
  remove(name: string) { this.log.push(`remove ${name}`); this.values.delete(name.toLowerCase()); }
}

const OTHER = 'C:\\Program Files\\Thing;%LOCALAPPDATA%\\Microsoft\\WindowsApps;;D:\\odd path\\';

let home: string;
let reg: FakeRegistry;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-winpath-'));
  reg = new FakeRegistry();
  reg.values.set('path', { type: 'REG_EXPAND_SZ', value: OTHER });
  reg.values.set('temp', { type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\AppData\\Local\\Temp' });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('C5′ ensureWinEnv', () => {
  it('appends only the listed entries, keeps the type and every other entry byte for byte', () => {
    const before = new Map(reg.values);
    const writes = ensureWinEnv(reg, { cli: true, gitCmd: true, claudeLocal: true }, home);
    expect(writes.map((w) => w.entry)).toEqual([PATH_ENTRIES.cli, PATH_ENTRIES.gitCmd, PATH_ENTRIES.claudeLocal]);
    const path = reg.read('Path')!;
    expect(path.type).toBe('REG_EXPAND_SZ');
    expect(path.value).toBe(`${OTHER};${PATH_ENTRIES.cli};${PATH_ENTRIES.gitCmd};${PATH_ENTRIES.claudeLocal}`);
    expect(path.value.startsWith(OTHER)).toBe(true);
    // Nothing but Path changed.
    for (const [k, v] of before) if (k !== 'path') expect(reg.values.get(k)).toEqual(v);
    expect([...reg.values.keys()].sort()).toEqual([...before.keys()].sort());
    expect(reg.log.every((l) => l === 'write Path')).toBe(true);
  });

  it('a REG_SZ Path stays REG_SZ with the entry expanded; a missing Path is created as REG_EXPAND_SZ', () => {
    reg.values.set('path', { type: 'REG_SZ', value: 'C:\\x' });
    ensureWinEnv(reg, { cli: true }, 'C:/Users/Example');
    expect(reg.read('Path')).toEqual({ type: 'REG_SZ', value: 'C:\\x;C:\\Users\\Example\\.dreamcontext\\bin\\cli' });
    // Either form already there counts as present; removal takes out either.
    expect(ensureWinEnv(reg, { cli: true }, 'C:/Users/Example')).toEqual([]);
    removeWinEnv(reg, ['cli'], { home: 'C:/Users/Example' });
    expect(reg.read('Path')).toEqual({ type: 'REG_SZ', value: 'C:\\x' });
    // In a REG_EXPAND_SZ Path an expanded entry is someone else's (Claude's installer): kept.
    const theirs = 'C:\\Users\\Example\\.local\\bin';
    reg.values.set('path', { type: 'REG_EXPAND_SZ', value: `C:\\x;${theirs}` });
    expect(ensureWinEnv(reg, { claudeLocal: true }, 'C:/Users/Example')).toEqual([]);
    expect(removeWinEnv(reg, ['claudeLocal'], { home: 'C:/Users/Example' })).toEqual([]);
    expect(reg.read('Path')!.value).toBe(`C:\\x;${theirs}`);
    reg.values.delete('path');
    ensureWinEnv(reg, { cli: true }, home);
    expect(reg.read('Path')).toEqual({ type: 'REG_EXPAND_SZ', value: PATH_ENTRIES.cli });
  });

  it('a second run adds nothing; presence is an exact entry match, case-insensitive', () => {
    ensureWinEnv(reg, { cli: true, gitCmd: true }, home);
    const after = reg.read('Path')!.value;
    reg.log = [];
    expect(ensureWinEnv(reg, { cli: true, gitCmd: true }, home)).toEqual([]);
    expect(reg.log).toEqual([]);
    expect(reg.read('Path')!.value).toBe(after);
    reg.values.set('path', { type: 'REG_EXPAND_SZ', value: PATH_ENTRIES.cli.toUpperCase() });
    expect(ensureWinEnv(reg, { cli: true }, home)).toEqual([]);
    // A longer entry that merely starts with ours is not ours.
    reg.values.set('path', { type: 'REG_EXPAND_SZ', value: `${PATH_ENTRIES.cli}\\sub` });
    expect(ensureWinEnv(reg, { cli: true }, home)).toHaveLength(1);
  });

  it('the owner opt-out keeps the bin\\cli entry out, other entries still go in', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(cliPathOptOutPath(home), '{}\n');
    const writes = ensureWinEnv(reg, { cli: true, gitCmd: true }, home);
    expect(writes.map((w) => w.entry)).toEqual([PATH_ENTRIES.gitCmd]);
    expect(reg.read('Path')!.value).not.toContain('bin\\cli');
  });

  it('CLAUDE_CODE_GIT_BASH_PATH only when asked, only our value, never over someone else', () => {
    expect(ensureWinEnv(reg, { cli: true }, home).some((w) => w.name === GIT_BASH_VAR)).toBe(false);
    expect(reg.read(GIT_BASH_VAR)).toBeNull();
    ensureWinEnv(reg, { gitBashPath: true }, home);
    expect(reg.read(GIT_BASH_VAR)).toEqual({ type: 'REG_EXPAND_SZ', value: GIT_BASH_VALUE });
    reg.values.set(GIT_BASH_VAR.toLowerCase(), { type: 'REG_SZ', value: 'C:\\Git\\bin\\bash.exe' });
    expect(ensureWinEnv(reg, { gitBashPath: true }, home)).toEqual([]);
    expect(reg.read(GIT_BASH_VAR)!.value).toBe('C:\\Git\\bin\\bash.exe');
  });
});

describe('C5′ removeWinEnv', () => {
  it('takes out exactly ours and keeps an entry another program added after us', () => {
    ensureWinEnv(reg, { cli: true, gitCmd: true }, home);
    const later = 'C:\\Later\\Tool';
    reg.values.set('path', { type: 'REG_EXPAND_SZ', value: `${reg.read('Path')!.value};${later}` });
    removeWinEnv(reg, ['cli', 'gitCmd']);
    expect(reg.read('Path')).toEqual({ type: 'REG_EXPAND_SZ', value: `${OTHER};${later}` });
    reg.log = [];
    expect(removeWinEnv(reg, ['cli', 'gitCmd'])).toEqual([]);
    expect(reg.log).toEqual([]);
  });

  it('removes CLAUDE_CODE_GIT_BASH_PATH only when it holds our value', () => {
    reg.values.set(GIT_BASH_VAR.toLowerCase(), { type: 'REG_SZ', value: 'C:\\Git\\bin\\bash.exe' });
    expect(removeWinEnv(reg, [], { gitBashPath: true })).toEqual([]);
    reg.values.set(GIT_BASH_VAR.toLowerCase(), { type: 'REG_EXPAND_SZ', value: GIT_BASH_VALUE });
    removeWinEnv(reg, [], { gitBashPath: true });
    expect(reg.read(GIT_BASH_VAR)).toBeNull();
  });
});

describe('Path entry helpers and reg.exe parsing', () => {
  it('append and remove keep separators byte for byte', () => {
    expect(pathWithEntry(null, 'X')).toBe('X');
    expect(pathWithEntry('A;', 'X')).toBe('A;X');
    expect(pathWithEntry('A;x', 'X')).toBeNull();
    expect(pathWithoutEntry('A;X;;B', 'X')).toBe('A;;B');
    expect(pathWithoutEntry('A;B', 'X')).toBeNull();
  });

  it('reads the exact UTF-16 value, non-ASCII included; only a confirmed absence is missing', () => {
    const value = 'C:\\Users\\Gökhan\\AppData\\Local\\Programs\\Microsoft VS Code\\bin;%USERPROFILE%\\şçğ';
    const b64 = Buffer.from(value, 'utf16le').toString('base64');
    expect(parseRegRead(`{"kind":"ExpandString","b64":"${b64}"}\r\n`)).toEqual({ type: 'REG_EXPAND_SZ', value });
    expect(parseRegRead(`{"kind":"String","b64":""}`)).toEqual({ type: 'REG_SZ', value: '' });
    expect(parseRegRead('{"missing":true}')).toBeNull();
    for (const bad of ['', 'Access is denied.', '{"kind":"MultiString","b64":""}', '{"kind":"String"}', '{"kind":"String","b64":"%%"}']) {
      expect(() => parseRegRead(bad)).toThrow();
    }
  });

  it('a read that fails writes nothing: it never treats an unreadable Path as empty', () => {
    const broken: EnvRegistry = {
      read: () => { throw new Error('denied'); },
      write: () => { throw new Error('must not write'); },
      remove: () => { throw new Error('must not remove'); },
    };
    expect(() => ensureWinEnv(broken, { cli: true, gitCmd: true, gitBashPath: true }, home)).toThrow('denied');
    expect(() => removeWinEnv(broken, ['cli'])).toThrow('denied');
  });
});
