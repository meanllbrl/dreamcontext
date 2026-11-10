import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AppDataError, appDataDir, checkAppDataChain, ensureAppDataDir, ensureAppsMergeAttributes, isInsideAppsData, scanAppData,
} from '../../src/lib/apps/data-dir.js';

/** plan-veri r3 K1/K2: where app data lives, the chain check, both ignore layers. */
let base: string; let project: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-appdata-')));
  project = join(base, 'proj');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

describe('the data folder', () => {
  it('is _dream_context/apps/<slug>, made 0700 step by step', () => {
    const d = ensureAppDataDir(project, 'yuk');
    expect(d).toBe(join(project, '_dream_context', 'apps', 'yuk'));
    expect(appDataDir(project, 'yuk')).toBe(d);
    expect(existsSync(d)).toBe(true);
  });

  it('writes both ignore layers BEFORE the folder, in a git repo, and the anchored line spares knowledge/apps', () => {
    git(project, 'init', '-q');
    ensureAppDataDir(project, 'yuk');
    expect(readFileSync(join(project, '_dream_context', '.gitignore'), 'utf-8').split('\n')).toContain('/apps/');
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf-8')).toContain('/_dream_context/apps/');
    writeFileSync(join(project, '_dream_context', 'apps', 'yuk', 'yuk-bildir.json'), '{"n":1}');
    // A nested `!*` cannot bring a file of an ignored folder back.
    writeFileSync(join(project, '_dream_context', 'apps', 'yuk', '.gitignore'), '!*\n');
    const status = git(project, 'status', '--porcelain', '-uall');
    expect(status).not.toContain('apps/yuk');
    // knowledge/apps/x.md is NOT ignored (exit 1 = not ignored).
    mkdirSync(join(project, '_dream_context', 'knowledge', 'apps'), { recursive: true });
    writeFileSync(join(project, '_dream_context', 'knowledge', 'apps', 'x.md'), '# x\n');
    let code = 0;
    try { git(project, 'check-ignore', '_dream_context/knowledge/apps/x.md'); } catch (e) { code = (e as { status: number }).status; }
    expect(code).toBe(1);
    expect(git(project, 'status', '--porcelain', '-uall')).toContain('_dream_context/knowledge/apps/x.md');
  });

  it('a project with no git still gets its folder', () => {
    expect(() => ensureAppDataDir(project, 'yuk')).not.toThrow();
  });

  it('refuses a symlinked apps/ or <slug>, or a file in their place, and writes nothing through it', () => {
    const outside = join(base, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(project, '_dream_context', 'apps'));
    expect(checkAppDataChain(project, 'yuk')).toMatchObject({ ok: false, code: 'app_data_symlink' });
    expect(() => ensureAppDataDir(project, 'yuk')).toThrow(AppDataError);
    expect(existsSync(join(outside, 'yuk'))).toBe(false);
    rmSync(join(project, '_dream_context', 'apps'));
    mkdirSync(join(project, '_dream_context', 'apps'));
    symlinkSync(outside, join(project, '_dream_context', 'apps', 'yuk'));
    expect(() => ensureAppDataDir(project, 'yuk')).toThrow(/app_data_symlink/);
    rmSync(join(project, '_dream_context', 'apps', 'yuk'));
    writeFileSync(join(project, '_dream_context', 'apps', 'yuk'), 'a file');
    expect(() => ensureAppDataDir(project, 'yuk')).toThrow(/app_data_symlink/);
  });

  it('a project with no brain is named, never made', () => {
    rmSync(join(project, '_dream_context'), { recursive: true });
    expect(() => ensureAppDataDir(project, 'yuk')).toThrow(/app_data_no_brain/);
    expect(existsSync(join(project, '_dream_context'))).toBe(false);
  });
});

describe('what is inside', () => {
  it('counts files, finds an instruction file in any letter case, and a link, never following it', () => {
    const d = ensureAppDataDir(project, 'yuk');
    writeFileSync(join(d, 'a.json'), '{}');
    mkdirSync(join(d, 'sub'));
    writeFileSync(join(d, 'sub', 'b.csv'), 'x');
    expect(scanAppData(d)).toMatchObject({ files: 2, instruction: null, symlink: null });
    writeFileSync(join(d, 'sub', 'claude.md'), 'do things');
    expect(scanAppData(d).instruction).toBe(join(d, 'sub', 'claude.md'));
    symlinkSync('/etc', join(d, 'etc'));
    expect(scanAppData(d).symlink).toBe(join(d, 'etc'));
  });

  it('knows a path under apps/ in any spelling, and nothing else', () => {
    const ctx = join(project, '_dream_context');
    ensureAppDataDir(project, 'yuk');
    expect(isInsideAppsData(ctx, join(ctx, 'apps', 'yuk', 'a.json'))).toBe(true);
    expect(isInsideAppsData(ctx, join(ctx, 'APPS', 'yuk', 'a.json'))).toBe(true);
    expect(isInsideAppsData(ctx, join(ctx, 'knowledge', 'apps', 'x.md'))).toBe(false);
    expect(isInsideAppsData(ctx, join(ctx, 'apps-notes.md'))).toBe(false);
  });
});

describe('the merge attribute line (app-veri-ortak K5)', () => {
  it('is written once to .git/info/attributes and read back; a nested brain gets its prefix; outside git there is nothing to protect', () => {
    expect(ensureAppsMergeAttributes(project, join(project, '_dream_context'))).toBe('none');
    git(project, 'init', '-q');
    expect(ensureAppsMergeAttributes(project, join(project, '_dream_context'))).toBe('ok');
    expect(ensureAppsMergeAttributes(project, join(project, '_dream_context'))).toBe('ok');
    const text = readFileSync(join(project, '.git', 'info', 'attributes'), 'utf-8');
    expect(text.split('\n').filter((l) => l === '/_dream_context/apps/** -merge -diff')).toHaveLength(1);
    const sub = join(project, 'pkg');
    mkdirSync(join(sub, '_dream_context'), { recursive: true });
    expect(ensureAppsMergeAttributes(sub, join(sub, '_dream_context'))).toBe('ok');
    expect(readFileSync(join(project, '.git', 'info', 'attributes'), 'utf-8')).toContain('/pkg/_dream_context/apps/** -merge -diff');
  });

  it('a .git/info/attributes that cannot be written fails (the pull is skipped)', () => {
    git(project, 'init', '-q');
    mkdirSync(join(project, '.git', 'info', 'attributes'), { recursive: true }); // a folder where the file goes
    expect(ensureAppsMergeAttributes(project, join(project, '_dream_context'))).toBe('failed');
  });
});
