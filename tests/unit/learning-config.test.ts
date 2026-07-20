import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSetupConfig,
  updateSetupConfig,
  writeSetupConfig,
  isLearningEnabled,
  type SetupConfig,
} from '../../src/lib/setup-config.js';

function makeProjectRoot(): string {
  const dir = join(tmpdir(), `dc-learning-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '_dream_context', 'state'), { recursive: true });
  return dir;
}

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.19.0',
  disableNativeMemory: true,
};

describe('setup-config learning field (proactive-learning-layer)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips learning.enabled:true through write → read', () => {
    writeSetupConfig(root, { ...BASE, learning: { enabled: true } });
    expect(readSetupConfig(root)?.learning).toEqual({ enabled: true });
    expect(isLearningEnabled(readSetupConfig(root))).toBe(true);
  });

  it('round-trips learning.enabled:false through write → read', () => {
    writeSetupConfig(root, { ...BASE, learning: { enabled: false } });
    expect(readSetupConfig(root)?.learning).toEqual({ enabled: false });
    expect(isLearningEnabled(readSetupConfig(root))).toBe(false);
  });

  it('legacy config with NO learning field reads as disabled (off by default)', () => {
    // A legacy .config.json that predates the learning layer has no `learning` key.
    const legacy = join(root, '_dream_context', 'state', '.config.json');
    writeFileSync(
      legacy,
      JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.18.0', disableNativeMemory: true }) + '\n',
    );
    expect(readSetupConfig(root)?.learning).toBeUndefined();
    expect(isLearningEnabled(readSetupConfig(root))).toBe(false);
  });

  it('a malformed learning block (wrong shape) sanitizes to undefined ⇒ disabled', () => {
    const legacy = join(root, '_dream_context', 'state', '.config.json');
    writeFileSync(
      legacy,
      JSON.stringify({
        platforms: [], packs: [], multiProduct: false, setupVersion: '0.19.0', disableNativeMemory: true,
        learning: { enabled: 'yes' },
      }) + '\n',
    );
    expect(readSetupConfig(root)?.learning).toBeUndefined();
    expect(isLearningEnabled(readSetupConfig(root))).toBe(false);
  });

  it('isLearningEnabled is false when config is null/undefined (no config at all)', () => {
    expect(isLearningEnabled(null)).toBe(false);
    expect(isLearningEnabled(undefined)).toBe(false);
    expect(isLearningEnabled(readSetupConfig(root))).toBe(false);
  });

  it('updateSetupConfig merges learning without clobbering other fields', () => {
    writeSetupConfig(root, { ...BASE, packs: ['core'] });
    updateSetupConfig(root, { learning: { enabled: true } });
    const cfg = readSetupConfig(root);
    expect(cfg?.learning).toEqual({ enabled: true });
    expect(cfg?.packs).toEqual(['core']);
    // A subsequent unrelated patch leaves learning in place (merge, not reset).
    updateSetupConfig(root, { disableNativeMemory: false });
    expect(readSetupConfig(root)?.learning).toEqual({ enabled: true });
  });

  it('updateSetupConfig can flip learning.enabled back off (the one-command disable path)', () => {
    writeSetupConfig(root, { ...BASE, learning: { enabled: true } });
    updateSetupConfig(root, { learning: { enabled: false } });
    expect(isLearningEnabled(readSetupConfig(root))).toBe(false);
  });
});
