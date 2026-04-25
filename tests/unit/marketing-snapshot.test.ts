import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMarketingSnapshot, listStaleRecs } from '../../src/lib/marketing/snapshot.js';
import { saveCohort, type Cohort } from '../../src/lib/marketing/cohort.js';
import { saveInsightsSnapshot } from '../../src/lib/marketing/insights-cache.js';
import { appendLearning } from '../../src/lib/marketing/learnings.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  for (const sub of ['cohorts', 'campaigns', 'adsets', 'ads', 'creatives', 'insights']) {
    mkdirSync(join(root, '_dream_context', 'marketing', sub), { recursive: true });
  }
  mkdirSync(join(root, '_dream_context', 'knowledge', 'marketing-learnings'), { recursive: true });
  return root;
}

function makeCohort(id: string, name: string, status: Cohort['status']): Cohort {
  const now = new Date().toISOString();
  return {
    id, profile: 'default', name, status,
    hypothesis: {
      predicted_winner: 'broad audience',
      predicted_metric: 'ROAS',
      decision_threshold: 2.0,
      kill_condition: 'spend zero for 3 days',
    },
    started_at: now, closed_at: null, campaign_ids: [],
    created_at: now, updated_at: now,
  };
}

describe('marketing/snapshot', () => {
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

  it('returns null when marketing/ directory does not exist', () => {
    // Non-marketing project
    const nonMk = realpathSync(mkdirSync(join(tmpdir(), `non-mk-${Date.now()}`), { recursive: true })!);
    mkdirSync(join(nonMk, '_dream_context'), { recursive: true });
    process.chdir(nonMk);
    try {
      expect(buildMarketingSnapshot()).toBeNull();
    } finally {
      rmSync(nonMk, { recursive: true, force: true });
    }
  });

  it('renders a snapshot block when marketing is bootstrapped but empty', () => {
    const out = buildMarketingSnapshot();
    expect(out).toContain('## Marketing');
    expect(out).toContain('No active cohorts');
    expect(out).toContain('Last insights pull:');
    expect(out).toContain('never');
    expect(out).toContain('no learnings recorded yet');
  });

  it('lists active cohorts (launched / monitoring) but skips closed', () => {
    saveCohort(makeCohort('coh_a', 'Active A', 'launched'));
    saveCohort(makeCohort('coh_b', 'Monitoring B', 'monitoring'));
    saveCohort(makeCohort('coh_c', 'Closed C', 'closed_won'));
    saveCohort(makeCohort('coh_d', 'Plan D', 'planning'));

    const out = buildMarketingSnapshot()!;
    expect(out).toContain('Active cohorts (2)');
    expect(out).toContain('coh_a');
    expect(out).toContain('coh_b');
    expect(out).not.toContain('coh_c');
    expect(out).toContain('Planning (1)');
    expect(out).toContain('coh_d');
  });

  it('shows last insights pull timestamp + age', () => {
    saveInsightsSnapshot({
      entity_id: '12345',
      level: 'campaign',
      pulled_at: new Date().toISOString(),
      since: 'last_7d',
      data: { foo: 'bar' },
    });
    const out = buildMarketingSnapshot()!;
    expect(out).toContain('Last insights pull:');
    expect(out).not.toContain('never');
  });

  it('lists pending recommendations and flags stale (>24h) ones', () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000); // 30h ago
    const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago
    appendLearning({ type: 'recommendation', cohort_id: 'coh_x', body: 'old rec',   agent: 'performance-monitor', now: old });
    appendLearning({ type: 'recommendation', cohort_id: 'coh_y', body: 'fresh rec', agent: 'performance-monitor', now: fresh });

    const out = buildMarketingSnapshot()!;
    expect(out).toContain('2 pending recommendations');
    expect(out).toContain('1 >24h');
  });

  it('shows all-clear when learnings exist but none pending', () => {
    appendLearning({ type: 'ledger', body: 'evergreen entry', agent: 'performance-monitor' });
    const out = buildMarketingSnapshot()!;
    expect(out).toContain('all clear');
  });

  it('completes well under 500ms with realistic data', () => {
    for (let i = 0; i < 20; i++) {
      saveCohort(makeCohort(`coh_${i}`, `Cohort ${i}`, i % 3 === 0 ? 'launched' : 'planning'));
    }
    for (let i = 0; i < 10; i++) {
      appendLearning({
        type: 'recommendation',
        body: `rec ${i}`,
        agent: 'performance-monitor',
        cohort_id: `coh_${i}`,
      });
    }
    const t0 = Date.now();
    buildMarketingSnapshot();
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
  });

  it('listStaleRecs returns only recommendations older than threshold', () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000);
    appendLearning({ type: 'recommendation', body: 'old', agent: 'performance-monitor', now: old });
    appendLearning({ type: 'recommendation', body: 'fresh', agent: 'performance-monitor', now: fresh });

    const stale = listStaleRecs(24);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.summary).toBe('old');
  });
});
