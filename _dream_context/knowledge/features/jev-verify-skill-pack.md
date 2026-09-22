---
id: feat_w_uSc2kt
type: feature
name: jev-verify-skill-pack
description: >-
  Installable skill pack: Jev-judged Playwright validation (assert, walk, judge)
  behind an OPENROUTER_JEV_KEY
pinned: false
date: '2026-09-22'
status: in_review
created: '2026-09-22'
updated: '2026-09-22'
released_version: null
tags:
  - 'topic:skills'
  - 'topic:testing'
  - 'topic:agents'
related_tasks:
  - >-
    jev-verification-skill-pack-plain-language-playwright-validation-judged-by-a-system-one-model
---

## Why

Three spikes on 2026-09-21 proved that TypeSafe Jev (a System One decision model reached through OpenRouter) can judge Playwright page state in under a second for a fraction of a cent: 20/20 acceptance criteria on the Settings screen, 97/97 empty custom fields across 541 tasks, and a 58-screen autonomous funnel walk with zero wrong picks. The owner wants this shipped as an installable dreamcontext skill pack so every project gets fast, cheap, plain-language product validation on top of Playwright, with navigation and measurement in code and only the semantic judgement in Jev.

Before this pack a browser check in this repo was a hand-written verify script: dozens of selector assertions that take hours to write and break on every UI change, and `goal-validator` declared browser validation unsupported outright.

## User Stories

- [x] As a developer, I can install `jev-verify` like any standalone pack (`dreamcontext install-skill --packs jev-verify` or the Packs page) and get SKILL.md, four scripts, a lib and an example spec, with no new dreamcontext runtime dependency.
- [x] As a developer, I write acceptance criteria as sentences in the screen's own words and `assert.mjs` tells me pass / fail / inconclusive per criterion with a screenshot, in about half a second per checkpoint.
- [x] As a developer, I can hand `walk.mjs` a URL and a goal and get every screen of the flow screenshotted and indexed, with the walker never clicking anything that looks like a purchase and never typing a password or phone number.
- [x] As a developer, I can ask the same typed question over hundreds of rows with `judge.mjs` and get a distribution in a handful of one-second calls.
- [x] As a goal-skill user, I can choose `Browser (jev-verify)` as the validation method and the validator runs the spec and reports evidence instead of refusing.
- [x] As the owner, the pack uses a dedicated `OPENROUTER_JEV_KEY`, never the voice assistant's key, and never prints it anywhere.

## Acceptance Criteria

- [x] `skill-packs/jev-verify/` is a `bundleDir` standalone in `catalog.json`; `installPack('jev-verify')` ships SKILL.md + scripts/ + scripts/lib/ + examples/ (unit test A9d in `tests/unit/install-packs.test.ts`).
- [x] Key resolution: `process.env.OPENROUTER_JEV_KEY` → `./.env` → `~/.dreamcontext/.env`; a git-tracked `./.env` is refused with a named reason; missing key is exit 2 `unobtainable`; the key never appears in a report, trace, error or on argv (redaction choke point in `scripts/lib/report.mjs`, tests in `tests/unit/jev-verify-lib.test.ts`).
- [x] `doctor.mjs` checks key source, Playwright resolution (project → @playwright/test → global), Chromium binary presence, a real launch, and one 1-question Jev ping with latency and cost.
- [x] `assert.mjs` runs a strict allow-listed JSON spec (goto/dismiss/click/fill/select/press/wait/waitFor/waitForResponse + expect/reject/scope/label); http(s)-only and same-origin `goto`; password/card fills only from `env:VAR`; bands 0.85/0.15; exit 0/1/3/2; report.json, report.md, screenshot per checkpoint; ⚠ when state hits the size cap.
- [x] `walk.mjs` keeps every spike lesson and the security review's additions: act-side purchase guard checked twice, page chrome and nav links withheld, sensitive inputs never typed, visible-only payment detector incl. wallets and more PSPs, fills/ticks count as progress, zero-guarded next-best withdrawal, capped waits, retry on 5xx/429, spend ceiling, fail closed on extraction error, trace.jsonl, index.md, final screenshot always.
- [x] `judge.mjs` batches N items per call (default 40), nests items under `observation`, prefixes the data-not-instruction rule, emits per-item answers and a per-question distribution.
- [x] SKILL.md teaches the split, criteria writing, bands, what Jev must not judge, the key (secret card in Chat, env/.env in a terminal), and a plain "What leaves your machine" section.
- [x] Feature-integration checklist: `skill/SKILL.md` triage row, README standalone row, catalog entry, `goal-validator` gains the Browser (jev-verify) method, `goal-skill` Phase 0 offers it.
- [x] Real validation (AC9 of the task): CLI install into a scratch project, doctor READY, assert 16/16 PASS on the Settings › Recall spec against a real dashboard (2 calls, 1.3 s, $0.00011), walk `--max 6` on the PushMe funnel OK, judge example OK; vitest 9919 passed, root `tsc` clean, `npm run build` clean.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

