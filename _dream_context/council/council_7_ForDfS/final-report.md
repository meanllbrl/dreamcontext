---
council: council_7_ForDfS
topic: meta-marketing skill plan
status: synthesized
created_at: '2026-04-25'
---

# Final Report — Meta-Marketing Skill Plan

## 1. Decision

**Adopt with material changes — do not commit as-is, do not reject.** The plan's
spine (cohort → campaign → adset → creative → ad, JSON-first state, dry-run
default, PAUSED-on-create, CLI-first sub-agents, install-skill distribution,
read-only dashboard) is correct and all five personas back it. But as written it
ships a *modeling exercise*, not a daily ops tool, and inherits a fragile Tilki
client. **Bar for approval:** every MUST-CHANGE below merged into the plan,
v0/v1 split codified, and the four open user questions answered.

## 2. Convergence — what all 5 personas agreed on

- **Adopt the folder layout, JSON-first state, sub-agent split shape, dry-run
  default, and PAUSED-on-create** — backed by all 5 (growth-operator,
  architect, staff-ts, dashboard-lead, risk-skeptic).
- **Five sub-agents on day one is too many.** Ship 2-3, defer the rest.
  (growth-operator, risk-skeptic, staff-ts implicit; architect tolerant;
  dashboard-lead neutral.)
- **`--preset marketing` on the council command is wrong.** Council must stay
  domain-agnostic. (architect: explicit; risk-skeptic: explicit; growth-operator:
  "premature"; staff-ts and dashboard-lead: did not defend it.)
