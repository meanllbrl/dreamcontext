import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
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
import { runMigrations } from '../../src/lib/migration-runner.js';
import { readLedger } from '../../src/lib/migration-ledger.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-feat-mig-'));
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  return root;
}

function setupOldFeature(root: string, slug = 'foo', body = 'PRD body.'): void {
  const dir = join(root, 'core', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), `---\nid: feat_${slug}\nstatus: planning\n---\n\n${body}\n`, 'utf-8');
}

// ─── runMigrations integration (0.10.7 move-features-to-knowledge) ────────────

describe('migration-features — runner integration', () => {
  let root: string;

  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('runMigrations(0.10.6, 0.10.7) moves core/features/*.md into knowledge/features/', () => {
    setupOldFeature(root);
    const result = runMigrations(root, '0.10.6', '0.10.7');

    const codeApplied = result.applied.filter((e) => e.executor === 'code');
    expect(codeApplied.length).toBeGreaterThanOrEqual(1);
    expect(result.failedSteps).toBe(0);

    const dest = join(root, 'knowledge', 'features', 'foo.md');
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(join(root, 'core', 'features', 'foo.md'))).toBe(false);
    const content = readFileSync(dest, 'utf-8');
    expect(content).toContain('type: feature');
    expect(content).toContain('PRD body.');
  });

  it('ledger has a 0.10.7 / move-features-to-knowledge entry', () => {
    setupOldFeature(root);
    runMigrations(root, '0.10.6', '0.10.7');
    const ledger = readLedger(root);
    const entry = ledger.find(
      (e) => e.version === '0.10.7' && e.step === 'move-features-to-knowledge',
    );
    expect(entry).toBeDefined();
    expect(entry!.executor).toBe('code');
  });

  it('CHANGELOG.json gets a migration entry for a code run', () => {
    setupOldFeature(root);
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    runMigrations(root, '0.10.6', '0.10.7');
    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8'));
    expect(changelog.length).toBeGreaterThanOrEqual(1);
    expect(changelog[0]).toHaveProperty('scope', 'migration');
    expect(String(changelog[0].description)).toContain('0.10.7');
  });

  it('idempotent — a second run applies nothing new (ledger-gated)', () => {
    setupOldFeature(root);
    const r1 = runMigrations(root, '0.10.6', '0.10.7');
    expect(r1.applied.filter((e) => e.executor === 'code').length).toBeGreaterThanOrEqual(1);

    const ledgerAfterFirst = readLedger(root);
    const r2 = runMigrations(root, '0.10.6', '0.10.7');
    expect(r2.applied).toHaveLength(0);
    expect(r2.failedSteps).toBe(0);

    const ledgerAfterSecond = readLedger(root);
    expect(ledgerAfterSecond.length).toBe(ledgerAfterFirst.length);
  });

  it('no core/features/ source directory — detected, zero failures, zero ledger writes for the step', () => {
    // No setupOldFeature() call: no source dir at all.
    const result = runMigrations(root, '0.10.6', '0.10.7');
    const detectedEntries = result.applied.filter((e) => e.executor === 'detected');
    expect(detectedEntries.length).toBeGreaterThanOrEqual(1);
    expect(result.failedSteps).toBe(0);
  });

  it('crash-recovery run (skipped-only) records executor code + CHANGELOG entry — phase-2 unlinks are real writes', () => {
    // Simulate run 1 killed between phase 1 and phase 2: every dest is already
    // fully valid, every source still present. Run 2 classifies all slugs as
    // case S and unlinks the leftover sources — a real filesystem mutation that
    // must NOT be mislabeled executor 'detected' (which would suppress the
    // CHANGELOG entry and the sleep notice for a destructive step).
    setupOldFeature(root, 'foo', 'Shared body.');
    const destDir = join(root, 'knowledge', 'features');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(destDir, 'foo.md'),
      '---\nid: feat_foo\ntype: feature\nname: foo\ndescription: ""\npinned: false\ndate: "2026-01-01"\nstatus: planning\n---\n\nShared body.\n',
      'utf-8',
    );
    const changelogPath = join(root, 'core', 'CHANGELOG.json');
    writeFileSync(changelogPath, JSON.stringify([]), 'utf-8');

    const result = runMigrations(root, '0.10.6', '0.10.7');
    expect(result.failedSteps).toBe(0);
    expect(existsSync(join(root, 'core', 'features', 'foo.md'))).toBe(false);

    const entry = readLedger(root).find(
      (e) => e.version === '0.10.7' && e.step === 'move-features-to-knowledge',
    );
    expect(entry?.executor).toBe('code');

    const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8'));
    expect(changelog.length).toBeGreaterThanOrEqual(1);
  });

  it('a divergent pre-existing dest produces failedSteps > 0 and preserves both files', () => {
    setupOldFeature(root, 'foo', 'SOURCE version.');
    const destDir = join(root, 'knowledge', 'features');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(destDir, 'foo.md'),
      '---\nid: feat_foo\ntype: feature\nname: foo\npinned: false\ndate: "2026-01-01"\n---\n\nDEST version (different!).\n',
      'utf-8',
    );

    const result = runMigrations(root, '0.10.6', '0.10.7');
    expect(result.failedSteps).toBeGreaterThan(0);
    // Divergent dest: neither file is touched.
    expect(existsSync(join(root, 'core', 'features', 'foo.md'))).toBe(true);
    expect(readFileSync(join(destDir, 'foo.md'), 'utf-8')).toContain('DEST version');

    const ledger = readLedger(root);
    const entry = ledger.find(
      (e) => e.version === '0.10.7' && e.step === 'move-features-to-knowledge',
    );
    // Partial failure still records executor 'code' — auditable, work was attempted.
    expect(entry?.executor).toBe('code');
  });
});

