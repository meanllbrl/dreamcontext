---
id: "feat_Ewqk-9Ei"
type: "feature"
name: "linked-repos"
description: "A shared brain governs bare code repos with no _dream_context/ of their own — shared {name,url} config + machine-local path registry + link CLI + trust-gated clone + dashboard panel"
pinned: false
date: "2026-07-09"
status: "in_review"
created: "2026-07-09"
updated: "2026-07-09"
released_version: null
tags:
  - "topic:github"
  - "topic:federation"
  - "architecture"
  - "layer:server"
  - "layer:frontend"
related_tasks:
  - "feat-linked-repos-shared-brain-governs-bare-code-repos-machine-local-path-registry-link-cli-trust-gated-clone-dashboard"
---

## Why

Users want ONE shared dreamcontext brain to govern multiple bare CODE repos (products) that have NO `_dream_context/` of their own — pure code in separate GitHub repos, cloned at arbitrary local paths per machine, some potentially absent on a given machine. Without this, the brain cannot locate or reach those sibling repos.

**This is DISTINCT from:**
- **Federation** — cross-vault recall between projects that HAVE brains (read-only peer queries)
- **Brain-repo-sync** — whole-project GitHub sync of code + brain together

Linked repos is the control-tower pattern: one brain points at the bare code repos it governs, with a two-layer split so the shared config (what repos exist) travels with the team while the machine-specific paths (where each repo lives locally) stay private.

## User Stories

- [x] As a user, I can link a local code repo to the brain via `dreamcontext link add <name> <path>`, so the brain knows this repo exists and can hand its path to agents.
- [x] As a user, the shared config carries only `{name, gitRemoteUrl}` and never my local path, so teammates see which repos exist without exposing anyone's machine-specific directory structure.
- [x] As a user, the machine-local registry (`~/.dreamcontext/linked-repos.json`) maps canonical GitHub URLs to my local paths globally (across all projects), so one registry serves every brain on this machine.
- [x] As a user, I can `dreamcontext link clone <name>` to clone a missing linked repo after a trust gate and confirmation, so setting up on a new machine doesn't require hand-cloning every repo the brain references.
- [x] As a user, the session-start snapshot shows which linked repos are present (with resolved paths) and which are missing, so I know at a glance whether I need to clone anything.
- [x] As a user, the dashboard Settings → Brain panel lists linked repos with their present/missing status and offers a Clone button for missing ones (after a trust warning), so I can manage linked repos without using the CLI.
- [x] As a developer, linking a repo validates it is a git repo AND its `origin` matches the declared URL (or I provide `--url` if no origin), so the brain never links a repo at the wrong path or with a mismatched remote.

## Acceptance Criteria