- **Real-spend guardrails as written are insufficient.** Need typed-confirm,
  hard daily cap, diff-vs-current. (growth-operator change #3; risk-skeptic risk
  #2; staff-ts §8 launch idempotency.)
- **Recharts is the wrong dep.** (dashboard-lead: uPlot; growth-operator:
  hand-rolled SVG; architect: defer entirely; risk-skeptic: scope creep.)
- **Plan is silent on hooks, multi-account, and rate-limits/retries — all
  load-bearing.** (architect on hooks; growth-operator + risk-skeptic on
  multi-account; staff-ts on rate-limits/retries.)

## 3. Disagreements / trade-offs

- **Multi-account in v0?** growth-operator wants it first-class day one;
  risk-skeptic wants the *config shape* now but single-profile UX; staff-ts
  flags it as a v1 deferral; architect/dashboard-lead neutral.
  **Resolution:** ship risk-skeptic's compromise — `config.json` as
  `{default_profile, profiles: {<slug>: {...}}}` on day 1, single-profile UX,
  `--profile/--account` flag wired but optional. Adding agency UX later is
  trivial; migrating committed JSON is not. Growth-operator's safety concerns
  are addressed by the typed-confirm + active-account-printed-bold-red rule
  (MUST-CHANGE 3), not by full multi-account UX.
- **Brain graph nodes for marketing.** architect wants `.md` bridge files +
  graph anchors; dashboard-lead wants a filterable layer default-OFF;
  growth-operator wants it deferred.
  **Resolution:** ship the `.md` bridge files (architect's Rule 7 win,
  non-negotiable for vault parity) but render them as a Brain layer that is
  default-off (dashboard-lead). Growth-operator's "useless at 500 cohorts" is
  satisfied by the toggle.
- **`marketing-learnings.md` cap & race.** architect wants rem-sleep extraction
  past 300 lines; risk-skeptic wants per-day files merged nightly.
  **Resolution:** combine — write to `marketing-learnings/<YYYY-MM-DD>.md`
  daily, rem-sleep merges into a current-quarter rollup and archives older
  quarters into `knowledge/marketing-archive-<YYYY-Q>.md`. No flock needed; cap
  enforced.
- **Reinfluence in v0.** growth-operator: defer to v0.2; staff-ts: requires
  health-probe before any ingest if shipped; architect: open-question whether
  it's even part of marketing skill.
  **Resolution:** competitor *data model* + `competitor add --notes` ships v0;
  Reinfluence subprocess + vision pass deferred to v1. Health-probe spec
  (staff-ts §4) blocks any future ingest path.

## 4. MUST-CHANGE before commit (ranked)

1. **Token-leakage closure** (risk-skeptic #1, #3). Implement
   `redactSecrets(str)` in `src/lib/marketing/config.ts`; wire into runs writer,
   meta-client logs, and a rem-sleep pre-pass. Header-only `Authorization:
   Bearer`; assert no `access_token=` ever appears in a built URL.
2. **Hardened meta-client** (staff-ts §1, §6, §7). `metaFetch()` with retry +
   exponential backoff + jitter, idempotency keys on every create*, token-expiry
   `OAuthException 190` non-retry, BUC/X-App-Usage header-driven backoff,
   chunked upload >50MB, per-account in-process queue. **Ctx-threaded dry-run
   default-true gate inside `metaFetch()`** — bypass-by-refactor impossible.
3. **Real-spend guard on `launch`** (risk-skeptic #2, growth-operator #3,
   staff-ts §8). Require `--confirm <cohort_id>` typed verbatim; hard
   `max_daily_spend_usd` cap from `config.json`; print 6-line human summary +
   diff + audience-size estimate before payload; pre-flip state recorded in
   `runs/<ts>__launch.json`; `marketing launch resume <run_id>` for crash
   recovery.
4. **Hypothesis shape-validation gate** (growth-operator #4). Reject free-string
   hypotheses; require predicted-winner, predicted-metric, decision-threshold,
   kill-condition. Strategy Optimizer refuses to write strategy JSON until
   shape passes.
5. **Vault parity — `.md` bridge files** (architect Rule 7). Every
   cohort/campaign/creative/competitor gets a sibling `.md` with frontmatter
   (id, type, fb_id, status, links). JSON canonical for state; `.md` is graph
   anchor. Auto-generated by store layer, atomic with JSON write. Single
   `runs/index.md` LIFO log, not per-run.
6. **Replace `--preset marketing` with marketing-owned wrapper** (architect,
   risk-skeptic). `dreamcontext marketing council "<topic>"` lives in marketing
   CLI; council reads any presets from `_dream_context/council/presets/*.json`
   shipped as data on install. Council code stays domain-agnostic.
7. **Hooks integration** (architect). SessionStart snapshot emits `## Marketing`
   section (active cohorts, last insights pull, pending recs); UserPromptSubmit
   nudges on unconfirmed kill/scale recs >24h; rem-sleep prunes `runs/` >30d
   keeping last 100, compacts `insights/` snapshots into per-campaign rollups.
8. **JSON store concurrency** (staff-ts §2). Atomic-rename writes, PID lockfile
   at `marketing/.lock`, write-ahead log via `runs/<ts>__<verb>.json`,
   crash-replay on incomplete runs.
9. **Daily-ops verbs** (growth-operator #2). Ship `pause`, `resume`, `scale
   --pct`, `kill --bottom N --by <metric>`, `today`, `diff --since 24h` in v0.
   Without these the tool is unused after day two.
10. **Profiles-shaped config + per-account budget cap** (risk-skeptic #4,
    growth-operator open Q2). `config.json` profiles shape day 1; hard
    `max_daily_spend_usd` per profile that the CLI refuses to exceed even with
    `--no-dry-run`.

## 5. SHOULD-CHANGE — strong recommendations

1. **`mk` alias** for `marketing` (growth-operator). Operators type it 200x/day.
2. **Tab-completion** on `--cohort`, `--campaign`, `--account` from JSON store
   (growth-operator). Human-readable local IDs (`tr-leads-q2-hookv3`)
   decoupled from `fb_id`.
3. **Pre-commit hook in `dist/hooks/`** rejecting any staged path under
   `_assets/` or `_media/` (risk-skeptic #7). `.gitignore` is not a security
   boundary.
4. **Per-day `marketing-learnings/<YYYY-MM-DD>.md`** rolled up nightly by
   rem-sleep (risk-skeptic #7 + architect cap rule).
5. **Insights cache 15-min TTL** shared across CLI/dashboard/agent
   (growth-operator #5). Hour-granularity snapshots so `diff --since 24h`
   actually works.
6. **Reinfluence health-probe** spec (staff-ts §4) gate any future ingest path
   even though Reinfluence itself is deferred.
7. **Asset static-serving lockdown** (dashboard-lead): extension allowlist,
   realpath symlink check, filename whitelist from `creatives/*.json`,
   localhost-bind only, no directory listing, competitor `_media/` not exposed.
8. **`dreamcontext doctor` retroactive secret scan** of existing knowledge
   files (risk-skeptic open Q).

## 6. DEFER to v1 (explicit cut from v0)

- CreativeGenerator agent (image/video gen) — research project.
- Brainstormer + CopyWriter as separate agents — merge into one
  `marketing-creative-director` for v0.
- Reinfluence subprocess + vision pass — competitor data model only in v0.
- `recharts` and the Performance multi-series chart suite — uPlot lands v0
  with a single time-series chart; richer charts v1.
- Cohort drawer polish, Competitors sub-tab UI, SSE live updates, mobile
  responsive (dashboard-lead).
- Async insights >7d, resumable upload >2GB, cross-process BUC queue, full
  multi-account UX, council `--preset` even as data file (staff-ts v1 list).
- Brain graph layer rendering (default OFF means it can ship as a stub in v0
  and gain polish in v1).
- Staged ramps (10% → 50% → 100%) — reserve data shape only.

## 7. v0 implementation order

1. **PR 1 — foundation, no agents.** `metaFetch()` (retry, backoff, idempotency,
   token-expiry, chunked upload, ctx-threaded dry-run gate); env loader (8
   rules, BOM, quoted, multiline); `redactSecrets`; `config.json` profiles
   shape with `max_daily_spend_usd`; `store.ts` atomic write + PID lock + WAL.
2. **PR 2 — CLI surface (read-only + safety verbs).** `marketing init`,
   `account use/list`, `cohort create` with hypothesis shape-validation,
   `today`, `diff`, `insights pull` (sync 24h), `pause`, `resume`, `scale
   --pct`, `kill --bottom N`. All mutations dry-run default. Tab-completion +
   `mk` alias.
3. **PR 3 — `launch` with full guardrails.** Typed-confirm, daily cap, diff,
   pre-flip state, `launch resume`. End-to-end e2e test against Tilki sandbox.
4. **PR 4 — `.md` bridge layer + hooks.** Atomic JSON+MD writes, SessionStart
   `## Marketing` snapshot, UserPromptSubmit nudge, rem-sleep prune/rollup
   rules, per-day learnings file.
5. **PR 5 — Strategy Optimizer + Performance Monitor agents only.** Distributed
   via install-skill. CLI-first; library imports forbidden. CreativeDirector
   merged-agent stub but feature-flagged off.
6. **PR 6 — Dashboard v0.** 3 tabs (Overview, Performance with uPlot, Creatives
   with clipboard "Discuss in chat"), hardened asset serving, freshness badge,
   empty states, Brain layer toggle default-off, sidebar entry. Learnings
   deep-links into existing KnowledgePage.
7. **PR 7 — pre-commit hook + `dreamcontext doctor` secret-scan extension.**
8. **PR 8 — `marketing council` wrapper** that calls `dreamcontext council
   create` underneath; presets shipped as data file.

## 8. Open questions for the user

- **Multi-account UX urgency:** are you running >1 ad account *now*, or only the
  Tilki account? Decides whether `--profile` ships v0 or stays a v1 flag with
  the config shape only. (growth-operator vs risk-skeptic split.)
- **Reinfluence in v0:** confirm we defer the subprocess + vision pass to v1
  and ship only `competitor add --notes` data model in v0?
- **`max_daily_spend_usd` per-profile default:** what number? And do you want
  `marketing budget set <cohort> <usd>` to be a *required* step before
  `launch` is even allowed (risk-skeptic open Q)?
- **Dry-run permanence:** stay default-on forever, or flip after a stability
  period? (staff-ts open Q.) Recommend: forever; opt-out per-call only.
- **Dashboard hosting:** ever served bundled-prod over a non-localhost
  interface? If yes, asset rules need auth, not just bind-host. (dashboard-lead
  open Q1.)
- **Sleep-consolidation on hypothesis ledger:** confirm rem-sleep treats
  hypothesis-ledger entries as evergreen evidence (no pruning, only
  archive-on-cap)? (growth-operator open Q5, architect Rule 2.)

## 9. Architectural rule to memorialize

**A skill earns a top-level `_dream_context/<domain>/` folder iff it produces
durable operational state inspected between sessions, that state has relational
structure the dashboard graphs (FK joins + lifecycle status), AND it owns
external side effects (API calls, money spent, deployments) requiring an audit
trail.** Marketing meets all three; brand-voice, design, growth, engineering,
and system-prompts do not — they live in `knowledge/`. Codify in
`DEEP-DIVE.md`. (architect.)
