---
id: task_xy5dw5Zm
name: meta-marketing-skill
description: >-
  Multi-agent Meta marketing skill with Graph API CRUD, competitor ingestion via
  Reinfluence, and dashboard. Single source of truth for v0.
priority: high
urgency: high
status: in_progress
created_at: '2026-04-25'
updated_at: '2026-04-25T19:45Z'
status_pr0: shipped
status_pr0_5: shipped
status_pr1: shipped
status_pr2: shipped
status_pr3: shipped
status_pr4: todo
status_pr5: partial (vision pass remaining)
status_pr6: shipped (early — agent roster grounded in corpus)
status_pr7: todo
status_pr8: todo
tags:
  - skill
  - marketing
  - meta
  - graph-api
  - multi-agent
  - dashboard
  - reinfluence
  - v0
parent_task: null
related_feature: null
version: v0.3.0
council: council_7_ForDfS
---

## ▶️ Resume here (refreshed-session entry point)

If you are starting a fresh session, **this section is your single source of context — read it before anything else.**

**Status as of 2026-04-25 (PR 0 / 0.5 / 1 / 2 / 3 / 6 SHIPPED).** Working tree clean for marketing files. 6 marketing commits ahead of remote. 614/614 tests passing. mk CLI exposes 19 subcommands. Sleep debt at 4 (consolidated once mid-session) — PR 4 is safe to start fresh.

### Branch state

```
323aa38  [feat] PR 3 — launch with full guardrails + 6 mutation verbs (13 files, 1788 ins)
a5b1b51  [docs] task state refresh for PR 1/2/6 shipped
69aadc5  [feat] PR 2 — CLI surface (13 verbs + 4 lib modules + 32 tests)
17c279a  [feat] PR 1 — Graph API foundation + 3-layer fallback
85b4a4d  [feat] PR 6 — agent roster (early, grounded in corpus)
5ec28f4  [feat] PR 0 + PR 0.5 — bundled ingester + corpus + skill-pack
```

### What's shipped

**PR 0** — bundled Reinfluence ingester (`tools/reinfluence/`) + `mk init` + `mk competitor {ingest,list,health}` + `src/lib/marketing/{paths,env-loader,secrets,config,store,bootstrap,competitors}.ts`. Atomic JSON+MD bridge writes, PID lockfile, runs/ WAL, redactSecrets corpus. 28 unit tests.

**PR 0.5** — 9 YouTube videos ingested with per-source learnings; `skill-packs/meta-marketing/` fully generated (SKILL.md + account-ops + copy-formulas + creative-frameworks + mistakes + platform-state). All 8 user decisions resolved.

**PR 1 — Graph API foundation:**
- `src/lib/marketing/meta-fetch.ts` (525 lines) — sole wrapper for graph.facebook.com / graph-video.facebook.com. Retry on 429/5xx + Meta codes {1,2,4,17,32,613} max 5 attempts; exponential backoff + ±25% jitter capped at 30s; honors `X-Business-Use-Case-Usage`. Idempotency UUIDv4 + `runs/by-idem/<key>.json` cache. OAuth 190 → `TokenExpiredError` no-retry. Header-only auth + `HeaderAuthAssertionError` if `access_token=` ever in URL. Per-account in-process write queue capped at 3, reads unthrottled. Chunked >50MB upload via graph-video host with `start|transfer|finish` + 4MB chunks. `ctx.dryRun` gate inside the wrapper.
- `src/lib/marketing/meta-client.ts` (270 lines) — typed surface mirroring Tilki's `meta-client.ts` but `ctx`-first: `listAdAccounts`, `getAdAccount`, `createCampaign`/`updateCampaign`/`getCampaign`, `createAdSet`/`updateAdSet`, `createVideoCreative`/`createImageCreative`, `createAd`/`updateAd`, `pauseEntity`/`resumeEntity`, `uploadVideo`/`uploadImage`, `getInsights`.
- `src/lib/marketing/config.ts` — `DEFAULT_API_VERSION` bumped from v21.0 → **v25.0** (latest as of 2026-04, released 2026-02-18; v20.0 expires 2026-09-24).
- `tests/unit/marketing-meta-fetch.test.ts` — 21 unit tests (dry-run gate, header-only auth + URL assertion, 429 retry with X-Business-Use-Case-Usage hint, 5xx retry, Meta code retry, exhaust 5×, OAuth 190 no-retry, idempotency cache write, chunked threshold, per-account queue, factories).

**Three-layer API fallback:**
- `skill-packs/meta-marketing/api-reference.md` (470 lines) — endpoint map (CRUD by entity), field reference per entity, full Targeting + asset_feed_spec specs, 10 raw `metaFetch` recipes (delete, paginate, duplicate via `/copies`, batch 50-op, custom audiences, breakdowns, async insights v1, search, previews, full-fields read), error code cross-reference, live-doc fallback protocol with self-extending promotion rule.
- `SKILL.md` — new §X "Beyond the Typed Client — Three-Layer API Fallback"; Anti-Patterns renumbered to §XI.
- `marketing-strategy.md` + `marketing-monitor.md` — knowledge base tables include `api-reference.md`; rule "confirm op is not in typed client before recommending a raw recipe."

**PR 2 — CLI surface (13 verbs):**
- 4 new lib modules: `hypothesis.ts` (4-field shape validator with known-metric allowlist), `budget.ts` (never-defaults; `BudgetMissingError` if `--daily-budget` omitted; snow-globe-capped scale at [-50, +500]), `insights-cache.ts` (15-min TTL with hour-bucketed filenames + atomic writes), `cohort.ts` (entity helpers + bridge .md).
- 13 CLI verbs registered in `src/cli/commands/marketing.ts`: `init`, `competitor {ingest,list,health}` (PR 0), `config check`, `account {list,use}`, `cohort {create,list,show}`, `insights {pull,show}`, `today`, `diff`, `pause`, `resume`, `scale`, `kill`, `doctor`.
- All mutations dry-run by default; `--no-dry-run` is the only flip path. Every mutation acquires marketing lock + writes runs/ WAL entry. `mk insights pull` hard-caps `--since` at `last_7d` for v0.
- 32 unit tests (`hypothesis`, `budget`, `insights-cache`); 582/582 suite passing.

**PR 6 — agent roster (shipped early, grounded in corpus):**
- `skill-packs/agents/marketing-strategy.md` — Strategy Optimizer; refuses to plan until hypothesis shape valid; budget always `null + ASK_USER_FOR_BUDGET`; CAPI gate; 9-section output contract with mandatory corpus citations.
- `skill-packs/agents/marketing-monitor.md` — Performance Monitor; reads insights, applies §4 post-launch rules, writes evergreen ledger entries via `mk learnings append`. No auto-mutation. Kill-by-spend not by-ROAS. Mandatory anti-pattern check section.
- `skill-packs/agents/marketing-creative.md` — flag-gated stub; reads `marketing.creative_director.enabled` and refuses cleanly until v1.

**PR 3 — launch with full guardrails (SHIPPED 2026-04-25 commit 323aa38):**
- `src/lib/marketing/entity-store.ts` — generic store for campaign / adset / ad / creative. Local id (`cmp_/as_/ad_/cr_` prefix) decoupled from Meta `fb_id` so dry-run entities don't collide with live state. Atomic JSON+MD bridge writes. `gatherEntitiesByCohort` scoops the launch tree.
- `src/lib/marketing/launch.ts` — `buildLaunchSummary` (6 lines), `createLaunchWal` (pre-flip), `executeFlips` (campaign → adset → ad order, one at a time, HALTS at first error using `noRetry: true` so metaFetch retry loop is bypassed for launch flips), `findWalByRunId`/`readWal`/`writeWal` for resume.
- `src/lib/marketing/meta-client.ts` — `pauseEntity` / `resumeEntity` accept `{ noRetry?: boolean }` 3rd arg; required for launch flips per task contract.
- `src/lib/marketing/paths.ts` — added `MARKETING_PATHS.adsDir()`.
- 6 mutation CLI verbs: `mk campaign {create,list}`, `mk adset {create,list}` (REQUIRES `--daily-budget`, `BudgetMissingError` on omit), `mk creative {create-image,create-video,list}`, `mk asset upload <path>` (auto-detects video/image; chunked >50MB), `mk ad {create,list}`.
- `mk launch <cohort_id> --confirm <cohort_id>` — `--confirm` must match verbatim (no `-y`/`--yes` shortcut). Prints 6-line summary BEFORE creating WAL. WAL written first, then flips one entity at a time. HALTS at first error.
- `mk launch resume <run_id>` — replays from WAL; rejects ctx mismatch (live WAL ↔ dry-run invocation, vice versa).
- 17 unit tests (`marketing-entity-store`, `marketing-launch`); 614/614 suite passing.

### What's NOT shipped yet

**PR 4 (NEXT) — `.md` bridge layer + hooks:**
- SessionStart `## Marketing` snapshot section in the auto-loaded context (active cohorts + last insights pull ts + pending Performance Monitor recs count)
- UserPromptSubmit hook nudge if unconfirmed Performance Monitor recommendations are >24h old
- rem-sleep marketing rules: prune `runs/` >30d keeping last 100; compact `insights/` snapshots into per-campaign daily/weekly rollups; redact transcripts before consolidation; merge `marketing-learnings/<date>.md` into current-quarter rollup; archive on cap
- Per-day `_dream_context/knowledge/marketing-learnings/<YYYY-MM-DD>.md` plumbing + `mk learnings show`/`mk learnings append` verbs (Performance Monitor agent only writer)
- PreToolUse hook to block direct edits to `_dream_context/marketing/.env`
**PR 5** — Reinfluence vision pass (mostly done; remaining: optional vision-pass behind env flag)
**PR 7** — Dashboard v0 (3 tabs, uPlot, locked-down assets, Brain layer toggle)
**PR 8** — Pre-commit hook + `mk doctor --scan` retroactive secret sweep + `mk council` wrapper

### Hard rules that carry forward