- [x] `canonicalRemote(url)` collapses ssh / https / `owner/repo` / `.git` / trailing-slash forms of the SAME GitHub repo to one identical string; returns null for non-GitHub or non-repo strings.
- [x] `readLinkedRepoRegistry` returns `{}` for a missing file and `{}` (with a logged notice) for malformed JSON; filters out non-string / non-absolute entries; never throws.
- [x] `writeLinkedRepoRegistry` writes atomically (temp+rename, pid+nonce), creating `~/.dreamcontext/` as needed; two interleaved writes never corrupt the file.
- [x] `deriveRemoteUrl(path)` returns the canonical URL from a repo's `origin`; returns null when there is no origin or it is non-canonicalizable.
- [x] `linkRepo` writes `{name, gitRemoteUrl}` (canonical, NO path) to `.config.json` AND `url→absPath` to the home registry; rejects a non-existent path and a non-canonicalizable URL.
- [x] `resolveLinkedRepos` reports `present=true` with the resolved path when the registry maps the URL and the path exists; `present=false, path=null` when the URL is unmapped OR the path is gone. Performs NO network/git call (hot-path safe).
- [x] `unlinkRepo` removes the config entry and LEAVES the home registry mapping intact (preserves the local path for other projects that might link the same repo).
- [x] Config round-trip: a `.config.json` containing `linkedRepos` survives `readSetupConfig → updateSetupConfig → readSetupConfig` unchanged; a hand-injected `path` key on an entry is stripped by `sanitizeLinkedRepos`.
- [x] Shared `linkedRepos` entries provably carry `name + gitRemoteUrl` only (no `path` field) after any write.
- [x] Scrub backstop: `scrubContent` flags a `/Users` home path with the `home-path` rule (WARN) — documents the defense-in-depth layer; the real guarantee is architectural (path lives only in the HOME registry, never a tracked file). Do NOT raise `home-path` to BLOCK.
- [x] CLI: `dreamcontext link add <name> <path>` binds and prints the resolved path; `link ls` (and the top-level `links` alias command) shows present/missing; `link rm <name>` (and the top-level `unlink <name>` alias) removes it. `link` is a pure group with no parent positional action, so a repo named "clone" is just an argument.
- [x] `link clone <name>` refuses without confirmation, emits the team-writable-URL trust warning, and with `--yes` plus an injected clone registers the new path.
- [x] Route guards: every `/api/linked-repos` handler returns 403 when `isDesktop()` is false; bodies are strict-picked (extra fields ignored); `/clone` returns 400 `needs_confirm` without `confirmed=true` and 401 `no_token` without a token.
- [x] Snapshot: with a present linked repo the session-start output contains the "Linked" line with the external-data prefix, the canonical URL, and the resolved absolute path; with none the section is absent; generation performs no network/git (hot-path regression guard).
- [x] Validation: BOTH automated (unit/integration tests + existing suite ~3107 green + builds clean) AND manual (real-binary CLI walkthrough in isolated scratch HOME — shared/local split proven, present/missing, unlink-leaves-registry, snapshot 3 states, non-git + origin-mismatch rejected).
- [x] S1 (RCE guard): a `linkedRepos` entry with `gitRemoteUrl` "ext::sh -c ..." and one with a leading dash (`--upload-pack=...`) are rejected by `cloneLinkedRepo` BEFORE any git call (`parseRepoSlug` null → `LinkedRepoError`); the injected git module `clone` spy is called 0 times.
- [x] S1 transport: `git.clone` is invoked with `-c protocol.ext.allow=never` and a `--` options terminator; the clone uses the rebuilt canonical URL, never the raw stored string.
- [x] S2 (traversal): a slug or `--dir` whose folder component resolves outside `dirname(projectRoot)` is rejected by the resolve → `startsWith` containment check; the sanitized default dest is always a direct child.
- [x] S3 (governed-repo): `linkRepo` rejects (a) a path that is not a git repo (`isGitRepo` false), and (b) a git dir whose canonical origin does not equal the entry or `--url` canonical URL.
- [x] `linkRepo` persists ONLY a canonical `gitRemoteUrl` (a non-canonical `--url` is rejected, never stored); the snapshot renders the canonical URL.
- [x] Cross-project isolation: two distinct `projectRoot`s, each declaring a linked repo named "api" at DIFFERENT canonical URLs, resolved against the SAME injected home, produce two distinct registry entries; each `resolveLinkedRepos` returns its own path — no overwrite, no cross-read.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-07-09]** **OUT OF SCOPE (YAGNI):** non-GitHub remotes; auto-cloning missing repos at session start or ANY network/git in the snapshot; sub-brains or recall INTO linked code repos (that is federation, not this); the agent reading/writing inside linked repos beyond receiving resolved paths; `links prune` / registry GC; any per-key shared+local merge of `linkedRepos`.
- **[2026-07-09]** **Scrub is a SOFT backstop only** — the `home-path` rule is severity WARN (non-blocking foreground; matches only `/Users` and `/home`). The real path-never-reaches-git guarantee is ARCHITECTURAL: the path lives only in the HOME registry (outside every repo) and `sanitizeLinkedRepos` strips any stray `path` key from the shared config. Do NOT raise `home-path` to BLOCK (would false-positive on prose paths).
- **[2026-07-09]** **Security — 3 layers neutralize the team-writable URL:** (S1) rebuild the clone URL via `parseRepoSlug`/`canonicalRemote` BEFORE git + `git.ts` `--` terminator + `protocol.ext.allow=never`; (S2) `sanitizeRepoName` + `resolve`/`startsWith` containment on the clone dest; (S3) `linkRepo` requires `isGitRepo` AND canonical-origin match. Also: link-time URL is canonicalized before persisting; the snapshot frames name/url as external unverified data and shows the canonical URL.
- **[2026-07-09]** **LOCKED (validated):** two-layer split; join key = canonical GitHub URL; shared half `{name, gitRemoteUrl}` in `SetupConfig`/`.config.json` (pushed); machine-global half in `~/.dreamcontext/linked-repos.json` KEYED BY CANONICAL URL (globally unique, NOT name — name is a per-project label only); mirror `vaults.ts` for file mechanics ONLY; CLI `link add/clone/ls/rm` PLUS separate top-level `links` + `unlink` commands (not `.alias`); clone behind a FRESH trust-gate (attach was removed — nothing to reuse); snapshot resolution OFF the hot path (cheap local reads only); dashboard in scope with the native Tauri folder picker; GitHub-only v1; clone dest = `dirname(projectRoot)/sanitizeRepoName(repo)` with a contained `--dir` override; zero migration (absent `linkedRepos` => empty, never-throw).

