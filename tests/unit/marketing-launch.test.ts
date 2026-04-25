import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLaunchSummary, renderLaunchSummary,
  createLaunchWal, executeFlips, readWal, findWalByRunId,
  buildPlannedFlips,
} from '../../src/lib/marketing/launch.js';
import { saveCohort, type Cohort } from '../../src/lib/marketing/cohort.js';
import { saveEntity, type CampaignEntity, type AdSetEntity, type AdEntity } from '../../src/lib/marketing/entity-store.js';
import type { MetaCtx } from '../../src/lib/marketing/meta-fetch.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  for (const sub of ['cohorts', 'campaigns', 'adsets', 'ads', 'creatives', 'runs']) {
    mkdirSync(join(root, '_dream_context', 'marketing', sub), { recursive: true });
  }
  return root;
}

function seedCohort(): Cohort {
  const now = new Date().toISOString();
  const cohort: Cohort = {
    id: 'coh_test01',
    profile: 'default',
    name: 'Test Cohort',
    hypothesis: {
      predicted_winner: 'broad audience UGC video',
      predicted_metric: 'ROAS',
      decision_threshold: 2.0,
      kill_condition: 1.0,
    },
    status: 'planning',
    started_at: now,
    closed_at: null,
    campaign_ids: ['cmp_a'],
    created_at: now,
    updated_at: now,
  };
  saveCohort(cohort);
  return cohort;
}

function seedTree(opts: { liveFbIds?: boolean } = {}): void {
  const now = new Date().toISOString();
  const fb = (s: string) => (opts.liveFbIds ? s : '');
  const campaign: CampaignEntity = {
    id: 'cmp_a', kind: 'campaign', fb_id: fb('120211_cmp_a'),
    status: 'PAUSED', cohort_id: 'coh_test01', name: 'Camp A',
    objective: 'OUTCOME_LEADS', daily_budget: 3000, special_ad_categories: [],
    created_at: now, updated_at: now,
  };
  const adset: AdSetEntity = {
    id: 'as_a', kind: 'adset', fb_id: fb('120211_as_a'),
    status: 'PAUSED', cohort_id: 'coh_test01', name: 'AS A',
    campaign_id: 'cmp_a', daily_budget: 3000,
    optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
    targeting: { geo_locations: { countries: ['TR'] } },
    created_at: now, updated_at: now,
  };
  const ad: AdEntity = {
    id: 'ad_a', kind: 'ad', fb_id: fb('120211_ad_a'),
    status: 'PAUSED', cohort_id: 'coh_test01', name: 'Ad A',
    adset_id: 'as_a', creative_id: 'cr_a',
    created_at: now, updated_at: now,
  };
  saveEntity(campaign);
  saveEntity(adset);
  saveEntity(ad);
}

function dryCtx(): MetaCtx {
  return {
    dryRun: true, apiVersion: 'v25.0', accessToken: 'TEST',
    adAccountId: 'act_999', logger: () => undefined,
  };
}

function liveCtx(fetchImpl: typeof fetch): MetaCtx {
  return {
    dryRun: false, apiVersion: 'v25.0', accessToken: 'TEST',
    adAccountId: 'act_999', logger: () => undefined,
    // fetchImpl injected per-call via metaFetch init; here we patch globalThis.
  } as unknown as MetaCtx;
}

