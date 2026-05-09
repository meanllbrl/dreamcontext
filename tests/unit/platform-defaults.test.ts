import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getPlatformDefaultsPath,
  readProjectPlatformDefaults,
  writeProjectPlatformDefaults,
} from '../../src/lib/platform-defaults.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-platform-defaults-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('project platform defaults', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTmpDir();
    mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes and reads defaults roundtrip', () => {
    const path = writeProjectPlatformDefaults(projectRoot, ['codex', 'claude']);
    expect(path).toBe(join(projectRoot, '_dream_context', 'state', '.platforms.json'));
    expect(readProjectPlatformDefaults(projectRoot)).toEqual(['codex', 'claude']);
  });

  it('falls back to claude when file is missing or malformed', () => {
    expect(readProjectPlatformDefaults(projectRoot)).toEqual(['claude']);

    const path = getPlatformDefaultsPath(projectRoot);
    expect(path).toBeTruthy();
    writeFileSync(path!, '{not-json', 'utf-8');

    expect(readProjectPlatformDefaults(projectRoot)).toEqual(['claude']);
  });

  it('normalizes stored selections', () => {
    const path = getPlatformDefaultsPath(projectRoot);
    writeFileSync(path!, JSON.stringify({ version: 1, selected: ['CODex', 'codex', 'bad'] }), 'utf-8');
    expect(readProjectPlatformDefaults(projectRoot)).toEqual(['codex']);
  });

  it('returns null path when project has no _dream_context', () => {
    const other = makeTmpDir();
    try {
      expect(getPlatformDefaultsPath(other)).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('returns null on write when context is missing', () => {
    const other = makeTmpDir();
    try {
      expect(writeProjectPlatformDefaults(other, ['codex'])).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('includes metadata fields in saved file', () => {
    writeProjectPlatformDefaults(projectRoot, ['claude']);
    const path = getPlatformDefaultsPath(projectRoot)!;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; selected: string[]; updated_at: string };

    expect(raw.version).toBe(1);
    expect(raw.selected).toEqual(['claude']);
    expect(new Date(raw.updated_at).toISOString()).toBe(raw.updated_at);
  });
});