1. **CLI is the only place that flips `ctx.dryRun = false`.** Library code accepts `ctx`, never constructs it. Bypass-by-refactor impossible.
2. **Header-only auth.** `metaFetch` throws `HeaderAuthAssertionError` if any built URL contains `access_token=`. Never bypass.
3. **Budget never defaults.** `parseDailyBudget` throws `BudgetMissingError` on missing input. Strategy Optimizer emits `null + ASK_USER_FOR_BUDGET`.
4. **Hypothesis shape validation.** All 4 fields (predicted_winner, predicted_metric, decision_threshold, kill_condition) must pass before strategy is written. `mk cohort create` rejects shape-invalid input.
5. **Three-layer API fallback.** Layer 1 = typed client; Layer 2 = `api-reference.md`; Layer 3 = live Meta docs (dry-run first, write recipe back to layer 2 after use, propose typed wrapper after 3 uses).
6. **Snow-globe rule.** No two structural changes within 3 days. `mk scale` warns >30%; `parseScalePct` rejects outside [-50, +500].
7. **Same-speaker discipline.** Ben Heath (4 videos), Charlie (1), Moonlighters (1), Optimizer (1) = 4 voices. Single-speaker rules flagged as lower confidence.
8. **Omnipresent content gate.** Don't recommend campaign structure above ₺30-40K/month spend until Ben's omnipresent content video is ingested.

### Files that exist and should NOT be re-created

- `tools/reinfluence/{__main__.py, __init__.py, requirements.txt, README.md}`
- `src/lib/marketing/{paths,env-loader,secrets,config,store,bootstrap,competitors,meta-fetch,meta-client,hypothesis,budget,insights-cache,cohort,entity-store,launch}.ts`
- `src/cli/commands/marketing.ts`
- `src/cli/commands/marketing/{init,competitor,_ctx,config,account,cohort,insights,today,diff,status-flip,scale,kill,doctor,campaign,adset,creative,asset,ad,launch}.ts`
- `tests/unit/marketing-{paths,env-loader,secrets,store,meta-fetch,hypothesis,budget,insights-cache,entity-store,launch}.test.ts`
- `skill-packs/meta-marketing/{SKILL.md, account-ops.md, copy-formulas.md, creative-frameworks.md, mistakes.md, platform-state.md, api-reference.md}`
- `skill-packs/agents/{marketing-strategy.md, marketing-monitor.md, marketing-creative.md}`
- `_dream_context/marketing/competitors/_youtube/posts/*.{json, md, learnings.md}` (9 videos)
- `.gitignore` (marketing patterns), `src/cli/index.ts` (mk command registered), `skill-packs/catalog.json` (meta-marketing standalone + 3 agents under agents[])

### Old PR-0.5-era state (preserved for reference)

**9 videos ingested** (all under `_dream_context/marketing/competitors/_youtube/posts/<shortcode>.{json,md,learnings.md}`):

| # | shortcode | speaker | runtime | lane | role |
| --- | --- | --- | --- | --- | --- |
| 1 | `ooF7rNBYAog` | Jared Robinson (Creative Don) | 15:16 | paid-ad-creative | first source |
| 2 | `HwO7g5uHHYY` | anon (low-credibility) | 14:36 | organic-dm-funnel | first source |
| 3 | `JLlcwojiVtw` | Ben Heath | 18:31 | paid-ad-account-ops | first source |
| 4 | `E_wZJhuSK5U` | "Charlie" (Disruptor Academy, branded "Andromeda 1") | 15:12 | paid-ad-account-ops | 2nd speaker |
| 5 | `dAJyqo6wnq4` | Ben Heath (×2) | 66:41 | paid-ad-account-ops | **foundational reference** |
| 6 | `13s-G9Uj51A` | Ben Heath (×3) | 23:29 | paid-ad-account-ops | delta extraction |
| 7 | `FYUR8ZL4_xY` | Edward / The Moonlighters ("M4 method") | 13:41 | paid-ad-account-ops | 3rd speaker |
| 8 | `TMOfiSdx7Tg` | "Optimizer" (anon, school community) | 21:14 | paid-ad-account-ops | **4th speaker, NEW sub-domain: post-launch-optimization** |
| 9 | `kuSq-pmNfnM` | Ben Heath (×4) | 17:35 | paid-ad-creative + paid-ad-account-ops | delta extraction — 2 net-new signals: hook-swap strategy + turn-off-by-spend rule |

Every video has a `<shortcode>.learnings.md` next to its post bridge — that's the per-source distillation, with `lane:`, `evidence_strength:`, and `promotion_rule:` frontmatter.

### Corpus state (lanes + speaker counts)

| Lane | Distinct speakers | Videos |
| --- | --- | --- |
| `paid-ad-creative` | 1 (Jared) + Ben delta | 2 |
| `organic-dm-funnel` | 1 (anon, low-credibility) | 1 |
| `paid-ad-account-ops` | **4 (Ben + Charlie + Moonlighters + Optimizer)** | **6** |

`paid-ad-account-ops` is now multi-source enough to ship real playbook rules. The other two lanes are still single-source.

### All user decisions (resolved)

| # | Decision | Resolution |
| --- | --- | --- |
| 1 | Lane consolidation | One skill (`meta-marketing`), 5 sections — NOT separate skills |
| 2 | Cross-lane copy rule | `copy-formulas.md` as shared reference inside skill-pack |
| 3 | Performance goal trap | Hard block — wrong objective = launch refused, no override |
| 4 | Min-spend = 1× CPA | Adopted as testing default (Moonlighters); Charlie = low-budget fallback; Ben = per-creative attribution |
| 5 | CAPI prerequisite | Hard block — no CAPI = launch refused, no override |
| 6 | Platform-state lifecycle | `platform-state.md` added to skill-pack (time-stamped, separate from rules) |
| 7 | Trust-Meta line | Named rule added to SKILL.md §VIII |
| 8 | Omnipresent content | Flagged as pre-scale prerequisite — ingest Ben's video before scaling past ₺30-40K/month |

### Remaining open conflicts (documented in account-ops.md, not collapsed)

1. **`further limit reach` toggle** — Ben (off by default) vs Moonlighters (on for interest-winners adsets). Stage-dependent, not a true conflict.
2. **Creative volume vs ad spam** — Ben (20+ creatives) vs Charlie (ad spam breaks system). Proposed resolution: variation within a stable journey ≠ fragmentation. Not yet confirmed.

### Single-speaker claims still pending corroboration (not yet promoted to rules)

- Auction overlap mechanism (Ben — `13s-G9Uj51A` §1)
- Filter-by-row-selected preview trick + spend redistribution math (Optimizer — `TMOfiSdx7Tg` §4–§5)
- Ad-level vs adset-level optimization decision matrix (Optimizer §10)
- Profit_volume / blended outcome + test purpose + low-budget rule (Charlie)

### Hard rules for the training pass (unchanged)

- **Never invent patterns.** Every pattern file must cite the specific `<handle>__<shortcode>` source it came from.
- **Quote, don't paraphrase blindly.** When a hook line works, quote verbatim and tag it as a hook example.
- **Frames matter for IG reels.** Not applicable to YouTube path (transcript-only).
- **Disagreements with the user override the corpus.** If the user contradicts a pattern, the user wins.
- **Test files do not get edited.** Generated files live in `skill-packs/`, never in `tests/` or `src/`. There is no `playbooks/` directory — everything is inside the skill-pack.
- **Same-speaker discipline:** N videos from the same speaker = 1 voice for cross-source corroboration. Ben's 3 videos do NOT count as 3 sources.

### Files this session created in working tree (NOT committed)

**Per-source learnings (9 files):**
- `_dream_context/marketing/competitors/_youtube/posts/{ooF7rNBYAog,HwO7g5uHHYY,JLlcwojiVtw,E_wZJhuSK5U,dAJyqo6wnq4,13s-G9Uj51A,FYUR8ZL4_xY,TMOfiSdx7Tg,kuSq-pmNfnM}.learnings.md`

**skill-packs/meta-marketing/ (6 files — self-contained, no _dream_context/ dependency):**
- `SKILL.md`, `account-ops.md`, `copy-formulas.md`, `creative-frameworks.md`, `mistakes.md`, `platform-state.md`

**Note:** `_dream_context/marketing/playbooks/` directory has been deleted — all content moved into `skill-packs/meta-marketing/`.

**Ingester patches (working tree edits to existing files — commit with PR 0.5):**
- `tools/reinfluence/__main__.py` (canonical) + `_dream_context/marketing/.tools/reinfluence/__main__.py` (deployed copy)
- `tools/reinfluence/requirements.txt`
- `_dream_context/marketing/.venv/` has `youtube-transcript-api` installed (will be picked up automatically by future `mk init` runs because requirements.txt is updated)

### Files you already shipped in PR 0 (do not re-create; only modify if explicitly asked)
- `tools/reinfluence/{__main__.py, __init__.py, requirements.txt, README.md}`
- `src/lib/marketing/{paths.ts, env-loader.ts, secrets.ts, config.ts, store.ts, bootstrap.ts, competitors.ts}`
- `src/cli/commands/marketing.ts`
- `src/cli/commands/marketing/{init.ts, competitor.ts}`
- `tests/unit/marketing-{paths,env-loader,secrets,store}.test.ts`
- `.gitignore` (added `.tools/`, `.venv/`, `.cache/`, `_assets/`, `_media/`, `.lock`, `.env`)

### Commands you'll use to continue

```bash
# health
dreamcontext mk competitor health

# per URL — run sequentially (concurrent ingests are capped at 1)
dreamcontext mk competitor ingest <url>

# enumerate ingested posts
ls _dream_context/marketing/competitors/_youtube/posts/

# inspect a transcript via the Python venv
/Users/mehmetnuraydin/projects/dreamcontext/_dream_context/marketing/.venv/bin/python -c "
import json
d = json.load(open('_dream_context/marketing/competitors/_youtube/posts/<SHORTCODE>.json'))
for s in d['transcript']['segments']:
    mm,ss = int(s['start'])//60, int(s['start'])%60
    print(f'[{mm:02d}:{ss:02d}] {s[\"text\"]}')
"
```

### What to do next when this section is read

