---
id: know_geh3rxpz
name: >-
  Decision: Should dreamcontext 0.20.2 be published to npm now, or batched with
  more features into a larger release?
type: decision
source_debate: council_p_kpwMTP
topic: >-
  Should dreamcontext 0.20.2 be published to npm now, or batched with more
  features into a larger release?
personas:
  - release-discipline-steward
  - field-stability-auditor
  - user-value-economist
rounds: 1
created_at: '2026-07-23'
updated_at: '2026-07-23'
tags:
  - decision
  - council
---

## Verdict

**Publish 0.20.2 now — but gate the `npm publish` step on running the full standing checklist first: write the 0.20.2 `RELEASES.json` + `CHANGELOG.json` entries, resolve the two uncommitted files, run the pack dry-run and the curl-install smoke test.** Do not batch it behind undefined future features.

- **Confidence**: medium. Two of three personas back publishing (78, 70) against one batch vote (72); convergence is 67% toward A. It is a clear majority, not a split — but it is a single Quick round, and the two sides are closer on substance than the vote implies (see the minority view).

The batch case rests entirely on real, untested-in-the-wild surface area — and it collapsed on one point neither batch-voter could answer: there is no defined exit criterion. "Let it soak" with no feature list and no ship date is how value sits on main indefinitely, and it does nothing to close the documentation gap that already exists on this branch. The publish case wins because shipping now, correctly ritualized, both delivers council v2 to users and forces the paper trail to catch up. The field-stability concern is not dismissed — it converts into a cheap pre-publish dogfooding pass on the two new surfaces, which costs hours, not a delayed release.

`Final vote: A 2×(78,70) — B 1×(72)`

## Decision card

| Chosen | Runner-up | Deciding factors | Strongest dissent | Conditions to revisit |
|---|---|---|---|---|
| A — Publish now (checklist-gated) | B — Batch with a larger release | No defined batch exit criterion; council v2 is real announceable value; unreleased value = zero user access | field-stability-auditor — two new surfaces have only ever run on the maintainer's laptop, and the auto-update nudge pushes any breakage to everyone within days | Batch only if a dated, named killer feature lands within 2 weeks |

## Why

> *Consensus: release-discipline-steward R1, user-value-economist R1*

- **No one proposed a real reason to wait.** The batch case is "let it soak," but soak time has no feature set and no ship date attached. An open-ended hold is not a plan — it is a decision to do nothing, indefinitely, while value sits on main.
  *— release-discipline-steward R1, user-value-economist R1*
- **Council v2 alone clears the announcement bar.** Live debates + structured verdicts + the chamber board is a coherent, story-carrying UX upgrade — enough to justify the in-session update nudge on its own. The permission pill and Lab categories ride along as honest supporting QoL.
  *— user-value-economist R1*
- **Unreleased value is zero user value, and batching slides into never.** 0.20.2 is committed, 3951 tests pass, and it installs locally — friction to ship is near zero. Every day it sits on main is a day users cannot `npm install` and get council v2.
  *— user-value-economist R1*
- **Waiting does not write the release record — running the checklist does.** The failure signal is already present on this branch: all five version surfaces read 0.20.2, but `RELEASES.json` and `CHANGELOG.json` still stop at 0.20.1, with two uncommitted files sitting on top of the bump commit. This is the exact shape of the v0.10.x scar. Batching adds surface area to document without adding any process rigor.
  *— release-discipline-steward R1*
- **Small, frequent, fully-ritualized releases beat large drifting ones.** The longer main runs ahead of npm, the bigger the eventual checklist burden and the higher the odds of another undocumented gap. Ship now, correctly, and keep the drift small.
  *— release-discipline-steward R1*

## Minority view & revisit conditions

**field-stability-auditor's case, at its strongest:** npm has no meaningful rollback, and the in-session update nudge gives you no gradual rollout — the first users to update are your canaries whether you chose them or not. 0.20.2 carries three things that have never touched another machine: council v2's concurrent verdict/chamber-board rendering, lab insight-category grouping over datasets that may be sparse or malformed in the wild, and renderer/animation changes on the terminal hot path (untested on iTerm2, Hyper, Alacritty, tmux, Kitty). A few days of the maintainer simply *using* these surfaces on varied project shapes would catch the obvious breakages — deadlocks, empty-dataset crashes, non-ANSI renderer hangs — at essentially zero cost. The A-voters concede the mechanism (the nudge does push everyone fast) and concede a bug on main could force a ship; they only dispute that *this* release is risky enough to hold.

This view **becomes the right call** under any of these observable triggers:
- **A pre-publish dogfooding pass reproduces a crash or hang** on either new surface with sparse/malformed insight data or on a non-ANSI terminal (Alacritty/tmux/Kitty) → hold and fix before publish.
- **Either new surface is confirmed default-on with no fail-soft path** (the auditor's unanswered open question resolves to "hard-fails on bad data") → batch until it degrades gracefully.
- **There is no committed 0.20.3 hotfix SLA** — i.e. nobody can ship a fix within, say, 24 hours of a field report → the no-rollback risk is unhedged, so soak first.
- **The pre-publish smoke test cannot exercise the renderer changes on at least one non-maintainer terminal** → the hot-path risk is unmeasured; dogfood before shipping.

Absent these, the minority's own concession applies: if dogfooding coverage would be negligible anyway, waiting adds nothing.

## Open risks

- **Field breakage on the two never-shipped surfaces.** Council v2 concurrent-verdict handling or lab category grouping crashes on real/edge-case data; the auto-update nudge spreads it fleet-wide within days. *Monitor:* first-24h error reports on council and lab commands; watch for empty/sparse-insight crashes. *Mitigate:* a short pre-publish dogfooding pass and a standing 0.20.3 hotfix SLA. *— field-stability-auditor R1*
- **Renderer/animation changes hang non-ANSI terminals.** The terminal hot-path change is untested outside the maintainer's setup. *Monitor:* smoke-test the desktop terminal renderer on at least one of iTerm2 / Alacritty / tmux before publish. *— field-stability-auditor R1*
- **The checklist gap ships anyway.** If publish happens before `RELEASES.json`/`CHANGELOG.json` get their 0.20.2 entries and the two uncommitted diffs are resolved, this reproduces the v0.10.x documentation-debt scar under a "shipped" version. *Monitor:* block `npm publish` until both files carry a 0.20.2 entry and `git status` is clean. *— release-discipline-steward R1*
- **Orphaned uncommitted diffs.** `AgentSetup.tsx` and `agent-terminal.ts` sit on top of the bump commit — unclear whether they belong to 0.20.2 or the next version. Publishing with them unresolved either ships unintended code or strands work. *Monitor:* explicitly commit-or-stash them and confirm intent before publish. *— release-discipline-steward R1*
- **Diagrams/docs never regenerated for the four post-0.20.1 features.** No confirmation that `npm run diagrams` / README cross-check ran since council v2 and lab categories landed. *Monitor:* run the doc/diagram regeneration as part of the checklist. *— release-discipline-steward R1*

---

_Promoted from council debate `council_p_kpwMTP` on 2026-07-23. See `_dream_context/council/council_p_kpwMTP/final-report.md` for the full record._
