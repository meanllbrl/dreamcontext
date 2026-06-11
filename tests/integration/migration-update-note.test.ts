/**
 * Integration test — AC-7 update-path migration notice (end-to-end).
 *
 * Purpose: verify the REAL update command (not a logic replica) correctly:
 *   1. runs the 0.7.0 data-structures migration when setupVersion is below 0.7.0
 *   2. writes a 'code' entry to state/.migrations.json (the ledger)
 *   3. queues pendingMigrationNotices into state/.sleep.json
 *   4. the subsequent snapshot command outputs the "Migrations applied" note
 *
 * The old unit test (migration-report.test.ts L116-145) replicated update.ts's
 * notice-queueing logic inline, so a real bug in update.ts's queueing block
 * would have been invisible to it. This test drives the real CLI command.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(
    tmpdir(),
    `ac-mig-update-note-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
    });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

/** Scaffold a minimal project with claude platform installed. */
function scaffoldProject(tmp: string): void {
  run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
  run('install-skill --platforms claude', tmp);
}

/**
 * Put the project into a pre-0.7.0 state:
 *   - remove the already-migrated knowledge/data-structures/default.md that init creates
 *   - create core/data-structures/default.md (the OLD layout the migration moves)
 *   - overwrite state/.config.json setupVersion to '0.6.0' so update's
 *     runMigrations sees (0.6.0, <cli>] and the 0.7.0 migration is pending
 *
 * After init + install-skill, the project is already in the new layout (init creates
 * knowledge/data-structures/default.md directly). We simulate the OLD state by
 * removing that file and placing the source file in core/data-structures/ instead.
 */
function backdateAndPlantOldLayout(tmp: string): void {
  const ctxRoot = join(tmp, '_dream_context');

  // Remove the already-migrated file that init creates so the migration has real work
  const newFile = join(ctxRoot, 'knowledge', 'data-structures', 'default.md');
  if (existsSync(newFile)) {
    rmSync(newFile, { force: true });
  }

  // Plant the old core/data-structures/default.md (source layout)
  const oldDir = join(ctxRoot, 'core', 'data-structures');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(
    join(oldDir, 'default.md'),
    '---\nname: default\ntype: data-structures\n---\n\nCREATE TABLE x (id UUID);\n',
    'utf-8',
  );

  // Back-date setupVersion to 0.6.0 so the migration is in range
  const configPath = join(ctxRoot, 'state', '.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  config.setupVersion = '0.6.0';
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

describe('migration update-path notice — AC-7 integration', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('real update command: applies 0.7.0 migration, writes ledger+sleep notices, snapshot surfaces the note', () => {
    // ── Arrange ──────────────────────────────────────────────────────────────
    scaffoldProject(tmp);
    backdateAndPlantOldLayout(tmp);

    const ctxRoot = join(tmp, '_dream_context');
    const ledgerPath = join(ctxRoot, 'state', '.migrations.json');
    const sleepPath = join(ctxRoot, 'state', '.sleep.json');
    const newFilePath = join(ctxRoot, 'knowledge', 'data-structures', 'default.md');
    const oldFilePath = join(ctxRoot, 'core', 'data-structures', 'default.md');

    // Precondition: old layout exists, new layout absent
    expect(existsSync(oldFilePath)).toBe(true);
    expect(existsSync(newFilePath)).toBe(false);

    // ── Act: run the REAL update command ─────────────────────────────────────
    const updateOutput = run('update --yes', tmp);

    // ── Assert: 1. file moved to new location ────────────────────────────────
    // NOTE: migrateDataStructures leaves the old directory in place intentionally
    // (the user deletes it after confirming the move). Only the DESTINATION is
    // asserted as present, not the source removal.
    expect(existsSync(newFilePath)).toBe(true);

    // ── Assert: 2. ledger has a 'code' entry for 0.7.0 ───────────────────────
    expect(existsSync(ledgerPath)).toBe(true);
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Array<{
      version: string;
      step: string;
      executor: string;
      summary: string;
    }>;
    const codeEntries = ledger.filter(
      (e) => e.version === '0.7.0' && e.executor === 'code',
    );
    expect(codeEntries.length).toBeGreaterThanOrEqual(1);
    const moveEntry = codeEntries.find((e) => e.step === 'move-data-structures');
    expect(moveEntry).toBeDefined();

    // ── Assert: 3. .sleep.json has pendingMigrationNotices ───────────────────
    expect(existsSync(sleepPath)).toBe(true);
    const sleepRaw = JSON.parse(readFileSync(sleepPath, 'utf-8')) as {
      pendingMigrationNotices?: unknown;
    };
    expect(Array.isArray(sleepRaw.pendingMigrationNotices)).toBe(true);
    const notices = (sleepRaw.pendingMigrationNotices as unknown[]).filter(
      (n): n is string => typeof n === 'string',
    );
    expect(notices.length).toBeGreaterThanOrEqual(1);
    // Each notice must match "<version> <step>: <summary>"
    for (const notice of notices) {
      expect(notice).toMatch(/^\S+ \S+: .+/);
    }
    // The move-data-structures step must be in the notices
    const moveNotice = notices.find((n) => n.includes('move-data-structures'));
    expect(moveNotice).toBeDefined();

    // Sanity: update output mentions migration step(s) were applied
    expect(updateOutput.toLowerCase()).toMatch(/migration/);

    // ── Act: run snapshot ─────────────────────────────────────────────────────
    const snapshotOutput = run('snapshot', tmp);

    // ── Assert: 4. snapshot includes "Migrations applied since last session" ──
    expect(snapshotOutput).toContain('Migrations applied since last session');
    // The notice text itself must appear in the snapshot
    expect(snapshotOutput).toContain('move-data-structures');
  });
});
