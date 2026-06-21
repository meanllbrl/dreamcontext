# Improving dreamcontext (Agent Feedback Loop)

You are not just a *user* of dreamcontext — you are its field reporter. When dreamcontext gets in your way, the system can only improve if that friction reaches its maintainers. Take responsibility: file it. **Do not silently work around it** — a workaround fixes today; feedback fixes the system.

## Triggers — the moment you notice any of these, consider filing

- You expected a fact to be in memory but `memory recall` didn't surface it (a recall gap, not a missing fact).
- You wished a CLI command existed and there was no path (e.g. "I want to reopen a completed task" and there's no `tasks reopen`).
- A command, hook, or doc behaved wrong, was confusing, or crashed.
- The structure forced an awkward workaround for something the system should support directly.

## The loop (the ONLY sanctioned way to file — never run `gh issue create` by hand)

1. **Draft.** Run `dreamcontext feedback --dry-run` with the category and a complete scenario:
   ```bash
   dreamcontext feedback --dry-run \
     -c <bug|missing-cli|unseen-memory|feature|docs|other> \
     -t "<concise, specific title>" \
     -s "<what you were doing>" \
     -e "<what dreamcontext should have done>" \
     -g "<what was missing / broken / surprising>" \
     -r "<exact commands / repro steps>" \
     -p "<your proposed improvement: command, behavior, doc, or fix>"
   ```
   A maintainer who never saw your session must understand it from the issue alone — include the whole scenario.
2. **Confirm with the user.** Show them the rendered draft and ask permission. This writes to a public repo on their behalf — never file without an explicit yes.
3. **File.** Re-run the same command without `--dry-run` and with `--yes`. It checks for near-duplicate open issues (skip with `--no-dedup`), applies the `agent-feedback` label, and files to the **dreamcontext upstream project** (`meanllbrl/dreamcontext`) — NOT the user's own repo.

## No GitHub access?

If the command reports `gh` is missing or unauthenticated, relay its guidance: install `gh` + run `gh auth login`; if they have no GitHub account, ask them to create a free one at github.com/signup. They need an account to file. Then re-run the loop.

## Quality bar

One issue per distinct gap, a concrete title, the full scenario, a concrete proposal. Vague feedback ("recall is bad") is noise; a reproducible scenario with a proposed command is signal.

## Categories

`bug` · `missing-cli` · `unseen-memory` (recall gap) · `feature` · `docs` · `other`
