---
id: know_publish_checklist
name: publish-checklist
description: Steps to publish dreamcontext to npm and activate the curl install URL
tags:
  - devops
  - decisions
pinned: false
date: '2026-06-15'
---

# Publish / Release Checklist

Run these steps in order when you are ready to go live. The curl install URL and the
in-session update nudge only activate after the publish + merge steps are complete.

## 0. Docs & diagrams are current — DO THIS FIRST

**README.md and DEEP-DIVE.md MUST reflect what this release ships.** Before building or
publishing anything:```bash
npm run diagrams   # rebuild every Excalidraw board → re-render public/image/diagram-*.png```Then review and update:

- **README.md** — How It Works / Memory Recall figures, command surface, skill-pack
  table, and any version-specific copy.
- **DEEP-DIVE.md** — the section figures (problem · architecture · sleep · neuroscience ·
  council · recall) and any new mechanics.

The figures are generated from editable Excalidraw boards at
`_dream_context/knowledge/diagrams/*.board.cjs` (house-style via the `excalidraw` skill).
`npm run diagrams` re-runs each board spec (writing the `.excalidraw.md` you can open in
Obsidian) and re-renders the PNGs the docs embed, via `scripts/diagrams/build-all.mjs`
(headless `@excalidraw/excalidraw`). If a mechanism changed, edit the board spec, re-run,
and the README/DEEP-DIVE figures update in place (same filenames). **Do not publish with
stale docs or diagrams.**

## 1. Build and test```bash
npm run build && npm test```Both must exit 0 with no failing tests. Do not proceed if either fails.

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
intended release before running. As of 2026-06, current shipped version is v0.8.6;
the active planning version is v0.9.0. Always bump `package.json` to the new version
before publishing (the CI pipeline does NOT bump automatically).

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