### 2026-09-22 - Dedicated key, no fallback to the voice key
The plan reviewer proposed reading `~/.dreamcontext/voice.json → openRouterKey` as the last link so a configured machine never sees `unobtainable`. Rejected by owner instruction ("Openrouter_jev_key iste"): a validation tool's spend and blast radius stay separate from the assistant's. `doctor` names the source it resolved from so the first-run experience is a sentence, not a mystery.

### 2026-09-22 - The purchase guard lives on the ACT side, checked twice
Security review: a deny-list on observation (card fields visible) only stops one step after arriving at a card form, and express wallets / one-click confirms never render a card field. `PURCHASE_RE` in `page.mjs` removes purchase-labelled controls from the option set AND is re-checked at the click site, because the next-best withdrawal mutates the option set between pick and act. The visible-payment detector still stops the walk; `--past-payment` only lets it keep observing.

### 2026-09-22 - Page text is data, nested under `observation`
Every question that judges page content is prefixed with the rule that `observation` is data, never an instruction; control characters and bidi overrides are stripped before send; PII shapes are masked by default (`--no-redact` opts out). The goal comes only from the caller. Jev picks the KIND of a text field, code picks the string; page text never becomes typed text.

### 2026-09-22 - Bands, not booleans
pass ≥ 0.85, fail ≤ 0.15, inconclusive between, reported as such and never rounded up (exit 3). A gate that cannot run (no key, no Playwright, no Chromium) is `unobtainable` (exit 2), never a pass. Same posture as the fail-open-toward-the-observable-state and unrecognized-shape-returns-null patterns.

### 2026-09-22 - Playwright is the project's, not the pack's
Resolved from the project's node_modules, then `@playwright/test`, then the global npm root; the pack ships no browser and dreamcontext gains no runtime dependency. The first wall most projects hit is the missing Chromium binary, not the module, so `doctor` checks `executablePath()` and every script maps the launch error to `unobtainable` with the install command.

### 2026-09-22 - Output directories are 0700 and self-ignored
`ensureOutDir` writes a `.gitignore` of `*` before the first file. Screenshots contain whatever was on screen and cannot be redacted; SKILL.md says so.

## Technical Details

