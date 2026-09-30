---
name: jev-verify
description: >-
  Fast, cheap product validation in the real browser: Playwright drives the page, TypeSafe's Jev
  (a System One decision model, via OpenRouter) judges plain-language acceptance criteria against
  the page's text state in ~0.5 s for a fraction of a cent, code decides. Three tools: `assert`
  (a scripted route with expect/reject checkpoints), `walk` (Jev navigates a flow on its own and
  screenshots every screen), `judge` (map-reduce the same typed questions over hundreds of items).
  Triggers: "validate this in the browser", "does the screen show X", "check every task/row for
  Y", "walk the funnel and screenshot each step", "run the acceptance criteria against the app",
  "Playwright test", "UI doğrulaması", "ekranı kontrol et", "funnel'ı gez", "her ekranın
  görüntüsünü al", "kriterleri gerçek uygulamada doğrula", and any goal-skill validation method
  that says Browser (jev-verify). Needs OPENROUTER_JEV_KEY and Playwright in the project.
alwaysApply: false
ruleType: "Tool Workflow"
version: "1.0"
---

# jev-verify — navigate in code, judge with Jev, decide in code

Playwright already returns the page as **text**: an accessibility snapshot (roles, names, states)
and the visible words. Jev reads that text and answers a typed question in one parallel pass —
"is Hybrid the selected option?" comes back as a probability, "which category does this field
open with?" as a choice with a confidence. It never writes prose and it never sees pixels.

Measured on 2026-09-21, against ground truth, before this pack existed:

| Run | Criteria | Agreement | Per call | Cost |
|---|---|---|---|---|
| Settings screen, before/after a click, with decoys | 20 | 20/20 | 520–800 ms | $0.0002 total |
| 541 tasks, "is this field empty" + category | 1082 | 97/97 empties, 0 false | ~700 ms per 80 questions | $0.01 |
| 58-screen live onboarding funnel, autonomous | 68 decisions | 0 wrong picks | 480–840 ms | $0.004 |

Every failure in those runs was in the harness, never in a judgement. The harness lessons are
now code in `scripts/lib/`.

## The split (do not move these lines)

- **Playwright**: navigation, waiting, measuring geometry, taking screenshots, reading the DOM.
- **Jev**: one bounded semantic question at a time over text — *given this screen, is X true?*
- **Code**: what gets typed, what is never clicked, thresholds, exit codes, when to stop.

Jev must **not** judge pixel geometry (line-height, overlap), colours or themes, or anything
security-critical ("the auth code appears in no DOM node" stays a string check). It cannot see
screenshots. For those, keep measuring in code; use Jev for what the *user reads*.

## Setup (once per project)

```bash
dreamcontext install-skill --skill jev-verify         # or via Packs in the dashboard
npm i -D playwright && npx playwright install chromium   # the pack ships no browser
node .claude/skills/jev-verify/scripts/doctor.mjs        # key · Playwright · Chromium · one $0.00002 ping
```

### The key: `OPENROUTER_JEV_KEY`

A dedicated OpenRouter key for this pack (it does **not** reuse the voice assistant's key — spend
and blast radius stay separate). Resolution order: `process.env` → `./.env` → `~/.dreamcontext/.env`.
A `./.env` that git tracks is **refused by name**, not silently used.

- **In dreamcontext Chat**, request it with a secret card — the value goes from the browser to the
  server to `.env`; the agent only ever sees a receipt:

  ```dream-view
  {"type":"secret","id":"jev-key","title":"OpenRouter key for Jev","fields":[{"key":"OPENROUTER_JEV_KEY","label":"OPENROUTER_JEV_KEY","hint":"An OpenRouter API key with access to typesafe/jev-1.13"}],"intro":"jev-verify judges Playwright page state with TypeSafe Jev through OpenRouter. The key is written to this project's .env (gitignored first) and never enters the conversation."}
  ```

- **In a terminal**: `export OPENROUTER_JEV_KEY=…` or a line in a gitignored `.env`. Never on argv —
  the scripts refuse to run if the key appears on the command line.

Missing key, missing Playwright or missing Chromium is **exit 2 `unobtainable`**, never a pass.

## What leaves your machine

To `https://openrouter.ai/api/alpha/decisions`, over TLS: the criteria you wrote, and for the
judged scope its `url`, `title`, accessibility tree and visible text (capped at 20k / 8k chars),
plus interactive-element labels for `walk`. **Screenshots never leave the machine.** E-mail, phone,
card and IBAN shapes are masked before sending (`--no-redact` to send literal values). Retention is
OpenRouter's, not ours. Default to **staging and a disposable account**: a page rendering other
people's data would disclose it to a third party your agreements may not cover.

Reports, traces and screenshots are written to an output directory created `0700` with its own
`.gitignore` of `*`. Screenshots contain whatever was on screen — the directory is not for sharing.

## Tool 1 — `assert`: a scripted route, judged in plain language

```bash
node .claude/skills/jev-verify/scripts/assert.mjs --spec checks.json [--out tmp/jev-assert] [--device iphone] [--headed]
```

