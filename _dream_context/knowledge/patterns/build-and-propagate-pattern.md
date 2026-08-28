---
id: build-and-propagate-pattern
name: 'Build & Propagate Pattern (CLI → every vault, then the Tauri app)'
description: >-
  Build order is not a preference: dashboard, then CLI, then `dreamcontext
  update` to every vault, then the Tauri app LAST. Two footguns make a build
  look successful while shipping stale code — tsup's dashboard copy fails
  SILENTLY behind an existsSync guard, and resolve_cli prefers a globally-linked
  CLI over the bundled one, so a locally-run .app never exercises its own bundle.
tags:
  - architecture
  - 'topic:desktop'
  - 'topic:cli'
  - onboarding
  - 'kind:pattern'
pinned: true
date: '2026-07-26'
---

## Why This Exists

Three things in this repo's build are load-bearing and none of them announce themselves:

1. `tsup` copies `dashboard/dist` into `dist/dashboard` **only `if (existsSync('dashboard/dist'))`**. Run `build:cli` without a prior dashboard build and you get a clean, green, exit-0 build that ships **no dashboard at all** — discovered only when the app opens to nothing.
2. `tsup` runs with `clean: true`, so every CLI build wipes `dist/` and re-copies its assets from scratch. There is no incremental state to lean on.
3. The Tauri bundle lists `../../dist` as a **resource**. Whatever is in `dist/` at `tauri build` time is what ships. Build the app before building the CLI and you bundle yesterday's code.

The order is therefore not a preference. It is: **dashboard → CLI → propagate → app.**

## The Pattern

### Stage 0 — preconditions

- Tests green and `dashboard/ npx tsc --noEmit` exit 0. A build is not a check; it will happily bundle broken code.
- Working tree understood. This repo frequently carries parallel in-flight work — know what you are shipping.

### Stage 1 — CLI (which includes the dashboard)

```bash
npm run build          # = build:dashboard (Vite) THEN build:cli (tsup). Never run build:cli alone.
```

`npm run build:cli` on its own is the trap in Why #1. Always use the composite script.

