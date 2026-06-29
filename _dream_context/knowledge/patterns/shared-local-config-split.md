---
id: shared-local-config-split
name: "Shared/Local Config Split (team-committed + per-machine override)"
description: "Architectural pattern for splitting persistent app config between a version-controlled shared file (team default, survives dreamcontext update) and a gitignored per-machine override file (personal preference, survives loopback origin resets). The client merges on read: local overrides win per-key; local-only entries append. Used for brain settings (ui-settings.ts) and board preferences (overrides/board.json + state/board.local.json)."
tags: ["kind:architecture", "kind:decisions", "layer:frontend", "topic:dashboard"]
pinned: false
date: "2026-06-28"
---

## Why This Exists

Local web apps served from `127.0.0.1:<random-port>` (or a Tauri desktop app) reset `localStorage` on every launch because the origin (`127.0.0.1:<port>`) changes. Any preference stored only in `localStorage` is lost when the server restarts. At the same time, some preferences (saved views, filter configs, version lists) are team conventions that should be shared via git — while others (which view is active right now, card property toggles) are purely per-machine and should never pollute a commit.

Two surfaces in dreamcontext hit this problem:
1. **Brain graph settings** (`ui-settings.ts` → `~/.dreamcontext/brain-settings.json` / vault-scoped `.brain-settings.json`) — brain view, force settings, display prefs.
2. **Tasks board preferences** (`overrides/board.json` + `state/board.local.json`) — saved views, sort/filter/group combos, version list.

## The Pattern

Two files, never localStorage as source of truth:

| File | Location | Git | Content |
|---|---|---|---|
| **Shared** | `_dream_context/overrides/<name>.json` | Tracked (versioned) | Team defaults: saved view definitions, the managed version list, shared sort/filter configs |
| **Local** | `_dream_context/state/<name>.local.json` | Gitignored | Per-machine: active view, card property toggles, private view overrides |

**On read** (client or server): load shared → load local → deep-merge (local wins per-view key; local-only views append). Result is the effective config for this machine.

**On write** — the user explicitly chooses scope:
- "Save for everyone" → writes to `overrides/<name>.json` (git-tracked)
- "Save for yourself" → writes to `state/<name>.local.json` (gitignored)

For implicit writes (e.g. "which view is active") where the user has no explicit intent, always write local. For structural changes (adding/removing a version from the managed list) always write shared.

**The `overrides/` directory is the right home for the shared file** because: (1) it is git-tracked, (2) it survives `dreamcontext update` (the update command preserves `overrides/`), and (3) it already hosts `overrides/task.md` — so the pattern is established.

## Implementation Sketch

```ts
// Server: GET /api/<name>
const shared = readJsonSafe('overrides/<name>.json') ?? {}
const local  = readJsonSafe('state/<name>.local.json') ?? {}
return { shared, local }

// Server: PUT /api/<name>/shared → writes overrides/<name>.json
// Server: PUT /api/<name>/local  → writes state/<name>.local.json

// Client merge
function effectiveConfig(shared, local) {
  const views = { ...shared.views }
  for (const [id, localView] of Object.entries(local.views ?? {})) {
    views[id] = localView.isLocalOnly
      ? localView                          // local-only view: append
      : { ...views[id], ...localView }     // shared view with local override: merge
  }
  return { ...shared, views, activeView: local.activeView ?? shared.defaultView }
}
```

## When To Use / Avoid

- **Use** when: (a) a config object must survive server restarts / origin changes, AND (b) some entries should be shared across the team (version control), AND (c) some entries are personal (should not pollute commits).
- **Avoid** if the config is purely personal with no sharing need — `~/.dreamcontext/<name>.json` (like `sleepy.json`) is simpler. Avoid if the config is structural application data (use a proper data store, not a JSON blob).
- **Watch out for**: merge conflicts on `overrides/<name>.json` when two team members save shared views simultaneously. Design the schema so views are keyed by ID (not an array index) to keep git diffs minimal.

## Related

- Applied in dashboard `board.json` + `board.local.json` (tasks board saved views) — see `web-dashboard` PRD Constraints & Decisions [2026-06-28].
- Inspired by the earlier `ui-settings.ts` pattern for brain settings (vault-scoped `.brain-settings.json`).
- `overrides/task.md` is another `overrides/` resident that survives `dreamcontext update`.