## Technical Details

**Shipped:** session 94eda2ea (2026-07-09), all 21 acceptance criteria met, validated via both automated suite (3107 tests green) + real-binary CLI walkthrough.

**Architecture:** Two-layer split where the shared config (what repos exist) and the machine-local registry (where each lives on THIS machine) are kept separate and joined by canonical GitHub URL.

**Core module:** `src/lib/linked-repos.ts`
- Home registry: `~/.dreamcontext/linked-repos.json`, type `LinkedRepoRegistry = { repos: Record<canonicalUrl, absPath> }`, KEYED BY CANONICAL `gitRemoteUrl` (globally unique across ALL projects), NEVER by name.
- Mirrors `vaults.ts` ONLY for file mechanics (HOME location, atomic temp+rename write with pid+nonce, never-throw read, sanitize-on-read) — NOT its name-keyed schema.
- Exports: `linkedReposFilePath`, `readLinkedRepoRegistry`, `writeLinkedRepoRegistry`, `get/set/removeLinkedRepoPath`, `deriveRemoteUrl`, `resolveLinkedRepos` [HOT-PATH SAFE: `readSetupConfig().linkedRepos` + registry + `existsSync`; NO net/git], `linkRepo`, `unlinkRepo`, `cloneLinkedRepo`, `LinkedRepoError`.

**Clone security ordering (every gate BEFORE any git call):**
1. Find config entry by name (throw if absent)
2. S1: `slug=parseRepoSlug(entry.gitRemoteUrl)`, null → HARD `LinkedRepoError` BEFORE any git, `cloneUrl=canonicalRemote(entry.gitRemoteUrl)` so the raw team-writable string NEVER reaches git
3. S2: `base=sanitizeRepoName(slug.repo)` (null→throw), `parent=resolve(dir ?? dirname(projectRoot))`, `dest=join(parent,base)`, assert `resolve(dest).startsWith(resolve(parent)+sep)` else throw (also guards `--dir`)
4. Refuse if dest exists
5. `confirmed===true` required
6. `resolved=resolveBrainSyncToken(projectRoot)`, if(!resolved) throw
7. `withGitCredentials(resolved.token, env=>git.clone(cloneUrl,dest,env))`
8. `setLinkedRepoPath(entry.gitRemoteUrl,dest)`

**`linkRepo` validation:** `abs=resolve(path)`; `existsSync` + `statSync.isDirectory`; S3 `gitModule.isGitRepo(abs)` required; `localCanon=canonicalRemote(getRemoteUrl(abs,origin))`; if `--url` given `entryCanon=canonicalRemote(url)` (null→throw) and when `localCanon` non-null require `localCanon===entryCanon` (origin match else throw); else `entryCanon=localCanon` (null→throw, pass `--url`); name-collision guard (same name different url → throw); `updateSetupConfig {name, gitRemoteUrl: entryCanon}` (ALWAYS canonical) + `setLinkedRepoPath(entryCanon, abs)`. No post-resolve dotdot check (resolve normalizes it); safety = exists+dir+isGitRepo+origin-match.

**Git transport hardening:** `src/lib/git-sync/git.ts` — added export `const SAFE_TRANSPORT_ARGS = ['-c', 'protocol.ext.allow=never']` near `CREDENTIAL_HELPER_DISABLE_ARGS`; `clone` → `run(cwd, [...CREDENTIAL_HELPER_DISABLE_ARGS, ...SAFE_TRANSPORT_ARGS, 'clone', '--', url, dest], {env})`. `git.clone` has ZERO other callers (verified) so global hardening is safe; the `--` terminator defeats a leading-dash url/dest.

**Shared config:** `src/lib/setup-config.ts` — interface `LinkedRepo {name, gitRemoteUrl}`; `SetupConfig.linkedRepos?` (sibling of `multiProduct`); `sanitizeLinkedRepos` keeps ONLY `{name, gitRemoteUrl}` per entry (drops any stray `path` key); THREADED through BOTH `readSetupConfig` (field-by-field rebuild DROPS unnamed fields) AND `updateSetupConfig`. Orthogonal to `multiProduct`.

**CLI:** `src/cli/commands/link.ts` — `registerLinkCommand`: pure group `link` with `add <name> <path> [--url]` / `clone <name> [--dir] [--yes]` / `ls` / `rm <name>`; PLUS two separate top-level registrations `program.command('links')` and `program.command('unlink <name>')` calling the SAME impl fns as `link ls` / `link rm` (NOT commander `.alias`).

