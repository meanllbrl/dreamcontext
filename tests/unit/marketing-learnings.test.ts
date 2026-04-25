import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendLearning, setStatus, listPending, loadIndex, loadByDate,
  findEntry, todayDateString, newLearningId,
  LearningsAgentError, LearningNotFoundError,
} from '../../src/lib/marketing/learnings.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-learn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  // Both _dream_context/ root and the marketing dir need to exist for resolveContextRoot
  mkdirSync(join(root, '_dream_context', 'marketing'), { recursive: true });
  mkdirSync(join(root, '_dream_context', 'knowledge', 'marketing-learnings'), { recursive: true });
  return root;
}

describe('marketing/learnings', () => {
  let project: string;
  const origCwd = process.cwd();
  const origOverride = process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE;

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
    delete process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE;
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origOverride === undefined) delete process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE;
    else process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE = origOverride;
    rmSync(project, { recursive: true, force: true });
  });

  describe('id helpers', () => {
    it('newLearningId prefixes by type', () => {
      expect(newLearningId('recommendation')).toMatch(/^rec_[0-9a-z]{8}$/);
      expect(newLearningId('ledger')).toMatch(/^led_[0-9a-z]{8}$/);
    });

    it('todayDateString returns UTC YYYY-MM-DD', () => {
      const d = new Date('2026-04-25T23:59:59Z');
      expect(todayDateString(d)).toBe('2026-04-25');
    });
  });

  describe('appendLearning', () => {
    it('rejects non-performance-monitor agents by default', () => {
      expect(() => appendLearning({
        type: 'recommendation',
        cohort_id: 'coh_1',
        body: 'test body',
        agent: 'main',
      })).toThrow(LearningsAgentError);
    });

    it('rejects empty body', () => {
      expect(() => appendLearning({
        type: 'recommendation',
        body: '   ',
        agent: 'performance-monitor',
      })).toThrow(/non-empty/);
    });

    it('accepts test override env', () => {
      process.env.MARKETING_LEARNINGS_AGENT_OVERRIDE = '1';
      const e = appendLearning({
        type: 'recommendation',
        body: 'override allowed',
        agent: 'test-runner',
      });
      expect(e.id).toMatch(/^rec_/);
    });

    it('writes a recommendation with status=pending', () => {
      const now = new Date('2026-04-25T19:45:00Z');
      const e = appendLearning({
        type: 'recommendation',
        cohort_id: 'coh_1',
        body: 'Pause adset 123 — CPR is 2x baseline.',
        agent: 'performance-monitor',
        now,
      });
      expect(e.type).toBe('recommendation');
      expect(e.status).toBe('pending');
      expect(e.cohort_id).toBe('coh_1');
      expect(e.date_file).toBe('2026-04-25');
      expect(e.summary).toContain('Pause adset 123');
    });

    it('writes a ledger entry with status=evergreen', () => {
      const e = appendLearning({
        type: 'ledger',
        cohort_id: 'coh_2',
        body: 'Closed: hypothesis confirmed at day 7.',
        agent: 'performance-monitor',
      });
      expect(e.type).toBe('ledger');
      expect(e.status).toBe('evergreen');
    });

    it('creates a per-day .md with proper header and entry block', () => {
      const now = new Date('2026-04-25T19:45:00Z');
      const e = appendLearning({
        type: 'recommendation',
        cohort_id: 'coh_1',
        body: 'Hello world.',
        agent: 'performance-monitor',
        now,
      });
      const md = loadByDate('2026-04-25');
      expect(md).toBeTruthy();
      expect(md).toContain('# Marketing learnings — 2026-04-25');
      expect(md).toContain(`<!-- entry id=${e.id}`);
      expect(md).toContain('status=pending');
      expect(md).toContain('cohort=coh_1');
      expect(md).toContain('## 19:45 UTC — Recommendation (coh_1)');
      expect(md).toContain('Hello world.');
      expect(md).toContain('<!-- /entry -->');
    });

    it('appends multiple entries to the same day file under one header', () => {
      const now = new Date('2026-04-25T10:00:00Z');
      appendLearning({ type: 'recommendation', body: 'first', agent: 'performance-monitor', now });
      appendLearning({ type: 'ledger', body: 'second', agent: 'performance-monitor', now });
      const md = loadByDate('2026-04-25')!;
      expect((md.match(/# Marketing learnings/g) ?? []).length).toBe(1);
      expect((md.match(/<!-- entry /g) ?? []).length).toBe(2);
      expect((md.match(/<!-- \/entry -->/g) ?? []).length).toBe(2);
    });

    it('updates the .index.json sidecar', () => {
      appendLearning({ type: 'recommendation', body: 'x', agent: 'performance-monitor' });
      const idx = loadIndex();
      expect(idx.version).toBe(1);
      expect(idx.entries).toHaveLength(1);
    });
  });

  describe('setStatus', () => {
    it('flips a recommendation pending → confirmed', () => {
      const e = appendLearning({ type: 'recommendation', body: 'x', agent: 'performance-monitor' });
      const updated = setStatus(e.id, 'confirmed');
      expect(updated.status).toBe('confirmed');
      const idx = loadIndex();
      expect(idx.entries[0]!.status).toBe('confirmed');
    });

    it('rewrites the .md file with the new status in the entry comment', () => {
      const now = new Date('2026-04-25T10:00:00Z');
      const e = appendLearning({
        type: 'recommendation', body: 'body', agent: 'performance-monitor', now,
      });
      setStatus(e.id, 'rejected');
      const md = loadByDate('2026-04-25')!;
      expect(md).toContain(`status=rejected`);
      expect(md).not.toContain(`status=pending`);
    });

    it('rejects setting a ledger to non-evergreen', () => {
      const e = appendLearning({ type: 'ledger', body: 'x', agent: 'performance-monitor' });
      expect(() => setStatus(e.id, 'pending')).toThrow(/evergreen/);
    });

    it('rejects setting a recommendation to evergreen', () => {
      const e = appendLearning({ type: 'recommendation', body: 'x', agent: 'performance-monitor' });
      expect(() => setStatus(e.id, 'evergreen')).toThrow(/evergreen/);
    });

    it('throws LearningNotFoundError on unknown id', () => {
      expect(() => setStatus('rec_doesnotexist', 'confirmed')).toThrow(LearningNotFoundError);
    });
  });

  describe('listPending', () => {
    it('returns only pending recommendations', () => {
      appendLearning({ type: 'recommendation', body: 'r1', agent: 'performance-monitor' });
      const r2 = appendLearning({ type: 'recommendation', body: 'r2', agent: 'performance-monitor' });
      appendLearning({ type: 'ledger', body: 'l1', agent: 'performance-monitor' });
      setStatus(r2.id, 'confirmed');

      const pending = listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.type).toBe('recommendation');
      expect(pending[0]!.status).toBe('pending');
    });

    it('respects olderThanMs threshold', () => {
      const old = new Date('2026-04-24T00:00:00Z');
      const fresh = new Date('2026-04-25T00:00:00Z');
      appendLearning({ type: 'recommendation', body: 'old', agent: 'performance-monitor', now: old });
      appendLearning({ type: 'recommendation', body: 'fresh', agent: 'performance-monitor', now: fresh });

      // 12h threshold relative to fresh+1h (so 'old' is >24h, 'fresh' is 1h old)
      const checkpoint = new Date('2026-04-25T01:00:00Z');
      const stale = listPending({ olderThanMs: 12 * 3600 * 1000, now: checkpoint });
      expect(stale).toHaveLength(1);
      expect(stale[0]!.summary).toBe('old');
    });
  });

  describe('findEntry', () => {
    it('returns the entry by id', () => {
      const e = appendLearning({ type: 'ledger', body: 'x', agent: 'performance-monitor' });
      expect(findEntry(e.id)?.id).toBe(e.id);
    });
    it('returns null for unknown id', () => {
      expect(findEntry('rec_nope')).toBeNull();
    });
  });

  describe('atomic writes', () => {
    it('writes index file in expected location', () => {
      appendLearning({ type: 'recommendation', body: 'x', agent: 'performance-monitor' });
      const indexPath = join(project, '_dream_context', 'knowledge', 'marketing-learnings', '.index.json');
      expect(existsSync(indexPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
      expect(parsed.version).toBe(1);
    });
  });
});