describe('marketing/launch', () => {
  let project: string;
  const origCwd = process.cwd();
  let origFetch: typeof fetch;

  beforeEach(() => {
    project = makeProject();
    process.chdir(project);
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    process.chdir(origCwd);
    globalThis.fetch = origFetch;
    rmSync(project, { recursive: true, force: true });
  });

  describe('buildLaunchSummary', () => {
    it('returns 6-line summary for a populated cohort', () => {
      seedCohort();
      seedTree();
      const s = buildLaunchSummary('coh_test01');
      expect('error' in s).toBe(false);
      if ('error' in s) return;
      expect(s.cohort_name).toBe('Test Cohort');
      expect(s.campaigns).toBe(1);
      expect(s.adsets).toBe(1);
      expect(s.ads).toBe(1);
      expect(s.total_daily_budget_minor).toBe(3000); // CBO budget
      const lines = renderLaunchSummary(s);
      expect(lines).toHaveLength(6);
    });

    it('errors when cohort missing', () => {
      const s = buildLaunchSummary('coh_doesnt_exist');
      expect('error' in s).toBe(true);
    });

    it('errors when cohort has no campaigns', () => {
      seedCohort();
      const s = buildLaunchSummary('coh_test01');
      expect('error' in s).toBe(true);
    });

    it('errors when cohort has campaigns but no ads', () => {
      seedCohort();
      const now = new Date().toISOString();
      saveEntity({
        id: 'cmp_a', kind: 'campaign', fb_id: '', status: 'PAUSED',
        cohort_id: 'coh_test01', name: 'C', objective: 'OUTCOME_LEADS',
        daily_budget: 1000, special_ad_categories: [], created_at: now, updated_at: now,
      });
      const s = buildLaunchSummary('coh_test01');
      expect('error' in s).toBe(true);
      if ('error' in s) expect(s.error).toMatch(/no ads/);
    });
  });

  describe('buildPlannedFlips', () => {
    it('orders campaign → adset → ad', () => {
      seedCohort();
      seedTree();
      const plan = buildPlannedFlips('coh_test01');
      expect(plan.map((p) => p.kind)).toEqual(['campaign', 'adset', 'ad']);
    });
  });

  describe('createLaunchWal + readWal', () => {
    it('writes a WAL file and round-trips', () => {
      seedCohort();
      seedTree();
      const { walPath, wal } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: true,
      });
      expect(existsSync(walPath)).toBe(true);
      expect(wal.status).toBe('pending');
      expect(wal.dry_run).toBe(true);
      expect(wal.planned).toHaveLength(3);
      const reread = readWal(walPath);
      expect(reread?.id).toBe(wal.id);
    });

    it('findWalByRunId resolves by stem', () => {
      seedCohort();
      seedTree();
      const { walPath, wal } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: true,
      });
      const found = findWalByRunId(wal.id);
      expect(found).toBe(walPath);
    });
  });

  describe('executeFlips — dry run', () => {
    it('flips all in sequence, marks WAL complete, sets cohort to launched', async () => {
      seedCohort();
      seedTree();
      const { walPath } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: true,
      });
      const result = await executeFlips(dryCtx(), walPath);
      expect(result.status).toBe('complete');
      expect(result.flipped).toBe(3);
      const wal = readWal(walPath);
      expect(wal?.status).toBe('complete');
      expect(wal?.completed_at).not.toBeNull();
      // Cohort should be flipped to launched
      const cohortJson = readFileSync(
        join(project, '_dream_context', 'marketing', 'cohorts', 'coh_test01.json'),
        'utf8',
      );
      expect(JSON.parse(cohortJson).status).toBe('launched');
    });

    it('rejects ctx mismatch (live vs WAL dry-run)', async () => {
      seedCohort();
      seedTree();
      const { walPath } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: true,
      });
      const liveButFakeCtx: MetaCtx = { ...dryCtx(), dryRun: false };
      const result = await executeFlips(liveButFakeCtx, walPath);
      expect(result.status).toBe('aborted');
      const wal = readWal(walPath);
      expect(wal?.status).toBe('aborted');
    });
  });

  describe('executeFlips — live with errors (no silent retries)', () => {
    it('halts at first error and writes partial WAL with no retries', async () => {
      seedCohort();
      seedTree({ liveFbIds: true });
      const { walPath } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: false,
      });
      let calls = 0;
      // First call (campaign) succeeds; second call (adset) returns Meta error code that would normally retry
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ success: true }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: { code: 4, message: 'rate limited' } }), {
          status: 429, headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const live: MetaCtx = { ...dryCtx(), dryRun: false };
      const result = await executeFlips(live, walPath);
      expect(result.status).toBe('partial');
      expect(result.flipped).toBe(1); // campaign succeeded
      expect(calls).toBe(2);          // NO retry on the failed adset (would be 6 with retries)
      const wal = readWal(walPath);
      expect(wal?.status).toBe('partial');
      expect(wal?.flipped_count).toBe(1);
      expect(wal?.planned[0].flipped_at).not.toBeNull();
      expect(wal?.planned[1].flipped_at).toBeNull();
      expect(wal?.planned[1].error).toBeTruthy();
    });

    it('refuses to launch live entities without fb_id', async () => {
      seedCohort();
      seedTree({ liveFbIds: false }); // empty fb_ids
      const { walPath } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: false,
      });
      const live: MetaCtx = { ...dryCtx(), dryRun: false };
      const result = await executeFlips(live, walPath);
      expect(result.status).toBe('partial');
      expect(result.flipped).toBe(0);
      expect(result.errors[0]).toMatch(/no fb_id/);
    });
  });

  describe('resume from WAL', () => {
    it('continues from where the partial left off', async () => {
      seedCohort();
      seedTree();
      const { walPath } = createLaunchWal({
        cohortId: 'coh_test01', cohortName: 'Test Cohort', dryRun: true,
      });
      // Manually mark first item flipped, status partial
      const wal = readWal(walPath);
      if (!wal) throw new Error('wal not found');
      wal.planned[0].flipped_at = new Date().toISOString();
      wal.flipped_count = 1;
      wal.status = 'partial';
      writeFileSync(walPath, JSON.stringify(wal, null, 2));

      const result = await executeFlips(dryCtx(), walPath);
      expect(result.status).toBe('complete');
      expect(result.flipped).toBe(3); // 1 already + 2 new
      const after = readWal(walPath);
      expect(after?.status).toBe('complete');
    });
  });
});
