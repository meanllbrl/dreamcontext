/**
 * Unit tests for `looksLikePath` — the gate that decides whether a backticked span in an
 * answer becomes a clickable chip.
 *
 * The asymmetry matters: a missed path costs a click the user makes by hand, but a FALSE
 * positive is a button that opens nothing (a shell fragment, a branch name), which is worse.
 * So most of these pin what must NOT become clickable.
 */
import { describe, it, expect } from 'vitest';
import { looksLikePath, normalizeDrivePath, splitUserMedia } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';

describe('looksLikePath — the way an answer actually names files', () => {
  it('accepts a project-relative source path', () => {
    expect(looksLikePath('src/server/routes/agent-chat.ts')).toBe(true);
    expect(looksLikePath('dashboard/src/components/sleepy/ChatPane.tsx')).toBe(true);
    expect(looksLikePath('_dream_context/state/my-task.md')).toBe(true);
  });

  it('accepts a `./`-prefixed path and a folder (which the file endpoint lists)', () => {
    expect(looksLikePath('./scripts/build.js')).toBe(true);
    expect(looksLikePath('src/server/routes/')).toBe(true);
  });

  it('tolerates surrounding whitespace from the DOM text node', () => {
    expect(looksLikePath('  src/a.ts  ')).toBe(true);
  });
});

describe('looksLikePath — what must stay inert', () => {
  it('rejects a bare filename with no directory', () => {
    expect(looksLikePath('package.json')).toBe(false);
  });

  it('rejects a command, which is what most backticks in an answer hold', () => {
    expect(looksLikePath('npm run build')).toBe(false);
    expect(looksLikePath('git push --force')).toBe(false);
  });

  it('rejects a URL — that is a link, not a file to preview', () => {
    expect(looksLikePath('https://example.com/a/b.ts')).toBe(false);
    expect(looksLikePath('file:///etc/passwd')).toBe(false);
  });

  it('rejects prose and identifiers that merely contain a slash', () => {
    expect(looksLikePath('and/or')).toBe(false);       // no extension, no trailing slash
    expect(looksLikePath('feat/inline-boards')).toBe(false);
    expect(looksLikePath('')).toBe(false);
  });

  it('rejects an over-long span rather than making a wall of text clickable', () => {
    expect(looksLikePath(`${'a/'.repeat(120)}b.ts`)).toBe(false);
  });

  it('rejects an extension too long to be one', () => {
    expect(looksLikePath('a/b.thisisnotanextension')).toBe(false);
  });
});

describe('looksLikePath — Windows absolute paths', () => {
  it('accepts a drive path to a file or a folder, in either separator', () => {
    expect(looksLikePath('C:/Users/berda/Downloads/croqi-studios/')).toBe(true);
    expect(looksLikePath('C:/Users/berda/Downloads/croqi-studios/00-tum-gezinti-video.webm')).toBe(true);
    expect(looksLikePath(String.raw`C:\Users\berda\Desktop\shot.png`)).toBe(true);
    expect(looksLikePath(String.raw`d:\out\ `.trim())).toBe(true);
  });

  it('accepts the spaces and non-ASCII names Windows folders carry', () => {
    expect(looksLikePath(String.raw`C:\Program Files\dreamcontext\app.log`)).toBe(true);
    expect(looksLikePath('C:/Users/me/Masaüstü/çizim.svg')).toBe(true);
  });

  it('still rejects a drive path with no extension and no trailing separator', () => {
    expect(looksLikePath('C:/Windows/System32/cmd')).toBe(false);
    expect(looksLikePath('C:')).toBe(false);
  });
});

describe('looksLikePath — a Windows command line is not a path', () => {
  it('refuses a program path followed by flags', () => {
    expect(looksLikePath(String.raw`C:\tools\run.exe --flag x.y`)).toBe(false);
    expect(looksLikePath(String.raw`C:\tools\run.exe -v out.log`)).toBe(false);
    expect(looksLikePath(String.raw`C:\Program Files\App\app.exe`)).toBe(true);
    // A spaced dash is not a flag: Explorer names a duplicate `notes - Copy.txt`.
    expect(looksLikePath(String.raw`C:\Users\me\Desktop\notes - Copy.txt`)).toBe(true);
    expect(looksLikePath(String.raw`C:\a\Screenshot 2026-10-24 -1.png`)).toBe(true);
  });
});

describe('normalizeDrivePath', () => {
  it('turns backslashes into forward slashes and undoes marked\'s encoding', () => {
    expect(normalizeDrivePath(String.raw`C:\Users\me\a.png`)).toBe('C:/Users/me/a.png');
    expect(normalizeDrivePath('C:%5CUsers%5Cme%5Ca.png')).toBe('C:/Users/me/a.png');
    expect(normalizeDrivePath('C:/Users/me/My%20shot.png')).toBe('C:/Users/me/My shot.png');
  });

  it('does not decode code text, where a `%20` is part of the file name', () => {
    expect(normalizeDrivePath(String.raw`C:\a%20b.txt`, { decode: false })).toBe('C:/a%20b.txt');
  });

  it('leaves every non-drive reference exactly as written', () => {
    expect(normalizeDrivePath(String.raw`src/a\b.ts`)).toBe(String.raw`src/a\b.ts`);
    expect(normalizeDrivePath('/Users/me/a%20b.png')).toBe('/Users/me/a%20b.png');
  });
});

describe('splitUserMedia — a Windows attachment path', () => {
  it('draws a trailing drive-path screenshot instead of leaving it as text', () => {
    expect(splitUserMedia('look at this C:/Users/me/tmp/shot.png')).toEqual({ text: 'look at this', media: ['C:/Users/me/tmp/shot.png'] });
  });
});
