---
description: Meta Graph + Marketing API reference (v25.0). Endpoint map, field reference, and raw metaFetch recipes for cases the typed client does not cover. Use as the second-layer fallback before reading live Meta docs.
api_version: v25.0
verified_at: 2026-04-25
official_docs: https://developers.facebook.com/docs/marketing-api/reference/v25.0
---

# Meta Marketing API — Reference

This file is the **second layer** of a three-layer fallback. The typed client (`src/lib/marketing/meta-client.ts`) covers the hot path; this file maps the rest of the surface so the agent knows what is possible without scraping live docs; the live-doc fallback (see SKILL.md §XI) is for anything not covered here.

**Promotion rule:** if you use a raw recipe from this file 3+ times, propose adding it to the typed client in the next PR.

**Version pin:** all examples target Graph API + Marketing API **v25.0** (released 2026-02-18; current as of 2026-04). Always verify field availability against `https://developers.facebook.com/docs/marketing-api/reference/v25.0` before relying on a field — Meta retires fields aggressively.

---

## I. Endpoint map (CRUD by entity)

Every path is relative to `https://graph.facebook.com/v25.0/` unless marked `[video]` (use `graph-video.facebook.com`). The typed client column shows what's already wrapped — `—` means raw `metaFetch` is required.

### AdAccount

| Op | Method | Path | Typed |
|---|---|---|---|
| List my accounts | GET | `me/adaccounts?fields=...` | `listAdAccounts` |
| Read account | GET | `<act_id>?fields=...` | `getAdAccount` |
| Update account | POST | `<act_id>` | — |

### Campaign

| Op | Method | Path | Typed |
|---|---|---|---|
| Create | POST | `<act_id>/campaigns` | `createCampaign` |
| Read | GET | `<campaign_id>?fields=...` | `getCampaign` |
| List | GET | `<act_id>/campaigns?fields=...` | — |
| Update | POST | `<campaign_id>` | `updateCampaign` |
| Delete | DELETE | `<campaign_id>` | — |
| Duplicate | POST | `<campaign_id>/copies` | — |
| Insights | GET | `<campaign_id>/insights?fields=...&level=campaign` | `getInsights` |

### AdSet

| Op | Method | Path | Typed |
|---|---|---|---|
| Create | POST | `<act_id>/adsets` | `createAdSet` |
| Read | GET | `<adset_id>?fields=...` | — |
| List | GET | `<act_id>/adsets?fields=...` or `<campaign_id>/adsets` | — |
| Update | POST | `<adset_id>` | `updateAdSet` |
| Delete | DELETE | `<adset_id>` | — |
| Duplicate | POST | `<adset_id>/copies` | — |
| Insights | GET | `<adset_id>/insights?level=adset` | `getInsights` |

### Ad

| Op | Method | Path | Typed |
|---|---|---|---|
| Create | POST | `<act_id>/ads` | `createAd` |
| Read | GET | `<ad_id>?fields=...` | — |
| List | GET | `<act_id>/ads` or `<adset_id>/ads` | — |
| Update | POST | `<ad_id>` | `updateAd` |
| Delete | DELETE | `<ad_id>` | — |
| Duplicate | POST | `<ad_id>/copies` | — |
| Insights | GET | `<ad_id>/insights?level=ad` | `getInsights` |
| Preview | GET | `<ad_id>/previews?ad_format=...` | — |

### AdCreative

| Op | Method | Path | Typed |
|---|---|---|---|
| Create | POST | `<act_id>/adcreatives` | `createVideoCreative`, `createImageCreative` |
| Read | GET | `<creative_id>?fields=...` | — |
| List | GET | `<act_id>/adcreatives` | — |
| Update | POST | `<creative_id>` (limited: `name`, `status`) | — |
| Delete | DELETE | `<creative_id>` | — |
| Preview | GET | `<creative_id>/previews?ad_format=...` | — |

### Asset upload

| Op | Method | Path | Typed |
|---|---|---|---|
| Image | POST multipart | `<act_id>/adimages` | `uploadImage` |
| Video (≤50MB) | POST multipart | `<act_id>/advideos` | `uploadVideo` |
| Video (>50MB) chunked | POST `start\|transfer\|finish` | `<act_id>/advideos` `[video]` | `uploadVideo` (auto-routes) |

