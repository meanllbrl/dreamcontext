/**
 * meta-client — typed surface for Meta Graph + Marketing API operations.
 *
 * Mirrors signatures from Tilki Öğretmen's existing meta-client.ts (which
 * served the v0 launch of the platform), but every function takes a MetaCtx
 * first and routes through metaFetch — so dry-run, retry, idempotency,
 * header-only auth, per-account concurrency, and chunked upload come for free.
 *
 * Library code accepts a ctx; it never constructs one. CLI commands build the
 * ctx via meta-fetch.liveCtxFromEnv() (or dryRunCtx() for previews).
 */
import type { MetaCtx, MetaJson } from './meta-fetch.js';
import { metaFetch, uploadVideoFile, uploadImageFile, type ChunkedUploadResult } from './meta-fetch.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type CampaignObjective =
  | 'OUTCOME_LEADS'
  | 'OUTCOME_SALES'
  | 'OUTCOME_TRAFFIC'
  | 'OUTCOME_ENGAGEMENT'
  | 'OUTCOME_AWARENESS'
  | 'OUTCOME_APP_PROMOTION';

export type AdStatus = 'ACTIVE' | 'PAUSED' | 'DELETED' | 'ARCHIVED';

export type OptimizationGoal =
  | 'OFFSITE_CONVERSIONS'
  | 'LINK_CLICKS'
  | 'LEAD_GENERATION'
  | 'LANDING_PAGE_VIEWS'
  | 'IMPRESSIONS'
  | 'REACH'
  | 'THRUPLAY'
  | 'VALUE';

export type BillingEvent = 'IMPRESSIONS' | 'LINK_CLICKS' | 'THRUPLAY';

export type CTAType =
  | 'SIGN_UP'
  | 'LEARN_MORE'
  | 'GET_OFFER'
  | 'SUBSCRIBE'
  | 'INSTALL_APP'
  | 'DOWNLOAD'
  | 'BOOK_TRAVEL'
  | 'SHOP_NOW'
  | 'SEND_MESSAGE';

export interface Targeting {
  geo_locations: { countries: string[]; location_types?: string[] };
  age_min?: number;
  age_max?: number;
  /** Advantage+ Audience replaces detailed targeting in v23+. */
  targeting_automation?: { advantage_audience: 0 | 1 };
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  /** Detailed targeting interests/behaviors — only when deviating from broad. */
  flexible_spec?: Array<Record<string, unknown>>;
}

// ─── Account ─────────────────────────────────────────────────────────────────

/** GET /me/adaccounts — used by `mk config check` to confirm token + access. */
export async function listAdAccounts(ctx: MetaCtx): Promise<{ data: Array<{ id: string; name: string; account_status: number }> }> {
  return metaFetch(ctx, {
    method: 'GET',
    path: 'me/adaccounts',
    query: { fields: 'id,name,account_status' },
  }) as Promise<{ data: Array<{ id: string; name: string; account_status: number }> }>;
}

/** GET /<ad_account_id> — basic account info. */
export async function getAdAccount(ctx: MetaCtx): Promise<MetaJson> {
  return metaFetch(ctx, {
    method: 'GET',
    path: ctx.adAccountId,
    query: { fields: 'id,name,currency,timezone_name,account_status,disable_reason' },
  });
}

// ─── Campaign ────────────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  objective: CampaignObjective;
  /** Defaults to PAUSED — agent never auto-launches. */
  status?: AdStatus;
  /** Required by Meta: empty array unless an ad category applies. */
  special_ad_categories?: string[];
  /** Campaign Budget Optimization — daily budget at the campaign level (minor unit). */
  daily_budget?: number;
  buying_type?: 'AUCTION' | 'RESERVED';
}

export async function createCampaign(ctx: MetaCtx, input: CreateCampaignInput): Promise<{ id: string }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: `${ctx.adAccountId}/campaigns`,
    params: {
      name: input.name,
      objective: input.objective,
      status: input.status ?? 'PAUSED',
      special_ad_categories: input.special_ad_categories ?? [],
      ...(input.daily_budget != null ? { daily_budget: String(input.daily_budget) } : {}),
      ...(input.buying_type ? { buying_type: input.buying_type } : {}),
    },
  }) as Promise<{ id: string }>;
}

