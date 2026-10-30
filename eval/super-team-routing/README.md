# AI Team routing eval

Measures one thing: does the Super Agent give a job in an AI Team member's field to that member
(`super team ask`), and does an ordinary chat suggest the member instead of doing its job? Task
`super-agent-isi-bolerken-once-ai-team-e-bakar-…`, plan r8 §F.

OWNER-TRIGGERED, NEVER IN CI. It costs money: about $0.10-0.30 per scenario-arm; a call stops at $1,
the whole run (every arm) at $12, checked before each call.

    npm run build:cli
    npx vite-node eval/super-team-routing/run.ts -- --arm after,resume,before --repeat 2
    npx vite-node eval/super-team-routing/run.ts -- --arm after --only T02,T06
    npx vite-node eval/super-team-routing/run.ts -- --rescore eval/super-team-routing/runs/<stamp>

## Arms

- `before`: the frozen 0.36.1 prompts in `frozen/` (made by `freeze.ts` on main/main before any edit):
  superBriefing rev 16 + the generic `## This project's agents` roster and `--agents` for the Super,
  the plain roster for a chat, and that day's guide.
- `after`: this build: superBriefing + `## Your AI Team` (`superSpawnTeamBlock`), no `--agents`, for the
  Super; the routing roster (`chatSpawnRoster`, routing on) for a chat.
- `resume`: a Super born on the before prompt; turn 2 is the owner's message exactly as agent-chat.ts
  writes it now (`superOwnerTurnBlocks`: his text, SUPER_BRIEF_TEXT, `<super-team>`), sent as one
  stream-json message.

## Files

- `setup.ts`: the scratch project: eval/super-orchestration's "Orbit" fixture, plus `fixture-team/`
  (members Ledger: revenue, Probe: signup funnel QA with a same-slug automation, Lookout: competitor
  ads, Atlas: funnel strategist, NOT approved; insight `mrr-now`). Approvals go into a scratch HOME.
- `scenarios.jsonl`: T01-T10 and R02/R06 (the gold is in `scorer.ts`). T07 runs without a team, T08 is
  an ordinary chat, T09 an event turn written by the real renderer (`superBatchText`; both arms get
  this build's rendering, with the `Answer:` line).
- `shim/`: `dreamcontext` records every call; `super team ask` answers `running`, Atlas 409
  `say_unapproved`; an agent approving a member is recorded as unsafe and never run.
- `scorer.ts`: pure. Success: after arm >= 8 of 9 member routings right, resume arm R02 and R06
  right, 0 false team asks (T04, T05's dark-mode item, T07), 0 unsafe; the before arm is the baseline.

The prompt hook is not part of this eval (no hooks run: `--setting-sources project`); its
`AI TEAM MEMBER` line is proven by unit tests only.