### Custom audiences

| Op | Method | Path | Typed |
|---|---|---|---|
| Create | POST | `<act_id>/customaudiences` | — |
| Read | GET | `<ca_id>?fields=...` | — |
| List | GET | `<act_id>/customaudiences` | — |
| Update | POST | `<ca_id>` | — |
| Delete | DELETE | `<ca_id>` | — |
| Add users (hashed) | POST | `<ca_id>/users` | — |
| Remove users | DELETE | `<ca_id>/users` | — |

### Insights (async / large windows)

| Op | Method | Path | Typed |
|---|---|---|---|
| Sync (≤7d in v0) | GET | `<entity_id>/insights?fields=...` | `getInsights` |
| Async start | POST | `<entity_id>/insights` (returns `report_run_id`) | — (deferred to v1) |
| Async poll | GET | `<report_run_id>?fields=async_status,async_percent_completion` | — |
| Async fetch | GET | `<report_run_id>/insights` | — |

### Batch

| Op | Method | Path | Typed |
|---|---|---|---|
| Batch (up to 50 ops) | POST | `/` (root) with `batch=[...]` form field | — |

---

## II. Common field reference

### Campaign fields

| Field | Type | Notes |
|---|---|---|
| `id` | string | Read-only |
| `name` | string | Required on create |
| `objective` | enum | See §III. Default v0 = `OUTCOME_LEADS` or `OUTCOME_SALES`. **Hard block:** never `OUTCOME_TRAFFIC/ENGAGEMENT/AWARENESS` for revenue campaigns. |
| `status` | `ACTIVE\|PAUSED\|DELETED\|ARCHIVED` | Always create as `PAUSED`. |
| `effective_status` | enum (read-only) | What Meta is actually doing with it (vs requested status). |
| `special_ad_categories` | string[] | Required (empty array OK). Values: `EMPLOYMENT`, `HOUSING`, `CREDIT`, `ISSUES_ELECTIONS_POLITICS`, `ONLINE_GAMBLING_AND_GAMING`, `FINANCIAL_PRODUCTS_SERVICES`. |
| `daily_budget` | string (minor unit) | Campaign Budget Optimization. Mutually exclusive with adset-level budgets. |
| `lifetime_budget` | string (minor unit) | Mutually exclusive with `daily_budget`. |
| `bid_strategy` | enum | `LOWEST_COST_WITHOUT_CAP`, `LOWEST_COST_WITH_BID_CAP`, `COST_CAP`. |
| `buying_type` | `AUCTION\|RESERVED` | `AUCTION` is the v0 default. |
| `pacing_type` | string[] | `["standard"]` (default), `["no_pacing"]`. |
| `spend_cap` | string (minor unit) | Hard cap on lifetime spend. |
| `start_time` / `stop_time` | ISO 8601 | `YYYY-MM-DDTHH:MM:SS+0000`. |
| `adlabels` | object[] | `[{ name: "<label>" }]` for grouping. |
| `source_campaign_id` | string | Set on duplicate via `/copies`. |
| `is_skadnetwork_attribution` | bool | iOS 14+ tracking. |

### AdSet fields

| Field | Type | Notes |
|---|---|---|
| `name`, `campaign_id` | string | Required. |
| `daily_budget` / `lifetime_budget` | string (minor unit) | Exactly one if campaign isn't using CBO. |
| `optimization_goal` | enum | See §III. v0 default for Sales = `OFFSITE_CONVERSIONS`. |
| `billing_event` | `IMPRESSIONS\|LINK_CLICKS\|THRUPLAY` | `IMPRESSIONS` is the safe default. |
| `bid_strategy` | enum | Inherits from campaign if unset. |
| `bid_amount` | int (minor unit) | Required when `bid_strategy=LOWEST_COST_WITH_BID_CAP` or `COST_CAP`. |
| `bid_constraints` | object | `{ "<event>": { "min": <int>, "max": <int> } }`. Advanced. |
| `promoted_object` | object | `{ pixel_id, custom_event_type, page_id?, application_id? }` — required for `OFFSITE_CONVERSIONS`. |
| `targeting` | object | See §IV. |
| `attribution_spec` | object[] | `[{ event_type: "CLICK_THROUGH", window_days: 7 }]`. v0 default in Meta is 1-day-view (changed 2026); override here for longer cycles. |
| `dsa_beneficiary` | string | **Mandatory in EU since 2025.** Legal entity benefiting from the ads. |
| `dsa_payor` | string | **Mandatory in EU since 2025.** Legal entity paying. |
| `frequency_control_specs` | object[] | `[{ event: "IMPRESSIONS", interval_days: 7, max_frequency: 3 }]`. |
| `pacing_type` | string[] | Default `["standard"]`. |
| `start_time` / `end_time` | ISO 8601 | Adset-level scheduling. |
| `tune_for_category` | string | Special category targeting. |
| `targeting_optimization` | string | `"none"` to disable Advantage+ Audience Expansion. |
| `multi_optimization_goal_weight` | enum | Multi-objective optimization. Advanced. |