export async function updateCampaign(ctx: MetaCtx, campaignId: string, fields: Partial<CreateCampaignInput> & { status?: AdStatus }): Promise<{ success: boolean }> {
  const params: Record<string, unknown> = { ...fields };
  if (params.daily_budget != null) params.daily_budget = String(params.daily_budget);
  return metaFetch(ctx, {
    method: 'POST',
    path: campaignId,
    params,
  }) as Promise<{ success: boolean }>;
}

export async function getCampaign(ctx: MetaCtx, campaignId: string): Promise<MetaJson> {
  return metaFetch(ctx, {
    method: 'GET',
    path: campaignId,
    query: { fields: 'id,name,objective,status,daily_budget,lifetime_budget,buying_type,created_time,updated_time' },
  });
}

// ─── Ad set ──────────────────────────────────────────────────────────────────

export interface CreateAdSetInput {
  name: string;
  campaign_id: string;
  /** Daily budget in minor currency units (kuruş for TRY, cents for USD). */
  daily_budget: number;
  optimization_goal: OptimizationGoal;
  billing_event: BillingEvent;
  /** Required for OFFSITE_CONVERSIONS — { pixel_id, custom_event_type }. */
  promoted_object?: { pixel_id?: string; custom_event_type?: string; page_id?: string; application_id?: string };
  targeting: Targeting;
  status?: AdStatus;
  bid_strategy?: 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP';
  /** YYYY-MM-DDTHH:MM:SS±HHMM */
  start_time?: string;
  end_time?: string;
}

export async function createAdSet(ctx: MetaCtx, input: CreateAdSetInput): Promise<{ id: string }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: `${ctx.adAccountId}/adsets`,
    params: {
      name: input.name,
      campaign_id: input.campaign_id,
      daily_budget: String(input.daily_budget),
      optimization_goal: input.optimization_goal,
      billing_event: input.billing_event,
      bid_strategy: input.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP',
      ...(input.promoted_object ? { promoted_object: input.promoted_object } : {}),
      targeting: input.targeting,
      status: input.status ?? 'PAUSED',
      ...(input.start_time ? { start_time: input.start_time } : {}),
      ...(input.end_time ? { end_time: input.end_time } : {}),
    },
  }) as Promise<{ id: string }>;
}

export async function updateAdSet(ctx: MetaCtx, adsetId: string, fields: Partial<CreateAdSetInput> & { status?: AdStatus }): Promise<{ success: boolean }> {
  const params: Record<string, unknown> = { ...fields };
  if (params.daily_budget != null) params.daily_budget = String(params.daily_budget);
  return metaFetch(ctx, {
    method: 'POST',
    path: adsetId,
    params,
  }) as Promise<{ success: boolean }>;
}

// ─── Ad creative ─────────────────────────────────────────────────────────────

export interface MultiVideoCreativeInput {
  name: string;
  video_ids: string[];
  message: string;
  link: string;
  cta: CTAType;
}

export interface MultiImageCreativeInput {
  name: string;
  image_hashes: string[];
  message: string;
  link: string;
  cta: CTAType;
}

/** Multi-aspect video creative via asset_feed_spec — Meta picks per placement. */
export async function createVideoCreative(ctx: MetaCtx, input: MultiVideoCreativeInput): Promise<{ id: string }> {
  if (!ctx.pageId) throw new Error('createVideoCreative requires ctx.pageId');
  return metaFetch(ctx, {
    method: 'POST',
    path: `${ctx.adAccountId}/adcreatives`,
    params: {
      name: input.name,
      object_story_spec: {
        page_id: ctx.pageId,
        ...(ctx.igActorId ? { instagram_actor_id: ctx.igActorId } : {}),
      },
      asset_feed_spec: {
        videos: input.video_ids.map((id) => ({ video_id: id })),
        bodies: [{ text: input.message }],
        link_urls: [{ website_url: input.link }],
        call_to_action_types: [input.cta],
        ad_formats: ['SINGLE_VIDEO'],
      },
    },
  }) as Promise<{ id: string }>;
}

