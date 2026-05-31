---
id: knowledge_tauri_desktop_hosting
name: tauri-desktop-hosting
description: >-
  Architecture decision: host the existing Node dashboard in a Tauri 2.x native
  shell by spawning Node as a child on a free loopback port and loading via
  WebviewUrl::External. Covers alternatives rejected, free-port pattern,
  readiness poll, capability scoping, and the manual handoff boundary.
type: knowledge
tags:
  - architecture
  - decisions
pinned: false
created: '2026-06-01'
updated: '2026-06-01'
---

## Why this exists

The v0.6 Tauri slice (`v06-tauri-shell`) adds a native macOS shell for the dreamcontext dashboard. The approach is non-obvious: instead of reimplementing API routes in Rust or statically bundling the frontend, the Tauri app spawns the existing Node CLI. Future contributors should understand why this was chosen and what the constraints are.

## The decision

**Chosen approach:** Tauri shell spawns the existing Node CLI (`node <dist/index.js> dashboard --port <free> --no-open --vault <vault>`), polls `GET /api/health` for readiness, then opens the dashboard in a native webview via `WebviewUrl::External(http://127.0.0.1:<port>)`.

The window is created at runtime (not statically in `tauri.conf.json`) because the port is dynamic — `WebviewWindowBuilder::new(app, "main", WebviewUrl::External(...))`.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Reimplementing `/api/*` in Rust | dreamcontext reads `_dream_context/` files via TypeScript libraries (`src/lib/`). Reimplementing that layer in Rust would duplicate ~5 kloc and drift. Not a static SPA. |
| Packaged-Node sidecar (`bundle.externalBin`) | Deferred. Adds significant build complexity (platform-specific binaries, notarization of the sidecar). Viable follow-up path, scaffolded as a commented block in `lib.rs`. |
| Rust-native HTTP proxy | Same duplication problem as option 1, plus ongoing sync overhead. |

## Free-port pattern

```rust
let listener = TcpListener::bind("127.0.0.1:0")?;
let port = listener.local_addr()?.port();
drop(listener); // release before Node binds — TOCTOU accepted for single-user desktop
```

`TcpListener::bind("127.0.0.1:0")` asks the OS for any available port. The port number is read, then the listener is dropped so Node can bind to it. There is a narrow TOCTOU race (another process could grab the port between drop and Node binding). This is acceptable for a single-user desktop app; if `EADDRINUSE` is seen on the Node child, retry once.

## Readiness poll

After spawning the Node child, `host_dashboard` polls `GET http://127.0.0.1:<port>/api/health` with a ~10 s timeout (short retry loop). On timeout, fail loudly (don't silently load a blank webview). The poll prevents opening the webview before the server is listening.

## Vault selection at launch

The Tauri shell reads the vault to open from env var `DREAMCONTEXT_VAULT` (dev default: cwd). The CLI path to `dist/index.js` comes from `DREAMCONTEXT_CLI`. A native vault-picker UI (reading `~/.dreamcontext/vaults.json`) is a follow-up, not v0.6.

## Capability scoping (least privilege)

`capabilities/default.json`:
```json
{
  "windows": ["main"],
  "permissions": ["core:default", "shell:allow-spawn", "updater:default"]
}
```

`shell:allow-spawn` is scoped to `node` — the shell plugin will only spawn processes named `node`. CSP is `null` for the first cut (serving own loopback content); hardening to a strict CSP is a follow-up TODO.

## Signing and notarization boundary

The `desktop/` directory is committed and `cargo check` compiles, but window-launch + code-signing + Apple-notarization + updater endpoint configuration are manual handoff items. They require:

1. `tauri signer generate` — keypair; pubkey goes to `tauri.conf.json`, private key to CI secret (never committed; `desktop/.tauri-signing/` is gitignored).
2. `npm run tauri build` — produces `.app`/`.dmg` + updater `.sig`/`latest.json`.
3. Apple code-sign + notarize via `xcrun notarytool`.
4. `tauri icon` — replace placeholder icons with real branded assets.
5. Fill GitHub Releases `latest.json` endpoint owner/repo in `tauri.conf.json`.

Node ≥18 is a documented runtime prerequisite (not bundled in v0.6).

## File layout

```
desktop/
  package.json              # devDep: @tauri-apps/cli ^2.9; not added to root build
  src-tauri/
    Cargo.toml              # dreamcontext-desktop; tauri 2 + plugin-shell + plugin-updater
    build.rs                # tauri_build::build()
    src/
      main.rs               # cfg_attr windows_subsystem="windows" + calls lib::run()
      lib.rs                # pub fn run(); host_dashboard(); WebviewWindowBuilder
    tauri.conf.json         # productName, identifier, runtime windows:[], csp:null, updater
    capabilities/
      default.json          # shell:allow-spawn (node), updater:default
    frontend-placeholder/
      index.html            # one-line placeholder (Tauri requires a frontendDist dir)
    icons/                  # default placeholder icons (real icons = tauri icon handoff)
  .gitignore                # src-tauri/target/, node_modules/, .tauri-signing/, *.key
```

## Sources

- Task `v06-tauri-shell` — architecture decision + constraints + technical details
- `desktop/src-tauri/src/lib.rs` (spawning + poll + WebviewWindowBuilder)
- `desktop/src-tauri/capabilities/default.json`

## Last verified

2026-06-01 (v0.6.0, A5+A6 met: scaffolded + cargo check green; A7/A8 manual handoff pending)