**Snapshot integration:** `src/cli/commands/snapshot.ts` — in `generateSnapshot`, adjacent to Connected projects: external-data prefix line; render `canonicalRemote` (not raw); present repo shows resolved abs path inline; missing shows `(dc link clone <name>)`; hot-path safe (config+registry+existsSync); try/catch; omit when empty.

**Server routes:** `src/server/routes/linked-repos.ts` — GET `list` + POST `link/clone/unlink`; gate via `isDesktop()` (403 else); strict-pick `parseJsonBody`; `/link` delegates ALL validation to `linkRepo`; `/clone` requires `confirmed=true` (400 else) + token (401 else); map `LinkedRepoError→400`.

**Dashboard:** `dashboard/src/hooks/useLinkedRepos.ts` (mirror `useBrainStatus`). `dashboard/src/components/brain/LinkedRepos.tsx` + css — list present/missing; Add/Link via `openFolderPicker()` (native Tauri dialog) → POST `/link`; Clone-missing shows a trust-warning confirm before POST `/clone confirmed=true`; Unlink → POST `/unlink`. `dashboard/src/pages/SettingsPage.tsx` — render `LinkedRepos` in the brain section after `OriginSetup`. `dashboard/src/context/I18nContext.tsx` — keys mirror `brain.origin`.

**Tests:** `tests/unit/linked-repos.test.ts` (39 tests), `tests/unit/setup-config-linked-repos.test.ts` (8), `tests/unit/linked-repos-route.test.ts` (17), `tests/integration/link-cli.test.ts` (6) + 1 scrub assertion. Inject fake git module + injected home.

**Reused anchors:** `vaults.ts` (registry mechanics), `connections.ts:106-112` (atomic write), `origin-setup.ts:21,28-31,34-46` (`parseRepoSlug`/`remoteForSlug`/`sanitizeRepoName`/`REPO_NAME_RE`), `credentials.ts:55` (`withGitCredentials`), `brain-repo.ts:34` (`resolveBrainSyncToken` returns `ResolvedToken` or null, use `.token`), `brain.ts:56-62,334` (gate + confirmed), `server/desktop.ts` (`isDesktop`), `dashboard/src/lib/desktop.ts:116-126` (`openFolderPicker`).

## Notes

- User correction in session 94eda2ea confirmed the distinction: "hayır onların kendi beyinleri yok işte" — these repos have NO brains of their own, which is what makes this DIFFERENT from federation (peer brains that DO have `_dream_context/`).
- One residual manual smoke-test: `link clone` against a real GitHub repo with a token (logic is unit-covered via injected git).
- The dashboard `LinkedRepos` panel is implemented but pending full desktop-app walkthrough.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-07-09 - Shipped (session 94eda2ea)

Full linked-repos feature shipped: `src/lib/linked-repos.ts` (registry + `linkRepo` + `unlinkRepo` + `resolveLinkedRepos` + `cloneLinkedRepo` with S1/S2/S3 ordering), `git.ts` `SAFE_TRANSPORT_ARGS` + clone hardening, `origin-setup.ts` `canonicalRemote` export, `setup-config.ts` `linkedRepos` + `sanitizeLinkedRepos` threaded through read/update, `cli/commands/link.ts` (`link add/clone/ls/rm` + top-level `links`/`unlink`), `server/routes/linked-repos.ts` + registration, `snapshot.ts` Linked repos glance (hot-path safe), dashboard `useLinkedRepos` hook + `LinkedRepos` panel wired into `SettingsPage` + i18n keys.

**Coverage:** 4 new test files (`linked-repos.test.ts` 39 tests, `setup-config-linked-repos.test.ts` 8, `linked-repos-route.test.ts` 17, `link-cli.test.ts` 6) covering all 21 AC including S1a/b/c, S2a/b, S3a/b/c, AC21 cross-project isolation, and the snapshot glance. Full suite green (3107 tests, 236 files), root `tsc --noEmit` clean, `tsup` build clean, dashboard `tsc -b` + `vite build` clean.

**Validation:** BOTH paths verified — automated suite + real-binary CLI walkthrough in isolated scratch HOME (shared/local split proven, present/missing, unlink-leaves-registry, snapshot 3 states, non-git + origin-mismatch rejected). Manual walkthrough confirmed via task changelog; one residual human step (real-GitHub `link clone` with a token) noted as logic unit-covered.

All 21 acceptance criteria met. Status `planning` → `in_review`.
