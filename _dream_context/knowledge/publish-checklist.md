---
id: know_publish_checklist
name: publish-checklist
description: Steps to publish dreamcontext to npm and activate the curl install URL
tags:
  - devops
  - decisions
pinned: false
date: '2026-05-31'
---

# Publish Checklist (v0.5.0)

Run these steps in order when you are ready to go live. The curl install URL and the
in-session update nudge only activate after steps 4 and 5 are complete.

## 1. Build and test

```bash
npm run build && npm test
```

Both must exit 0 with no failing tests. Do not proceed if either fails.

## 2. Dry-run pack review

```bash
npm pack --dry-run
```

Confirm the following are present in the file listing:

- `dist/` (compiled CLI)
- `skill/` (SKILL.md and related files)
- `install.sh`
- `README.md`
- `LICENSE`

If any are missing, check the `files` array in `package.json` and the tsup `onSuccess`
copy step.

## 3. Login to npm

```bash
npm login
```

Authenticate with your npm account. If you have 2FA enabled, have your authenticator
ready.

## 4. Publish

```bash
npm publish --access public
```

This pushes `dreamcontext@0.5.0` (the current version). Confirm the version is `0.5.0`
in `package.json` before running.

## 5. Merge install.sh + README to main and make the repo public

- Open a PR (or push directly) merging `install.sh` and the updated `README.md` to the
  `main` branch of `meanllbrl/dreamcontext` on GitHub.
- Make the GitHub repository public if it is currently private.

Only after this step does the curl URL become active:

```
https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh
```

## 6. Smoke test the curl install

In a clean shell with no existing `_dream_context/`:

```bash
curl -fsSL https://raw.githubusercontent.com/meanllbrl/dreamcontext/main/install.sh | sh
```

Verify that `dreamcontext --version` prints `0.5.0` after the script completes.

## Notes

- The version is already `0.5.0` in `package.json` — do not bump it before publishing.
- The in-session update nudge (WS3 version-check) reads from the npm registry via
  `npm view dreamcontext version`. It activates automatically once the package is live.
- The seeded `.version-check.json` fixture tests are offline-only and pass before
  publish; the live nudge path is exercised in production.