PR 3 is shipped. Sleep debt is at 4 (already partially consolidated mid-session). PR 4 is next per the task file.

1. **Greet the user, confirm state loaded, then ask:**
   - Consolidate sleep (debt = 4) before PR 4, OR
   - Start PR 4: `.md` bridge layer + hooks (SessionStart `## Marketing` snapshot, UserPromptSubmit nudge for stale recs >24h, rem-sleep marketing rules, per-day `marketing-learnings/<date>.md` plumbing, `mk learnings show/append`, PreToolUse block on `_dream_context/marketing/.env`), OR
   - Smoke-test the end-to-end create→launch flow against a Tilki sandbox account (dry-run first, confirm 6-line summary + WAL works as expected, then re-run with `--no-dry-run` against a sandbox ad account if available), OR
   - Backlog polish: tab-completion script for `mk` (deferred from PR 2), `mk cohort close <id>` to flip cohort to `closed_won/closed_lost/killed`, currency lookup so `mk scale` formats budgets correctly, integration test for `mk insights pull --campaign <id>`.

2. **Hard constraints for PR 4:**
   - SessionStart hook reads `_dream_context/marketing/cohorts/*.json` + insights cache; emits a `## Marketing` block with active cohort summary, last `insights pull` timestamp, and pending Performance Monitor rec count. Must complete in <500ms (SessionStart is in the hot path of every session).
   - UserPromptSubmit hook nudge: only fires if there are unconfirmed Performance Monitor recommendations from >24h ago. Must NOT fire on every prompt.
   - rem-sleep marketing rules go in `dist/agents/dreamcontext-rem-sleep.md` — prune `runs/` keeping latest 100, compact `insights/` snapshots into per-campaign daily/weekly rollups, redact transcripts via `redactSecrets` before consolidation, merge per-day `marketing-learnings/<date>.md` files into current-quarter rollup, archive on cap.
   - Per-day learnings: `_dream_context/knowledge/marketing-learnings/<YYYY-MM-DD>.md`. Performance Monitor agent is the only writer. Hypothesis ledger entries are evergreen — never pruned, only archived.

3. **Same-speaker discipline still applies** for any further corpus ingestion: Ben (4 videos), Charlie (1), Moonlighters (1), Optimizer (1).

4. **Omnipresent content gate:** before recommending campaign structure above ₺30-40K/month, ingest Ben's omnipresent content video first.

**Hand-off rule:** when this section grows stale, update it; do not delete. The next refreshed session must be able to resume here without re-reading every learnings file.

---

## Why

dreamcontext today only advises; no skill-pack can *operate* an ad account. The user has ~10 years of Meta ad-ops intent encoded in `Tilki Ogretmen/scripts/ads/meta-client.ts` (261 lines, Graph API v21.0, native fetch + FormData, no SDK lock-in) and a Python pipeline at `Reinfluence Ai` (Whisper / yt-dlp / ffmpeg) that mines competitor IG reels and YouTube videos for the visual + copy patterns that work in their market. Both projects work today but live alone.

This task turns dreamcontext into a multi-agent ad operator: plans cohort hypotheses, ingests competitor content as **training fuel for the agents themselves**, generates creative briefs, launches campaigns through Graph API with strict guardrails, monitors performance, and self-improves via a single living `marketing-learnings` file. Must respect dreamcontext's architecture rules (CLI-first mutations, hooks, sleep consolidation, install-skill distribution, Obsidian vault parity) and surface in the dashboard the way council and Brain graph already do.

A council debate (`_dream_context/council/council_7_ForDfS/final-report.md`) reviewed the prior draft. This task incorporates the synthesizer's MUST-CHANGE list and the user's answers to the four blocking questions:
1. Profile-shape from day 1, single-profile UX (multi-account plumbing without UX cost).
2. Reinfluence ships in v0 — it's the training fuel for the agents.
3. Agent **asks the user for budget every time and never assumes a default**.
4. v0 sub-agent roster is 2 (Strategy Optimizer + Performance Monitor) with a stubbed CreativeDirector behind a flag.

## User Stories

- [ ] As an operator, I want to set up Meta credentials once so the skill can act on my ad account without me copy-pasting tokens.
- [ ] As an operator, I want to create a cohort with a *shape-validated* hypothesis (predicted_winner, predicted_metric, decision_threshold, kill_condition) so my tests stop being vibes-based.
- [ ] As an operator, I want the agent to ask me for a daily budget on **every** campaign and adset — never assume — so I never get surprise-billed.
- [ ] As an operator, I want to run `mk today` and see active cohorts, today's spend, and deltas vs yesterday in <2s so I don't have to open Ads Manager.
- [ ] As an operator, I want `mk pause`, `mk scale --pct +20`, `mk kill --bottom 3 --by ROAS` to be one-line ops so daily ad management isn't a click-fest.
- [ ] As an operator, I want `mk launch <cohort>` to refuse without `--confirm <cohort_id>` typed verbatim and show a 6-line human summary first so I can't accidentally light $500 on fire.
- [ ] As an operator, I want the agent to ingest a competitor's IG handle / YouTube URL and learn from their hooks so my creative briefs are grounded in proven patterns, not guesses.
- [ ] As an operator, I want the Performance Monitor to write win/loss analyses into a per-day learnings file so my hypothesis ledger compounds into a moat.
- [ ] As an operator, I want a dashboard view of cohorts/campaigns/creatives that's read-only — every "edit" routes back to chat — so I can browse without breaking state.
- [ ] As a dreamcontext maintainer, I want the skill to follow the CLI-first / install-skill / vault-parity / sleep-consolidated architecture so it doesn't become a special case.

## Acceptance Criteria

### PR 0 (shipped 2026-04-25) done = all of:
- [x] Bundled `tools/reinfluence/` slim ingester emits NDJSON events; no SQLite leakage.
- [x] `src/lib/marketing/{paths,env-loader,secrets,config,store,bootstrap,competitors}.ts` implemented.
- [x] `mk init` creates folders + `.env` template + venv + pip-installs requirements + primes Whisper model — all under `_dream_context/marketing/`.
- [x] `mk competitor {ingest,list,health}` registered; `mk` alias works.
- [x] Health probe checks: python3, ffmpeg, ffprobe, venv exists, whisper importable, free disk > 2 GB. Cached 60s.
- [x] Atomic JSON + `.md` bridge writes via `writeJsonWithBridge`; PID lockfile with stale-clear; runs/ WAL with single LIFO `index.md`.
- [x] `redactSecrets` covers Bearer, `access_token=` URL, EAA tokens, app|secret pairs, long opaque blobs, SHA-256.
- [x] `.gitignore` for all generated artifacts.
- [x] 28 new unit tests; full suite 529/529 passing.

### PR 0.5 (NEXT — agent training) done = all of:
- [ ] User-provided URL list ingested via `mk competitor ingest`; every post lands as JSON+`.md` bridge with transcript + frames.
- [ ] `skill-packs/meta-marketing/SKILL.md` written, citing the corpus.
- [ ] `skill-packs/meta-marketing/playbooks/{hooks,copy-formulas,funnel-structures,visual-patterns,anti-patterns}.md` — each line traces to `<handle>__<shortcode>`.
- [ ] `skill-packs/agents/marketing-strategy-optimizer.md` and `marketing-performance-monitor.md` — system prompts reference playbooks, not generic ad-ops advice.
- [ ] User reviews each file before commit; corrections folded back.
- [ ] `dreamcontext install-skill` accepts the new skill-pack and installs it into `.claude/`.

### Remaining v0 (PR 1–8) done = all of:
- [ ] `mk init` bootstraps `_dream_context/marketing/` with profiles-shaped `config.json`, gitignored `.env`, and folder layout below. Templates created.
- [ ] `mk config check` hits Meta Graph `/me/adaccounts` via `metaFetch` and confirms ad-account access.
- [ ] `metaFetch` (the **only** wrapper allowed to reach Meta) implements: retry on 429/5xx + Meta error codes {1,2,4,17,32,613}, exponential backoff with jitter (base 1000ms, cap 30s), idempotency keys (UUIDv4) on every create*, OAuthException 190 → no-retry + remediation URL, header-only `Authorization: Bearer` (asserts `access_token=` never in URL), per-account in-process queue (max 3 concurrent writes), chunked upload >50MB, ctx-threaded dry-run gate (default true).
- [ ] `redactSecrets(str)` runs in: every runs/ writer, every meta-fetch log line, rem-sleep transcript pre-pass. Test corpus passes (System User Token, Bearer values, IG Graph tokens, Pixel hash, Page tokens).
- [ ] `store.ts` writes are atomic-rename (`*.tmp.<pid>.<rand>` → `fs.renameSync`); multi-file mutations use WAL via `runs/<ts>__<verb>.json`; PID lockfile at `marketing/.lock`; JSON write atomically pairs with `.md` bridge file write.
- [ ] Hypothesis shape-validator rejects free-string hypotheses; requires `predicted_winner`, `predicted_metric`, `decision_threshold`, `kill_condition`. Strategy Optimizer refuses to write strategy until shape passes.
- [ ] `mk launch <cohort>` requires `--confirm <cohort_id>` typed verbatim, prints 6-line summary, records pre-flip WAL, flips one entity at a time, supports `mk launch resume <run_id>` after crash. **No silent retries on launch flips.**
- [ ] CLI `--daily-budget <usd>` is required on `campaign create` and `adset create` (no fallback). Strategy Optimizer emits `daily_budget_usd: null` with `ASK_USER_FOR_BUDGET` note; main agent prompts user before any create call.
- [ ] Daily-ops verbs ship: `today`, `diff --since 24h`, `pause`, `resume`, `scale --pct`, `kill --bottom N --by <metric>`. Tab-completion and `mk` alias work.
- [ ] Sub-agents `marketing-strategy-optimizer` and `marketing-performance-monitor` distributed via `install-skill`; CLI-first; library imports forbidden. `marketing-creative-director` stub shipped behind `marketing.creative_director.enabled = false` flag in `config.json`.
- [ ] `.md` bridge files auto-generated atomic with JSON for cohort/campaign/adset/creative/competitor entities. Bridges contain frontmatter (id, type, fb_id, status, links) + 1-paragraph summary. `runs/index.md` is a single LIFO log (no per-run .md).
- [ ] SessionStart hook emits `## Marketing` snapshot section (active cohorts, last insights pull ts, pending-recs count). UserPromptSubmit nudges if unconfirmed Performance Monitor recs > 24h old. rem-sleep marketing rules: prune `runs/` >30d keeping last 100, compact `insights/` into per-campaign rollups, redact transcripts, merge `marketing-learnings/<date>.md` into current-quarter rollup.
- [ ] Per-day `_dream_context/knowledge/marketing-learnings/<YYYY-MM-DD>.md` writes work; rollup into `marketing-learnings.md`; archive on cap into `knowledge/marketing-archive-<YYYY-Q>.md`. Hypothesis-ledger entries are evergreen (never pruned, only archived).
- [ ] Reinfluence subprocess: `mk competitor ingest <url-or-handle>` runs end-to-end with `health()` probe (binary resolves, `--version` ≤5s, Whisper model present, yt-dlp ok, free disk >2GB; cached 60s); 600s wall-clock kill; concurrent ingests capped at 1; outputs normalized into `competitors/<handle>/posts/<shortcode>.{json,md}`; binaries land in `_media/` (gitignored). Optional vision pass behind env-key flag.
- [ ] `mk council "<topic>"` wraps `dreamcontext council create` with 4 marketing personas loaded from `skill-packs/meta-marketing/council-personas/*.md` (data files). **No `--preset` flag added to council code.**
- [ ] `mk doctor` validates: env present, FK integrity across JSON store, retroactive secret-scan of `_dream_context/`, Reinfluence health.
- [ ] Pre-commit hook `dist/hooks/marketing-binary-guard.sh` rejects staged paths under `_assets/` or `_media/` even if `.gitignore` is bypassed.
- [ ] Dashboard `/marketing` ships 3 tabs (Overview / Performance with uPlot / Creatives with clipboard "Discuss in chat"); locked-down asset static-serving (extension allowlist, realpath check, filename whitelist tied to creative JSON, localhost-bind, no listing); `last_synced_at` freshness badge; empty states everywhere; Brain graph layer toggle (default OFF).
- [ ] Architectural rule "when a skill earns a top-level `_dream_context/<domain>/` folder" memorialized in `DEEP-DIVE.md`.

