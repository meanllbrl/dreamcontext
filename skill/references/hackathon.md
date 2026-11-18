# Hackathon (plugin)

Several teams solve ONE problem the owner gives, each on its own, over timed rounds; their results are shown side by side on the Hackathon page, a jury ranks them and the owner picks the winner. A plugin: `dreamcontext plugins install hackathon` (on the owner's yes) before any write.

## When

`/hackathon`, "hackathon", "let several teams try this", the page's **Yeni hackathon** button (it sends the request to the Super). Typical problems: a better home page (`screen`), a funnel A/B test that raises revenue (`experiment`), a plan for a hard change (`plan`).

## The flow (the agent sets it up, the owner starts it)

1. **Ask, as cards.** One AskUserQuestion card each, read cold: what to solve (the problem in his words), the kind (`screen` | `experiment` | `plan`), how long (the end time), and the limit. The limit is time plus at most a share of the weekly usage (default 15%); teams pause when the 5-hour window reaches 80%. Never quote a cost in money: the limit is time and usage share only.
2. **Draft.** `dreamcontext hackathon design --problem "<his words>" --kind <kind> [--target <repo>] --json > $TMPDIR/hackathon/<slug>.json`. No model call: every line comes from `hackathon stats` (past runs) with its reason and run count. Teams are personas (Claude or Codex; copies and different models may mix), each a trio (Kaptan + Yapıcı + Eleştirmen) or solo. With 4 or more teams one is the control team: it never peeks (always Claude).
3. **Edit.** Fill each team's `persona`, adjust names, models, rounds, round minutes, end time. Keep the file valid: `start` re-validates it.
4. **Create.** `dreamcontext hackathon start --design <file>` creates the run (`awaiting-owner`) and prints a card. Paste it as is:

   ```dream-view
   {"type":"hackathon","run":"<run-id>"}
   ```

   The owner reads the design on that card and presses **Başlat**. The start is bound to the design he read: an edit after the card was drawn makes him confirm the new design first. The end time counts from Başlat: a card started late gets every round.
5. **Watch.** `dreamcontext hackathon status [run]` / `show <run>`. The page shows the tables, each team's screen in a window frame, the team room, the peek between rounds, then the presentation and the results.

## What only the owner does

Start, resume after a pause, **Sürdür** (a run whose conductor stopped: reboot, crash), pick the winner and open the winner's PR are owner actions on the page (his key, his click). **Never** call those routes yourself (no curl, no fetch): the server refuses an agent's token for them. The PR is opened only after the secret scan passes and he confirms any hunk that runs elsewhere.

**Stop is open to anyone** (the safe direction): `dreamcontext hackathon stop <run> [--why "<reason>"]`. It only marks the run stopped; the conductor ends every team turn within a few seconds. A stopped run cannot be picked.

## Boundaries the teams run in

Each team works in its own clone under `~/.dreamcontext-hackathon/<run>/<team>/`, OS-sandboxed with no network (localhost included); it reads the brain and linked repos, writes only its own clone and `out/`. Secret files are denied to it, but its Bash can still reach the Mac Keychain (the card says so), so the PR scan looks for every known value plain and encoded. After the pick a team's folder goes only when its last copy is whole; its `out/` is kept for the results. v1 teams: Claude and Codex (Codex teams can read the whole disk and get no MCP; the design says so). Antigravity is refused.

## After a run

- `dreamcontext hackathon stats [--kind <kind>] [--json]`: what past runs taught (derived from every `result.json`); the next design uses it.
- `dreamcontext hackathon outcome <run> --pr merged|closed|none`: record what became of the winner's PR.
- `dreamcontext hackathon list [--json]`: every run, newest first.

Records: `_dream_context/hackathon/<run>/run.json` and `result.json` travel with the brain; the brief, team files and round records stay on this Mac.
