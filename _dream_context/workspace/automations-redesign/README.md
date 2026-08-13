# Automations redesign — the lane's working record

Shipped as `0098f57` (`feat(automations): the flow graph is the manifest, the run
asks in chat, and the queue never loses a fire`). This directory is the reasoning
BEHIND that commit, kept because a diff shows what changed and never why a
rejected alternative was rejected.

## What is here

- **`plan-validated.md`** — the plan as it was actually executed, 1,386 lines,
  verbatim. It is not a clean document and is not meant to be: it accreted six
  correction passes on top of the original, each one overriding the last, and the
  overrides are the valuable part. Read it back-to-front if you want the truth
  fastest — §12 beats §11 beats §10 beats §9/§8 beats §3/§4 on any conflict.

## The sections that carry the decisions

| § | What it holds |
|---|---|
| §0 | The owner's fixed decisions, D1–D9 — the ones that were never up for re-litigation |
| §2 | D-A … D-K, the design calls, including the four questions the owner declined to answer and how they were decided instead |
| §7 | **C1–C13** — the planner's own correction pass against real code. Seven wrong file paths, two blocking math errors in the layout algorithm, and an acceptance criterion that was unachievable as written |
| §8 | **A1–A6** — round-2 revisions, incl. A3 (`flow` is `FlowGraph \| null`, never `undefined` — the byte-identity hazard) and A4/R5 (a disabled automation's queued fire is kept, not dropped) |
| §9 | **S1–S7** — the security amendments. S3 is the one that mattered: `agent-chat.ts` was the real resume gate and it was automations-blind |
| §10 | **P1–P7** — consistency pass. P3 moved the approval-question spawn inside the per-slug lock; P5 corrected T24 to key on the resume uuid rather than a client-supplied tag |
| §11 | **R1–R5** — critic amendments. R1 moved the kind refusal inside `resumeWithAnswer`; R3 gave the flow graph real control flow instead of more prompt text |
| §12 | **X1–X4** — final security pass. X1 caught the capability-lifetime property the design had silently dropped; X2 caught that a refused upgrade renders as a crash |

## What the plan got wrong, corrected during the build

Recorded here because the plan is preserved verbatim and these are NOT fixed in it:

- **T12's file list omitted `runner.ts` and `verdict.ts`**, which both still created
  review cards. Between waves 6 and 9 those cards were write-only — created by two
  live paths, answerable nowhere.
- **AC31 said a drained fire for a disabled automation "clears the entry."** The
  shipped `tick.ts` re-parks it. R5 is right and AC31 was stale; the code is the truth.
- **T10's approval question was specified with `--permission-mode default`.** S2
  superseded it with `plan` + `--disallowedTools` + a guard prompt.
- **D-K specified a runner-rendered before/after diff.** Impossible: the approval
  registry stores a sha256 and no prior field values, so only the CHANGED-ness is
  knowable. It ships as a full-field REVIEW that says so.
- **`SessionMeta.kind` was double-booked** as both the tab-strip display kind and the
  transport kind. No section of the plan anticipated it; the runtime verify script
  found it. See `transportKind` in `AgentSurface.tsx`.

## Related

- Feature: `knowledge/features/automations-scheduled-headless-claude-jobs.md` — the
  distilled, durable version. Read that first; this directory is the audit trail.
- Pattern: `knowledge/patterns/wave-by-wave-rollout.md`
- Runtime proof: `scripts/verify/automations.mjs` (`npm run verify:automations`)