### Done overall = a real Tilki campaign launches via the agent end-to-end with the user typing budget for every step; Reinfluence ingests a competitor IG handle and the Strategy Optimizer cites a pattern from it; Performance Monitor closes a hypothesis ledger entry; the dashboard reflects state without manual refresh; `mk doctor` returns clean.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-04-25 — Strict containment: every artifact lives under `_dream_context/marketing/` (user override)
No global pip / pipx / `~/.dreamcontext/` / external project paths. The dreamcontext npm package ships `tools/reinfluence/` as a static asset; on `mk init` it is copied to `_dream_context/marketing/.tools/reinfluence/`, a venv is created at `_dream_context/marketing/.venv/`, and Whisper / HF / yt-dlp caches are pinned via env vars (`XDG_CACHE_HOME`, `HF_HOME`, `WHISPER_CACHE_DIR`) into `_dream_context/marketing/.cache/`. **System prerequisites that cannot be bundled** (Node policy + disk cost): `python3 ≥ 3.10` and `ffmpeg`/`ffprobe`. Health-probe enforces both with one-line install hints.

### 2026-04-25 — Inverted PR order: transcription/competitors slice ships first (user override)
The original 8-PR sequence put Reinfluence at PR 5. User flipped the order: **competitor ingestion ships before Meta CRUD** because the *agents and skills are themselves trained on the ingested content* (transcripts + frames). Foundation (`config.ts`, `paths.ts`, `secrets.ts`, `store.ts`) is built minimally to support competitors; `metaFetch` and Meta CRUD are deferred until after the agent-training round (PR 1 in this revised plan = competitors slice; old PR 1 metaFetch becomes PR 2).

### 2026-04-25 — Reinfluence ships in v0 (user override)
The agents *learn* from competitor content; deferring Reinfluence to v1 would gut the training-fuel loop the user explicitly wants. v0 includes the Python subprocess (with a strict health-probe gate) plus optional vision pass behind an env-key flag.

### 2026-04-25 — Agent asks for budget every time, never defaults (user override)
No `max_daily_spend_usd` default in `config.json`. CLI `campaign create` / `adset create` reject without `--daily-budget`. Strategy Optimizer emits `daily_budget_usd: null` + `ASK_USER_FOR_BUDGET` so the main agent must prompt the user before any create call. `mk launch` requires `--confirm <cohort_id>` typed verbatim plus a 6-line human summary.

### 2026-04-25 — v0 ships 2 sub-agents, not 5
Strategy Optimizer + Performance Monitor only. CreativeDirector (merges Brainstormer + CopyWriter + Generator from the original draft) ships as a stub behind `marketing.creative_director.enabled = false`. Creative loop runs in main-agent chat in v0; v1 turns the flag on and adds image/video generation tools.

### 2026-04-25 — Profile-shape from day 1, single-profile UX
`config.json` is `{ default_profile, profiles: { <slug>: {...} } }` from the first commit. CLI accepts `--profile`/`--account` but defaults silently. Migrating committed JSON to multi-profile later would be expensive; the shape costs nothing now.

### 2026-04-25 — Council stays domain-agnostic; `mk council` is the wrapper
`--preset marketing` on the council command is rejected as anti-pattern (architect MUST-CHANGE 6). Marketing personas live as **data files** at `skill-packs/meta-marketing/council-personas/*.md` and are piped into `dreamcontext council agent create` via `--body`. Zero changes to core council code.

### 2026-04-25 — JSON canonical, .md bridges for vault parity
JSON drives logic and dashboard joins; `.md` bridge files (auto-generated atomic with JSON write) restore Obsidian vault parity (architect Rule 7). Bridges hold only frontmatter + 1-paragraph summary; the JSON is the source of truth. Single `runs/index.md` LIFO log replaces per-run `.md` proliferation.

### 2026-04-25 — Dry-run gate lives inside `metaFetch`, not at CLI boundary
`ctx.dryRun` defaults true and is required as the first arg to every library function. Library code accepts a `ctx`, never constructs one. Only CLI commands flip `ctx.dryRun=false` when `--no-dry-run` is passed. Bypass-by-refactor impossible.

### 2026-04-25 — Header-only auth; `access_token=` never in URL
All Graph API calls send `Authorization: Bearer <token>` headers only. Runtime assertion fails if any built URL contains `access_token=`. Closes the leakage path through transcript logs and dashboard request-line capture.

### 2026-04-25 — Direct port of Tilki `meta-client.ts` is rejected
The Tilki client has zero retry, no idempotency, no rate-limit handling, no resumable upload. v0 ships a hardened `metaFetch` first; the typed `meta-client.ts` surface mirrors Tilki's signatures (`createCampaign`, `createAdSet`, `uploadVideo`, etc.) but every function takes `ctx` first and routes through `metaFetch`.

### 2026-04-25 — Marketing earns a top-level `_dream_context/` folder; future skills must pass the 3-test rule
Memorialize in `DEEP-DIVE.md`: a skill earns a top-level folder iff (1) it produces durable operational state inspected between sessions, (2) that state has relational structure the dashboard graphs (FK joins + lifecycle status), AND (3) it owns external side effects (API calls, money spent, deployments) requiring an audit trail. Marketing meets all three; brand-voice/design/growth/engineering/system-prompts do not — they live in `knowledge/`.

## Technical Details

### Architecture at a glance

```
User chat
   │
   ▼
Main agent ──▶ skill-packs/meta-marketing/SKILL.md
                       │
                       ├─▶ dreamcontext marketing <cmd>      (alias: mk; src/cli/commands/marketing/*)
                       │       │
                       │       ├─▶ src/lib/marketing/meta-fetch.ts     (retry, backoff, idempotency, ctx dry-run gate)
                       │       ├─▶ src/lib/marketing/meta-client.ts    (typed Graph API surface)
                       │       ├─▶ src/lib/marketing/store.ts          (atomic JSON+MD writes, PID lock, WAL)
                       │       ├─▶ src/lib/marketing/config.ts         (profiles, env loader, redactSecrets)
                       │       ├─▶ src/lib/marketing/learnings.ts      (per-day write, rollup-aware read)
                       │       ├─▶ src/lib/marketing/competitors.ts    (Reinfluence subprocess + health-probe + vision pass)
                       │       ├─▶ src/lib/marketing/budget.ts         (per-action prompt; never defaults)
                       │       └─▶ src/lib/marketing/hypothesis.ts     (shape validator)
                       │
                       └─▶ Dispatches v0 sub-agents (parallel where safe):
                              ├─ marketing-strategy-optimizer
                              ├─ marketing-performance-monitor
                              └─ marketing-creative-director  (v0 stub; flag-gated; ships v1)

_dream_context/marketing/                       ← canonical state (JSON + .md bridges)
_dream_context/knowledge/marketing-learnings/   ← per-day .md, rolled up by rem-sleep
dashboard/src/pages/MarketingPage.tsx           ← read-only; chat-back via clipboard
src/server/routes/marketing.ts                  ← read-only API
src/server/routes/graph.ts                      ← extended with cohort/campaign/creative/competitor nodes
```

### Folder layout — `_dream_context/marketing/`

