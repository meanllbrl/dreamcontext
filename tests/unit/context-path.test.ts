import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// We need to import from source
import {
  resolveContextRoot,
  ensureContextRoot,
  contextExists,
  getInitPath,
} from '../../src/lib/context-path.js';

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  // Resolve symlinks (macOS /var -> /private/var) so paths match process.cwd()
  return realpathSync(raw);
}

describe('context-path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveContextRoot', () => {
    it('returns path when _dream_context/ exists in given dir', () => {
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      const result = resolveContextRoot(tmpDir);
      expect(result).toBe(ctxDir);
    });

    it('returns null when _dream_context/ does not exist', () => {
      const result = resolveContextRoot(tmpDir);
      expect(result).toBeNull();
    });

    it('walks up parent directories to find _dream_context/', () => {
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      const nested = join(tmpDir, 'a', 'b');
      mkdirSync(nested, { recursive: true });
      const result = resolveContextRoot(nested);
      expect(result).toBe(ctxDir);
    });

    it('respects MAX_WALK_UP limit (5 levels)', () => {
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      // Create a path 6 levels deep — should NOT find it
      const deep = join(tmpDir, 'a', 'b', 'c', 'd', 'e', 'f');
      mkdirSync(deep, { recursive: true });
      const result = resolveContextRoot(deep);
      expect(result).toBeNull();
    });

    it('finds _dream_context/ exactly at MAX_WALK_UP (5 levels)', () => {
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      // 5 levels deep — should find it
      const deep = join(tmpDir, 'a', 'b', 'c', 'd', 'e');
      mkdirSync(deep, { recursive: true });
      const result = resolveContextRoot(deep);
      expect(result).toBe(ctxDir);
    });

    it('stops at filesystem root without infinite loop', () => {
      const result = resolveContextRoot('/');
      expect(result).toBeNull();
    });

    it('uses process.cwd() when no argument provided', () => {
      const orig = process.cwd();
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      try {
        process.chdir(tmpDir);
        const result = resolveContextRoot();
        expect(result).toBe(ctxDir);
      } finally {
        process.chdir(orig);
      }
    });
  });

  describe('ensureContextRoot', () => {
    it('returns path when _dream_context/ exists', () => {
      const ctxDir = join(tmpDir, '_dream_context');
      mkdirSync(ctxDir);
      expect(ensureContextRoot(tmpDir)).toBe(ctxDir);
    });

    it('throws when _dream_context/ does not exist', () => {
      expect(() => ensureContextRoot(tmpDir)).toThrow(
        '_dream_context/ not found',
      );
    });

    it('error message suggests running init', () => {
      expect(() => ensureContextRoot(tmpDir)).toThrow('dreamcontext init');
    });
  });

  describe('contextExists', () => {
    it('returns true when _dream_context/ exists', () => {
      mkdirSync(join(tmpDir, '_dream_context'));
      expect(contextExists(tmpDir)).toBe(true);
    });

    it('returns false when _dream_context/ does not exist', () => {
      expect(contextExists(tmpDir)).toBe(false);
    });

    it('returns true when found in parent directory', () => {
      mkdirSync(join(tmpDir, '_dream_context'));
      const child = join(tmpDir, 'sub');
      mkdirSync(child);
      expect(contextExists(child)).toBe(true);
    });
  });

  describe('getInitPath', () => {
    it('returns _dream_context path in cwd', () => {
      const orig = process.cwd();
      try {
        process.chdir(tmpDir);
        expect(getInitPath()).toBe(join(tmpDir, '_dream_context'));
      } finally {
        process.chdir(orig);
      }
    });
  });
});
