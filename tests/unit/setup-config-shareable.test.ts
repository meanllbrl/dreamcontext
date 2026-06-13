import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readSetupConfig,
  updateSetupConfig,
  writeSetupConfig,
  type SetupConfig,
} from '../../src/lib/setup-config.js';
import { isShareable } from '../../src/lib/federation-config.js';

function makeProjectRoot(): string {
  const dir = join(tmpdir(), `dc-shareable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('setup-config shareable field (federation P1.5)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips shareable:true through write → read', () => {
    writeSetupConfig(root, { ...BASE, shareable: true });
    expect(readSetupConfig(root)?.shareable).toBe(true);
    expect(isShareable(root)).toBe(true);
  });

  it('round-trips shareable:false through write → read', () => {
    writeSetupConfig(root, { ...BASE, shareable: false });
    expect(readSetupConfig(root)?.shareable).toBe(false);
    expect(isShareable(root)).toBe(false);
  });

  it('legacy config with NO shareable field reads as false (private by default)', () => {
    // A legacy .config.json that predates federation has no `shareable` key.
    const legacy = join(root, '_dream_context', 'state', '.config.json');
    writeFileSync(
      legacy,
      JSON.stringify({ platforms: [], packs: [], multiProduct: false, setupVersion: '0.6.0', disableNativeMemory: true }) + '\n',
    );
    expect(readSetupConfig(root)?.shareable).toBeUndefined();
    expect(isShareable(root)).toBe(false);
  });

  it('isShareable is false when there is no config at all (fail closed)', () => {
    expect(isShareable(root)).toBe(false);
  });

  it('updateSetupConfig merges shareable without clobbering other fields', () => {
    writeSetupConfig(root, { ...BASE, packs: ['core'] });
    updateSetupConfig(root, { shareable: true });
    const cfg = readSetupConfig(root);
    expect(cfg?.shareable).toBe(true);
    expect(cfg?.packs).toEqual(['core']);
    // A subsequent unrelated patch leaves shareable in place (merge, not reset).
    updateSetupConfig(root, { disableNativeMemory: false });
    expect(readSetupConfig(root)?.shareable).toBe(true);
  });
});