```
_dream_context/marketing/
├── .env                          ← gitignored — System User Token, ad account, page, IG, WA, vision keys
├── .lock                         ← PID lockfile
├── config.json                   ← { default_profile, profiles: { <slug>: { ad_account_id, page_id, ig_actor_id?, whatsapp_id?, api_version } } }
├── cohorts/
│   ├── <cohort_id>.json          ← { id, profile, name, hypothesis: {predicted_winner,predicted_metric,decision_threshold,kill_condition}, status, started_at, campaign_ids[] }
│   └── <cohort_id>.md            ← bridge (frontmatter + summary)
├── campaigns/
│   ├── <campaign_id>.json        ← { id, cohort_id, profile, fb_id, name, objective, status, daily_budget_usd, ... }
│   └── <campaign_id>.md
├── adsets/
│   ├── <adset_id>.json           ← { id, campaign_id, fb_id, targeting, optimization_goal, daily_budget_usd, ad_ids[] }
│   └── <adset_id>.md
├── creatives/
│   ├── <creative_id>.json        ← { id, adset_ids[], type, copy, hook, video_id|image_hash, brief_id, source }
│   ├── <creative_id>.md
│   └── _assets/                  ← gitignored binaries
├── briefs/
│   ├── <brief_id>.json
│   └── <brief_id>.md
├── insights/
│   └── <campaign_id>__<YYYY-MM-DD-HH>.json    ← hour-granularity snapshots, 15-min TTL cache
├── competitors/
│   └── <handle>/
│       ├── meta.json
│       ├── posts/<shortcode>.json   ← { url, transcript, frame_paths[], pattern_tags[], vision_summary }
│       ├── posts/<shortcode>.md
│       └── _media/                  ← gitignored binaries
└── runs/
    ├── index.md                  ← LIFO log, single file
    ├── by-idem/<key>.json        ← idempotency cache (UUIDv4)
    └── <ISO_ts>__<verb>.json     ← write-ahead + audit JSON
```

#### Relations (drive the Brain graph)
- `cohort.campaign_ids[]` ↔ `campaign.cohort_id`
- `campaign.fb_id` is Meta's ID; `campaign.id` is local UUID (decoupled — dry-run entities never collide with Meta state)
- `adset.campaign_id` ↔ `campaign.id`; `creative.adset_ids[]` ↔ `adset.ad_ids[]` (many-to-many)
- `creative.source` may reference `competitor.handle` + `post.shortcode` for "inspired by" lineage

### MARKETING_LEARNINGS — `_dream_context/knowledge/marketing-learnings/`

Per-day file `marketing-learnings/<YYYY-MM-DD>.md`. rem-sleep merges day files into a current-quarter rollup `marketing-learnings.md` and archives older quarters into `knowledge/marketing-archive-<YYYY-Q>.md`. No file ever exceeds the 300-line rule. Per-day files prevent races (no flock needed).

Section shape (shared across day files and rollups so merge is trivial):
1. Frontmatter — `id`, `tags`, `date`.
2. **Audience truths** — what we know about the buyer.
3. **Hypothesis ledger (evergreen)** — `[date] | hypothesis | cohort | outcome | reason`. Performance Monitor only writer. Never pruned, only archived on cap.
4. **Pattern library** — visual + copy patterns from competitor scouting.
5. **Anti-patterns** — disproven, with cohort reference.
6. **Open questions** — what to test next.

### Sub-agents (v0 ships 2; CreativeDirector stubbed)

**`marketing-strategy-optimizer`** (model: opus, tools: Bash, Read, WebFetch)
Reads `marketing-learnings/`, project `core/`, active cohort hypothesis. Refuses to write strategy until hypothesis shape passes. Emits funnel split, budget allocation pattern, targeting spec, optimization goals, kill/scale thresholds. **Never sets a budget number** — emits `daily_budget_usd: null` + `ASK_USER_FOR_BUDGET`. Writes via `mk strategy write`.

**`marketing-performance-monitor`** (model: opus, tools: Bash, Read, WebFetch)
Polls `mk insights pull`. Diffs latest two snapshots per campaign. Runs structured win/loss: hypothesis confirmed? what surprised? Appends to today's `marketing-learnings/<YYYY-MM-DD>.md` hypothesis-ledger. Surfaces "kill these / scale those" recommendations to main agent. Never auto-mutates.

**`marketing-creative-director`** (v0 stub, flag-gated; ships v1)
Single merged agent (replaces Brainstormer + CopyWriter + Generator from original draft). v0 ships file behind `marketing.creative_director.enabled = false`; loop validation in main-agent chat in v0. v1 adds image/video generation tools.

Hard rule: sub-agents call CLI, never import library code, never write JSON directly.

### Hardened `metaFetch` contract (PR 1, blocks everything else)

- **Retry**: on 429, 500, 502, 503, 504, and Meta `error.code` ∈ {1, 2, 4, 17, 32, 613}. Max 5 attempts.
- **Backoff**: exponential + jitter, base 1000ms, cap 30s. On 429, honor `X-Business-Use-Case-Usage` (`estimated_time_to_regain_access`) and `X-App-Usage`.
- **Idempotency**: `idempotency_key` (UUIDv4) on every create*. Pre-POST check `runs/by-idem/<key>.json`; cache success atomically.
- **Token expiry**: `OAuthException` code 190 → `TokenExpiredError`, no retry, prints regen URL.
- **Header-only auth**: `Authorization: Bearer <token>`. Asserts `access_token=` is never in any built URL.
- **Per-account in-process queue**: max 3 concurrent writes per `ad_account_id`. Reads unthrottled.
- **Chunked upload >50MB**: `uploadVideo` switches to `upload_phase=start|transfer|finish` against `graph-video.facebook.com`. 4MB chunks. Throws on chunk failure.
- **Dry-run gate**: `if (ctx.dryRun) { logDry(url, init); return synthesizeFakeResponse(url); }` — inside `metaFetch`, not at CLI boundary.
- **Async insights**: deferred to v1. v0 hard-caps `--since` at 7d sync.

### CLI surface — `dreamcontext marketing <cmd>` (alias: `mk`)

```
mk init                                        # bootstrap _dream_context/marketing/, prompt env
mk config check                                # ping Graph API, validate token
mk account list | use <slug>                   # profile selection (single-profile UX, plumbing ready)

# Daily-ops verbs
mk today                                       # active cohorts, today's spend by campaign, deltas vs yesterday
mk diff --since 24h                            # diff insights snapshots
mk pause <id> | resume <id>                    # status flip
mk scale --campaign <id> --pct +20             # adjust daily_budget_usd; agent asks user to confirm $
mk kill --bottom <N> --by <metric>             # ranks active campaigns, pauses worst N

# Cohort lifecycle
mk cohort create <name> --hypothesis-file <path>   # rejects until shape-valid
mk cohort list
mk strategy write --cohort <id>                # invoked by Strategy Optimizer
mk campaign create --cohort <id> --objective <obj> --daily-budget <usd> [--no-dry-run]
mk adset create --campaign <id> --daily-budget <usd> --targeting <file> [--no-dry-run]
mk creative create --brief <id> --type video|image [--no-dry-run]
mk asset upload <path>                         # chunked >50MB; returns image_hash | video_id
mk ad create --adset <id> --creative <id> [--no-dry-run]
mk launch <cohort_id> --confirm <cohort_id> [--no-dry-run]
mk launch resume <run_id>

# Insights
mk insights pull [--since 24h]                 # 15-min TTL cache; sync only in v0
mk insights show --campaign <id>

# Competitors (Reinfluence)
mk competitor ingest <url-or-handle>
mk competitor list

# Learnings
mk learnings show [--date <YYYY-MM-DD>]
mk learnings append --section <id> --entry <text>   # Performance Monitor only

# Strategy debate
mk council "<topic>"                           # wraps dreamcontext council create with marketing personas

# Diagnostics
mk doctor                                      # secret-scan _dream_context/, FK integrity, env, Reinfluence health
```

### Env (`_dream_context/marketing/.env`, gitignored)

```
META_SYSTEM_USER_TOKEN=
META_AD_ACCOUNT_ID=
META_PAGE_ID=
META_PIXEL_ID=
META_IG_ACTOR_ID=          # optional
META_WHATSAPP_ID=          # optional
GOOGLE_API_KEY=            # optional — vision pass
OPENAI_VISION_API_KEY=     # optional — vision pass
OPENAI_IMAGE_API_KEY=      # optional — v1 CreativeDirector
REINFLUENCE_BIN=           # optional override
```

Loader rules (no `dotenv` dep): strip BOM; support `\r\n` and `\n`; `#` comment outside quotes; `KEY=value` trimmed unless quoted; double-quote allows `\n \t \\ \"` escapes, single-quote literal; multiline only inside double quotes; `=` inside quoted value is literal; `process.env` overrides file (CI safety); reject keys not matching `[A-Z_][A-Z0-9_]*`; no env-of-env.

`requireEnv(['META_SYSTEM_USER_TOKEN', 'META_AD_ACCOUNT_ID'])` blocks any command that needs Meta. On missing, prints setup walkthrough, exits non-zero. SKILL.md instructs main agent: *"if `mk config check` fails, ask user for missing values and write to `_dream_context/marketing/.env`."*

`.gitignore` additions:
```
_dream_context/**/.env
_dream_context/marketing/**/_assets/
_dream_context/marketing/**/_media/
_dream_context/marketing/.lock
```

Pre-commit hook `dist/hooks/marketing-binary-guard.sh` rejects staged paths under `_assets/` or `_media/`. Installed via `dreamcontext install-hooks`.

### JSON store concurrency

- Atomic-rename writes (`fs.writeFileSync(path.tmp.<pid>.<rand>)` → `fs.renameSync`).
- Multi-file mutations use WAL: append planned ops to `runs/<ts>__<verb>.json` first, execute second. Crash → replay last incomplete run.
- PID lockfile at `marketing/.lock`. Stale lock (PID dead) auto-cleared.
- `.md` bridge written in same atomic sequence as JSON; if `.md` fails, JSON tmp unlinked.

### Hooks integration

- **SessionStart** (`src/hooks/session-start.ts`): adds `## Marketing` snapshot — active cohorts (slug + status), last `insights pull` ts, count of pending Performance Monitor recs.
- **UserPromptSubmit** (`src/hooks/user-prompt-submit.ts`): if unconfirmed Performance Monitor recs > 24h old, prepend a one-line nudge.
- **rem-sleep agent** (modify `dist/agents/dreamcontext-rem-sleep.md`): prune `runs/` >30d keeping last 100, compact `insights/` snapshots into per-campaign daily/weekly rollups, run `redactSecrets` over transcripts before consolidation, merge `marketing-learnings/<date>.md` into current-quarter rollup, archive on cap.
- **PreToolUse**: if a tool call would touch `_dream_context/marketing/.env`, block and route via `mk init` instructions.