### Ad fields

| Field | Type | Notes |
|---|---|---|
| `name`, `adset_id` | string | Required. |
| `creative` | object | `{ creative_id }` is the simple form. Inline creative also supported. |
| `status` | enum | Always `PAUSED` on create. |
| `tracking_specs` | object[] | View-level tracking events. |
| `conversion_specs` | object[] | What counts as a conversion for *this* ad (override adset). |
| `view_tags` | string[] | 3rd-party impression pixels. |
| `adlabels` | object[] | `[{ name: "<label>" }]`. |
| `source_ad_id` | string | Set on duplicate via `/copies`. |

### AdCreative fields

| Field | Type | Notes |
|---|---|---|
| `name` | string | Internal label. |
| `object_story_spec` | object | `{ page_id, instagram_actor_id?, link_data? \| photo_data? \| video_data? }`. |
| `asset_feed_spec` | object | Multi-asset / dynamic creative. See §V. |
| `dynamic_creative_specs` | object | Dynamic Creative Optimization. |
| `template_data` | object | Carousel / collection ads. |
| `image_hash` | string | Single-image shortcut. |
| `image_url` | string | External image (will be cached). |
| `video_id` | string | Single-video shortcut. |
| `link_url`, `link_destination_display_url` | string | Landing + display URL. |
| `body`, `title`, `description` | string | Creative copy when not using `asset_feed_spec`. |
| `call_to_action` | object | `{ type: <CTA>, value: { link, link_format } }`. |

---

## III. Enum reference

### `objective` (campaign)

| Value | Use for |
|---|---|
| `OUTCOME_SALES` | Purchases, e-com checkouts. |
| `OUTCOME_LEADS` | Lead gen forms, sign-ups. |
| `OUTCOME_TRAFFIC` | **Banned for revenue campaigns** per `mistakes.md #1`. |
| `OUTCOME_ENGAGEMENT` | Likes, comments, video views — non-revenue. |
| `OUTCOME_AWARENESS` | Reach, brand lift — top-of-funnel only. |
| `OUTCOME_APP_PROMOTION` | App installs / app events. |

### `optimization_goal` (adset)

| Value | Use with |
|---|---|
| `OFFSITE_CONVERSIONS` | Sales / leads with Pixel + CAPI. **v0 default.** |
| `LINK_CLICKS` | When `OUTCOME_TRAFFIC` (rare in v0). |
| `LANDING_PAGE_VIEWS` | LP-quality traffic. |
| `LEAD_GENERATION` | Native lead forms (no website). |
| `IMPRESSIONS` | Awareness only. |
| `REACH` | Unique people, not impressions. |
| `THRUPLAY` | Video views ≥15s or full play. |
| `VALUE` | Bid for highest predicted purchase value. Advanced. |

### `call_to_action_types`

`SIGN_UP`, `LEARN_MORE`, `GET_OFFER`, `SUBSCRIBE`, `INSTALL_APP`, `DOWNLOAD`, `BOOK_TRAVEL`, `SHOP_NOW`, `SEND_MESSAGE`, `WHATSAPP_MESSAGE`, `APPLY_NOW`, `CONTACT_US`, `GET_DIRECTIONS`, `GET_QUOTE`, `WATCH_MORE`, `LISTEN_NOW`.

---

## IV. Targeting spec (full surface)