**What `dist/` contains afterwards** (all copied by tsup's `onSuccess`): the bundled `index.js`, `templates/`, `agents/`, `skill-packs/`, `git-sync/askpass.cjs` (chmod 0755 — a non-executable askpass fails every authenticated git op with a bare "Permission denied"), `hooks/`, and `dashboard/`.

**Verify, don't assume:**

```bash
ls dist/index.js dist/dashboard/index.html dist/agents dist/skill-packs
test -x dist/git-sync/askpass.cjs && echo "askpass executable"
```

If `dist/dashboard/index.html` is missing, the dashboard did not build — go back, do not proceed.

### Stage 2 — propagate to every vault

**CHECK THE LINK, DO NOT ASSUME IT (2026-08-28).** This section used to state flatly that the global `dreamcontext` is npm-LINKED to this repo. On 2026-08-28 it was not: both `~/.nvm/.../bin/dreamcontext` and `/usr/local/bin/dreamcontext` resolved to a real npm INSTALL of the published 0.26.2, and the drift was invisible — `dreamcontext update --yes` ran happily in all six vaults and wrote `Setup version: 0.26.2`, i.e. it propagated the PUBLISHED skill docs over the new ones while looking like a successful propagation. The tell is that line: **if `Setup version` does not match `package.json`, the global CLI is not this checkout** and Stage 2 did the opposite of its job. Restore with `npm link` from the repo root, then verify:

```bash
dreamcontext --version                       # must equal package.json
for p in $(which -a dreamcontext); do readlink -f "$p"; done   # every path → THIS checkout's dist/index.js
```

WHEN LINKED, and only then: Stage 1 updates the CLI for **every project on the machine instantly** — no reinstall, and no opt-out. A broken build breaks every vault at once. (This also decides Stage 4: `resolve_cli()` prefers the global CLI over the bundle, so an unlinked machine runs the *published* CLI inside a freshly built `.app` — the app looks updated and behaves old.)

What does *not* propagate automatically is each vault's **installed skill copies** under its own `.claude/`. Those are regenerated from this repo's `skill/` + `skill-packs/` sources only when `update` runs **inside that vault**:

```bash
dreamcontext vaults list                     # the authoritative list — never hardcode it
# then, per vault:
cd <vault> && dreamcontext update --yes
```

Skip this and the CLI is new while every agent still reads the old skill docs — the exact drift `feature-integration-pattern.md` exists to prevent, reintroduced at the last step.

### Stage 3 — the Tauri app, LAST

```bash
cd desktop && npm run tauri build -- --bundles app    # what desktop-release.yml actually runs
```

**Pass `--bundles app`.** The bare `npm run tauri build` also targets the dmg, and `bundle_dmg.sh` fails on this machine — after the `.app` has already been bundled correctly. The run then ends with "failed to bundle project", which reads as a failed build when the artifact you need is sitting there, finished. Don't debug the dmg; it is not shipped.

The bundle ships `../../dist`, `../../skill-packs`, `../../skill`, and `sleepy` as resources. `frontendDist` is a **placeholder** — Tauri does not build a frontend here. The Rust shell spawns `node <cli> dashboard --launcher` on a free loopback port at runtime and points a webview at it, which is why the CLI build must already be correct.

**Capability changes need this stage.** `desktop/src-tauri/capabilities/*.json` is read at app startup, so any new window label or permission (e.g. a `checklist-*` window) is inert until the app is rebuilt and relaunched — not merely reloaded.

### Stage 3b — never edit a bundled resource while the app is building

The Tauri bundle ships `../../dist`, `../../skill-packs`, `../../skill` and `sleepy` **as resources**, copied at the *bundling* step — which happens only after a long Rust compile. So a `skill/SKILL.md` edit made ten minutes into a build lands in a race you cannot see: early enough and it ships, late enough and it doesn't, and **the build succeeds either way**.

Treat every path in `bundle.resources` as frozen from the moment `tauri build` starts. If you must change one mid-build, don't reason about the timing — verify the artifact:

```bash
grep -c "<the thing you just added>" \
  desktop/src-tauri/target/release/bundle/macos/dreamcontext.app/Contents/Resources/skill/SKILL.md
```

If it's absent, rebuild. This is cheap to check and impossible to infer.

### Stage 4 — verify the app actually runs what you shipped

**The footgun that makes local testing lie.** `resolve_cli()` (`desktop/src-tauri/src/lib.rs`) resolves in this order:

1. `$DREAMCONTEXT_CLI`
2. **`find_global_cli()`** ← a dev machine with the npm link hits this
3. the bundled `resource_dir/dist/index.js`

So on the machine that built it, the `.app` runs **the repo's `dist/`, not its own bundle**. Launching it locally therefore does *not* test the bundle — it tests your working tree. A bundle missing `dist/dashboard` looks perfectly fine until it reaches a machine with no global install.

To exercise the real bundle, remove the global link (or test on a clean machine); to force a specific CLI, set `DREAMCONTEXT_CLI`.

## Checklist (copyable)

- [ ] Tests green, `dashboard` tsc exit 0
- [ ] `npm run build` (composite — never `build:cli` alone)
- [ ] `dist/dashboard/index.html` exists; `dist/git-sync/askpass.cjs` is executable
- [ ] `dreamcontext --version` equals `package.json` (else `npm link` first — see Stage 2)
- [ ] `dreamcontext vaults list` → `dreamcontext update --yes` in each; each reports the NEW `Setup version`
- [ ] `cd desktop && npm run tauri build`
- [ ] Relaunch the app (capability/permission changes need a real restart)
- [ ] If verifying the bundle rather than the working tree: test without the global link

## Anti-patterns

- **`npm run build:cli` alone.** Silently ships no dashboard. The `existsSync` guard means no error, no warning, exit 0.
- **Tauri build before CLI build.** Bundles the previous `dist/`. Green build, stale app.
- **Trusting a locally-launched `.app`.** It's running your repo, not its bundle (Stage 4) — and if the global link is missing, "your repo" is actually the published npm package.
- **Assuming the npm link is in place.** It silently reverts to a published install (an `npm i -g` anywhere does it), and every downstream stage then succeeds while shipping the old code.
- **Hardcoding the vault list.** It changes; `dreamcontext vaults list` is the source of truth.
- **Treating a green build as a passing test.** It bundles whatever compiles.
