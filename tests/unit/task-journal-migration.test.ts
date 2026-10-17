import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateTaskJournals } from '../../src/lib/task-journal-migration.js';
import { migration0330 } from '../../src/migrations/0.33.0.js';
import { REGISTRY } from '../../src/migrations/index.js';
import { taskLockPath } from '../../src/lib/task-file-lock.js';
import { SyncLedger, hashContent } from '../../src/lib/task-backend/sync-state.js';
import { readJournal, parseJournal } from '../../src/lib/task-journal.js';
import { buildBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';

let root: string;
let ctx: string;
let stateDir: string;

const ENTRIES = '### 2026-10-02 - Session Update\n- legacy progress\n### 2026-10-01 - Created\n- Task created.';
const legacyCard = (name: string) => [
  '---', `id: task_${name}`, `name: ${name}`, 'status: in_review', 'created_at: "2026-10-01"', 'updated_at: "2026-10-02"', '---', '',
  '## Why', '<!-- What problem does this solve? What breaks if we don\'t do it? Be concrete — name the user, the friction, the cost. -->', '',
  `Because ${name} matters.`, '',
  '<!-- Other sections (User Stories, Acceptance Criteria, Workflow, Constraints & Decisions, Technical Details, Notes) are created on first insert — `dreamcontext tasks insert <task> <section> "…"`. A section that has nothing to say doesn\'t exist. -->', '',
  '## Acceptance Criteria', '', '- [x] shipped it', '- [ ] still open', '',
  '## Changelog', '<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->', '', ENTRIES, '',
].join('\n');

function write(slug: string, content = legacyCard(slug)): void {
  writeFileSync(join(stateDir, `${slug}.md`), content);
}
const read = (rel: string) => readFileSync(join(stateDir, rel), 'utf-8');

beforeEach(() => {
  root = realpathSync(mkdtempSyncSafe());
  ctx = join(root, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(join(stateDir, 'archive'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function mkdtempSyncSafe(): string {
  const dir = join(tmpdir(), `dc-jmig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('the 0.33.0 journal migration', () => {
  it('is registered as 0.33.0', () => {
    expect(REGISTRY.find((m) => m.version === '0.33.0')).toBe(migration0330);
  });

  it('moves the Changelog verbatim, strips template comments, marks legacy ticks, backs up to tmp/ and leaves archive alone', () => {
    write('alpha');
    write('beta');
    writeFileSync(join(stateDir, 'archive', 'old.md'), legacyCard('old'));
    const before = { alpha: read('alpha.md'), archive: read('archive/old.md') };

    const r = migrateTaskJournals(ctx, { now: new Date('2026-10-16T12:00:00Z') });
    expect(r.migrated).toEqual(['alpha', 'beta']);
    expect(r.failed).toEqual([]);

    const card = read('alpha.md');
    expect(card).not.toContain('## Changelog');
    expect(card).not.toContain('<!--');
    expect(card).toContain('- [x] shipped it (evidence: legacy)');
    expect(card).toContain('- [ ] still open\n');
    expect(read('journal/alpha.md')).toBe(`\n${ENTRIES}\n`);
    // Byte ledger: original = card (minus the added marks) + journal + stripped.
    const { original, card: c, journal, stripped, added } = r.bytes;
    expect(original).toBe(c + journal + stripped);
    expect(added).toBe(2 * ' (evidence: legacy)'.length);
    expect(original).toBe(Buffer.byteLength(before.alpha) + Buffer.byteLength(legacyCard('beta')));
    // Backup lives in tmp/ (ignored by the generated brain gitignore), never in state/.
    expect(r.backupDir).toBe(join(ctx, 'tmp', 'pre-migration-2026-10-16-12-00-00'));
    expect(read('../tmp/pre-migration-2026-10-16-12-00-00/alpha.md')).toBe(before.alpha);
    expect(readdirSync(stateDir).some((f) => f.startsWith('.pre-migration') || f.startsWith('pre-migration'))).toBe(false);
    expect(buildBrainGitignore('github')).toMatch(/^tmp\/$/m);
    expect(read('archive/old.md')).toBe(before.archive);
  });

  it('a second run changes nothing and reports detected', () => {
    write('alpha');
    migrateTaskJournals(ctx);
    const card = read('alpha.md');
    const journal = read('journal/alpha.md');
    const step = migration0330.steps[0](ctx);
    expect(step.detected).toBe(true);
    expect(step.filesTouched).toEqual([]);
    expect(read('alpha.md')).toBe(card);
    expect(read('journal/alpha.md')).toBe(journal);
  });

  it('a crash between the journal write and the card write reruns without duplicates', () => {
    write('alpha');
    mkdirSync(join(stateDir, 'journal'), { recursive: true });
    writeFileSync(join(stateDir, 'journal', 'alpha.md'), `${ENTRIES}\n`); // journal landed, card did not
    const r = migrateTaskJournals(ctx);
    expect(r.duplicatesCollapsed).toBe(2);
    expect(readJournal(stateDir, 'alpha')).toHaveLength(2);
    expect(read('alpha.md')).not.toContain('## Changelog');
  });

  it('a busy task lock fails that step (version stays pinned) and the next run retries it', () => {
    write('alpha');
    write('beta');
    const lock = taskLockPath(ctx, 'beta');
    mkdirSync(join(stateDir, '.locks'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const step = migration0330.steps[0](ctx);
    expect(step.failedCount).toBe(1);
    expect(read('beta.md')).toContain('## Changelog');
    expect(read('alpha.md')).not.toContain('## Changelog');
    rmSync(lock);
    const retry = migration0330.steps[0](ctx);
    expect(retry.failedCount ?? 0).toBe(0);
    expect(read('beta.md')).not.toContain('## Changelog');
  }, 15_000);

  it('a busy-lock-failed task is not seeded; its retry seeds every legacy entry as posted (end-review Major)', () => {
    write('beta');
    const raw = read('beta.md');
    const ledger = new SyncLedger(ctx);
    ledger.updateTaskSync('beta', { last_synced_at: 1, base_snapshot: { hash: hashContent(raw), body: raw }, localHash: hashContent(raw) });
    const lock = taskLockPath(ctx, 'beta');
    mkdirSync(join(stateDir, '.locks'), { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    migrateTaskJournals(ctx);
    const afterFail = new SyncLedger(ctx).taskSync('beta')!;
    expect(afterFail.posted_journal_ids).toBeUndefined();
    expect(afterFail.base_snapshot!.body).toContain('## Changelog');
    rmSync(lock);
    migrateTaskJournals(ctx);
    const ids = readJournal(stateDir, 'beta').map((e) => e.id).sort();
    expect(ids.length).toBeGreaterThan(0);
    expect(new SyncLedger(ctx).taskSync('beta')!.posted_journal_ids).toEqual(ids);
  }, 15_000);

  it('a running task sync fails the whole step and writes nothing', () => {
    write('alpha');
    const ledger = new SyncLedger(ctx);
    expect(ledger.acquireSyncLock(Date.now(), 180_000)).toBe(true);
    const r = migrateTaskJournals(ctx);
    expect(r.lockBusy).toBe(true);
    expect(r.failed).toHaveLength(1);
    expect(read('alpha.md')).toContain('## Changelog');
    ledger.releaseSyncLock();
  });

  it('seeds posted_journal_ids from the old base snapshot and strips only the Changelog from the base', () => {
    write('alpha');
    const raw = read('alpha.md');
    const ledger = new SyncLedger(ctx);
    ledger.updateTaskSync('alpha', { last_synced_at: 1, base_snapshot: { hash: hashContent(raw), body: raw }, localHash: hashContent(raw) });
    migrateTaskJournals(ctx);
    const entry = new SyncLedger(ctx).taskSync('alpha')!;
    const ids = readJournal(stateDir, 'alpha').map((e) => e.id).sort();
    expect(entry.posted_journal_ids).toEqual(ids);
    expect(entry.base_snapshot!.body).not.toContain('## Changelog');
    // The base keeps what the remote holds (template comments), so the lean card is pushed once.
    expect(entry.base_snapshot!.body).toContain('<!-- What problem');
    expect(entry.localHash).not.toBe(hashContent(read('alpha.md')));
    expect(parseJournal(read('journal/alpha.md'))).toHaveLength(2);
  });

  it('dry run reports and writes nothing', () => {
    write('alpha');
    const before = read('alpha.md');
    const r = migrateTaskJournals(ctx, { dryRun: true });
    expect(r.migrated).toEqual(['alpha']);
    expect(read('alpha.md')).toBe(before);
    expect(existsSync(join(stateDir, 'journal'))).toBe(false);
    expect(existsSync(join(ctx, 'tmp'))).toBe(false);
  });
});