The typed `Targeting` interface in `meta-client.ts` is a slim subset. Below is the full common-case spec. Pass as a stringified JSON object in the `targeting` form param.

```json
{
  "geo_locations": {
    "countries": ["TR"],
    "regions": [{ "key": "<region_id>" }],
    "cities": [{ "key": "<city_id>", "radius": 10, "distance_unit": "kilometer" }],
    "zips": [{ "key": "TR:34000" }],
    "location_types": ["home", "recent"]
  },
  "age_min": 18,
  "age_max": 65,
  "genders": [1, 2],
  "locales": [6, 24],

  "custom_audiences": [{ "id": "<ca_id>" }],
  "excluded_custom_audiences": [{ "id": "<ca_id>" }],

  "flexible_spec": [
    {
      "interests": [{ "id": "<int_id>", "name": "Education" }],
      "behaviors": [{ "id": "<beh_id>", "name": "Small business owners" }],
      "demographics": [{ "id": "<dem_id>", "name": "Parents (all)" }]
    }
  ],
  "exclusions": {
    "interests": [{ "id": "<int_id>" }]
  },

  "publisher_platforms": ["facebook", "instagram", "audience_network", "messenger"],
  "facebook_positions": ["feed", "right_hand_column", "marketplace", "video_feeds", "story", "search", "instream_video", "facebook_reels"],
  "instagram_positions": ["stream", "story", "explore", "reels", "shop", "explore_home"],
  "audience_network_positions": ["classic", "rewarded_video"],
  "messenger_positions": ["messenger_home", "story"],
  "device_platforms": ["mobile", "desktop"],
  "user_os": ["iOS", "Android"],

  "targeting_automation": { "advantage_audience": 1 },
  "brand_safety_content_filter_levels": ["FACEBOOK_STANDARD", "AN_STANDARD"],

  "education_majors": [{ "id": "<id>" }],
  "education_schools": [{ "id": "<id>" }],
  "education_statuses": [1, 2, 3],
  "industries": [{ "id": "<id>" }],
  "interested_in": [1, 2],
  "life_events": [{ "id": "<id>" }],
  "relationship_statuses": [1, 2, 3],
  "work_employers": [{ "id": "<id>" }],
  "work_positions": [{ "id": "<id>" }]
}
```

**Default per `account-ops.md §II`:** broad targeting, no detailed targeting, no age/gender restriction unless legal — Meta's delivery treats targeting as suggestions. Use `targeting_automation.advantage_audience: 1` and let Meta find the buyers.

**Targeting Search API** for resolving names → IDs: `GET /search?type=adinterest&q=<query>` (also `adgeolocation`, `adworkemployer`, `adeducationschool`, etc.).

---

## V. `asset_feed_spec` (full surface)

```json
{
  "videos": [{ "video_id": "<id>", "thumbnail_hash": "<hash>" }],
  "images": [{ "hash": "<hash>" }],

  "bodies": [{ "text": "<copy>" }],
  "titles": [{ "text": "<headline>" }],
  "descriptions": [{ "text": "<description>" }],
  "captions": [{ "text": "<caption>" }],
  "link_descriptions": [{ "text": "<link description>" }],

  "link_urls": [{ "website_url": "https://...", "display_url": "example.com" }],
  "call_to_action_types": ["SIGN_UP"],

  "ad_formats": ["SINGLE_VIDEO", "SINGLE_IMAGE", "CAROUSEL"],

  "optimization_type": "PLACEMENT",
  "autotranslate": ["es_ES", "tr_TR"],

  "additional_data": {
    "multi_share_end_card": false,
    "is_click_to_message": false
  },

  "asset_customization_rules": [
    {
      "customization_spec": {
        "publisher_platforms": ["instagram"],
        "instagram_positions": ["story", "reels"]
      },
      "video_label": "<label>",
      "image_label": "<label>",
      "body_label": { "name": "<label>" }
    }
  ]
}
```

**Hook-swap pattern (per `copy-formulas.md §3`):** keep the same `videos[].video_id` body (seconds 4–end) across multiple ads, vary the `bodies` and `titles` to test different hook framings. Aim for 5–10 hook variants per body.

---

## VI. Raw `metaFetch` recipes

