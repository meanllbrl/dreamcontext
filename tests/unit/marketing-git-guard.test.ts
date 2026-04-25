import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isBlockedMarketingPath,
  findBlockedPaths,
  getStagedFiles,
} from '../../src/lib/marketing/git-guard.js';

describe('marketing/git-guard — isBlockedMarketingPath', () => {
  it('blocks paths under marketing/<x>/_assets/', () => {
    expect(isBlockedMarketingPath('_dream_context/marketing/competitors/_assets/foo.mp4')).toBe(true);
    expect(isBlockedMarketingPath('_dream_context/marketing/creatives/_assets/img.png')).toBe(true);
  });

  it('blocks paths under marketing/<x>/_media/', () => {
    expect(isBlockedMarketingPath('_dream_context/marketing/competitors/_media/frame_001.jpg')).toBe(true);
    expect(isBlockedMarketingPath('_dream_context/marketing/competitors/_youtube/_media/video.mp4')).toBe(true);
  });

  it('blocks deeply nested _assets/ paths', () => {
    expect(isBlockedMarketingPath('_dream_context/marketing/a/b/c/d/_assets/x/y/z.mp4')).toBe(true);
  });

  it('does NOT block files outside _dream_context/marketing/', () => {
    expect(isBlockedMarketingPath('_dream_context/state/foo.md')).toBe(false);
    expect(isBlockedMarketingPath('src/lib/_assets/anything')).toBe(false);
    expect(isBlockedMarketingPath('_assets/foo.mp4')).toBe(false);
  });

  it('does NOT block marketing JSON/MD content (the safe surface)', () => {
    expect(isBlockedMarketingPath('_dream_context/marketing/cohorts/c1.json')).toBe(false);
    expect(isBlockedMarketingPath('_dream_context/marketing/competitors/_youtube/posts/abc.md')).toBe(false);
    expect(isBlockedMarketingPath('_dream_context/marketing/.env')).toBe(false);
  });

  it('does NOT block files literally named _assets at root (no trailing dir)', () => {
    // The blocked segment must be a directory, i.e. not the final segment.
    expect(isBlockedMarketingPath('_dream_context/marketing/_assets')).toBe(false);
    expect(isBlockedMarketingPath('_dream_context/marketing/competitors/_assets')).toBe(false);
  });

  it('handles Windows-style backslashes by normalizing', () => {
    expect(isBlockedMarketingPath('_dream_context\\marketing\\competitors\\_assets\\x.mp4')).toBe(true);
  });

  it('rejects empty / non-string input', () => {
    expect(isBlockedMarketingPath('')).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(isBlockedMarketingPath(null)).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(isBlockedMarketingPath(undefined)).toBe(false);
  });
});

describe('marketing/git-guard — findBlockedPaths', () => {
  it('returns only the blocked entries from a mixed list', () => {
    const staged = [
      'src/lib/marketing/git-guard.ts',
      '_dream_context/marketing/cohorts/c1.json',
      '_dream_context/marketing/competitors/_assets/big.mp4',
      '_dream_context/marketing/_youtube/_media/frame.jpg',
      'README.md',
    ];
    expect(findBlockedPaths(staged)).toEqual([
      '_dream_context/marketing/competitors/_assets/big.mp4',
      '_dream_context/marketing/_youtube/_media/frame.jpg',
    ]);
  });

  it('returns [] when nothing matches', () => {
    expect(findBlockedPaths(['README.md', 'src/foo.ts'])).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(findBlockedPaths([])).toEqual([]);
  });
});

describe('marketing/git-guard — getStagedFiles (integration)', () => {
  let repo: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    const raw = join(tmpdir(), `mk-git-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    repo = realpathSync(raw);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns [] when nothing is staged', () => {
    expect(getStagedFiles()).toEqual([]);
  });

  it('returns staged file paths', () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    mkdirSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets'), { recursive: true });
    writeFileSync(join(repo, '_dream_context', 'marketing', 'competitors', '_assets', 'big.mp4'), 'x');
    execFileSync('git', ['add', '-f', 'a.txt', '_dream_context/marketing/competitors/_assets/big.mp4'], {
      cwd: repo,
    });
    const staged = getStagedFiles();
    expect(staged).toContain('a.txt');
    expect(staged).toContain('_dream_context/marketing/competitors/_assets/big.mp4');
  });

  it('handles paths with spaces and unicode', () => {
    writeFileSync(join(repo, 'with space.txt'), '');
    writeFileSync(join(repo, 'türkçe.txt'), '');
    execFileSync('git', ['add', 'with space.txt', 'türkçe.txt'], { cwd: repo });
    const staged = getStagedFiles();
    expect(staged).toContain('with space.txt');
    expect(staged).toContain('türkçe.txt');
  });
});
