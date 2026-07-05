---
id: knowledge_vault_registry_multivault
name: vault-registry-multivault
description: >-
  Architecture for the global vault registry (~/.dreamcontext/vaults.json):
  data shape, CLI, resolution logic, the v0.6 one-server-per-vault model
  (superseded in v0.8 beta by launcher mode — one shared server, multi-window),
  and the dashboard --vault flag.
type: knowledge
tags:
  - architecture
  - domain
pinned: false
created: '2026-06-01'
updated: '2026-06-15'
---

## Why this exists

Users with multiple projects each have their own `_dream_context/` directory. Before v0.6, the dashboard always served the project found by walking up from `process.cwd()`. There was no way to open a specific vault or switch between projects without changing directories. The vault registry provides a named directory of projects so the dashboard, CLI, and Tauri shell can address any vault by name or path.

## Registry location and shape```
~/.dreamcontext/vaults.json```Global, user-scoped (machine-local). Schema:```ts
interface Vault {
  name: string;   // user-chosen, unique
  path: string;   // absolute, resolved at add-time
}

interface VaultRegistry {
  vaults: Vault[];
}```The file is pretty-printed JSON with a trailing newline. Directory is created with `mkdirSync({ recursive: true })` on first `addVault`.

## Failure modes (never-throw contract)

- File missing → empty registry `{ vaults: [] }` (not an error).
- File exists but JSON is malformed → log a warning, return `{ vaults: [] }` (not an error).
- `listVaults` never throws.

This mirrors the `readVersionCache` pattern in `src/lib/version-check.ts`.

## Testability — injectable `home` param

All functions accept an optional `home` parameter (default `os.homedir()`):```ts
listVaults(home?: string): Vault[]
addVault(name: string, dirPath: string, home?: string): void
removeVault(name: string, home?: string): boolean
resolveVaultContextRoot(arg: string, home?: string): string```Tests pass a `tmpdir` as `home` to isolate from the developer's real registry. This DI pattern mirrors `runner` injection in `version-check.ts:177`.

## addVault validation

Throws `VaultError` (typed Error subclass) when:
1. `dirPath` does not exist (not a directory).
2. `dirPath` exists but has no `_dream_context/` child.
3. Name already registered (case-sensitive).
4. Resolved absolute path already registered (prevents path-alias dupes).

`VaultError` is rendered as a clean message at the CLI surface (no stack trace). Pattern from `vaults-cli.test.ts`.

## resolveVaultContextRoot

The single entrypoint used by both `dashboard --vault` (CLI) and the Tauri shell:```ts
resolveVaultContextRoot(arg: string, home = homedir()): string```Resolution order:
1. Check if `arg` matches a registered vault **name** in `listVaults(home)` → use its `path`.
2. Else treat `arg` as a filesystem **path**: `resolve(arg)`.
3. Require resolved path exists AND has a `_dream_context/` child (mirror `addVault` checks).
4. Return `join(resolved, '_dream_context')`.
5. Any failure → throw `VaultError`.

Name is tried first so desktop-launch-by-name and CLI-launch-by-path both use the same code path.

## Multi-vault strategy — Option A (v0.6) → SUPERSEDED in v0.8 beta

> **Update (2026-06-13, dreamcontext-beta):** the "one server per vault" model below was
> superseded for the desktop app by a **single shared Node server in launcher mode**
> (`dashboard --launcher`, `contextRoot=null`). Each window pins its vault via a
> `?vault=<name>` URL → `X-Dreamcontext-Vault` header → a per-request strict name-only
> contextRoot resolver. Multi-vault == multi-window, one process. See
> `knowledge/desktop-beta-tauri-multivault.md`. The v0.6 model below remains accurate for
> the plain `dreamcontext dashboard` CLI.

For v0.6 the multi-vault model is **one server per vault**. There is no vault-switcher in the running dashboard. To switch vaults you start a new dashboard process (or Tauri window) pointed at the desired vault via `--vault`.

`GET /api/vaults` returns:```json
{ "vaults": [...], "current": "<dirname(contextRoot)>" }```
The `current` field lets the frontend highlight the active vault in the read-only Vaults list. A future slice could add vault switching (e.g., a multi-vault proxy or a restart-with-vault flow), but that's explicitly out of scope for v0.6.

## `dashboard --vault` flag (CLI)```dreamcontext dashboard --vault <path|name>```
- Present → `resolveVaultContextRoot(opts.vault)` → pass resolved `contextRoot` to `startDashboardServer`.
- Absent → `ensureContextRoot()` walk-up from cwd (unchanged behavior).
- `VaultError` → non-zero exit with clean message (no stack).

The server signature `startDashboardServer(contextRoot: string)` was already parameterized — no server change needed.

## Sources

- Task `v06-control-plane-backend` — A1/A2/A3
- Task `v06-tauri-shell` — A1/A2/A3 + architecture decisions
- `src/lib/vaults.ts`, `src/cli/commands/vaults.ts`, `src/cli/commands/dashboard.ts`
- `tests/unit/vaults.test.ts`, `tests/integration/vaults-cli.test.ts`, `tests/unit/vaults-resolve.test.ts`, `tests/integration/dashboard-vault.test.ts`

## Last verified

2026-06-01 (v0.6.0, all auto-criteria met, suite 962 green)