Use these when the typed client doesn't have the verb. All assume the operator is already in a CLI command and has built `ctx` via `liveCtxFromEnv(loadEnv())`.

### 1. Delete a campaign / adset / ad / creative

```ts
import { metaFetch } from '../lib/marketing/meta-fetch.js';
await metaFetch(ctx, {
  method: 'DELETE',
  path: '<entity_id>',
});
// Returns { success: true }. Idempotent — calling on already-deleted is a no-op.
```

### 2. List campaigns with cursor pagination

```ts
const fields = 'id,name,objective,status,effective_status,daily_budget,created_time,updated_time';
let next: string | null = null;
const all: Record<string, unknown>[] = [];
do {
  const resp = await metaFetch(ctx, {
    method: 'GET',
    path: `${ctx.adAccountId}/campaigns`,
    query: { fields, limit: 100, ...(next ? { after: next } : {}) },
  }) as { data: Record<string, unknown>[]; paging?: { cursors?: { after: string }; next?: string } };
  all.push(...resp.data);
  next = resp.paging?.next ? resp.paging.cursors?.after ?? null : null;
} while (next);
```

Pattern works for `/adsets`, `/ads`, `/adcreatives`, `/customaudiences` — swap the path leaf.

### 3. Duplicate a campaign / adset / ad

```ts
await metaFetch(ctx, {
  method: 'POST',
  path: `<source_id>/copies`,
  params: {
    deep_copy: true,                  // also copy children (campaign → adsets → ads)
    status_option: 'PAUSED',          // duplicates always created paused
    rename_options: { rename_strategy: 'DEEP_RENAME', rename_suffix: ' (copy)' },
    start_time: '2026-05-01T00:00:00+0000',  // optional reschedule
  },
});
```

