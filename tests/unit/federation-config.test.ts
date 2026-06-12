import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { isShareable } from '../../src/lib/federation-config.js';

function makeProjectRoot(): string {
  const dir = join(tmpdir(), `dc-fedcfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return dir;
}

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

describe('federation-config isShareable (federation P1.5)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns true only when config explicitly opts in', () => {
    writeSetupConfig(root, { ...BASE, shareable: true });
    expect(isShareable(root)).toBe(true);
  });

  it('returns false for shareable:false', () => {
    writeSetupConfig(root, { ...BASE, shareable: false });
    expect(isShareable(root)).toBe(false);
  });

  it('returns false when shareable is absent (private by default)', () => {
    writeSetupConfig(root, { ...BASE });
    expect(isShareable(root)).toBe(false);
  });

  it('returns false when no config exists (fail closed)', () => {
    expect(isShareable(join(root, 'nonexistent'))).toBe(false);
  });
});