### Training plan (PR 0.5) — distilling skills + agents from ingested videos

**Inputs:** a user-curated list of YouTube + Instagram URLs (the "training corpus"). Stored loosely in chat; you may also write the canonical list to `_dream_context/marketing/training-corpus.md` with frontmatter `id: training_corpus_v0`, ingest timestamps, and per-URL ingestion status.

**Pipeline:**
1. **Ingest** — run `dreamcontext mk competitor ingest <url>` for every URL (sequentially; concurrent cap = 1; 600s wall-clock kill per URL). Each produces:
   - `competitors/<handle>/posts/<shortcode>.json` (canonical: transcript text + segments + frames + duration + caption + URL).
   - `competitors/<handle>/posts/<shortcode>.md` (Obsidian-friendly bridge with transcript snippet).
   - `competitors/<handle>/_media/<shortcode>/{video.*, frames/}` (binaries, gitignored).
2. **Read corpus** — load every `posts/*.json`. Build an in-memory list of {handle, shortcode, url, transcript, hook_frames, regular_frames, caption, duration}.
3. **Distill** — extract patterns. Each pattern is a small structured record:
   ```yaml
   pattern_id: hook_open_with_question
   kind: hook | copy | funnel | visual | anti
   evidence:
     - { handle, shortcode, quote_or_frame, timestamp? }
   summary: "single-sentence rule"
   when_to_use: "..."
   when_not_to_use: "..."
   ```
   At least 3 evidence rows per pattern before it earns a slot in a playbook (fewer = "watch list", not a rule).
4. **Generate**:
   - `skill-packs/meta-marketing/SKILL.md` — front-matter (`alwaysApply: true`, triggers including "ads", "campaign", "creative", "cohort"), one-line skill summary, hard rules (CLI-first, ask-for-budget, dry-run default), playbook references.
   - `skill-packs/meta-marketing/playbooks/hooks.md` — hook patterns with verbatim quotes and frame_path links.
   - `playbooks/copy-formulas.md`, `playbooks/funnel-structures.md`, `playbooks/visual-patterns.md`, `playbooks/anti-patterns.md`.
   - `skill-packs/agents/marketing-strategy-optimizer.md` — frontmatter (`name`, `description`, `model: opus`, `tools: Bash, Read, WebFetch`), system prompt that:
     - Loads the playbooks at the start of every dispatch.
     - Refuses to write strategy until hypothesis shape passes.
     - Always emits `daily_budget_usd: null` + `ASK_USER_FOR_BUDGET`.
     - Cites `<handle>__<shortcode>` when recommending a pattern.
   - `skill-packs/agents/marketing-performance-monitor.md` — frontmatter + system prompt for win/loss + ledger writes.
5. **Review** — show the user a diff/preview of every generated file; accept corrections; iterate.
6. **Install** — `dreamcontext install-skill meta-marketing` copies the pack into `.claude/`.

**Distillation hard rules:**
- Every pattern cites ≥1 source post (`<handle>__<shortcode>`); aim for 3+.
- Quote transcript verbatim for hook examples; do not paraphrase the first 5 words of a successful hook.
- Visual patterns reference `_media/<shortcode>/frames/frame_<ts>s.png`; do not invent frame content.
- If the corpus is too thin for a category, say so explicitly in the playbook ("insufficient evidence — collect more samples"); never pad with generic advice.
- User corrections take precedence over corpus signal.

**Failure modes to flag, not paper over:**
- Ingest fails (private profile, dead URL, Whisper OOM): record in `runs/` and skip; do not fabricate a transcript.
- Single language assumption: Whisper auto-detects; if the corpus is multi-lingual, note in the playbook header which patterns are language-specific.
- Vision pass skipped (no API key): visual patterns rely solely on user description + filename; flag this as a corpus weakness in the playbook.

### Reinfluence pipeline (v0)

1. `mk competitor ingest <url-or-handle>` resolves to single-post or full-handle scrape.
2. `competitors.ts:health()` runs first: binary resolves, `--version` exits 0 in 5s, Whisper model present, yt-dlp ok, free disk >2GB. Cached 60s.
3. Subprocess spawns Reinfluence (`pipx`-installed `reinfluence` CLI; falls back to `python -m reinfluence` then `$REINFLUENCE_BIN`). Stdout/stderr stream into `runs/<ts>__competitor-ingest.json`.
4. Wall-clock kill at 600s. Cap concurrent ingests at 1.
5. Outputs normalized into `_dream_context/marketing/competitors/<handle>/posts/<shortcode>.{json,md}`. Binaries land in `_media/` (gitignored).
6. **Vision pass** (optional): if `OPENAI_VISION_API_KEY` or `GOOGLE_API_KEY` set, hook frames tagged with pattern labels (face-zoom, text-only, prop-driven, etc.) stored on the post JSON.

If Reinfluence missing: one-screen install hint (`pipx install reinfluence-ai` or local path), exit non-zero.

### Council integration

`mk council "<topic>"` is a thin wrapper in marketing CLI that calls `dreamcontext council create "<topic>"` and seeds 4 marketing personas (growth-engineer, brand-voice-lead, customer-advocate, performance-skeptic). Personas live as **data files** at `skill-packs/meta-marketing/council-personas/*.md`, piped to `dreamcontext council agent create` via `--body`. Council code stays domain-agnostic.

### Dashboard — v0 minimal

**Tabs (3):**
1. **Overview** — active cohorts (cards), today's spend per campaign (sparkline-style hand-rolled SVG, like SleepPage), top/bottom performers, "last synced" badge that turns amber >24h with a clipboard "Discuss in chat" CTA.
2. **Performance** — single time-series chart per metric (CPM, CTR, ROAS, frequency) using **uPlot** (~40KB, no deps; recharts rejected by council). Filterable by campaign.
3. **Creatives** — gallery grid with thumbnails (read-only). Click → side panel with metrics + "Discuss in chat" copies a `mk discuss <id>` prompt to clipboard.

Learnings rendered inside existing **KnowledgePage** (no standalone tab in v0). Competitors fold into Creatives as a "Sources" segmented control.

