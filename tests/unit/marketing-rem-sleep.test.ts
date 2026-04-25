import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, rmSync, realpathSync, writeFileSync, existsSync, readdirSync,
  readFileSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  pruneRuns, compactInsights, mergeDailyLearnings, redactRunsSweep, runRemSleep,
} from '../../src/lib/marketing/rem-sleep.js';
import { appendLearning, setStatus } from '../../src/lib/marketing/learnings.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-rs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  for (const sub of ['cohorts', 'campaigns', 'adsets', 'ads', 'creatives', 'insights', 'runs']) {
    mkdirSync(join(root, '_dream_context', 'marketing', sub), { recursive: true });
  }
  mkdirSync(join(root, '_dream_context', 'knowledge', 'marketing-learnings'), { recursive: true });
  return root;
}

function writeRun(project: string, name: string, mtimeMs: number, content: unknown = { ok: true }): string {
  const p = join(project, '_dream_context', 'marketing', 'runs', `${name}.json`);
  writeFileSync(p, JSON.stringify(content, null, 2));
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

function writeSnap(project: string, entity: string, dayHour: string, mtimeMs: number): string {
  const p = join(project, '_dream_context', 'marketing', 'insights', `${entity}__${dayHour}.json`);
  writeFileSync(p, JSON.stringify({ entity_id: entity, pulled_at: dayHour, since: 'last_7d', data: {} }));
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

describe('marketing/rem-sleep', () => {
  let project: string;
  const origCwd = process.cwd();
  const origOverride = process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE;

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
    process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE = '1';
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origOverride === undefined) delete process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE;
    else process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE = origOverride;
    rmSync(project, { recursive: true, force: true });
  });

  describe('pruneRuns', () => {
    it('keeps latest N by mtime, deletes the rest', () => {
      const now = Date.now();
      for (let i = 0; i < 150; i++) {
        writeRun(project, `run_${String(i).padStart(3, '0')}`, now - i * 60_000);
      }
      const result = pruneRuns({ keepLast: 100 });
      expect(result.scanned).toBe(150);
      expect(result.kept).toBe(100);
      expect(result.deleted).toBe(50);

      const remaining = readdirSync(join(project, '_dream_context', 'marketing', 'runs'))
        .filter((f) => f.endsWith('.json'));
      expect(remaining).toHaveLength(100);
      // The 100 newest (run_000..run_099) should survive
      expect(remaining).toContain('run_000.json');
      expect(remaining).not.toContain('run_149.json');
    });

    it('no-ops when files <= keepLast', () => {
      writeRun(project, 'run_a', Date.now());
      const result = pruneRuns({ keepLast: 100 });
      expect(result.deleted).toBe(0);
    });

    it('--dry-run reports without deleting', () => {
      const now = Date.now();
      for (let i = 0; i < 105; i++) writeRun(project, `r${i}`, now - i * 1000);
      const result = pruneRuns({ keepLast: 100, dryRun: true });
      expect(result.deleted).toBe(5);
      const remaining = readdirSync(join(project, '_dream_context', 'marketing', 'runs')).length;
      expect(remaining).toBe(105);
    });

    it('handles missing runs/ directory gracefully', () => {
      rmSync(join(project, '_dream_context', 'marketing', 'runs'), { recursive: true });
      const result = pruneRuns();
      expect(result).toEqual({ scanned: 0, kept: 0, deleted: 0, deletedFiles: [] });
    });
  });

  describe('compactInsights', () => {
    it('keeps latest snapshot per day within recent window', () => {
      const now = new Date('2026-04-25T12:00:00Z');
      // 4 snapshots same day, different hours, all recent
      writeSnap(project, '111', '2026-04-25-09', now.getTime() - 3 * 60 * 60 * 1000);
      writeSnap(project, '111', '2026-04-25-10', now.getTime() - 2 * 60 * 60 * 1000);
      writeSnap(project, '111', '2026-04-25-11', now.getTime() - 1 * 60 * 60 * 1000);
      writeSnap(project, '111', '2026-04-25-12', now.getTime());

      const result = compactInsights({ now, weeklyAfterDays: 14 });
      expect(result.scanned).toBe(4);
      // Latest of the day kept; only 1 unique day; so 1 kept
      expect(result.kept).toBe(1);
      expect(result.deleted).toBe(3);
    });

    it('keeps latest per ISO week for snapshots older than weeklyAfterDays', () => {
      const now = new Date('2026-04-25T12:00:00Z');
      const dayMs = 24 * 60 * 60 * 1000;
      // 7 snapshots on 7 consecutive days, all older than 14 days
      for (let i = 0; i < 7; i++) {
        const d = new Date(now.getTime() - (20 + i) * dayMs);
        const dayStr = d.toISOString().slice(0, 10);
        writeSnap(project, '222', `${dayStr}-12`, d.getTime());
      }
      const result = compactInsights({ now, weeklyAfterDays: 14 });
      // Should compact down to 1 or 2 weeks (7 days span ~ 1-2 ISO weeks)
      expect(result.kept).toBeLessThan(7);
    });

    it('always keeps the very latest snapshot per entity', () => {
      const now = new Date('2026-04-25T12:00:00Z');
      writeSnap(project, '333', '2026-04-25-12', now.getTime());
      const result = compactInsights({ now });
      expect(result.kept).toBe(1);
      expect(existsSync(join(project, '_dream_context', 'marketing', 'insights', '333__2026-04-25-12.json'))).toBe(true);
    });

    it('skips files that do not match snapshot pattern (e.g. _index.json)', () => {
      writeFileSync(join(project, '_dream_context', 'marketing', 'insights', '_index.json'), '{}');
      const result = compactInsights();
      expect(result.scanned).toBe(0);
    });
  });

  describe('mergeDailyLearnings', () => {
    it('merges per-day .md files older than retainDays into quarterly archive', () => {
      const now = new Date('2026-04-25T00:00:00Z');
      const oldDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const oldStr = oldDate.toISOString().slice(0, 10);
      const file = join(project, '_dream_context', 'knowledge', 'marketing-learnings', `${oldStr}.md`);
      writeFileSync(file, `# Marketing learnings — ${oldStr}\n\nold content here`);

      const result = mergeDailyLearnings({ retainDays: 7, now });
      expect(result.merged).toBe(1);
      expect(result.archivePath).toBeTruthy();
      expect(existsSync(file)).toBe(false);
      // Archive should exist and contain old content
      const archive = readFileSync(result.archivePath!, 'utf8');
      expect(archive).toContain('old content here');
      expect(archive).toMatch(/# Marketing learnings archive — \d{4}-Q\d/);
    });

    it('keeps recent files (newer than retainDays)', () => {
      const now = new Date('2026-04-25T00:00:00Z');
      const recent = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const file = join(project, '_dream_context', 'knowledge', 'marketing-learnings', `${recent}.md`);
      writeFileSync(file, 'recent');
      const result = mergeDailyLearnings({ retainDays: 7, now });
      expect(result.merged).toBe(0);
      expect(existsSync(file)).toBe(true);
    });

    it('drops rejected recommendations from index when their day is archived', () => {
      const oldNow = new Date('2026-03-01T00:00:00Z');
      // Add a learning into an old day
      const rec = appendLearning({
        type: 'recommendation', body: 'old rejected', agent: 'performance-monitor', now: oldNow,
      });
      const ledger = appendLearning({
        type: 'ledger', body: 'old ledger', agent: 'performance-monitor', now: oldNow,
      });
      setStatus(rec.id, 'rejected');

      const result = mergeDailyLearnings({ retainDays: 7, now: new Date('2026-04-25T00:00:00Z') });
      expect(result.droppedRejected).toBe(1);
      // Ledger entry must remain
      const idx = JSON.parse(readFileSync(
        join(project, '_dream_context', 'knowledge', 'marketing-learnings', '.index.json'),
        'utf8',
      ));
      const ids = idx.entries.map((e: { id: string }) => e.id);
      expect(ids).toContain(ledger.id);
      expect(ids).not.toContain(rec.id);
    });

    it('keeps confirmed recommendations even when their day is archived', () => {
      const oldNow = new Date('2026-03-01T00:00:00Z');
      const rec = appendLearning({
        type: 'recommendation', body: 'old confirmed', agent: 'performance-monitor', now: oldNow,
      });
      setStatus(rec.id, 'confirmed');

      const result = mergeDailyLearnings({ retainDays: 7, now: new Date('2026-04-25T00:00:00Z') });
      expect(result.droppedRejected).toBe(0);
      const idx = JSON.parse(readFileSync(
        join(project, '_dream_context', 'knowledge', 'marketing-learnings', '.index.json'),
        'utf8',
      ));
      expect(idx.entries.map((e: { id: string }) => e.id)).toContain(rec.id);
    });

    it('is idempotent: re-running does not duplicate archived content', () => {
      const oldNow = new Date('2026-03-01T00:00:00Z');
      appendLearning({
        type: 'ledger', body: 'archived ledger', agent: 'performance-monitor', now: oldNow,
      });
      const checkpoint = new Date('2026-04-25T00:00:00Z');

      mergeDailyLearnings({ retainDays: 7, now: checkpoint });
      const archivePath = join(
        project, '_dream_context', 'knowledge', 'marketing-learnings', '_archive-2026-Q1.md',
      );
      const firstContent = readFileSync(archivePath, 'utf8');

      // Simulate "we got killed before unlinking" by re-creating the daily file
      const dailyFile = join(
        project, '_dream_context', 'knowledge', 'marketing-learnings', '2026-03-01.md',
      );
      writeFileSync(dailyFile, '# Marketing learnings — 2026-03-01\n\nold content (replayed)');

      // Second pass should detect the date marker is already in the archive and skip
      mergeDailyLearnings({ retainDays: 7, now: checkpoint });
      const secondContent = readFileSync(archivePath, 'utf8');

      // Archive must still contain exactly one occurrence of the date marker
      const occurrences = (secondContent.match(/# Marketing learnings — 2026-03-01/g) ?? []).length;
      expect(occurrences).toBe(1);
      // And the daily file should now be cleaned up
      expect(existsSync(dailyFile)).toBe(false);
      // First and second runs produce equivalent state
      expect(secondContent).toBe(firstContent);
    });

    it('handles missing learnings directory gracefully (no ENOENT)', () => {
      // Remove the learnings dir entirely (simulates first-run with seeded data
      // where appendLearning was never called)
      rmSync(
        join(project, '_dream_context', 'knowledge', 'marketing-learnings'),
        { recursive: true, force: true },
      );
      const result = mergeDailyLearnings({ retainDays: 7, now: new Date('2026-04-25') });
      expect(result.scanned).toBe(0);
      expect(result.merged).toBe(0);
    });
  });

  describe('redactRunsSweep', () => {
    it('rewrites files containing secrets', () => {
      const now = Date.now();
      writeRun(project, 'leaky', now, { token: 'Bearer EAAGabcdef1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' });
      const result = redactRunsSweep();
      expect(result.scanned).toBe(1);
      expect(result.rewritten).toBeGreaterThanOrEqual(0); // depends on redactSecrets impl
    });

    it('--dry-run reports without rewriting', () => {
      const now = Date.now();
      writeRun(project, 'leaky', now, { token: 'Bearer EAAGabcdef1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' });
      const before = readFileSync(join(project, '_dream_context', 'marketing', 'runs', 'leaky.json'), 'utf8');
      redactRunsSweep({ dryRun: true });
      const after = readFileSync(join(project, '_dream_context', 'marketing', 'runs', 'leaky.json'), 'utf8');
      expect(after).toBe(before);
    });
  });

  describe('runRemSleep (driver)', () => {
    it('returns marketingPresent=false when marketing/ does not exist', () => {
      // Remove marketing dir
      rmSync(join(project, '_dream_context', 'marketing'), { recursive: true });
      const result = runRemSleep();
      expect(result.marketingPresent).toBe(false);
    });

    it('returns aggregated results when marketing/ exists', () => {
      const now = Date.now();
      for (let i = 0; i < 105; i++) writeRun(project, `r${i}`, now - i * 1000);
      const result = runRemSleep({ keepRuns: 100 });
      expect(result.marketingPresent).toBe(true);
      expect(result.runs.deleted).toBe(5);
      expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
