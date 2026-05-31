# dreamcontext desktop (Tauri shell)

A Tauri 2.x native window that hosts the existing dreamcontext dashboard. It
spawns the Node dashboard server (`node dist/index.js dashboard`) on a free
loopback port, waits for `/api/health`, then loads it via `WebviewUrl::External`.
The dashboard (React + the `/api/*` server) is unchanged — this is only a shell.

> **Status:** the Rust shell compiles (`cargo check`) and the architecture is
> wired. Everything below needs your machine (a display) and, for release,
> Apple Developer signing secrets — it cannot be validated in CI/headless.
> Full spec: `_dream_context/state/v06-tauri-shell.md`.

## Prerequisites

- **Rust** (`cargo`, `rustc` ≥ 1.86 — Tauri 2's deps require it).
- **Node ≥ 18** (the shell spawns the existing `dreamcontext` CLI; Node is a
  runtime prerequisite for this first cut — a packaged-Node sidecar is the
  follow-up for a self-contained `.dmg`).
- A built CLI at the repo root: from the repo root run `npm run build` (produces
  `dist/index.js` + `dist/dashboard/`).
- macOS uses the system WebKit — no extra system packages.

## Run it (dev)

```bash
cd desktop
npm install                       # @tauri-apps/cli + plugins (first run, network)

# Point the shell at the CLI and a vault (or accept dev defaults):
DREAMCONTEXT_CLI=../dist/index.js \
DREAMCONTEXT_VAULT=/absolute/path/to/a/project/with/_dream_context \
  npm run tauri dev
```

Verify: a native window opens, the dashboard loads, and closing the window kills
the Node child process (no orphaned server).

> The vault is selected by env var in this first cut. A native vault-picker that
> reads `~/.dreamcontext/vaults.json` is a follow-up. You can register vaults with
> `dreamcontext vaults add <name> <path>` and list them with `dreamcontext vaults list`.

## Build a distributable

```bash
cd desktop

# 1. Generate an updater signing keypair (ONCE). Keep the private key secret.
npm run tauri signer generate -- -w ./.tauri-signing/dreamcontext.key
#    → paste the printed PUBLIC key into src-tauri/tauri.conf.json
#      at plugins.updater.pubkey (replace the <PLACEHOLDER>).
#    The .tauri-signing/ dir and *.key* are gitignored — never commit the private key.

# 2. Real app icons (replaces the placeholders):
npm run tauri icon path/to/dreamcontext-1024.png

# 3. Fill the updater endpoint owner/repo in tauri.conf.json
#    (plugins.updater.endpoints → https://github.com/<owner>/<repo>/releases/latest/download/latest.json)

# 4. Build (.app + .dmg + updater .sig/latest.json):
export TAURI_SIGNING_PRIVATE_KEY="$(cat ./.tauri-signing/dreamcontext.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...   # NOT via .env — Tauri ignores .env for signing
npm run tauri build
```

Then **code-sign + Apple-notarize** the `.dmg` (Apple Developer cert + `notarytool`)
— that is its own runbook and requires your Developer account.

## Security notes

- The Tauri **shell capability is scoped to `node` only** (`src-tauri/capabilities/default.json`).
  Note that `node -e <code>` is still expressible, so this is defense-in-depth, not a hard
  sandbox — it prevents spawning *other* binaries via the IPC layer.
- The dashboard server it spawns binds loopback (`127.0.0.1`) with the CSRF/CORS/path
  hardening from v0.5.1 + the v0.6 slice.
- The webview CSP is `null` for the first cut (own loopback content) — tighten before release.

## Layout

```
desktop/
├── package.json                  # @tauri-apps/cli + plugin JS bindings
└── src-tauri/
    ├── Cargo.toml                # tauri + plugin-shell + plugin-updater
    ├── build.rs
    ├── tauri.conf.json           # bundle, updater endpoint+pubkey, frontendDist=placeholder
    ├── capabilities/default.json # least-privilege: shell spawn(node) + kill + updater
    ├── frontend-placeholder/     # Tauri requires a frontendDist; the External webview replaces it
    ├── icons/                    # placeholders — regenerate with `tauri icon`
    └── src/
        ├── main.rs               # delegates to lib::run()
        └── lib.rs                # spawn node dashboard on free port → poll /api/health → External webview
```
