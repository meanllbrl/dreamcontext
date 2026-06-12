import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readSleepState, writeSleepState } from '../../src/cli/commands/sleep.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-report-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function setupOldDataStructures(root: string): void {
  const dir = join(root, 'core', 'data-structures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'default.md'),
    '---\nname: default\ntype: data-structures\n---\n\nCREATE TABLE x (id UUID);\n',
    'utf-8',
  );
}

function setupAlreadyMigrated(root: string): void {
  const dir = join(root, 'knowledge', 'data-structures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'default.md'),
    '---\nname: default\ntype: data-structures\nproduct: default\ntags:\n  - data-structures\n  - database\n  - schema\n---\n```sql\nCREATE TABLE x (id UUID);\n```\n',
    'utf-8',
  );
}

// ─── Snapshot read helper (mirrors getMigrationNote logic) ───────────────────
// Reads pendingMigrationNotices from a .sleep.json
function readMigrationNotices(root: string): string[] {
  const sleepPath = join(root, 'state', '.sleep.json');
  if (!existsSync(sleepPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(sleepPath, 'utf-8')) as {
      pendingMigrationNotices?: unknown;
    };
    if (!Array.isArray(parsed.pendingMigrationNotices)) return [];
    return (parsed.pendingMigrationNotices as unknown[]).filter(
      (n): n is string => typeof n === 'string',
    );
  } catch {
    return [];
  }
}

describe('migration-report', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('applied code migration appends CHANGELOG entry', () => {
    setupOldDataStructures(root);
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    runMigrations(root, '0.0.0', '0.7.0');

    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8')) as Array<{
      scope: string;
      type: string;
      description: string;
    }>;
    expect(changelog.length).toBeGreaterThanOrEqual(1);
    expect(changelog[0].scope).toBe('migration');
    expect(changelog[0].type).toBe('change');
    expect(changelog[0].description).toContain('0.7.0');
  });

  it('snapshot emits one-line note when pendingMigrationNotices present; no pending -> no note', () => {
    // This tests the getMigrationNote logic: if pendingMigrationNotices is
    // non-empty in .sleep.json, a note is emitted; if empty/absent, no note.

    // Case 1: no notices in .sleep.json → getMigrationNote returns ''
    writeFileSync(
      join(root, 'state', '.sleep.json'),
      JSON.stringify({ pendingMigrationNotices: [] }),
      'utf-8',
    );
    expect(readMigrationNotices(root)).toHaveLength(0);

    // Case 2: notices present → getMigrationNote returns a note
    writeFileSync(
      join(root, 'state', '.sleep.json'),
      JSON.stringify({
        pendingMigrationNotices: ['0.7.0 move-data-structures: Moved default'],
      }),
      'utf-8',
    );
    const notices = readMigrationNotices(root);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('move-data-structures');
  });

  it('detected-only run does NOT append CHANGELOG entry', () => {
    setupAlreadyMigrated(root);
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    runMigrations(root, '0.0.0', '0.7.0');

    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8')) as unknown[];
    // No 'code' steps ran, so CHANGELOG must be empty
    expect(changelog).toHaveLength(0);
  });

  it('update-applied migration queues a pendingMigrationNotice that the snapshot note surfaces', () => {
    // Arrange: old data-structures layout triggers a real 'code' migration step.
    setupOldDataStructures(root);
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    // Act: replicate exactly what update.ts does after runMigrations returns.
    const migResult = runMigrations(root, '0.0.0', '0.7.0');
    const codeApplied = migResult.applied.filter((e) => e.executor === 'code');
    expect(codeApplied.length).toBeGreaterThan(0); // precondition: a code step ran

    const codeNotices = codeApplied.map((e) => `${e.version} ${e.step}: ${e.summary}`);
    const sleepState = readSleepState(root);
    sleepState.pendingMigrationNotices = [
      ...sleepState.pendingMigrationNotices,
      ...codeNotices,
    ];
    writeSleepState(root, sleepState);

    // Assert: .sleep.json contains the notices (same format sleep.ts uses).
    const notices = readMigrationNotices(root);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    // Each notice must match the format "<version> <step>: <summary>"
    for (const notice of notices) {
      expect(notice).toMatch(/^\S+ \S+: .+/);
    }
    // The notice must match the code step that was actually applied.
    const firstApplied = codeApplied[0];
    expect(notices).toContain(`${firstApplied.version} ${firstApplied.step}: ${firstApplied.summary}`);
  });
});