**Brain graph (filterable layer, default OFF):** `src/server/routes/graph.ts` emits 4 new node types: `cohort` (#ff6b6b), `campaign` (#fbbf24), `creative` (#22d3ee), `competitor` (#94a3b8). Edges from FK relations. Toggle in `BrainSettings`; default off so daily-non-marketing usage isn't cluttered.

**Asset static-serving lockdown:** extension allowlist (`.jpg .jpeg .png .webp .mp4`); resolve + prefix-check + realpath-symlink check against `creatives/_assets/`; filename whitelist tied to `creatives/*.json` records; localhost-bind only; no directory listing; competitor `_media/` not exposed in v0.

**Server routes (`src/server/routes/marketing.ts`, all read-only):**
```
GET /api/marketing/overview
GET /api/marketing/cohorts | /:id
GET /api/marketing/campaigns?cohort=<id> | /:id
GET /api/marketing/creatives?cohort=<id> | /:id
GET /api/marketing/insights?campaign=<id>
GET /api/marketing/competitors | /:handle
GET /api/marketing/assets/:filename     # locked-down static
```

TanStack Query: `staleTime: 60_000`, refetch on window focus. SSE for run-log → deferred v1.

**v0 dashboard cuts (defer v1):** cohort drawer polish, Competitors tab, SSE live updates, mobile responsive, standalone Learnings route, multi-series perf charts.

### v0 implementation order — REVISED 2026-04-25 (transcription-first; 9 PRs)

**PR 0 — Transcription / competitors slice (SHIPPED 2026-04-25).**
- ✅ `tools/reinfluence/` — slim Python ingester bundled in npm package (download → transcribe → frames; emits NDJSON; no SQLite).
- ✅ `src/lib/marketing/{paths,env-loader,secrets,config,store,bootstrap,competitors}.ts`.
- ✅ `mk init` (folders + .env template + venv + pip + Whisper prime) and `mk competitor {ingest,list,health}`.
- ✅ Strict containment — everything under `_dream_context/marketing/`. Caches pinned via env vars.
- ✅ `.gitignore` for `.env`, `.tools/`, `.venv/`, `.cache/`, `_assets/`, `_media/`, `.lock`.
- ✅ 28 new unit tests (env loader, secrets corpus, store atomicity + lock + WAL + redaction, paths). 529/529 suite passing.
- ✅ `mk` alias registered. `dreamcontext mk competitor health` smoke-tested.

**PR 0.5 — Agent-training from ingested videos (NEXT — see "Training plan" below).**
- User provides a curated list of YouTube + Instagram URLs (proven competitor / mentor content).
- Run `mk competitor ingest` against each → produces transcripts + frames + post JSON under `_dream_context/marketing/competitors/`.
- A *training-distill* pass synthesizes patterns from those posts into:
  - **Skill files** at `skill-packs/meta-marketing/SKILL.md` and `skill-packs/meta-marketing/playbooks/*.md` (hooks, copy patterns, funnel structures, anti-patterns).
  - **Agent system prompts** at `skill-packs/agents/marketing-strategy-optimizer.md` and `marketing-performance-monitor.md` — grounded in the user's actual training corpus, not generic advice.
- Output is reviewed by the user; corrections fold back into the corpus.

**PR 1 — Meta foundation (`metaFetch` + typed client) — SHIPPED 2026-04-25 (commit 17c279a).**
- ✅ `meta-fetch.ts` (525 lines): retry on 429/5xx + Meta codes {1,2,4,17,32,613} max 5; expo backoff + jitter cap 30s honoring X-Business-Use-Case-Usage; idempotency UUIDv4 cache at runs/by-idem/; OAuth 190 → TokenExpiredError no-retry; header-only auth + HeaderAuthAssertionError; per-account write queue cap=3; chunked >50MB via graph-video host (start|transfer|finish, 4MB chunks); ctx.dryRun gate inside the wrapper.
- ✅ `meta-client.ts` typed surface (mirrors Tilki's signatures, ctx-first, routes through metaFetch): listAdAccounts, getAdAccount, createCampaign/updateCampaign/getCampaign, createAdSet/updateAdSet, createVideoCreative/createImageCreative, createAd/updateAd, pauseEntity/resumeEntity, uploadVideo/uploadImage, getInsights.
- ✅ DEFAULT_API_VERSION bumped v21.0 → v25.0 (latest as of 2026-04, released 2026-02-18; v20.0 expires 2026-09-24).
- ✅ 21 unit tests against fake Graph mock; 550/550 suite passing at PR 1 commit.
- ✅ Three-layer API fallback shipped alongside: `skill-packs/meta-marketing/api-reference.md` (470 lines, 10 raw recipes); `SKILL.md` §X "Beyond the Typed Client"; agent files updated; self-extending promotion rule (3 uses → propose typed wrapper).

**PR 2 — CLI surface (read + safety verbs) — SHIPPED 2026-04-25 (commit 69aadc5).**
- ✅ `src/lib/marketing/{hypothesis,budget,insights-cache,cohort}.ts` (4 new lib modules).
- ✅ 13 mk subcommands: `init`, `competitor {ingest,list,health}` (PR 0), `config check`, `account {list,use}`, `cohort {create,list,show}`, `insights {pull,show}`, `today`, `diff`, `pause`, `resume`, `scale`, `kill`, `doctor`.
- ✅ All mutations dry-run default; `--no-dry-run` wired; CLI is the only flip path.
- ✅ Every mutation acquires marketing lock + writes runs/ WAL entry.
- ✅ `mk insights pull` hard-caps `--since` at `last_7d` for v0 (>7d deferred to v1 async).
- ✅ `mk cohort create` rejects shape-invalid hypothesis (predicted_winner / predicted_metric / decision_threshold / kill_condition all required).
- ✅ `mk doctor` checks env + FK integrity + Reinfluence health; opt-in `--scan` for retroactive secret sweep.
- ✅ 32 unit tests; 582/582 suite passing.
- [ ] Tab-completion script (deferred — single-file follow-up).

**PR 3 — `launch` with full guardrails — SHIPPED 2026-04-25 (commit 323aa38).**
- ✅ `mk launch <cohort_id> --confirm <cohort_id>` — `--confirm` matches verbatim, no `-y`/`--yes` shortcut.
- ✅ 6-line human summary printed BEFORE WAL creation (cohort name, # campaigns, # adsets, # ads, total daily budget, objective).
- ✅ Pre-flip WAL at `runs/<ts>__launch-<cohort_id>.json` with all planned ops; flips one entity at a time.
- ✅ `mk launch resume <run_id>` replays from WAL; rejects ctx mismatch (live ↔ dry-run).
- ✅ No silent retries on launch flips — `pauseEntity`/`resumeEntity` accept `{ noRetry: true }` to bypass metaFetch retry loop; first error halts and preserves WAL.
- ✅ 6 mutation CLI verbs: `mk campaign create/list`, `mk adset create/list` (REQUIRES `--daily-budget`), `mk creative create-image/create-video/list`, `mk asset upload <path>` (auto-detects video/image), `mk ad create/list`.
- ✅ `src/lib/marketing/{entity-store,launch}.ts` — generic entity store + launch flow library.
- ✅ 17 unit tests (`marketing-entity-store`, `marketing-launch`); 614/614 suite passing.
- [ ] Diff-vs-current preview: deferred — the 6-line summary is the v0 substitute. Full diff hits Meta GETs at scale and is v1 polish.
- [ ] End-to-end manual test against Tilki sandbox: deferred — requires a sandbox ad account. Should run before any v0 production launch.

**PR 4 — `.md` bridge layer + hooks.**
- Bridge file generation atomic with JSON.
- SessionStart `## Marketing` snapshot; UserPromptSubmit nudge.
- rem-sleep marketing rules.
- Per-day `marketing-learnings/<date>.md` plumbing.

**PR 5 — Reinfluence integration.** *(Largely subsumed by PR 0; remaining work: vision pass + index/list polish.)*
- ✅ `competitors.ts` health-probe + subprocess + 600s timeout + concurrent cap (in PR 0).
- ✅ `mk competitor ingest` end-to-end (in PR 0).
- [ ] Optional vision pass behind env-key flag (`OPENAI_VISION_API_KEY` / `GOOGLE_API_KEY`) — tags hook frames with pattern labels (face-zoom, text-only, prop-driven, etc.). Stored on post JSON.

**PR 6 — Sub-agents (Strategy Optimizer + Performance Monitor) — SHIPPED EARLY 2026-04-25 (commit 85b4a4d).**
- ✅ `skill-packs/agents/marketing-strategy.md`: refuses to plan until hypothesis shape valid; budget always null + ASK_USER_FOR_BUDGET; CAPI gate; objective gate; snow-globe rule; omnipresent-content pre-scale gate; 9-section output contract with mandatory corpus citations.
- ✅ `skill-packs/agents/marketing-monitor.md`: reads insights, applies §4 post-launch rules, writes evergreen ledger entries via mk learnings append; no auto-mutation; kill-by-spend not by-ROAS; mandatory anti-pattern check on every recommendation block.
- ✅ `skill-packs/agents/marketing-creative.md`: flag-gated stub, refuses cleanly until `marketing.creative_director.enabled = true`.
- ✅ All three reference `skill-packs/meta-marketing/*.md` as knowledge base — no inline duplication. CLI-first; library imports forbidden.
- ✅ Registered in `skill-packs/catalog.json` under `agents[]` with `pack: "meta-marketing"`.
- Note: PR 6 was numbered after PR 5 in the original sequence but the corpus was ready, so it shipped early to unblock the agent-grounded test loop.

**PR 7 — Dashboard v0.**
- 3 tabs (Overview, Performance with uPlot, Creatives with clipboard "Discuss in chat").
- Locked-down asset serving.
- `last_synced_at` freshness badge.
- Empty states for every tab.
- Brain graph layer (default-off toggle).
- Sidebar nav entry.
- Learnings deep-link into existing KnowledgePage.

**PR 8 — Pre-commit hook + `mk doctor` retroactive secret scan + `mk council` wrapper.**
- `dist/hooks/marketing-binary-guard.sh` blocks `_assets/`/`_media/` paths.
- `mk doctor` scans existing `_dream_context/` for accidental token strings.
- `mk council "<topic>"` wraps `dreamcontext council create` with marketing personas.

### Files to create / modify

#### Created (new)
- `skill-packs/meta-marketing/SKILL.md` — triggers, flow, hard rules
- `skill-packs/meta-marketing/council-personas/{growth-engineer,brand-voice-lead,customer-advocate,performance-skeptic}.md` — data, not code
- `skill-packs/agents/marketing-strategy-optimizer.md`
- `skill-packs/agents/marketing-performance-monitor.md`
- `skill-packs/agents/marketing-creative-director.md` (stub, flag-gated)
- `src/cli/commands/marketing.ts` (top-level register)
- `src/cli/commands/marketing/{init,config,account,cohort,strategy,campaign,adset,creative,asset,ad,launch,insights,competitor,learnings,council,doctor,today,diff,pause,resume,scale,kill}.ts`
- `src/lib/marketing/meta-fetch.ts`
- `src/lib/marketing/meta-client.ts`
- `src/lib/marketing/store.ts`
- `src/lib/marketing/config.ts` (incl. `redactSecrets`)
- `src/lib/marketing/learnings.ts`
- `src/lib/marketing/competitors.ts`
- `src/lib/marketing/budget.ts`
- `src/lib/marketing/hypothesis.ts`
- `src/server/routes/marketing.ts`
- `dist/hooks/marketing-binary-guard.sh`
- `dashboard/src/pages/MarketingPage.tsx`
- `dashboard/src/hooks/useMarketing.ts`
- `dashboard/src/components/marketing/{OverviewTab,PerformanceChart,CreativesGrid,DiscussInChatButton,FreshnessBadge}.tsx`
- `dashboard/src/lib/uplot-loader.ts`

#### Modified
- `src/cli/index.ts` — register marketing command
- `src/server/index.ts` — mount marketing routes
- `src/server/routes/graph.ts` — emit cohort/campaign/creative/competitor nodes + edges
- `src/hooks/session-start.ts` — `## Marketing` snapshot section
- `src/hooks/user-prompt-submit.ts` — unconfirmed-recs nudge
- `dist/agents/dreamcontext-rem-sleep.md` — marketing-aware rules (prune runs, compact insights, redact secrets, merge per-day learnings)
- `dashboard/src/App.tsx` — add `'marketing'` page
- `dashboard/src/components/layout/Shell.tsx` — sidebar entry
- `dashboard/src/pages/BrainPage.tsx` — color palette + filter toggle
- `dashboard/src/pages/KnowledgePage.tsx` — render `marketing-learnings/`
- `dashboard/package.json` — add `uplot`
- `.gitignore` — `_dream_context/**/.env`, `_assets/`, `_media/`, `marketing/.lock`
- `_dream_context/.obsidian/graph.json` — color groups for marketing types
- `DEEP-DIVE.md` — one paragraph: "when a skill earns a top-level folder"

#### Reused (no change)
- `skill-packs/council/SKILL.md` — `mk council` calls it as-is
- `skill-packs/agents/council-persona.md`, `council-synthesizer.md`

### Verification plan (smoke per PR)

1. **PR 1** — unit tests for `metaFetch` (retry on 429 + backoff timing, idempotency cache hit, token-expiry no-retry, chunked upload threshold, ctx dry-run gate enforced even when CLI flag bypassed in test). `redactSecrets` test corpus passes.
2. **PR 2** — `mk init` from fresh `_dream_context/`. `mk config check` hits real Graph `/me/adaccounts`. `mk doctor` clean.
3. **PR 3** — dry-run campaign create matches Tilki known-good payload. Real campaign returns ID, JSON+MD bridge written, status PAUSED in Ads Manager. `mk launch` aborts without `--confirm`. With `--confirm`, prints 6-line summary, asks for budget, flips one entity at a time. Kill mid-flip → `mk launch resume` continues from WAL.
4. **PR 4** — open Claude Code → SessionStart shows `## Marketing` section. After 24h pending rec, UserPromptSubmit nudges. `dreamcontext sleep done` prunes runs/, compacts insights/, merges per-day learnings.
5. **PR 5** — `mk competitor ingest <youtube-url>` end-to-end: health-probe passes, Whisper transcribes, frames extract, JSON+MD bridge written, vision pass tags hooks if API key present. Missing Reinfluence binary → one-screen install hint.
6. **PR 6** — ask agent "let's plan a Q2 cohort" → SKILL.md auto-loads → Strategy Optimizer dispatches → refuses until hypothesis shape-valid → emits `daily_budget_usd: null` → main agent asks user for budget. Performance Monitor (after 24h insights) appends hypothesis-ledger entry to today's `marketing-learnings/<date>.md`.
7. **PR 7** — `npm run dev` in `dashboard/` → `/marketing` renders 3 tabs. Empty states show on first run. Asset gallery loads thumbnails. "Discuss in chat" copies prompt. Brain layer toggles correctly. uPlot chart renders insights cleanly.
8. **PR 8** — pre-commit hook blocks staging `_assets/*.mp4`. `mk doctor` scans `_dream_context/` and reports any leaked secrets. `mk council "should we scale Cohort 4?"` runs full council flow with marketing personas, promotes decision into open-questions.

**Done overall** = real Tilki campaign launches via the agent end-to-end with user typing budget for every step; Reinfluence ingests a competitor IG handle and Strategy Optimizer cites a pattern from it; Performance Monitor closes a hypothesis ledger entry; dashboard reflects state without manual refresh; `mk doctor` returns clean.

## Notes

### Open questions (non-blocking, address during implementation)
- **Idempotency cache pruning** — currently no policy. Likely belongs in rem-sleep alongside runs/ pruning. Decide during PR 4.
- **Dashboard hosting** — assumed localhost-only in v0. If ever served bundled-prod over a non-localhost interface, asset rules need auth, not just bind-host. Document in PR 7.
- **Token rotation** — System User tokens are long-lived but revocable. v0 ships manual `.env` edit; `mk config rotate-token` is v1.
- **Hypothesis ledger archival cadence** — quarterly assumed, but if cohort velocity is high we may need monthly. Revisit after 6 months of real use.
- **Multi-account UX** — config shape ships day 1 with single-profile UX. Full multi-account UX (`mk account add/use/list` interactive flow, active-account printed bold-red on every command) is v1 and triggered by adding a 2nd profile.

### Known gotchas (from Tilki + council debate)
- All Meta entities are created with `status: PAUSED`. Only `mk launch` flips to ACTIVE.
- Tilki's `meta-client.ts` uses URL-based `access_token=` — explicitly forbidden in our port; header-only.
- Tilki's video upload silently fails ~100MB — chunked path mandatory >50MB.
- Domain verification required for custom audiences/retargeting (per Tilki's `META_BUSINESS_SETUP.md`). Document in `mk doctor` output.
- Pixel events must flow ~1 week before custom audiences can form.
- GDPR consent banner required client-side (out of scope for this skill but flag in SKILL.md).

### References
- Council debate: `_dream_context/council/council_7_ForDfS/final-report.md`
- Source meta-client: `/Users/mehmetnuraydin/projects/Tilki Ogretmen/scripts/ads/meta-client.ts`
- Source Reinfluence: `/Users/mehmetnuraydin/projects/Reinfluence Ai/src/reinfluence/{cli.py, processing/transcriber.py, processing/downloader.py, processing/frame_extractor.py}`
- Plan file (predecessor; superseded by this task): `/Users/mehmetnuraydin/.claude/plans/like-council-now-we-serialized-petal.md`

## Changelog
<!-- LIFO: newest entry at top -->


### 2026-04-25T19:45Z — PR 3 shipped (launch + mutation verbs)
Commit `323aa38` — 13 files, 1788 insertions.
- 2 new lib modules: `entity-store.ts` (generic store for campaign/adset/ad/creative; local id decoupled from Meta `fb_id`; atomic JSON+MD bridge writes; `gatherEntitiesByCohort` for launch tree); `launch.ts` (`buildLaunchSummary` 6-line, `createLaunchWal` pre-flip, `executeFlips` with `noRetry: true` on the actual flip step so metaFetch retry loop is bypassed; `findWalByRunId`/`readWal`/`writeWal` for resume).
- `meta-client.ts` patched: `pauseEntity`/`resumeEntity` accept `{ noRetry?: boolean }` 3rd arg.
- `paths.ts` patched: added `MARKETING_PATHS.adsDir()`.
- 6 mutation CLI verbs: `mk campaign create/list`, `mk adset create/list` (REQUIRES `--daily-budget` per task line 227), `mk creative create-image/create-video/list`, `mk asset upload <path>` (auto-detects video/image; chunked >50MB via `uploadVideoFile`), `mk ad create/list`.
- `mk launch <cohort_id> --confirm <cohort_id>` + `mk launch resume <run_id>`.
- 17 unit tests verify: 6-line summary shape, missing cohort/campaigns/ads errors, plan ordering (campaign→adset→ad), WAL round-trip, dry-run flip-all + cohort flip to launched, ctx mismatch rejection, NO SILENT RETRIES on first error halt + WAL state preservation, refusal of live launch when fb_id empty, resume-from-partial.
- Test count: 582 → 614 (+32 net for PR 3).
- mk CLI now exposes 19 subcommands (was 13 after PR 2).
- Sleep debt reached 6 mid-session, partially consolidated; ended at 4. PR 4 (`.md` bridges + hooks) is next.

### 2026-04-25 — PR 0.5 + PR 1 + PR 2 + PR 6 shipped (single session)
Four commits in sequence:
- `5ec28f4` — PR 0 + PR 0.5 combined commit: bundled ingester (`tools/reinfluence/`), 9-video corpus + per-source learnings, `skill-packs/meta-marketing/` (SKILL.md + 5 reference files), all 8 user decisions resolved, council_7_ForDfS materialized.
- `85b4a4d` — PR 6 agent roster (early): 3 agent files (`marketing-strategy.md`, `marketing-monitor.md`, `marketing-creative.md` stubbed), all referencing skill-pack as knowledge base, registered in catalog.json under agents[].
- `17c279a` — PR 1 Graph API foundation: `meta-fetch.ts` (525 lines, full retry/backoff/idempotency/dry-run/chunked-upload contract); `meta-client.ts` (270 lines, ctx-first typed surface); DEFAULT_API_VERSION → v25.0; 21 unit tests. Plus three-layer API fallback: `api-reference.md` (470 lines, 10 raw recipes), `SKILL.md` §X "Beyond the Typed Client", agent knowledge tables updated.
- `69aadc5` — PR 2 CLI surface: 4 lib modules (hypothesis / budget / insights-cache / cohort), 13 mk subcommands wired (config check, account list/use, cohort create/list/show, insights pull/show, today, diff, pause, resume, scale, kill, doctor), 32 unit tests. All mutations dry-run by default; `--no-dry-run` is the only flip path; every mutation acquires lock + writes WAL.

Test count: 529 → 582 (+53). Sleep debt reached 6 by end of session. PR 3 (`mk launch` with full guardrails + mutation verbs) is next; recommend consolidating sleep before starting it because real money flows through that PR.

### 2026-04-25 - Session Update
- PR 0.5 in progress (sessions 65bd7bd5, 730cea90, fa1ee58f): 9 YouTube videos ingested. Per-source learnings written for all 9. Ingester patched to use youtube-transcript-api (no PO-token gate, no Whisper for YT). paid-ad-account-ops lane has 4 distinct speakers (Ben Heath, Charlie/Disruptor, Moonlighters, Optimizer) — eligible for playbook lift. Two delta signals extracted from video 9 (kuSq-pmNfnM): hook-swap variation strategy (3-second hook swap yields 10 variants from 1 base video) and turn-off-by-spend rule (turn off ads Meta stops spending on, NOT low-ROAS ads). State file resume block refreshed. 8 open user decisions still pending. Skill-pack files NOT yet generated — blocked on lane-consolidation decision (#1).
### 2026-04-25 — PR 0 shipped + plan revised for transcription-first
- Inverted PR order: competitor ingestion now ships before Meta CRUD because the agents are themselves trained on the ingested content.
- Strict containment decision recorded: every artifact lives under `_dream_context/marketing/`; no global pip / pipx / `~/.dreamcontext/` paths. System deps (`python3`, `ffmpeg`/`ffprobe`) cannot be bundled and are enforced by the health probe.
- PR 0 implemented end-to-end: `tools/reinfluence/` (slim NDJSON ingester), `src/lib/marketing/{paths,env-loader,secrets,config,store,bootstrap,competitors}.ts`, `mk init` + `mk competitor {ingest,list,health}` CLI, atomic JSON+MD bridge writes, PID lockfile, runs/ WAL, redactSecrets corpus.
- 28 new unit tests added; full suite 529/529 passing.
- Added "Resume here" entry-point block at the top of this task — refreshed sessions read it first.
- Defined PR 0.5 (training-from-corpus): the next step is for the user to provide YT+IG URLs, run `mk competitor ingest` against each, and distill the corpus into `skill-packs/meta-marketing/SKILL.md` + `playbooks/*.md` + agent system prompts. Distillation hard rules and pipeline documented in the new "Training plan" section.

### 2026-04-25 - Single-source-of-truth task created
- Folded final post-council plan into this task as the canonical implementation source.
- Council debate `council_7_ForDfS` synthesized 5 personas (growth-operator, dreamcontext-architect, staff-ts-engineer, dashboard-lead, risk-skeptic) into 10 MUST-CHANGEs and an 8-PR foundation-first sequence.
- User confirmed: profile-shape day 1 / Reinfluence in v0 / agent always asks for budget / 2 sub-agents in v0.
- Task created.
