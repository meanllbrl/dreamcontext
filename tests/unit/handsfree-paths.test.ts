// The shared hands-free path guard (AC9): every refusal the task names, the collision rules
// (case + NFC/NFD, case-only renames) and the write-time parent checks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PathGuardError, atomicWriteFile, checkRelPath, detectCollisions, ensureSafeParents, isDotGitSegment, leafState,
  isCanonicalLinkTarget, orderForApply, physicalResolve, sweepEscapingSymlinks, symlinkEscapes, symlinkTargetInside,
} from '../../src/lib/handsfree/paths.js';

const NFC = 'caf\u00e9.txt';
const NFD = 'cafe\u0301.txt';

function caseInsensitiveFs(dir: string): boolean {
  writeFileSync(join(dir, 'CaseProbe'), '');
  const ci = existsSync(join(dir, 'caseprobe'));
  rmSync(join(dir, 'CaseProbe'));
  return ci;
}

describe('checkRelPath refusals', () => {
  const refused: Array<[string, string]> = [
    ['..', 'dotdot'],
    ['a/../b', 'dotdot'],
    ['/etc/passwd', 'absolute'],
    ['C:/x', 'absolute'],
    ['a\0b', 'nul'],
    ['a\\b', 'backslash'],
    ['', 'empty'],
    ['a//b', 'empty_segment'],
    ['./a', 'dot_segment'],
    ['a/', 'empty_segment'],
    ['.git', 'dot_git'],
    ['.git/config', 'dot_git'],
    ['src/deep/.git/hooks/post-checkout', 'dot_git'],
    ['.GIT/config', 'dot_git'],
    ['sub/.Git/HEAD', 'dot_git'],
    ['.git./config', 'dot_git'],
    ['.git /config', 'dot_git'],
    ['.git::$INDEX_ALLOCATION/config', 'dot_git'],
    ['GIT~1/config', 'dot_git'],
    ['.g\u200cit/config', 'dot_git'],
    ['.gi\ufefft/hooks/x', 'dot_git'],
    ['a\nb', 'control_char'],
  ];
  for (const [p, reason] of refused) {
    it(`refuses ${JSON.stringify(p)} (${reason})`, () => {
      const c = checkRelPath(p);
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.reason).toBe(reason);
    });
  }

  it('accepts ordinary paths that merely start with .git', () => {
    for (const p of ['.gitignore', '.github/workflows/ci.yml', 'a/.gitkeep', 'git/x', '.gitattributes', NFC, NFD]) {
      expect(checkRelPath(p)).toEqual({ ok: true, path: p });
    }
  });

  it('isDotGitSegment folds NFC + case', () => {
    expect(isDotGitSegment('.GiT')).toBe(true);
    expect(isDotGitSegment('.gits')).toBe(false);
  });
});

describe('detectCollisions', () => {
  it('two incoming spellings of one name both become conflicts', () => {
    const r = detectCollisions(['README.md', 'readme.md', 'other'], []);
    expect(r.ok).toEqual(['other']);
    expect([...r.conflicts.keys()].sort()).toEqual(['README.md', 'readme.md']);
  });

  it('NFC vs NFD collide (incoming set and against existing)', () => {
    expect(detectCollisions([NFC, NFD], []).ok).toEqual([]);
    const r = detectCollisions([NFC], [NFD]);
    expect(r.conflicts.has(NFC)).toBe(true);
  });

  it('an incoming path colliding with a differently spelled existing path is a conflict', () => {
    expect(detectCollisions(['Readme.md'], ['README.md']).conflicts.has('Readme.md')).toBe(true);
  });

  it('a case-only rename passes when the old spelling is being deleted', () => {
    const r = detectCollisions(['Readme.md'], ['README.md'], ['README.md']);
    expect(r.ok).toEqual(['Readme.md']);
  });

  it('directory spellings collide too', () => {
    expect(detectCollisions(['Docs/a.md'], ['docs/b.md']).conflicts.has('Docs/a.md')).toBe(true);
    expect(detectCollisions(['docs/a.md'], ['docs/b.md']).ok).toEqual(['docs/a.md']);
  });

  it('the same exact spelling is not a collision', () => {
    expect(detectCollisions(['a/b.txt'], ['a/b.txt']).ok).toEqual(['a/b.txt']);
  });
});

describe('ordering + symlink targets', () => {
  it('orders deletions, then files, then symlinks', () => {
    const o = orderForApply([
      { kind: 'symlink' as const, path: 'l' },
      { kind: 'file' as const, path: 'b' },
      { kind: 'delete' as const, path: 'z' },
      { kind: 'file' as const, path: 'a' },
    ]);
    expect(o.map((x) => `${x.kind}:${x.path}`)).toEqual(['delete:z', 'file:a', 'file:b', 'symlink:l']);
  });

  it('symlink targets must stay inside the root', () => {
    expect(symlinkTargetInside('a/link', '../b.txt')).toBe(true);
    expect(symlinkTargetInside('a/link', 'c/d')).toBe(true);
    expect(symlinkTargetInside('a/link', '../../outside')).toBe(false);
    expect(symlinkTargetInside('link', '..')).toBe(false);
    expect(symlinkTargetInside('link', '/etc/passwd')).toBe(false);
    expect(symlinkTargetInside('link', 'x/../../../etc')).toBe(false);
    expect(symlinkTargetInside('link', '.git/config')).toBe(false);
    expect(symlinkTargetInside('link', 'a\0b')).toBe(false);
  });
});

