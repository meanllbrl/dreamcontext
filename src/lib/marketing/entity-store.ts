/**
 * Entity store for campaign / adset / ad / creative.
 *
 * Each entity gets a JSON file + paired .md bridge under
 * _dream_context/marketing/<kind>s/<id>.{json,md}. Local id (UUID-ish) is the
 * dreamcontext side; fb_id is the Meta side. They are decoupled so dry-run
 * entities can exist locally without colliding with real Meta IDs.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { customAlphabet } from 'nanoid';
import { MARKETING_PATHS } from './paths.js';
import { writeJsonWithBridge } from './store.js';

const idgen = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

export type EntityKind = 'campaign' | 'adset' | 'ad' | 'creative';
export type EntityStatus = 'PAUSED' | 'ACTIVE' | 'DELETED' | 'ARCHIVED';

export interface BaseEntity {
  /** Local dreamcontext id. */
  id: string;
  kind: EntityKind;
  /** Meta-side id (graph.facebook.com). Empty during dry-run. */
  fb_id: string;
  /** Always created PAUSED; only mk launch flips to ACTIVE. */
  status: EntityStatus;
  cohort_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignEntity extends BaseEntity {
  kind: 'campaign';
  objective: string;
  daily_budget: number | null;        // minor units; null when adset-budget mode
  special_ad_categories: string[];
}

export interface AdSetEntity extends BaseEntity {
  kind: 'adset';
  campaign_id: string;                 // local id, not fb_id
  daily_budget: number;                // minor units; required at adset level
  optimization_goal: string;
  billing_event: string;
  promoted_object?: Record<string, unknown>;
  targeting: Record<string, unknown>;
}

export interface AdEntity extends BaseEntity {
  kind: 'ad';
  adset_id: string;
  creative_id: string;
}

export interface CreativeEntity extends BaseEntity {
  kind: 'creative';
  type: 'video' | 'image';
  message: string;
  link: string;
  cta: string;
  /** For type=video: video_ids[]; for type=image: image_hashes[]. */
  asset_refs: string[];
}

export type AnyEntity = CampaignEntity | AdSetEntity | AdEntity | CreativeEntity;

// ─── Path helpers ────────────────────────────────────────────────────────────

function dirFor(kind: EntityKind): string {
  switch (kind) {
    case 'campaign': return MARKETING_PATHS.campaignsDir();
    case 'adset':    return MARKETING_PATHS.adsetsDir();
    case 'ad':       return MARKETING_PATHS.adsDir();
    case 'creative': return MARKETING_PATHS.creativesDir();
  }
}

export function newEntityId(kind: EntityKind): string {
  const prefix = kind === 'campaign' ? 'cmp' : kind === 'adset' ? 'as' : kind === 'ad' ? 'ad' : 'cr';
  return `${prefix}_${idgen()}`;
}

export function entityPaths(kind: EntityKind, id: string): { json: string; md: string } {
  const d = dirFor(kind);
  return { json: join(d, `${id}.json`), md: join(d, `${id}.md`) };
}

// ─── Load / list ─────────────────────────────────────────────────────────────

export function loadEntity<T extends AnyEntity>(kind: EntityKind, id: string): T | null {
  const { json } = entityPaths(kind, id);
  if (!existsSync(json)) return null;
  try {
    return JSON.parse(readFileSync(json, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function listEntities<T extends AnyEntity>(kind: EntityKind): T[] {
  const d = dirFor(kind);
  if (!existsSync(d)) return [];
  const out: T[] = [];
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
    try {
      out.push(JSON.parse(readFileSync(join(d, f), 'utf8')) as T);
    } catch {
      // skip malformed
    }
  }
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}

// ─── Save (atomic JSON + .md bridge) ─────────────────────────────────────────

export function saveEntity(entity: AnyEntity): void {
  const { json, md } = entityPaths(entity.kind, entity.id);
  writeJsonWithBridge(json, md, entity, renderEntityBridge(entity));
}

function renderEntityBridge(e: AnyEntity): string {
  const fm: string[] = [
    '---',
    `id: ${e.id}`,
    `type: ${e.kind}`,
    `fb_id: ${JSON.stringify(e.fb_id)}`,
    `status: ${e.status}`,
    `cohort_id: ${e.cohort_id}`,
    `name: ${JSON.stringify(e.name)}`,
    '---',
    '',
    `# ${e.name}`,
    '',
  ];
  switch (e.kind) {
    case 'campaign':
      fm.push(`- objective: ${e.objective}`);
      fm.push(`- daily_budget: ${e.daily_budget ?? '(adset-level)'}`);
      break;
    case 'adset':
      fm.push(`- campaign: ${e.campaign_id}`);
      fm.push(`- daily_budget: ${e.daily_budget}`);
      fm.push(`- optimization_goal: ${e.optimization_goal}`);
      fm.push(`- billing_event: ${e.billing_event}`);
      break;
    case 'ad':
      fm.push(`- adset: ${e.adset_id}`);
      fm.push(`- creative: ${e.creative_id}`);
      break;
    case 'creative':
      fm.push(`- type: ${e.type}`);
      fm.push(`- cta: ${e.cta}`);
      fm.push(`- assets: ${e.asset_refs.length}`);
      break;
  }
  return fm.join('\n') + '\n';
}

// ─── Cohort traversal helper (used by mk launch) ─────────────────────────────

export function gatherEntitiesByCohort(cohortId: string): {
  campaigns: CampaignEntity[];
  adsets: AdSetEntity[];
  ads: AdEntity[];
  creatives: CreativeEntity[];
} {
  const campaigns = listEntities<CampaignEntity>('campaign').filter((c) => c.cohort_id === cohortId);
  const adsets = listEntities<AdSetEntity>('adset').filter((a) => a.cohort_id === cohortId);
  const ads = listEntities<AdEntity>('ad').filter((a) => a.cohort_id === cohortId);
  const creativesAll = listEntities<CreativeEntity>('creative');
  // Creatives don't carry cohort_id directly; pull by ad.creative_id
  const usedCreativeIds = new Set(ads.map((a) => a.creative_id));
  const creatives = creativesAll.filter((c) => usedCreativeIds.has(c.id) || c.cohort_id === cohortId);
  return { campaigns, adsets, ads, creatives };
}
