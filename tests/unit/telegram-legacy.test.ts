import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLegacyTelegramFiles } from '../../src/lib/telegram/legacy.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tg-legacy-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('removeLegacyTelegramFiles', () => {
  it('removes the global and per-slug token files, keeps new binding directories', () => {
    const base = join(home, '.dreamcontext');
    const dir = join(base, 'telegram');
    mkdirSync(join(dir, 'abcdef0123456789', 'super'), { recursive: true });
    writeFileSync(join(base, 'telegram.json'), '{"botToken":"x"}');
    writeFileSync(join(dir, 'eod-digest.json'), '{"botToken":"y"}');
    writeFileSync(join(dir, 'abcdef0123456789', 'super', 'bot.json'), '{}');
    const removed = removeLegacyTelegramFiles(home);
    expect(removed.sort()).toEqual([join(base, 'telegram.json'), join(dir, 'eod-digest.json')].sort());
    expect(existsSync(join(dir, 'abcdef0123456789', 'super', 'bot.json'))).toBe(true);
    expect(removeLegacyTelegramFiles(home)).toEqual([]);
  });

  it('unlinks a symlinked legacy file as a link and never touches its target', () => {
    const dir = join(home, '.dreamcontext', 'telegram');
    mkdirSync(dir, { recursive: true });
    const target = join(home, 'precious.json');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(dir, 'job.json'));
    removeLegacyTelegramFiles(home);
    expect(existsSync(join(dir, 'job.json'))).toBe(false);
    expect(readFileSync(target, 'utf-8')).toBe('keep');
  });

  it('does nothing when the folder is a symlink or absent', () => {
    expect(removeLegacyTelegramFiles(home)).toEqual([]);
    const real = join(home, 'elsewhere');
    mkdirSync(real);
    writeFileSync(join(real, 'job.json'), 'keep');
    mkdirSync(join(home, '.dreamcontext'));
    symlinkSync(real, join(home, '.dreamcontext', 'telegram'));
    expect(removeLegacyTelegramFiles(home)).toEqual([]);
    expect(existsSync(join(real, 'job.json'))).toBe(true);
  });
});
