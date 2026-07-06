---
title: Make it a Business
start_date: '2026-08-24'
target_date: '2026-09-05'
depends_on:
  - improve-recall-mechanism
  - improve-sleep-quality
  - simplified-ux
  - make-dreamcontext-team-ready
  - include-codex-opencode-support
feature: null
impact: 5
effort: 4
status: null
created_at: '2026-07-04'
updated_at: '2026-07-06'
metric:
  label: MRR
  unit: $
  baseline: 0
  target: 2000
  current: 857
---
## Why

**Decision (2026-07-04): open, free CLI + closed-source, paid app — with zero data custody.**

We turn dreamcontext into a business by splitting it in two:

- **CLI — free & open source.** The CLI (context files + SessionStart hook + recall/sleep/roadmap/tasks + GitHub sync) stays MIT and free. It is our distribution channel and trust signal, not the thing we sell. Keeping it open kills the "you'll just copy the TypeScript" fear — the moat was never the code.
- **App — closed source & paid.** The desktop app (Sleepy, agent terminal, ⌘P/⌘K, 3D brain, the visual roadmap board, and the "easy even for non-technical teammates" experience) is the product. You pay a monthly subscription to use it. This is convenience/experience monetization, the Tower-over-git / TablePlus-over-psql model — the CLI power user is the funnel, the team/GUI user is who pays.

**Why this model and not a hosted cloud: zero data custody.** Team collaboration already runs over the customer's *own* GitHub — their context lives in the cloud *they* already trust, never on our servers. We are deliberately **not** the cloud. That means no "how can I trust you with my company's information" objection, no security/liability burden, no infra cost, no GDPR/SOC2 wall on every B2B deal. The responsibility for the data stays with the customer, where it belongs. **We just sell the app.** Positioning line: *"Your context never touches our servers — it lives in your GitHub. We ship the app, you own the data."*

**Pricing:** 14-day free trial → **$9.99/mo** (annual ≈ $99/yr, ~2 months free). Team / per-seat pricing is a later step once the single-user app converts. Paywall = license key + periodic activation check (carries no context data — only validates the license, so it doesn't break the "we're not the cloud" promise).

**Open question to resolve:** is shared-brain team collaboration a free-CLI capability (we sell only GUI convenience on top) or the app's headline gated feature? Current lean: keep capability in the free CLI, make the app so good the team won't live without the GUI.

## Notes

(PO notes — key results, context, links. Member tasks and rollups are computed:
run `dreamcontext roadmap` for the live board.)
