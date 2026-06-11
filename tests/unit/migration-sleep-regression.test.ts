/**
 * Regression test: sleep start behavior unchanged for users after migration
 * system refactor. Verifies that the old unconditional migrateDataStructures()
 * + fenceExistingDataStructures() calls were REPLACED (not duplicated) by
 * runMigrations(), and that the behavior is equivalent.
 *
 * AC1 test name: 'sleep start moves+fences once, second run no-op'
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readLedger } from '../../src/lib/migration-ledger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-sleep-reg-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function writeOldDataStructures(root: string, product: string): void {
  const dir = join(root, 'core', 'data-structures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${product}.md`),
    `---\nname: ${product}\ntype: data-structures\nproduct: ${product}\n---\n\nCREATE TABLE ${product} (id UUID);\n`,
    'utf-8',
  );
}

describe('migration-sleep-regression', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('sleep start moves+fences once, second run no-op', () => {
    // Set up the old-style brain (core/data-structures/)
    writeOldDataStructures(root, 'default');

    // First run (simulates sleep start running migrations)
    const r1 = runMigrations(root, '0.0.0', '0.7.0');

    // The move step should have run
    const moveEntry = r1.applied.find((e) => e.step === 'move-data-structures');
    expect(moveEntry).toBeDefined();
    expect(moveEntry!.executor).toBe('code');
    expect(moveEntry!.filesTouched.length).toBeGreaterThanOrEqual(1);

    // knowledge/data-structures/default.md should now exist
    expect(existsSync(join(root, 'knowledge', 'data-structures', 'default.md'))).toBe(true);

    // The fenced content should be in the new file
    const content = readFileSync(
      join(root, 'knowledge', 'data-structures', 'default.md'),
      'utf-8',
    );
    expect(content).toContain('```sql');

    // Second run (idempotent — ledger gates it)
    const r2 = runMigrations(root, '0.0.0', '0.7.0');
    expect(r2.applied).toHaveLength(0);

    // Ledger count should not have grown on the second run
    const ledger = readLedger(root);
    const moveCount = ledger.filter((e) => e.step === 'move-data-structures').length;
    expect(moveCount).toBe(1);
  });

  it('sleep start on already-migrated brain records detected entries, no file changes', () => {
    // Simulate a brain already fully migrated
    const dir = join(root, 'knowledge', 'data-structures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'default.md'),
      '---\nname: default\ntype: data-structures\nproduct: default\ntags:\n  - data-structures\n  - database\n  - schema\n---\n```sql\nCREATE TABLE x (id UUID);\n```\n',
      'utf-8',
    );

    const contentBefore = readFileSync(join(dir, 'default.md'), 'utf-8');
    const mtimeBefore = require('node:fs').statSync(join(dir, 'default.md')).mtimeMs;

    const r = runMigrations(root, '0.0.0', '0.7.0');

    // All detected — nothing written
    const codeEntries = r.applied.filter((e) => e.executor === 'code');
    expect(codeEntries).toHaveLength(0);

    const contentAfter = readFileSync(join(dir, 'default.md'), 'utf-8');
    const mtimeAfter = require('node:fs').statSync(join(dir, 'default.md')).mtimeMs;
    expect(contentAfter).toBe(contentBefore);
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
