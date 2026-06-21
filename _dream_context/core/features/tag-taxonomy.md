---
id: feat_kCUdOcvt
status: active
created: '2026-06-12'
updated: '2026-06-21'
released_version: v0.8.7
tags:
  - architecture
  - decisions
  - backend
related_tasks: []
---

## Why

Free-form tags fragment discovery: every agent and session invents near-duplicate tags (`db`, `database`, `domain:database`), making recall filters and the knowledge index noisier over time. The tag taxonomy gives each project a governed vocabulary — faceted canonical tags plus aliases — stored as data (`core/taxonomy.json`), mutated only through validated CLI commands, audited against the live corpus, and visible in the dashboard. Sleep agents and the initializer are instructed to pull tags from this vocabulary instead of freelancing.

## User Stories

- [x] As an AI agent, I can read the project tag vocabulary (`taxonomy vocab`) and resolve any tag's classification (`taxonomy resolve <tag>`) so I tag documents consistently across sessions.
- [x] As an AI agent, I can grow the vocabulary only through validated mutations (`taxonomy add`, `taxonomy alias`) so the vocabulary cannot silently drift or cycle.
- [x] As a developer, I can audit the corpus (`taxonomy audit`) to see non-canonical tags, orphans, near-duplicates, and untagged docs so tag debt is visible and fixable.
- [x] As a user, projects that predate the feature get `core/taxonomy.json` seeded automatically at SessionStart so no manual action or sleep cycle is required.
- [x] As a user, I can browse the taxonomy in the dashboard (facet chips, usage counts, alias arrows, audit panel) — see the web-dashboard PRD.

## Acceptance Criteria

- [x] Storage: `core/taxonomy.json` (matches the CHANGELOG.json/RELEASES.json data-file pattern; replaced the earlier `core/taxonomy.md`). Fail-soft parse, array-union merge over built-in defaults, `version` field. Inherited-object-key hardening: a tag named `constructor` can never read as a phantom alias.
- [x] Facets: `domain`, `layer`, `kind`, `topic` (`FACETS` in `src/lib/taxonomy.ts`). Tags of the form `<facet>:<value>` are faceted canonicals; bare standard tags remain valid fallbacks.
- [x] `taxonomy add <tag>`: facet whitelist enforced; reuse-before-invent rejection (near-duplicate of existing vocab is rejected with a pointer).
- [x] `taxonomy alias <alias> <canonical>`: canonical must exist; no alias chains or cycles.
- [x] `taxonomy resolve <tag>` prints classification (canonical / alias→target / orphan); `taxonomy vocab [--facet <f>]` prints the resolved vocabulary.
- [x] `taxonomy audit` buckets the live corpus (knowledge, features, tasks, memory, bookmarks): nonCanonical, alias-resolvable, orphan, nearDups, untagged.
- [x] `taxonomy init` and `dreamcontext init` share the same idempotent `ensureTaxonomyFile`; the SessionStart hook seeds `core/taxonomy.json` crash-safely on installs that predate the feature (first session after upgrade, no user action).
- [x] Sleep agents (`sleep-product`, initializer) are instructed to mutate the vocabulary ONLY via the CLI commands — never hand-edit the JSON.
- [x] Dashboard: read-only `GET /api/taxonomy` + Taxonomy page (detailed in the web-dashboard PRD).

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-06-12]** Mutations are CLI-only by design: raw file edits bypass validation (facet whitelist, alias cycle checks, reuse-before-invent), so agents and docs consistently route through `taxonomy add`/`taxonomy alias`. The dashboard surface is deliberately read-only.
- **[2026-06-12]** JSON over markdown storage: taxonomy is data consumed programmatically (audit, dashboard, validation), matching the CHANGELOG.json/RELEASES.json pattern. Defaults are merged via array-union so upgrading dreamcontext can add vocabulary without clobbering project-specific tags.
- **[2026-06-12]** The pre-existing corpus is migrated opportunistically, not bulk-rewritten: `taxonomy audit` surfaces drift; sleep-product fixes files surgically per cycle (its Pass C). Aliases let legacy bare tags resolve to canonicals without touching every file at once.

## Technical Details

- `src/lib/taxonomy.ts` — `FACETS`, vocabulary types (`facetTags`, bare tags, aliases), `ensureTaxonomyFile` (idempotent seed), fail-soft read with array-union merge over defaults, alias resolution with inherited-key hardening, audit logic.
- `src/cli/commands/taxonomy.ts` — `init`, `vocab [--facet]`, `add`, `alias`, `resolve`, `audit`.
- `src/cli/commands/hook.ts` — SessionStart auto-seed (crash-safe).
- `src/cli/commands/init.ts` / `doctor.ts` — scaffold + validation.
- Dashboard: `src/server` GET /api/taxonomy (read-only); `dashboard/src/pages/TaxonomyPage.tsx/.css`, `dashboard/src/hooks/useTaxonomy.ts`.
- Agent integration: `agents/sleep-product.md` Pass C (audit every cycle, surgical fixes, `taxonomy add`/`alias` for new domain nouns), `agents/dreamcontext-initializer.md`, `skill/SKILL.md`.

## Notes

- Default project vocabulary at first seed: `domain:{database,security,knowledge,recall}`, `layer:{frontend,backend,devops}`, `kind:{architecture,api,testing,design,decisions,onboarding}`, `topic:{recall,sleep,taxonomy,domain}` + aliases (e.g. `search`/`retrieval` → `topic:recall`).
- Shipped via branch `feat/taxonomy-behaviors` (merge 6ca4612, commit 9766b34); full build + 1433 tests green at merge.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-06-12 - Created (retrospective consolidation of taxonomy behaviors)
- JSON storage (`core/taxonomy.json`), validated CLI mutations (add/alias/resolve/vocab/audit/init), dashboard Taxonomy view, SessionStart auto-seed. Merged to main 6ca4612.