/** Multi-aspect image creative via asset_feed_spec. */
export async function createImageCreative(ctx: MetaCtx, input: MultiImageCreativeInput): Promise<{ id: string }> {
  if (!ctx.pageId) throw new Error('createImageCreative requires ctx.pageId');
  return metaFetch(ctx, {
    method: 'POST',
    path: `${ctx.adAccountId}/adcreatives`,
    params: {
      name: input.name,
      object_story_spec: {
        page_id: ctx.pageId,
        ...(ctx.igActorId ? { instagram_actor_id: ctx.igActorId } : {}),
      },
      asset_feed_spec: {
        images: input.image_hashes.map((hash) => ({ hash })),
        bodies: [{ text: input.message }],
        link_urls: [{ website_url: input.link }],
        call_to_action_types: [input.cta],
        ad_formats: ['SINGLE_IMAGE'],
      },
    },
  }) as Promise<{ id: string }>;
}

// ─── Ad ──────────────────────────────────────────────────────────────────────

export interface CreateAdInput {
  name: string;
  adset_id: string;
  creative_id: string;
  status?: AdStatus;
}

export async function createAd(ctx: MetaCtx, input: CreateAdInput): Promise<{ id: string }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: `${ctx.adAccountId}/ads`,
    params: {
      name: input.name,
      adset_id: input.adset_id,
      creative: { creative_id: input.creative_id },
      status: input.status ?? 'PAUSED',
    },
  }) as Promise<{ id: string }>;
}

export async function updateAd(ctx: MetaCtx, adId: string, fields: { status?: AdStatus; name?: string }): Promise<{ success: boolean }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: adId,
    params: fields,
  }) as Promise<{ success: boolean }>;
}

// ─── Status flip helpers (used by mk pause/resume) ───────────────────────────

export interface StatusFlipOptions {
  /** Bypass metaFetch's retry loop. Required for launch flips per task PR 3
   *  contract: "No silent retries on launch flips." Operator must decide. */
  noRetry?: boolean;
}

export async function pauseEntity(ctx: MetaCtx, entityId: string, opts: StatusFlipOptions = {}): Promise<{ success: boolean }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: entityId,
    params: { status: 'PAUSED' },
    noRetry: opts.noRetry,
  }) as Promise<{ success: boolean }>;
}

export async function resumeEntity(ctx: MetaCtx, entityId: string, opts: StatusFlipOptions = {}): Promise<{ success: boolean }> {
  return metaFetch(ctx, {
    method: 'POST',
    path: entityId,
    params: { status: 'ACTIVE' },
    noRetry: opts.noRetry,
  }) as Promise<{ success: boolean }>;
}

// ─── Asset upload re-exports (route through meta-fetch) ──────────────────────

export async function uploadVideo(ctx: MetaCtx, filepath: string, fields: { name?: string; title?: string; description?: string } = {}): Promise<ChunkedUploadResult> {
  return uploadVideoFile(ctx, filepath, fields);
}

export async function uploadImage(ctx: MetaCtx, filepath: string): Promise<{ hash: string }> {
  return uploadImageFile(ctx, filepath);
}

// ─── Insights ────────────────────────────────────────────────────────────────

export interface InsightsQuery {
  /** Entity (campaign / adset / ad) to pull insights for. */
  entityId: string;
  /** Default v0 supports sync windows up to 7d; longer = v1 async. */
  date_preset?: 'today' | 'yesterday' | 'last_3d' | 'last_7d' | 'last_14d' | 'last_30d' | 'this_month' | 'last_month';
  time_range?: { since: string; until: string };
  fields?: string[];
  level?: 'campaign' | 'adset' | 'ad';
  breakdowns?: string[];
}

const DEFAULT_INSIGHT_FIELDS = [
  'spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm',
  'reach', 'frequency',
  'actions', 'action_values',
  'purchase_roas', 'website_purchase_roas',
  'cost_per_action_type',
  'conversions', 'conversion_values',
  'video_3_sec_watched_actions',
  'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name',
];

export async function getInsights(ctx: MetaCtx, q: InsightsQuery): Promise<MetaJson> {
  const query: Record<string, unknown> = {
    fields: (q.fields ?? DEFAULT_INSIGHT_FIELDS).join(','),
    level: q.level ?? 'ad',
  };
  if (q.date_preset) query.date_preset = q.date_preset;
  if (q.time_range) query.time_range = q.time_range;
  if (q.breakdowns && q.breakdowns.length) query.breakdowns = q.breakdowns.join(',');
  return metaFetch(ctx, {
    method: 'GET',
    path: `${q.entityId}/insights`,
    query,
  });
}