The spec is a strict, allow-listed JSON grammar (unknown keys fail the run, `goto` is http(s) only
and must stay on the spec's origin, a password/card field may only be filled from `"env:VAR"`):

```json
{
  "url": "http://localhost:5173/?page=settings",
  "steps": [
    { "dismiss": ".modal-scrim" },
    { "click": "role=button[name='Recall']" },
    { "waitFor": "[role=radiogroup]" },
    { "label": "Recall, default", "scope": "main",
      "expect": ["The Haiku option is the currently selected recall mode"],
      "reject": ["An error message is currently displayed"] },
    { "click": "label:has-text('Hybrid')", "waitForResponse": { "url": "/api/sleep", "method": "PATCH" } },
    { "label": "Recall, after Hybrid", "scope": "main",
      "expect": ["The Hybrid option is the currently selected recall mode",
                 "A model download is shown in progress under the Hybrid option"] }
  ]
}
```

Steps: `goto` · `dismiss` (Escape while a selector exists — late modals) · `click` · `fill` ·
`select` · `press` · `wait` · `waitFor` (selector) · `waitForResponse` (put it ON the step that triggers
the request, so the listener is armed before the click) · a checkpoint with `expect` / `reject` / `scope` / `label`. Selectors are plain
Playwright selector strings.

Each checkpoint is **one** Jev call however many criteria it carries. Verdict per criterion:

| p | expect | reject |
|---|---|---|
| ≥ 0.85 | pass | fail |
| ≤ 0.15 | fail | pass |
| between | **inconclusive** — reported, never rounded up | inconclusive |

Exit codes: `0` all pass · `1` any fail or the route broke · `3` inconclusive only · `2` unobtainable.
Output: `report.md`, `report.json`, one screenshot per checkpoint. A ⚠ line tells you when the page
state hit its size cap — add a `scope` so the judged region is fully in view.

### Writing criteria that Jev can answer

- **Use the screen's own words.** "Embedding card visible" scored 0.28 on a screen that said
  "Downloading model… 0%"; "a model download is shown in progress" scored 0.99. Same screen.
- **One observable fact per sentence**, phrased as something a user could confirm by looking.
- **Add two or three `reject` decoys** about things not on the screen. A model that agrees with
  everything fails them; that is your calibration check for free.
- **Scope to the region** the criterion is about (`"scope": ".detail-panel"`). Unscoped state on a
  dense page truncates, and Jev then answers about a page it did not fully see.
- **Judge after the mutation lands**: `waitForResponse` on the PATCH, not a fixed sleep.

## Tool 2 — `walk`: Jev navigates a flow on its own

```bash
node .claude/skills/jev-verify/scripts/walk.mjs https://start.example.com/onboarding \
  --goal "Reach the plan selection screen as a plausible new user" \
  --email qa+jev@example.com --device iphone --max 80 [--fill first_name=Ada] [--out tmp/jev-walk]
```

Per step, one Jev call: a Choice over the offerable elements (plus scroll / wait / done), a Noul
"goal reached?", a Noul "stuck?". Every new screen is saved as `NN.png`; `index.md` lists each with
the action Jev took and its probability; `trace.jsonl` records exactly what Jev saw and picked.

**Never offered, never clicked** (checked when building the options and again at the click):
purchase-labelled controls (pay, buy, checkout, place order, subscribe, Apple/Google Pay, PayPal,
Klarna, "start my plan"…), disabled controls, page chrome (menu, back, close, home and language
links, nav links), password / file / tel / one-time-code inputs. The walk **stops** when a payment
control becomes visible (card fields, PSP frames, wallet buttons) — `--past-payment` only lets it
keep observing. Jev picks the *kind* of a text field; code picks the string from a fixed table.
Page text never becomes typed text. A spend ceiling (`--max-spend`, default $0.25) bounds a
looping or hostile page. Any extraction error stops the walk — it fails closed.

The `stuck` Noul runs high (0.8–0.9) on ordinary screens; the harness combines it with a no-op
counter and never stops on it alone. `goal` was well calibrated in measurement (0.05–0.35 across
57 screens, 0.86 on the checkout).

## Tool 3 — `judge`: the same questions over many items

```bash
node .claude/skills/jev-verify/scripts/judge.mjs --items items.json --questions questions.json [--batch 40]
```

Items are any JSON objects (task rows, tickets, page states). Questions are typed templates where
`{item}` points at the item inside the batch. 40 items × 2 questions is one ~1 s call. Use it for
"which of these 500 things has property X" and for semantic reads code cannot do ("which category
does this explanation open with"). Items are nested under `observation` and every instruction
carries the data-not-instruction rule, because item text may come from anywhere.

## Inside dreamcontext

- **goal-skill / goal-validator**: a task may record `Validation method: Browser (jev-verify)` with
  a spec path or inline expect lines. The validator runs `assert.mjs` and returns PASS only on exit 0
  with the report as evidence; exit 3 is reported as inconclusive, never PASS.
- **Verify scripts** in this repo: new browser checks that judge what the user *reads* go through
  `assert` with a spec under `scripts/verify/specs/`; geometry and security checks stay hand-coded.
- **Chat**: the agent runs a tool, then reports the verdict line and the report path; the key is
  obtained with the secret card above and never typed into the composer.

## Limits, stated plainly

- Text only. No visual judgement, no screenshots to the model.
- Calibrated is not infallible: a high-confidence answer can be wrong. Decoys and the inconclusive
  band are the defence, and security-critical checks stay deterministic.
- A live product is a live product: the walker's e-mail creates a real lead. Staging, or a
  disposable address.
- Jev's `choice` takes at most 255 options; `extract` caps at 120 elements per screen.
