import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDataDir, legacyAppDataDir, migrateAppData } from '../../src/lib/apps/data-dir.js';

/** plan-veri r3 K1, AC2: the old ~/.dreamcontext/apps/data/<hash>/ moves into the brain, once. */
let home: string; let project: string;
const rec = () => ({ projectRoot: project, slug: 'yuk-izleme', hash: 'h1234' });
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-migrate-')));
  project = join(home, 'proj');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedOld(): string {
  const old = legacyAppDataDir(home, 'h1234');
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'yuk-bildir.json'), JSON.stringify({ count: 42, rows: ['a', 'b'] }));
  return old;
}

describe('moving the old data in', () => {
  it('renames it with the bytes unchanged, leaves no old folder, and a second run does nothing', () => {
    const old = seedOld();
    const before = sha(join(old, 'yuk-bildir.json'));
    const r = migrateAppData(home, rec());
    expect(r).toMatchObject({ status: 'moved', via: 'rename' });
    const moved = join(appDataDir(project, 'yuk-izleme'), 'yuk-bildir.json');
    expect(sha(moved)).toBe(before);
    expect(existsSync(old)).toBe(false);
    expect(migrateAppData(home, rec())).toEqual({ status: 'none' });
    expect(sha(moved)).toBe(before);
  });

  it('another volume (EXDEV): copies beside, renames in, removes the old one, links left out', () => {
    const old = seedOld();
    symlinkSync('/etc/hosts', join(old, 'hosts-link'));
    const before = sha(join(old, 'yuk-bildir.json'));
    const exdev = () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
    const r = migrateAppData(home, rec(), { rename: exdev });
    expect(r).toMatchObject({ status: 'moved', via: 'copy', skippedLinks: [join(old, 'hosts-link')] });
    const dir = appDataDir(project, 'yuk-izleme');
    expect(sha(join(dir, 'yuk-bildir.json'))).toBe(before);
    expect(existsSync(join(dir, 'hosts-link'))).toBe(false);
    expect(existsSync(old)).toBe(false);
  });

  it('two folders that both hold data: app_data_conflict, neither touched', () => {
    const old = seedOld();
    const dir = appDataDir(project, 'yuk-izleme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'new.json'), '{}');
    const r = migrateAppData(home, rec());
    expect(r).toMatchObject({ status: 'refused', code: 'app_data_conflict' });
    expect(existsSync(join(old, 'yuk-bildir.json'))).toBe(true);
    expect(existsSync(join(dir, 'new.json'))).toBe(true);
  });

  it('an empty new folder is no conflict', () => {
    seedOld();
    mkdirSync(appDataDir(project, 'yuk-izleme'), { recursive: true });
    expect(migrateAppData(home, rec())).toMatchObject({ status: 'moved' });
  });

  it('a symlinked old folder is never followed', () => {
    const target = join(home, 'elsewhere'); mkdirSync(target);
    writeFileSync(join(target, 'secret.txt'), 'x');
    mkdirSync(join(home, '.dreamcontext', 'apps', 'data'), { recursive: true });
    symlinkSync(target, legacyAppDataDir(home, 'h1234'));
    expect(migrateAppData(home, rec())).toMatchObject({ status: 'refused', code: 'app_data_symlink' });
    expect(existsSync(join(target, 'secret.txt'))).toBe(true);
    expect(existsSync(appDataDir(project, 'yuk-izleme'))).toBe(false);
  });

  it('a project whose brain is gone is skipped, no ghost folder', () => {
    seedOld();
    rmSync(join(project, '_dream_context'), { recursive: true });
    expect(migrateAppData(home, rec())).toEqual({ status: 'skipped', why: 'no_brain' });
    expect(existsSync(join(project, '_dream_context'))).toBe(false);
  });

  it('no old folder: nothing to do', () => {
    expect(migrateAppData(home, rec())).toEqual({ status: 'none' });
  });
});
