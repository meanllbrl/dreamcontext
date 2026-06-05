import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyClaudeAutoMemory } from '../../src/lib/claude-settings.js';
import {
  readSetupConfig,
  updateSetupConfig,
  writeSetupConfig,
} from '../../src/lib/setup-config.js';

let projectRoot: string;
const settingsPath = () => join(projectRoot, '.claude', 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf-8'));

beforeEach(() => {
  projectRoot = join(tmpdir(), `nm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── applyClaudeAutoMemory ─────────────────────────────────────────────────────

describe('applyClaudeAutoMemory', () => {
  it('disable=true writes autoMemoryEnabled:false and creates the file', () => {
    const changed = applyClaudeAutoMemory(projectRoot, true);
    expect(changed).toBe(true);
    expect(readSettings().autoMemoryEnabled).toBe(false);
  });

  it('disable=false writes autoMemoryEnabled:true', () => {
    applyClaudeAutoMemory(projectRoot, false);
    expect(readSettings().autoMemoryEnabled).toBe(true);
  });

  it('is idempotent — returns false when already at the desired value', () => {
    expect(applyClaudeAutoMemory(projectRoot, true)).toBe(true);
    expect(applyClaudeAutoMemory(projectRoot, true)).toBe(false);
    expect(readSettings().autoMemoryEnabled).toBe(false);
  });

  it('preserves existing settings keys (e.g. hooks)', () => {
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] }, custom: 42 }),
      'utf-8',
    );
    applyClaudeAutoMemory(projectRoot, true);
    const s = readSettings();
    expect(s.autoMemoryEnabled).toBe(false);
    expect(s.hooks.SessionStart).toBeDefined();
    expect(s.custom).toBe(42);
  });

  it('recovers from a corrupt settings file by overwriting it', () => {
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), 'not json {{', 'utf-8');
    const changed = applyClaudeAutoMemory(projectRoot, true);
    expect(changed).toBe(true);
    expect(readSettings().autoMemoryEnabled).toBe(false);
  });

  it('does not create .claude when toggling false on a fresh project would be a no-op? (it always reflects desired)', () => {
    // Fresh project, no settings file → desired autoMemoryEnabled:true differs from absent → writes.
    expect(existsSync(settingsPath())).toBe(false);
    const changed = applyClaudeAutoMemory(projectRoot, false);
    expect(changed).toBe(true);
    expect(readSettings().autoMemoryEnabled).toBe(true);
  });
});

// ─── setup-config disableNativeMemory default ──────────────────────────────────

describe('SetupConfig.disableNativeMemory', () => {
  it('defaults to true for a legacy config missing the field', () => {
    mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
    writeFileSync(
      join(projectRoot, '_dream_context', 'state', '.config.json'),
      JSON.stringify({ platforms: ['claude'], packs: [], multiProduct: false, setupVersion: '1.0.0' }),
      'utf-8',
    );
    const cfg = readSetupConfig(projectRoot);
    expect(cfg?.disableNativeMemory).toBe(true);
  });

  it('updateSetupConfig persists disableNativeMemory:false', () => {
    updateSetupConfig(projectRoot, { platforms: ['claude'], disableNativeMemory: false });
    expect(readSetupConfig(projectRoot)?.disableNativeMemory).toBe(false);
  });

  it('an unrelated patch preserves a previously-set disableNativeMemory:false', () => {
    updateSetupConfig(projectRoot, { disableNativeMemory: false });
    updateSetupConfig(projectRoot, { packs: ['engineering'] });
    expect(readSetupConfig(projectRoot)?.disableNativeMemory).toBe(false);
  });

  it('round-trips through writeSetupConfig', () => {
    writeSetupConfig(projectRoot, {
      platforms: ['claude'],
      packs: [],
      multiProduct: false,
      setupVersion: '1.0.0',
      disableNativeMemory: false,
    });
    expect(readSetupConfig(projectRoot)?.disableNativeMemory).toBe(false);
  });
});