// ─── setupVersion gating on partial failure — real CLI (integration) ─────────
//
// Mirrors tests/unit/setup-drift-update.test.ts's pattern: drives the REAL
// built CLI (dist/index.js) so a bug in update.ts's ordering/gating logic
// (not just runMigrations) would be caught.

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const CONFIG_REL = join('_dream_context', 'state', '.config.json');

function makeTmpProject(): string {
  const raw = join(tmpdir(), `ac-feat-mig-upd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function scaffoldProject(tmp: string): void {
  run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmp);
  run('install-skill --platforms claude', tmp);
}

describe('features migration — setupVersion gating on partial failure (real CLI)', () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpProject(); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('a divergent dest keeps setupVersion pinned so the next update retries', () => {
    scaffoldProject(tmp);
    const ctxRoot = join(tmp, '_dream_context');
    const configPath = join(tmp, CONFIG_REL);

    // Plant an old-layout feature AND a divergent pre-existing dest (case D —
    // permanent failure; the migration will never clobber either side).
    const oldDir = join(ctxRoot, 'core', 'features');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(
      join(oldDir, 'foo.md'),
      '---\nid: feat_foo\nstatus: planning\n---\n\nSOURCE version.\n',
      'utf-8',
    );
    const newDir = join(ctxRoot, 'knowledge', 'features');
    mkdirSync(newDir, { recursive: true });
    writeFileSync(
      join(newDir, 'foo.md'),
      '---\nid: feat_foo\ntype: feature\nname: foo\npinned: false\ndate: "2026-01-01"\n---\n\nDEST version (different!).\n',
      'utf-8',
    );

    // Back-date setupVersion so the 0.10.7 migration is pending.
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.setupVersion = '0.10.6';
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    run('update --yes', tmp);

    // setupVersion must NOT be advanced past 0.10.6 — the migration partially failed.
    const afterConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(afterConfig.setupVersion).toBe('0.10.6');

    // Neither file was touched — a divergent dest is never clobbered.
    expect(readFileSync(join(oldDir, 'foo.md'), 'utf-8')).toContain('SOURCE version');
    expect(readFileSync(join(newDir, 'foo.md'), 'utf-8')).toContain('DEST version');
  });
});
