// relPosix — the single way src/ turns an absolute path into a project/vault-relative key.
// The replace(root + '/', '') it replaced never matched a Windows path, so recall hits kept
// their absolute path. path.win32 is injected, so these run the same on any host.
import { describe, it, expect } from 'vitest';
import { posix, win32 } from 'node:path';
import { relPosix } from '../../src/lib/paths.js';

describe('relPosix', () => {
  it('turns a backslash vault path into the forward-slash form macOS yields', () => {
    expect(relPosix('C:\\Users\\berda\\proj\\_dream_context', 'C:\\Users\\berda\\proj\\_dream_context\\knowledge\\foo.md', win32))
      .toBe('knowledge/foo.md');
  });

  it('handles the forward-slash absolute paths fast-glob returns on Windows', () => {
    expect(relPosix('C:\\Users\\berda\\proj\\_dream_context', 'C:/Users/berda/proj/_dream_context/core/2.memory.md', win32))
      .toBe('core/2.memory.md');
  });

  it('ignores drive-letter case and keeps nested folders', () => {
    expect(relPosix('C:\\Users\\me\\OneDrive\\Desktop\\p', 'c:\\Users\\me\\OneDrive\\Desktop\\p\\.claude\\skills', win32))
      .toBe('.claude/skills');
  });

  it('is byte-identical to the old POSIX replace for a path under the root', () => {
    const root = '/Users/me/proj/_dream_context';
    const file = `${root}/knowledge/products/a/b.md`;
    expect(relPosix(root, file, posix)).toBe(file.replace(root + '/', ''));
    expect(relPosix(root, file)).toBe(file.replace(root + '/', ''));
  });

  it('the product regex recall derives from relPath matches on both platforms', () => {
    const rel = relPosix('C:\\v\\_dream_context', 'C:\\v\\_dream_context\\knowledge\\products\\alpha\\x.md', win32);
    expect(rel.match(/(?:^|\/)knowledge\/products\/([^/]+)\//)?.[1]).toBe('alpha');
  });
});
