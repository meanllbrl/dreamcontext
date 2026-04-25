import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveInsightsSnapshot,
  getCachedInsights,
  getLatestSnapshot,
  getPriorSnapshot,
  listEntitiesWithSnapshots,
  INSIGHTS_TTL_MS,
} from '../../src/lib/marketing/insights-cache.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-ic-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  mkdirSync(join(root, '_dream_context', 'marketing', 'insights'), { recursive: true });
  return root;
}

describe('marketing/insights-cache', () => {
  let project: string;
  const origCwd = process.cwd();

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(project, { recursive: true, force: true });
  });

  it('save + getLatest round-trip', () => {
    const snap = {
      entity_id: '120211_camp1',
      level: 'campaign' as const,
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: { data: [{ spend: '50.00' }] },
    };
    saveInsightsSnapshot(snap);
    const loaded = getLatestSnapshot('120211_camp1');
    expect(loaded?.entity_id).toBe('120211_camp1');
    expect(loaded?.since).toBe('last_7d');
  });

  it('getCachedInsights returns null when older than TTL', () => {
    const old = new Date(Date.now() - INSIGHTS_TTL_MS - 60_000).toISOString();
    saveInsightsSnapshot({
      entity_id: 'cmp_x',
      level: 'campaign',
      pulled_at: old,
      since: 'last_7d',
      data: {},
    });
    expect(getCachedInsights('cmp_x')).toBeNull();
  });

  it('getCachedInsights returns snapshot when fresh', () => {
    saveInsightsSnapshot({
      entity_id: 'cmp_y',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: { data: [] },
    });
    expect(getCachedInsights('cmp_y')).not.toBeNull();
  });

  it('listEntitiesWithSnapshots tracks saved entities', () => {
    saveInsightsSnapshot({
      entity_id: 'a',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: {},
    });
    saveInsightsSnapshot({
      entity_id: 'b',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: {},
    });
    const list = listEntitiesWithSnapshots();
    expect(list).toContain('a');
    expect(list).toContain('b');
  });

  it('getPriorSnapshot returns one older than the cutoff', () => {
    // Write a snapshot, then forge an older one by manipulating the file's contents
    const dir = join(project, '_dream_context', 'marketing', 'insights');
    const oldFile = join(dir, 'cmp_z__2026-04-20-00.json');
    writeFileSync(oldFile, JSON.stringify({
      entity_id: 'cmp_z',
      level: 'campaign',
      pulled_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      since: 'last_7d',
      data: { spend_total: 100 },
    }));
    // Update mtime to be 48h old
    const old = (Date.now() - 48 * 3_600_000) / 1000;
    require('node:fs').utimesSync(oldFile, old, old);
    // And a fresh one
    saveInsightsSnapshot({
      entity_id: 'cmp_z',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: { spend_total: 200 },
    });

    const prior = getPriorSnapshot('cmp_z', 24 * 3_600_000);
    expect(prior).not.toBeNull();
    expect((prior?.data as { spend_total?: number })?.spend_total).toBe(100);
  });

  it('snapshots are atomic (no .tmp leak after save)', () => {
    saveInsightsSnapshot({
      entity_id: 'cmp_atom',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: {},
    });
    const dir = join(project, '_dream_context', 'marketing', 'insights');
    const files = require('node:fs').readdirSync(dir);
    const tmpFiles = files.filter((f: string) => f.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });
});
