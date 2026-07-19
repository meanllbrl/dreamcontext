---
id: know_publish_checklist
name: publish-checklist
description: Steps to publish dreamcontext to npm and activate the curl install URL
tags:
  - devops
  - decisions
pinned: false
date: '2026-07-01'
---

# Publish / Release Checklist

Run these steps in order when you are ready to go live. The curl install URL and the
in-session update nudge only activate after the publish + merge steps are complete.

## 0. Docs & diagrams are current — DO THIS FIRST

**README.md and the deep-dive wiki (github.com/meanllbrl/dreamcontext/wiki — its own git repo, dreamcontext.wiki.git) MUST reflect what this release ships.** Before building or
publishing anything:```bash
npm run diagrams   # rebuild every Excalidraw board → re-render public/image/diagram-*.png```Then review and update:

- **README.md** — How It Works / Memory Recall figures, command surface, skill-pack
  table, and any version-specific copy.
- **Deep-dive wiki** — the section figures (problem · architecture · sleep · neuroscience ·
  council · recall) and any new mechanics. The wiki carries its own copies of the
  rendered PNGs under `images/` — after `npm run diagrams`, re-copy changed PNGs
  into the wiki clone and push it (it is a separate git repo; local checkout at
  `~/projects/dreamcontext-wiki`).

The figures are generated from editable Excalidraw boards at
`_dream_context/knowledge/diagrams/**/*.board.cjs` (house-style via the `excalidraw` skill).
`npm run diagrams` re-runs each board spec (writing the `.excalidraw.md` you can open in
Obsidian) and re-renders the PNGs the docs embed, via `scripts/diagrams/build-all.mjs`
(headless `@excalidraw/excalidraw`). If a mechanism changed, edit the board spec, re-run,
and the README figures update in place (same filenames; sync the wiki copies). **Do not publish with
stale docs or diagrams.**

## 1. Build and test```bash
npm run build && npm test -- run```Both must exit 0 with no failing tests. **Note:** bare `npm test` is vitest watch-mode — always pass `-- run` for a one-shot, CI-equivalent exit code. Do not proceed if either fails.

**As of 2026-06-30 this is also enforced in CI** (`.github/workflows/ci.yml` — the project's first real test gate, runs `npm test -- run` on every push to `main` and every PR). Before this, the only workflow was `desktop-release.yml` (build+sign+publish the desktop `.app` on a version tag), which never ran `vitest`; `npm publish`'s `prepublishOnly` only runs `build`. That gap is exactly how the `CAPTURE_RANK_PENALTY` recall regression (see `[[recall-engine-v2]]`) shipped silently across v0.10.1/v0.10.2 before being caught here. CI passing is a strong signal but does not replace running this step locally first.

## 2. Dry-run pack review```bash
npm pack --dry-run```Confirm the following are present in the file listing:

- `dist/` (compiled CLI)
- `skill/` (SKILL.md and related files)
- `install.sh`
- `README.md`
- `LICENSE` (Apache-2.0 as of v0.6.0; irrevocable MIT for ≤v0.5.4)
- `NOTICE` (added at relicense; required by Apache-2.0 — must be present)

If any are missing, check the `files` array in `package.json` and the tsup `onSuccess`
copy step.

## 3. Login to npm```bash
npm login```Authenticate with your npm account. If you have 2FA enabled, have your authenticator
ready.

## 4. Publish```bash
npm publish --access public```This pushes the current version. Confirm the version in `package.json` matches the
intended release before running. As of 2026-07-17, shipped version is v0.17.2 (npm +
tag); v0.18.0 is prepared and awaiting `npm publish`. Always bump `package.json` to the new version before publishing (the CI pipeline
does NOT bump automatically) — bump ALL FIVE version surfaces if desktop is part of the
release: `package.json`, `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/Cargo.toml`, and `Cargo.lock`'s `dreamcontext-desktop` entry. These
have drifted out of sync before (desktop left at an old version while the CLI bumped
ahead) — verify all five read the same version before publishing.

## 5. Merge install.sh + README to main and make the repo public

- Open a PR (or push directly) merging `install.sh` and the updated `README.md` to the
  `main` branch of `meanllbrl/dreamcontext` on GitHub.
- Make the GitHub repository public if it is currently private.

Only after this step does the curl URL become active:```
https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh```## 6. Smoke test the curl install

In a clean shell with no existing `_dream_context/`:```bash
curl -fsSL https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh | sh```Verify that `dreamcontext --version` prints the expected version after the script
completes. Also run `dreamcontext app install` to confirm the desktop app artifact
resolves from the GitHub Release (the binary is published separately from npm).

## Notes

- Confirm the version in `package.json` matches the release before publishing (do not publish with a stale version string).
- The in-session update nudge (version-check) reads from the npm registry via
  `npm view dreamcontext version`. It activates automatically once the package is live.
- The seeded `.version-check.json` fixture tests are offline-only and pass before
  publish; the live nudge path is exercised in production.
- As of v0.6.0 the package ships Apache-2.0. Ensure `package.json` `license` field reads `Apache-2.0` and `NOTICE` is in the `files` array.
- **Don't "quick bump" without running this workflow.** v0.10.0/v0.10.1/v0.10.2 were each published to npm as a bare version-bump-and-publish (no diagram rebuild, no README/DEEP-DIVE refresh, no `RELEASES.json` entry) — discovered 3 versions later (2026-06-30) as an undocumented gap that had to be backfilled by reconstructing `git log v0.9.2..HEAD` and auditing README/deep-dive wiki against the actual shipped code. Every version bump that reaches npm should run this full checklist, even a "trivial" patch — the alternative is a multi-version documentation debt that's much more expensive to reconstruct later than to write down at the time.
