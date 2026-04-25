---
persona: risk-skeptic
rounds_completed: 1
---

## Round 1 — 2026-04-25

### Executive Summary
Do not adopt as-is. The architecture is sound but six small changes are non-negotiable: (1) a `redactSecrets` helper feeding runs/transcripts/sleep, (2) typed-confirm + daily-cap + y/N on `marketing launch`, (3) header-only auth in meta-client (no `?access_token=`), (4) profiles-shaped `config.json` from day 1 even with single-profile UX, (5) move council presets from code to JSON data files, (6) ship 3 agents not 5. None block core design; all are cheaper now than retrofit.

### Position
Conditional NO on the plan as written. Conditional YES with the seven mitigations below. The token-leakage and real-spend gaps are the two showstoppers; everything else is cost-of-rework prevention.

### Reasoning

**Top risks ranked by severity x likelihood:**

1. **Token leakage via transcripts + sleep (HIGH x HIGH).** `runs/<ts>__<verb>.json` stores "request payload, response" and Graph URLs carry `access_token` by default. Agent stdout flows into `_dream_context/state/transcripts/`; rem-sleep reads transcripts and writes knowledge. Codebase grep finds zero existing redact helpers — only an aspirational "never exfiltrate" line in CLAUDE.md template. Secrets will land in long-term memory.
   *Mitigation:* one `redactSecrets(str)` in `src/lib/marketing/config.ts` masking any `.env` value. Three choke points: runs writer, meta-client logs, rem-sleep pre-pass that refuses files matching `META_*_TOKEN=`. One snapshot test.

2. **Real-spend accident on `marketing launch` (HIGH x MED).** One verb flips PAUSED->ACTIVE across an entire cohort. No spend cap, no second confirm, no time guard. Wrong cohort id = unbounded loss.
   *Mitigation:* require `--confirm <cohort_id>` typed verbatim; hard `max_daily_spend_usd` cap in `config.json`; print diff (`N campaigns, $X/day`) + interactive y/N even with `--confirm`. ~30 lines in `launch.ts`.

3. **Token in WebFetch / Graph URL (MED x HIGH).** Performance Monitor has WebFetch. Graph default puts token in querystring -> tool-use log -> sleep.
   *Mitigation:* meta-client uses `Authorization: Bearer` only; assert no `access_token=` substring in any built URL.

4. **Multi-account future (MED x HIGH).** Agency users with N clients return in 3 months. Full profile UX now = scope creep; ignoring it = JSON migration later.
   *Mitigation:* punt UX, design shape. `config.json` -> `{ default_profile, profiles: { main: {...} } }` on day 1. Single-profile UX. Adding `--profile` later is trivial; restructuring committed JSON is not.

5. **Council coupling via `--preset marketing` (MED x MED).** Marketing-specific code in council registry. Every vertical adds a preset = drift.
   *Mitigation:* redesign, don't drop. Council reads presets from `_dream_context/council/presets/*.json`. Marketing skill ships its preset as data on install. Council stays vertical-agnostic.

6. **5 sub-agents = scope creep (MED x MED).** Strategy + Performance are load-bearing. Brainstormer/CopyWriter overlap heavily. CreativeGenerator is a thin external-API wrapper.
   *Mitigation:* ship 3 (Strategy, Brainstormer+CopyWriter merged, Performance). Defer CreativeGenerator until brief->copy->asset is proven the bottleneck.

7. **Binary commits + learnings.md races (LOW x HIGH).** Contributors `git add -f` past gitignore; two Monitor invocations collide on append.
   *Mitigation:* (a) ship a `pre-commit` hook in `dist/hooks/` that rejects any staged path under `_assets/` or `_media/` regardless of gitignore. (b) Per-day learnings file `marketing-learnings/<YYYY-MM-DD>.md` that rem-sleep merges nightly — no flock needed.

**Specific call-outs requested:**
- *Token paths:* runs/ -> transcripts/ -> rem-sleep -> knowledge/. One redact helper at three writes closes all three.
- *Real-spend guards:* typed-confirm + daily cap + interactive y/N. "Are you sure?" alone is not enough.
- *Multi-account:* profiles-shaped config.json now, single-profile UX. Cheap insurance.
- *Pre-commit binaries:* ship a hook; .gitignore is not a security boundary.
- *5 agents:* right-sized at 3.
- *--preset:* keep concept, move from code to data.

### Reactions to peers
None yet (round 1).

### Open questions
- Does `_dream_context/state/transcripts/` actually capture sub-agent stdout, or only main-thread? If sub-agent only, leakage surface is smaller and mitigation #1 simplifies.
- Is there appetite for a `dreamcontext doctor` extension that scans existing knowledge files for accidentally-committed secrets, retroactively?
- Should `marketing launch` require an explicit `dreamcontext marketing budget set <cohort> <usd>` step before launch is even allowed (forcing the cap to be considered)?
