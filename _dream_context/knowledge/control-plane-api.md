---
id: knowledge_control_plane_api
name: control-plane-api
description: >-
  Architecture decisions and invariants for the v0.6 backend control-plane:
  route design, strict-pick config PATCH, cache-only version-check, safeChildPath
  pattern, and catalog extraction to keep interactive deps out of the server bundle.
type: knowledge
tags:
  - architecture
  - api
  - backend
pinned: false
created: '2026-06-01'
updated: '2026-06-01'
---

## Why this exists

The v0.6 control-plane adds four REST routes (`/api/config`, `/api/packs`, `/api/version-check`, `/api/vaults`) to the existing dashboard server. Several non-obvious constraints govern their implementation; this file captures them so future contributors don't accidentally regress the security posture or reintroduce the `@inquirer/prompts` bundle-bloat bug.

## Route conventions

All four new routes follow the same handler signature used by existing routes:

```ts
handleXxx(req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string): void
```

`contextRoot` is the `_dream_context/` directory path. The project root is `dirname(contextRoot)`. Routes must compute the project root themselves — do not assume `process.cwd()`.

## PATCH /api/config — strict-pick, never spread

The config PATCH is the only mutating control-plane route. It accepts `{ platforms?, packs? }`.

**Invariant:** the request body is NEVER spread into the patch object. A new `patch` object is built by extracting `platforms` and `packs` by name after individual validation:

```ts
const patch: Partial<SetupConfig> = {};
if (body.platforms !== undefined) {
  // validate via parsePlatformList + PLATFORM_CATALOG
  patch.platforms = ...;
}
if (body.packs !== undefined) {
  // validate: Array.isArray && every(el => typeof el === 'string' && el.length > 0)
  patch.packs = ...;
}
```

This prevents prototype-pollution attacks (`__proto__`, `constructor.prototype`, etc.) — a crafted JSON body cannot overwrite `Object.prototype` fields via the patch.

Validation error codes: `invalid_body` (non-JSON), `invalid_platforms` (unknown platform id), `invalid_packs` (non-string or empty-string element), `no_changes` (both fields absent from body).

**Why `recordDashboardChange` is not called:** the `change-tracker.ts` entity union has no `'config'` member. Adding it would be a TypeScript compile error. The union is NOT widened in v0.6 — this is a deliberate deferral, not an oversight.

## GET /api/version-check — cache-only, no network

The version-check route reads the disk cache (`_dream_context/state/.version-check.json`) and calls `buildNudge(installedCli, cache | null, installedPacks, catalogPackNames)` — that argument order. It NEVER calls `refreshVersionCache` or any other network/subprocess function.

Rationale: `generateSnapshot()` (SessionStart hot path) already enforces this separation. Allowing network in the request path would add up to 5 s of latency per dashboard page load and introduce a new failure mode.

Cache failure → benign payload (`{cache: null, fresh: false, nudge: null}`), never 500.

Imports from `../../lib/version-check.js` (NOT `src/cli/commands/version-check.ts` — that path does not exist).

## POST /api/federation/sync — dry-run by construction, no write import

The federation sync route (`src/server/routes/federation.ts`) PREVIEWS the outbound digest deltas a sleep cycle would push to each consenting peer. It is **dry-run by construction**: it computes deltas with read-only functions (`buildInterestProfile`, `computeDigest`, `detectConflicts`) and returns `{ dryRun: true, deltas }`. The `dryRun: true` field is a constant.

**Invariant (binding):** NO file under `src/server/routes/*.ts` may import `writeInboxEntry`, `ingestEntry`, `consumeEntry`, `advanceWatermark`, or any other federation WRITE function. The only mutation path is the CLI `federation sync` / `federation drain` (run by the `sleep-federation` specialist). This mirrors the version-check no-network rule: the request path is structurally incapable of the side effect, not merely careful to avoid it. The route file carries a prohibition banner stating this; do not add a write import.

Rationale: a browser-reachable write into a PEER vault's inbox would be a cross-project write surface on the loopback API. Keeping all writes in the CLI keeps the consent rule + watermark advance in one auditable place and preserves the loopback-only invariant.

`GET /api/federation/inbox` is also read-only: `drainInbox` there is a pure read (it never consumes), and `listConsumedEntries` reads the consumed/ archive. Provenance (`origin{vault,entryId,sourceTimestamp}`) rides on every entry for the dashboard inbox view.

## safeChildPath — pass the full filename

All seven slug→path joins in route handlers go through `safeChildPath(<dir>, \`${slug}.md\`)`.

**Critical:** pass the FULL filename (`${slug}.md`), not the slug alone. This matches the pattern in `src/server/routes/core.ts:62-66`. Effect:

- `slug = '../etc/passwd'` → path outside base → `safeChildPath` returns `null` → handler returns 400 `invalid_path`.
- `slug = '.'` → resolves to `.md` (a nonexistent dotfile) → `existsSync` returns false → existing 404 branch fires. If the slug alone were passed, `slug='.'` would resolve to the base directory itself, causing a `readFileSync` on a directory — a 500 DoS.

Location: `src/server/safe-path.ts` — `safeChildPath(baseDir: string, filename: string): string | null`.

Helper pattern for DRY:
```ts
function resolveTaskPath(contextRoot: string, slug: string): string | null {
  return safeChildPath(getStateDir(contextRoot), `${slug}.md`);
}
```

## Catalog extraction — keep interactive deps out of server bundle

`src/lib/catalog.ts` was extracted from `src/cli/commands/install-skill.ts` specifically because `install-skill.ts:7` is:

```ts
import { checkbox, confirm } from '@inquirer/prompts';
```

This is a **top-level static import**. Any server route that imports anything from `install-skill.ts` — even a pure utility like `loadCatalog` — will pull `@inquirer/prompts` and its TTY-manipulation deps into the tsup server bundle. This breaks on headless/non-TTY environments and bloats the bundle.

**Rule:** server routes (`src/server/routes/*.ts`) must never import from `src/cli/commands/install-skill.ts`. They import catalog utilities from `src/lib/catalog.ts` only.

`install-skill.ts` re-exports from `catalog.ts` so existing callers in the CLI path are unchanged:
```ts
export { loadCatalog, findPackageDir, type Catalog, ... } from '../../lib/catalog.js';
```

`catalog.ts` requires its own ESM `__dirname` shim:
```ts
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
```
The original `__dirname` declaration lived at `install-skill.ts:364`, outside the moved function range — it cannot be implicitly carried over.

After moving, `findPackageDir` runs from `dist/lib/` (depth changes). The 3-candidate probe (`../../skill-packs`, `../skill-packs`, `skill-packs`) still reaches `skill-packs/` at the 2-hop candidate from `dist/lib/`. Smoke-test: `dreamcontext install-skill --list` should list packs after a fresh `npm run build`.

## Sources

- Task `v06-control-plane-backend` — constraints + technical details sections
- `src/server/routes/config.ts`, `packs.ts`, `version-check.ts`, `vaults.ts`
- `src/server/safe-path.ts`, `src/lib/catalog.ts`, `src/lib/vaults.ts`
- Knowledge file `dashboard-server-security.md` — full threat model (loopback bind + CSRF + safeChildPath)

## Last verified

2026-06-01 (v0.6.0, all 11 A-criteria met, suite 949 green)