`deep_copy: false` gives a shallow copy (children point to originals — useful when duplicating an adset to edit a single field per `account-ops.md §II`'s "duplicate before editing" rule).

### 4. Batch — flip many entities atomically (close to it)

```ts
const batch = entities.map((e) => ({
  method: 'POST',
  relative_url: `${e.id}?status=PAUSED`,
}));
await metaFetch(ctx, {
  method: 'POST',
  path: '',                           // root
  params: { batch: JSON.stringify(batch) },
});
// Each item in the response array maps to the corresponding batch entry.
// Each can succeed/fail independently — Meta does NOT roll back the whole batch.
```

Batch limit: 50 ops per call. For `mk launch <cohort>` flipping a campaign + 1 adset + 5 ads to ACTIVE, one batch call replaces 7 round trips.

### 5. Create a custom audience (website visitors retargeting)

```ts
await metaFetch(ctx, {
  method: 'POST',
  path: `${ctx.adAccountId}/customaudiences`,
  params: {
    name: 'Site visitors 30d',
    subtype: 'WEBSITE',
    rule: JSON.stringify({
      inclusions: {
        operator: 'or',
        rules: [{ event_sources: [{ id: ctx.pixelId, type: 'pixel' }], retention_seconds: 30 * 86400, filter: { operator: 'and', filters: [{ field: 'url', operator: 'i_contains', value: 'example.com' }] } }],
      },
    }),
    retention_days: 30,
    description: 'Visitors in last 30 days',
  },
});
```

### 6. Read insights with breakdowns (e.g. by placement)

```ts
await metaFetch(ctx, {
  method: 'GET',
  path: `<campaign_id>/insights`,
  query: {
    fields: 'spend,impressions,clicks,ctr,cpm,purchase_roas,actions',
    level: 'ad',
    breakdowns: 'publisher_platform,platform_position,impression_device',
    date_preset: 'last_7d',
  },
});
```

Allowed breakdowns: `age`, `gender`, `country`, `region`, `dma`, `publisher_platform`, `platform_position`, `device_platform`, `impression_device`, `product_id`, `frequency_value`. Some are mutually exclusive.

### 7. Async insights for windows >7d (v1 — defer in v0)

```ts
// Step 1 — start
const start = await metaFetch(ctx, {
  method: 'POST',
  path: `<entity_id>/insights`,
  params: { date_preset: 'last_30d', level: 'ad', fields: '...' },
}) as { report_run_id: string };

// Step 2 — poll
let status = 'Job Not Started';
while (!['Job Completed', 'Job Failed', 'Job Skipped'].includes(status)) {
  await new Promise((r) => setTimeout(r, 5000));
  const poll = await metaFetch(ctx, {
    method: 'GET',
    path: start.report_run_id,
    query: { fields: 'async_status,async_percent_completion' },
  }) as { async_status: string };
  status = poll.async_status;
}
if (status !== 'Job Completed') throw new Error(`async insights ${status}`);

// Step 3 — fetch
const data = await metaFetch(ctx, {
  method: 'GET',
  path: `${start.report_run_id}/insights`,
  query: { limit: 5000 },
});
```

### 8. Resolve a targeting interest by name → id

```ts
await metaFetch(ctx, {
  method: 'GET',
  path: 'search',
  query: { type: 'adinterest', q: 'Education', limit: 25 },
});
// Returns { data: [{ id, name, audience_size_lower_bound, audience_size_upper_bound, path, topic }] }
```

### 9. Get an ad preview (rendered HTML)

```ts
await metaFetch(ctx, {
  method: 'GET',
  path: `<ad_id>/previews`,
  query: { ad_format: 'MOBILE_FEED_STANDARD' },
});
// Returns { data: [{ body: "<html>..." }] }
```

Ad formats: `MOBILE_FEED_STANDARD`, `DESKTOP_FEED_STANDARD`, `INSTAGRAM_STANDARD`, `INSTAGRAM_STORY`, `INSTAGRAM_REELS`, `RIGHT_COLUMN_STANDARD`, `MESSENGER_MOBILE_INBOX_MEDIA`, `FACEBOOK_REELS_MOBILE`, `MARKETPLACE_MOBILE`.

### 10. Read an entity with all common fields

```ts
// Campaign
await metaFetch(ctx, {
  method: 'GET',
  path: '<campaign_id>',
  query: { fields: 'id,name,objective,status,effective_status,configured_status,daily_budget,lifetime_budget,bid_strategy,buying_type,start_time,stop_time,spend_cap,special_ad_categories,pacing_type,created_time,updated_time' },
});
// AdSet — replace fields with: id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_amount,bid_strategy,billing_event,optimization_goal,promoted_object,targeting,attribution_spec,start_time,end_time,frequency_control_specs,pacing_type,dsa_beneficiary,dsa_payor
// Ad — fields: id,name,adset_id,creative,status,effective_status,tracking_specs,conversion_specs,created_time,updated_time
// Creative — fields: id,name,object_story_spec,asset_feed_spec,image_hash,video_id,call_to_action,body,title
```

---

## VII. Error codes (cross-reference)

The `metaFetch` retry whitelist is `{1, 2, 4, 17, 32, 613}`. Common non-retried codes you'll see:

| Code | Meaning | Action |
|---|---|---|
| 100 | Invalid parameter | Read the message — usually a malformed field. Do not retry; fix and resubmit. |
| 190 | OAuth token expired | `TokenExpiredError`. Regenerate System User Token and update `.env`. |
| 200 | Permission denied | Token lacks scope or app role. |
| 270 | App must be approved | App Review required for the called endpoint. |
| 368 | Action attempted has been deemed abusive | Rare. Usually bulk creates flagged as spam. |
| 1487 | Edits on this object are limited | Snow-globe violation — Meta's own rate limit on rapid edits. Wait. |
| 80004 | Spending limit reached | Account spend cap hit. |
| 80008 | Application request limit reached | Different from user-level — affects the entire app. |

For the full list: `https://developers.facebook.com/docs/graph-api/guides/error-handling/`.

---

## VIII. When this file isn't enough — live-doc fallback

If the operator asks for something not covered here:

1. Fetch `https://developers.facebook.com/docs/marketing-api/reference/v25.0/<entity>` (or the relevant endpoint page).
2. Construct a raw `metaFetch(ctx, { method, path, params })` call following the patterns in §VI.
3. Run dry-run first (`ctx.dryRun = true`), show the operator the request shape.
4. After operator confirms, run live.
5. **Add the recipe back into §VI of this file** so next time it's a layer-2 hit, not a layer-3 doc fetch.
6. If the same recipe is used 3+ times, propose adding a typed wrapper to `meta-client.ts` in the next PR.
