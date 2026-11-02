import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { BACKUP_KEEP, backupAppData, backupRoot, dataLostWithBackup, listBackups, restoreAppData } from '../../src/lib/apps/data-backup.js';

/** The owner's extra criterion (AC11): a backup outside every repo, and a way back. */
let home: string; let project: string; let dir: string;
const rec = () => ({ projectRoot: project, slug: 'yuk', hash: 'hh1' });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-backup-')));
  project = join(home, 'proj');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  dir = ensureAppDataDir(project, 'yuk');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the backup', () => {
  it('copies the data outside the project, skips links, and skips an unchanged folder', async () => {
    writeFileSync(join(dir, 'yuk-bildir.json'), '{"n":1}');
    symlinkSync('/etc/hosts', join(dir, 'link'));
    const r = await backupAppData(home, 'hh1', dir, { reason: 'start' });
    expect(r).toMatchObject({ ok: true, files: 1 });
    const root = backupRoot(home, 'hh1');
    expect(root.startsWith(join(home, '.dreamcontext', 'apps', 'backup'))).toBe(true);
    expect(root.startsWith(project)).toBe(false);
    const [b] = listBackups(home, 'hh1');
    expect(readFileSync(join(b.path, 'yuk-bildir.json'), 'utf-8')).toBe('{"n":1}');
    expect(existsSync(join(b.path, 'link'))).toBe(false);
    expect(await backupAppData(home, 'hh1', dir, { reason: 'interval' })).toEqual({ ok: false, skipped: 'unchanged' });
  });

  it('an empty or missing folder makes no backup', async () => {
    expect(await backupAppData(home, 'hh1', dir, { reason: 'start' })).toEqual({ ok: false, skipped: 'empty' });
    expect(await backupAppData(home, 'hh1', join(dir, 'nope'), { reason: 'start' })).toEqual({ ok: false, skipped: 'missing' });
  });

  it(`keeps the newest ${BACKUP_KEEP}`, async () => {
    for (let i = 0; i < BACKUP_KEEP + 2; i++) {
      writeFileSync(join(dir, 'n.txt'), String(i));
      const r = await backupAppData(home, 'hh1', dir, { reason: 'interval', now: new Date(Date.UTC(2026, 10, 2, 10, i)), force: true });
      expect(r.ok).toBe(true);
    }
    const all = listBackups(home, 'hh1');
    expect(all).toHaveLength(BACKUP_KEEP);
    expect(readFileSync(join(all[0].path, 'n.txt'), 'utf-8')).toBe(String(BACKUP_KEEP + 1));
    expect(readdirSync(backupRoot(home, 'hh1')).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });
});

describe('the restore', () => {
  it('after `git clean -fdX` wiped the folder: the snapshot line knows, restore brings the bytes back', async () => {
    writeFileSync(join(dir, 'yuk-bildir.json'), '{"count":7}');
    await backupAppData(home, 'hh1', dir, { reason: 'start' });
    rmSync(join(project, '_dream_context', 'apps'), { recursive: true });
    expect(dataLostWithBackup(home, 'hh1', dir)).toBe(true);
    const r = await restoreAppData(home, rec());
    expect(r).toMatchObject({ ok: true, files: 1, previous: null });
    expect(readFileSync(join(dir, 'yuk-bildir.json'), 'utf-8')).toBe('{"count":7}');
    expect(dataLostWithBackup(home, 'hh1', dir)).toBe(false);
  });

  it('backs up what is there first, so the restore itself can be undone', async () => {
    writeFileSync(join(dir, 'a.json'), 'old');
    const first = await backupAppData(home, 'hh1', dir, { reason: 'start' });
    writeFileSync(join(dir, 'a.json'), 'newer and different');
    const r = await restoreAppData(home, rec(), { at: first.ok ? first.stamp : '' });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('old');
    if (!r.ok || !r.previous) throw new Error('no previous backup');
    await restoreAppData(home, rec(), { at: r.previous });
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('newer and different');
  });

  it('no backup, or an unknown stamp, is said and changes nothing', async () => {
    expect(await restoreAppData(home, rec())).toMatchObject({ ok: false, code: 'no_backup' });
    writeFileSync(join(dir, 'a.json'), 'x');
    await backupAppData(home, 'hh1', dir, { reason: 'start' });
    expect(await restoreAppData(home, rec(), { at: '20990101T000000Z-ffff' })).toMatchObject({ ok: false, code: 'backup_not_found' });
    expect(readFileSync(join(dir, 'a.json'), 'utf-8')).toBe('x');
  });
});
