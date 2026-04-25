import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newEntityId, saveEntity, loadEntity, listEntities,
  gatherEntitiesByCohort,
  type CampaignEntity, type AdSetEntity, type AdEntity,
} from '../../src/lib/marketing/entity-store.js';

function makeProject(): string {
  const raw = join(tmpdir(), `mk-es-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  const root = realpathSync(raw);
  for (const sub of ['cohorts', 'campaigns', 'adsets', 'ads', 'creatives']) {
    mkdirSync(join(root, '_dream_context', 'marketing', sub), { recursive: true });
  }
  return root;
}

describe('marketing/entity-store', () => {
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

  it('newEntityId prefixes by kind', () => {
    expect(newEntityId('campaign')).toMatch(/^cmp_/);
    expect(newEntityId('adset')).toMatch(/^as_/);
    expect(newEntityId('ad')).toMatch(/^ad_/);
    expect(newEntityId('creative')).toMatch(/^cr_/);
  });

  it('saveEntity + loadEntity round-trip with bridge file', () => {
    const now = new Date().toISOString();
    const c: CampaignEntity = {
      id: 'cmp_x', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_a', name: 'X', objective: 'OUTCOME_LEADS',
      daily_budget: 5000, special_ad_categories: [],
      created_at: now, updated_at: now,
    };
    saveEntity(c);
    const loaded = loadEntity<CampaignEntity>('campaign', 'cmp_x');
    expect(loaded?.objective).toBe('OUTCOME_LEADS');
    expect(loaded?.daily_budget).toBe(5000);
    const md = readFileSync(
      join(project, '_dream_context', 'marketing', 'campaigns', 'cmp_x.md'),
      'utf8',
    );
    expect(md).toContain('# X');
    expect(md).toContain('objective: OUTCOME_LEADS');
  });

  it('listEntities filters and sorts by newest first', () => {
    const t1 = '2026-04-20T00:00:00Z';
    const t2 = '2026-04-25T00:00:00Z';
    saveEntity({
      id: 'cmp_old', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_a', name: 'old', objective: 'OUTCOME_LEADS',
      daily_budget: 1000, special_ad_categories: [], created_at: t1, updated_at: t1,
    });
    saveEntity({
      id: 'cmp_new', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_a', name: 'new', objective: 'OUTCOME_LEADS',
      daily_budget: 1000, special_ad_categories: [], created_at: t2, updated_at: t2,
    });
    const list = listEntities<CampaignEntity>('campaign');
    expect(list[0].id).toBe('cmp_new');
    expect(list[1].id).toBe('cmp_old');
  });

  it('gatherEntitiesByCohort scoops campaign + adset + ad by cohort_id', () => {
    const now = new Date().toISOString();
    saveEntity({
      id: 'cmp_a', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_target', name: 'A', objective: 'OUTCOME_LEADS',
      daily_budget: 1000, special_ad_categories: [], created_at: now, updated_at: now,
    });
    saveEntity({
      id: 'cmp_b', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_other', name: 'B', objective: 'OUTCOME_LEADS',
      daily_budget: 1000, special_ad_categories: [], created_at: now, updated_at: now,
    });
    saveEntity({
      id: 'as_a', kind: 'adset', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_target', name: 'AS', campaign_id: 'cmp_a',
      daily_budget: 1000, optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
      targeting: {}, created_at: now, updated_at: now,
    });
    saveEntity({
      id: 'ad_a', kind: 'ad', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_target', name: 'Ad', adset_id: 'as_a', creative_id: 'cr_x',
      created_at: now, updated_at: now,
    });
    const tree = gatherEntitiesByCohort('coh_target');
    expect(tree.campaigns.map((c) => c.id)).toEqual(['cmp_a']);
    expect(tree.adsets.map((a) => a.id)).toEqual(['as_a']);
    expect(tree.ads.map((a) => a.id)).toEqual(['ad_a']);
  });

  it('writes are atomic (no .tmp files left behind)', () => {
    const now = new Date().toISOString();
    saveEntity({
      id: 'cmp_atom', kind: 'campaign', fb_id: '', status: 'PAUSED',
      cohort_id: 'coh_a', name: 'A', objective: 'OUTCOME_LEADS',
      daily_budget: 1000, special_ad_categories: [], created_at: now, updated_at: now,
    });
    const dir = join(project, '_dream_context', 'marketing', 'campaigns');
    const files = require('node:fs').readdirSync(dir);
    expect(files.filter((f: string) => f.includes('.tmp.'))).toEqual([]);
    expect(existsSync(join(dir, 'cmp_atom.json'))).toBe(true);
    expect(existsSync(join(dir, 'cmp_atom.md'))).toBe(true);
  });
});
