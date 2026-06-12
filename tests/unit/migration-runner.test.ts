import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readLedger } from '../../src/lib/migration-ledger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-runner-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function setupOldDataStructures(root: string, product = 'default'): void {
  const dir = join(root, 'core', 'data-structures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${product}.md`),
    `---\nname: ${product}\ntype: data-structures\nproduct: ${product}\n---\n\nCREATE TABLE x (id UUID);\n`,
    'utf-8',
  );
}

function setupAlreadyMigrated(root: string, product = 'default'): void {
  const dir = join(root, 'knowledge', 'data-structures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${product}.md`),
    `---\nname: ${product}\ntype: data-structures\nproduct: ${product}\ntags:\n  - data-structures\n  - database\n  - schema\n---\n\`\`\`sql\nCREATE TABLE x (id UUID);\n\`\`\`\n`,
    'utf-8',
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('migration-runner', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runMigrations applies once, ledger-gated second run is no-op', () => {
    setupOldDataStructures(root);
    // First run: applies code steps
    const r1 = runMigrations(root, '0.0.0', '0.7.0');
    const codeApplied = r1.applied.filter((e) => e.executor === 'code');
    expect(codeApplied.length).toBeGreaterThanOrEqual(1);

    // Verify ledger was written
    const ledger1 = readLedger(root);
    expect(ledger1.length).toBeGreaterThanOrEqual(1);

    // Second run: all steps already in ledger → no new entries
    const r2 = runMigrations(root, '0.0.0', '0.7.0');
    expect(r2.applied).toHaveLength(0);

    // Ledger should not have grown further
    const ledger2 = readLedger(root);
    expect(ledger2.length).toBe(ledger1.length);
  });

  it('downgrade guard: runMigrations with to < from returns empty', () => {
    const result = runMigrations(root, '0.9.0', '0.7.0');
    expect(result.applied).toHaveLength(0);
    expect(result.pendingAgentTasks).toHaveLength(0);
  });

  it('equal versions (0.7.0 -> 0.7.0) returns empty', () => {
    const result = runMigrations(root, '0.7.0', '0.7.0');
    expect(result.applied).toHaveLength(0);
  });

  it('migrated content + empty ledger -> detected backfill, zero files written', () => {
    // AC4: team clone scenario — knowledge/data-structures/ already populated,
    // core/data-structures/ absent, EMPTY ledger.
    setupAlreadyMigrated(root);
    // Ensure no core/data-structures/ source dir exists
    expect(existsSync(join(root, 'core', 'data-structures'))).toBe(false);

    // Capture file contents and mtimes before runMigrations
    const knowledgeFile = join(root, 'knowledge', 'data-structures', 'default.md');
    const contentBefore = readFileSync(knowledgeFile, 'utf-8');
    const mtimeBefore = statSync(knowledgeFile).mtimeMs;

    const result = runMigrations(root, '0.0.0', '0.7.0');

    // All steps should be 'detected' (no actual writes)
    const codeEntries = result.applied.filter((e) => e.executor === 'code');
    expect(codeEntries).toHaveLength(0);

    const detectedEntries = result.applied.filter((e) => e.executor === 'detected');
    expect(detectedEntries.length).toBeGreaterThanOrEqual(1);

    // File content and mtime MUST be unchanged
    const contentAfter = readFileSync(knowledgeFile, 'utf-8');
    const mtimeAfter = statSync(knowledgeFile).mtimeMs;
    expect(contentAfter).toBe(contentBefore);
    expect(mtimeAfter).toBe(mtimeBefore);

    // Ledger should have been written with 'detected' entries
    const ledger = readLedger(root);
    expect(ledger.length).toBeGreaterThanOrEqual(1);
    for (const entry of ledger) {
      expect(entry.executor).toBe('detected');
      expect(entry.filesTouched).toHaveLength(0);
    }
  });

  it('CHANGELOG.json append: code run appends entry, detected run does not', () => {
    setupOldDataStructures(root);
    // Create a CHANGELOG.json so the guard passes
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    runMigrations(root, '0.0.0', '0.7.0');
    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8'));
    // Should have appended at least one entry
    expect(changelog.length).toBeGreaterThanOrEqual(1);
    expect(changelog[0]).toHaveProperty('scope', 'migration');
    expect(changelog[0]).toHaveProperty('type', 'change');
    expect(changelog[0]).toHaveProperty('references');
  });

  it('CHANGELOG.json NOT appended for detected-only run (no-file-write)', () => {
    setupAlreadyMigrated(root);
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    runMigrations(root, '0.0.0', '0.7.0');
    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8'));
    // No code steps fired, so no CHANGELOG entry
    expect(changelog).toHaveLength(0);
  });

  it('CHANGELOG.json not created when absent (no crash)', () => {
    setupOldDataStructures(root);
    // No CHANGELOG.json present — should run without throwing
    expect(() => runMigrations(root, '0.0.0', '0.7.0')).not.toThrow();
    // File should still not exist
    expect(existsSync(join(root, 'core', 'CHANGELOG.json'))).toBe(false);
  });
});
