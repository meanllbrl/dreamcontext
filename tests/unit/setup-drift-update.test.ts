/**
 * Unit tests for buildUpdateSummary (AC7) +
 * Integration tests for update setupVersion bump (AC1 + AC11).
 *
 * AC1  (test: setup-drift-update integration 'update writes setupVersion on success')
 * AC7  (test: setup-drift-update unit 'buildUpdateSummary lists refreshed and pruned files')
 * AC11 (test: setup-drift-update integration 'packs-only does not bump setupVersion')
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildUpdateSummary } from '../../src/cli/commands/update.js';

// ─── AC7: buildUpdateSummary (pure unit) ─────────────────────────────────────

describe("setup-drift-update unit", () => {
  it("buildUpdateSummary lists refreshed and pruned files", () => {
    const summary = buildUpdateSummary({
      platforms: ['claude'],
      installedCount: 5,
      packs: ['engineering', 'firebase'],
      removed: ['old-hook.md', 'stale-agent.md'],
      setupVersion: '0.7.1',
    });

    expect(summary).toContain('## Update Summary');
    expect(summary).toContain('claude');
    expect(summary).toContain('5');
    expect(summary).toContain('engineering');
    expect(summary).toContain('firebase');
    expect(summary).toContain('old-hook.md');
    expect(summary).toContain('stale-agent.md');
    expect(summary).toContain('0.7.1');
  });

  it("buildUpdateSummary handles empty packs and no removed files", () => {
    const summary = buildUpdateSummary({
      platforms: ['claude'],
      installedCount: 3,
      packs: [],
      removed: [],
      setupVersion: '0.7.1',
    });

    expect(summary).toContain('## Update Summary');
    expect(summary).toContain('claude');
    expect(summary).toContain('3');
    expect(summary).toContain('none');
    expect(summary).toContain('0.7.1');
  });

  it("buildUpdateSummary with null setupVersion omits version line", () => {
    const summary = buildUpdateSummary({
      platforms: ['claude'],
      installedCount: 2,
      packs: [],
      removed: [],
      setupVersion: null,
    });
    expect(summary).not.toContain('Setup version');
  });
});

// ─── Integration helpers ──────────────────────────────────────────────────────

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const CONFIG_REL = join('_dream_context', 'state', '.config.json');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-drift-upd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 60000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

function scaffoldClaudeInstall(tmp: string): void {
  run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
  run('install-skill --platforms claude', tmp);
}

// Read package.json version for assertion
const PKG = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
const CLI_VERSION: string = PKG.version;

// ─── AC1: update writes setupVersion ─────────────────────────────────────────

describe("setup-drift-update integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("update writes setupVersion on success", () => {
    scaffoldClaudeInstall(tmp);

    // Confirm config exists before update
    const configPath = join(tmp, CONFIG_REL);
    expect(existsSync(configPath)).toBe(true);

    // Seed a stale setupVersion to simulate drift
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.setupVersion = '0.0.1';
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    const output = run('update --yes', tmp);
    expect(output).not.toContain('Error');

    const afterConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterConfig.setupVersion).toBe(CLI_VERSION);
  });

  // AC11
  it("packs-only does not bump setupVersion", () => {
    scaffoldClaudeInstall(tmp);

    const configPath = join(tmp, CONFIG_REL);
    expect(existsSync(configPath)).toBe(true);

    // Seed a stale setupVersion
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.setupVersion = '0.0.1';
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    run('update --packs-only --yes', tmp);

    // setupVersion must remain '0.0.1' — packs-only does not refresh core
    const afterConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterConfig.setupVersion).toBe('0.0.1');
  });
});