describe('write-time parent checks', () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-paths-root-'));
    outside = mkdtempSync(join(tmpdir(), 'hf-paths-out-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('creates missing parents and returns the target', () => {
    const abs = ensureSafeParents(root, 'a/b/c.txt', { create: true });
    expect(abs).toBe(join(realpathSync.native(root), 'a', 'b', 'c.txt'));
    expect(existsSync(join(root, 'a', 'b'))).toBe(true);
  });

  it('refuses a symlinked parent (escaping or not)', () => {
    symlinkSync(outside, join(root, 'esc'));
    expect(() => ensureSafeParents(root, 'esc/x.txt', { create: true })).toThrow(PathGuardError);
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'inner'));
    expect(() => ensureSafeParents(root, 'inner/x.txt', { create: true })).toThrow(/symlink/);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
  });

  it('refuses a parent that is a file', () => {
    writeFileSync(join(root, 'f'), 'x');
    expect(() => ensureSafeParents(root, 'f/x.txt', { create: true })).toThrow(/not a directory/);
  });

  it('refuses guard-refused paths before touching the disk', () => {
    expect(() => ensureSafeParents(root, '../x', { create: true })).toThrow(PathGuardError);
    expect(() => ensureSafeParents(root, 'a/.git/config', { create: true })).toThrow(PathGuardError);
    expect(existsSync(join(root, 'a'))).toBe(false);
  });

  it('on a case-insensitive volume a differently spelled parent or leaf is caught', () => {
    if (!caseInsensitiveFs(root)) return;
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'README.md'), 'x');
    expect(() => ensureSafeParents(root, 'Docs/a.md', { create: true })).toThrow(/spelling/);
    expect(leafState(join(root, 'docs', 'readme.md'))).toBe('differentSpelling');
    expect(leafState(join(root, 'docs', 'README.md'))).toBe('file');
  });

  it('atomicWriteFile writes durably', () => {
    atomicWriteFile(join(root, 'deep', 'j.json'), '{"a":1}');
    expect(readFileSync(join(root, 'deep', 'j.json'), 'utf8')).toBe('{"a":1}');
  });
});

describe('physical symlink sweep (chains and existing links)', () => {
  let root: string;
  beforeEach(() => { root = realpathSync.native(mkdtempSync(join(tmpdir(), 'hf-sweep-'))); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a two-link chain is refused by the canonical rule and, if planted anyway, undone physically', () => {
    mkdirSync(join(root, 'd'));
    expect(symlinkTargetInside('d/l1', '..')).toBe(false); // D18: `..` alone has no name
    expect(symlinkTargetInside('d/l2', 'l1/..')).toBe(false); // D18: `..` after a name
    symlinkSync('..', join(root, 'd', 'l1'));
    symlinkSync('l1/..', join(root, 'd', 'l2'));
    const undone: string[] = [];
    const escaped = sweepEscapingSymlinks(root, ['d/l1', 'd/l2'], (rel) => { undone.push(rel); rmSync(join(root, rel)); });
    expect(escaped).toEqual(['d/l2']);
    expect(undone).toEqual(['d/l2']);
    expect(existsSync(join(root, 'd', 'l1'))).toBe(true);
  });

  it('a .. taken through an existing receiver symlink is caught', () => {
    mkdirSync(join(root, 'd'));
    symlinkSync('..', join(root, 'd', 'lap')); // the receiver's own link (to the root)
    expect(symlinkTargetInside('d/x', 'lap/..')).toBe(false); // D18
    symlinkSync('lap/..', join(root, 'd', 'x'));
    expect(symlinkEscapes(root, 'd/x')).toBe(true);
    expect(symlinkEscapes(root, 'd/lap')).toBe(false);
    expect(physicalResolve(join(root, 'd', 'x'))).toBe(realpathSync.native(join(root, '..')));
  });
});

describe('D18 canonical link targets', () => {
  it('accepts only (../)*name(/name)* within 1023 bytes', () => {
    for (const t of ['a', 'a/b', '../a', '../../a/b.txt', '..a', 'a..b', './a', 'a/./b', './../x', '.././x', 'a/.']) expect(isCanonicalLinkTarget(t)).toBe(true);
    for (const t of ['', '.', './.', '..', '../..', './..', 'a/..', 'a/./..', 'sub/../..', 'a//b', 'a/', 'a/', '/abs', 'C:/x', 'a\\b', 'a\0b', '../.git/config', 'x'.repeat(1024)]) {
      expect(isCanonicalLinkTarget(t)).toBe(false);
    }
    expect(isCanonicalLinkTarget('x'.repeat(1023))).toBe(true);
    expect(isCanonicalLinkTarget('\u00e9'.repeat(512))).toBe(false); // 1024 UTF-8 bytes
  });
});