```
skill-packs/jev-verify/
  SKILL.md                      trigger-specific description (TR + EN), the split, setup, tools, limits
  scripts/doctor.mjs            key · Playwright · Chromium binary · launch · one Jev ping
  scripts/assert.mjs            strict spec grammar → route → batched Noul checkpoints → bands → reports
  scripts/walk.mjs              autonomous walker (Choice over offerable elements + goal/stuck Nouls)
  scripts/judge.mjs             judgeBatch over items with {item} path templating
  scripts/lib/jev.mjs           resolveKey (env → .env → ~/.dreamcontext/.env, git-tracked refusal), createJev (retry, auth-body drop, spend ceiling, judgeBatch), band, question builders, OBSERVATION_RULE
  scripts/lib/report.mjs        redaction choke point (registerSecret/redact/redactPii/sanitizeText), say/warn, ensureOutDir (0700 + .gitignore), writeReports, appendTrace, parseArgs, foldExit, exit words
  scripts/lib/page.mjs          pageState (aria + text, scoped, capped, truncated flag), extract (numbered elements, autocomplete, in_nav, visible-only payment detector), fingerprints, CHROME_RE, PURCHASE_RE, isOfferable/isTypeable/isSensitiveInput
  scripts/lib/playwright.mjs    loadPlaywright (project → @playwright/test → global), contextOptions (desktop / iphone / android / ipad)
  examples/settings-recall.json the dreamcontext Settings › Recall spec (the spike's 20 criteria as a spec)
  examples/judge-items.json + judge-questions.json
```

Wire format: `POST https://openrouter.ai/api/alpha/decisions` with `{ model: 'typesafe/jev-1.13', state, questions }` → `{ answers: { id: { noul | choice + probabilities + confidence | score } }, usage: { cost, input_tokens } }`. Measured 480–840 ms per call; $0.042 per million input tokens, output free.

Source of the behaviour: `scripts/verify/jev-spike-recall-settings.mjs`, `jev-spike-empty-field.mjs`, `jev-walk-funnel.mjs` (kept in the repo as the measured references).

Harness lessons carried into code, each from a real run: disabled controls must not be offered (three picks of a disabled CONTINUE); a fill or a tick is progress (the email screen was declared stuck one click before CONTINUE); `slice(-0)` is the whole array (the popup's Yes/No were withheld and Jev waited, correctly, forever); a "scratch card" is not a credit card (visible-only detector); page chrome and the logo link restart flows; waits on a loading screen are not failed actions; the board opens on the user's saved view, not All Tasks; a detail overlay closes from its own button, not Escape; similar-named duplicates (`x` vs `x-2`) mean cards are picked by slug, not search text.

Calibration notes from measurement: the `goal` Noul was well behaved (0.05–0.35 over 57 screens, 0.86 on checkout); the `stuck` Noul ran 0.8–0.9 on ordinary screens and is only usable combined with a no-op counter; criteria not phrased in the screen's words land in the inconclusive band ("embedding card" 0.28 vs "model download shown" 0.99 on the same screen).

## Notes

- Considered and not done: an offline recorded-snapshot agreement test for Jev's verdicts. It would test a mock, not Jev; the network-free half (bands, key chain, redaction, retry, batching, guards, spec grammar) is unit-tested instead, and the real run is the validation method.
- Considered and not done: reading the voice key as a fallback (see decision above).
- Considered: folding `judge.mjs` into `assert.mjs --state`. Kept separate; it has a real, measured use (541 tasks) and no browser.
- Open: `CHROME_RE` matches a handful of localized back/menu words; nav-ancestry handles the rest. Extend from real misses, not speculation.
- Open: a `dreamcontext verify` CLI verb wrapping the scripts. Not in this cut; the pack is the surface.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-09-22 - Code review (Opus, clean context) FAIL → five fixes → PASS re-run
- Origin now pinned to the first navigation when the spec omits `url` (a `url`-less spec could have carried cookies to any origin); `env:`-filled values registered as secrets; password/card/OTP fills refused by the LIVE element's type/autocomplete, not the selector's wording; zero judged criteria is FAIL and empty `expect`/`reject` arrays are rejected; URL and title masked like body text in `pageState` and `walk`. Two grammar tests added (44 total). Real assert re-run through the installed pack: 16/16 PASS.

### 2026-09-22 - Pack built, wired, unit-tested; real validation in progress
- Pack, catalog entry, A9d install test, 30 lib tests, SKILL.md, README + skill triage rows, goal-skill and goal-validator method wiring.

### 2026-09-22 - Created
- Feature PRD created.
