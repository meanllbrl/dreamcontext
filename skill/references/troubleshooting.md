# Troubleshooting — symptom → cause → careful fix

When something in the brain looks broken, start here. Every entry below follows the same
rule: **diagnose first, repair with the purpose-built command, never hand-edit the state
files the repair commands exist to protect.** When no entry matches, run
`dreamcontext doctor` and read what it reports before improvising.

---

## Duplicate tasks — the same task appears 2–4× in `tasks list`

**Symptom:** `dreamcontext tasks list` shows what looks like the same task several times,
usually with a numeric suffix (`my-task`, `my-task-2`, `my-task-3`); `state/` has grown
`<slug>-N.md` mirror files far beyond the real task count — typically right after a
team brain merge.

**Cause:** the committed sync ledger (`state/.tasks-map.json`) lost or corrupted the
mapping between local mirrors and remote tasks (e.g. a team-merge conflict on it), so a
pull couldn't match incoming remote tasks back to their existing mirrors and minted fresh
`-N` duplicates instead — each a new dcId pointing at the SAME remote task.

**Fix — `dreamcontext tasks dedup`, carefully, in this exact order:**

```bash
dreamcontext tasks dedup --dry-run   # 1. ALWAYS first: prints the exact plan, writes nothing
# 2. READ the plan: every family, which slug survives, which files get removed,
#    which map entries get repointed. Families mapped to genuinely DIFFERENT
#    remote tasks are listed as "skip" — they are never merged.
dreamcontext tasks dedup --yes       # 3. Apply only after the plan looks right
```

- **LOCAL-ONLY guarantee:** `tasks dedup` never talks to ClickUp or GitHub — no remote
  adapter is ever constructed. It merges each family to its canonical slug (newest body
  kept, changelogs unioned), repoints `.tasks-map.json`, and removes the redundant files.
- **Never** hand-delete the extra `state/<slug>-N.md` files or hand-edit
  `.tasks-map.json` — that's the ledger every sync command trusts; a wrong hand-edit
  re-orphans the mapping instead of healing it.
- On a brain you didn't create the duplicates in, read the `--dry-run` plan extra
  carefully before applying.

Full mechanics → [integrations.md](integrations.md#healing-duplicate-task-families-tasks-dedup--backend-generic).

## Sync refuses to run: `corrupt_ledger` / "unresolved merge conflict markers"

**Symptom:** any task-sync command fails with
`state/.tasks-map.json has unresolved merge conflict markers` (or "is not valid JSON").

**Cause:** a git merge left literal `<<<<<<<` conflict markers (or other corruption) in
the committed sync ledger. Sync commands refuse loudly rather than silently treating a
corrupt map as empty — that silent fallback is exactly what used to create duplicate
task families.

**Fix:** run `dreamcontext tasks dedup` (dry-run first, as above) — it heals the
conflicted map with a lossless union of both sides, then repairs any duplicates the
corruption already caused. Do not resolve the markers by hand unless you know exactly
which side owns each entry.

## Brain sync stuck: `awaiting-agent` / `already-awaiting-agent`

**Symptom:** `brain sync` (or the sync inside `sleep done`) stops reporting a pending
team merge awaiting resolution.

**Cause:** two people edited the same prose section of a knowledge/feature doc. The CLI
auto-merges every deterministic file (JSON ledgers, task `.md`) and defers only the
prose overlap to the agent.

**Fix:** run the **`/dream-sync`** skill — it reads the base/ours/theirs snapshots under
`state/.brain-merge/` and writes the real semantic merge — then `brain sync --continue`.
Never drive `--resume`/`--continue` unattended. Full model → [brain-sync.md](brain-sync.md).

## Structure looks off / links broken — `dreamcontext doctor`

**Symptom:** ghost task↔feature links, missing files, frontmatter drift, or anything
that "smells wrong" without a clearer symptom above.

**Fix:** `dreamcontext doctor` validates the whole `_dream_context/` structure and
reports issues; `dreamcontext doctor --heal-links` additionally applies the
deterministic task↔feature link fixes (adopt back-refs, drop ghost/foreign
`related_tasks` entries, canonicalize slugs). Read the report before repairing anything
by hand. Agents repairing programmatically should run `dreamcontext doctor --json`
instead: every check carries a stable `code`, plus `subject`/`evidence`/`supportedFixes`
where annotated — repair by picking a supported fix (one per round, re-run between
rounds), not by guessing. Contract → [cli-reference.md](cli-reference.md).

## The snapshot arrived as a 2KB preview / the brain looks empty

**Symptom:** the session opened with a `Full output saved to: …` line instead of the
context, or the snapshot carries a `⚠️ CONTEXT IS INCOMPLETE` banner under its first
heading. The agent behaves as if the project has no memory and starts re-exploring the
codebase it already mapped.

**Cause:** the rendered snapshot exceeded the harness's 20,000-character hook-output
limit, so Claude Code persisted the whole thing to a file and injected only the first
2,000 chars as a blind positional preview. The demotion ladder ran every rung it could
and still could not fit — almost always because the core files have grown past their
anti-bloat ceiling.

**First, don't start blind.** If a `Full output saved to:` path is in your context,
`Read` that file now — the full brain is in it. The banner says this too, and it is
placed inside the preview window precisely so it survives the cut.

**Then fix the cause:**

```bash
dreamcontext doctor        # reports snapshot size + every core file over the ceiling
```

`doctor` flags each `core/*.md` past **~4,000 characters** or **~150 lines**. Trim the
flagged files the same way the sleep cycle does: extract the lowest-value section to
`knowledge/<slug>.md`, replace it with a one-line reference, and keep the summary. The
extracted content stays findable through `dreamcontext memory recall` — nothing is lost.

**Start with `core/0.soul.md` and the active `people/<slug>.md`.** These two are
constitutions — the agent's and the person's — so both render **verbatim in every
snapshot**: never-evict, no compression rungs, no cap. They are the files the ladder cannot
help with, which is why an oversized soul *or* constitution is a `doctor` **error**
(never-evict tier over the limit) rather than a warning. The fix is content, not render
settings:

- **`0.soul.md`** — move every conditional "when X, do Y" rule into `knowledge/patterns/`,
  where recall fetches it on the prompt that needs it, and keep only the unconditional
  identity.
- **`people/<slug>.md`** — keep only what is true about the *person*. Project trivia,
  workflow recipes and one-off notes belong in `knowledge/` or the right core file; a
  constitution is not a junk drawer.

That ~4,000-char authoring ceiling matters *most* on these two.

**Measure characters, not lines.** A 69-line core file of dense bullets is still 13KB,
and the snapshot pays bytes, not lines. A file can sit comfortably under the 150-line
guideline while being the entire reason the snapshot busts the limit — which is why
`doctor` names the character count first.

**Not the fix:** raising `DREAMCONTEXT_SNAPSHOT_BUDGET`. The budget is what keeps the
render under the harness ceiling; raising it only trades a curated demotion for the
harness's blind positional cut. Full ladder → [cli-reference.md](cli-reference.md).

## The snapshot says `## Person (Active — UNRESOLVED)`

**Symptom:** the SessionStart snapshot carries a `## Person (Active — UNRESOLVED)` heading
and one line saying *"No constitution is loaded"* instead of the person's preferences.
`dreamcontext doctor` warns *"Active person unresolved on this machine"* on a multi-person
vault.

**Cause:** this is **by design, not a bug**. Active-person resolution walks
`DREAMCONTEXT_PERSON` → this machine's pin → git `user.email` matched against the roster →
a solo vault's only person → nothing, and it **never guesses**. Rendering somebody else's
constitution because this machine could not be identified is the one failure mode worse
than rendering none.

**Diagnose first — the notice names the reason, and so does `whoami`:**

```bash
dreamcontext people whoami   # Person / Name / Source / Why — the Why names every rejected rung
dreamcontext people list     # who is on the roster (`← you` marks the active person)
```

**Fix — pick the one that matches the reason:**

| Why says | Fix |
|---|---|
| `git user.email <addr> matches no person in this vault` | Add that address to your roster row: `dreamcontext people add "<Your Name>" --email <your git email>` (re-running on an existing person **merges**, it never overwrites prose). |
| `no git user.email on this machine and no pin` | Either set `git config user.email`, or pin the machine: `dreamcontext people whoami --set <slug>`. |
| `DREAMCONTEXT_PERSON="…" rejected: not a valid person slug` | The env var does not name a roster key. Unset it or correct it — resolution already fell through to the next rung, so a valid pin still wins. |
| `.brain-local.json activePersonSlug="…" rejected` | A stale or hand-edited pin. Re-pin (`whoami --set <slug>`) or clear it (`whoami --clear`). |
| `people/people.json lists no people` / `could not be read` | A corrupt or empty roster — `doctor` reports it as an **error** with the parse message. Fix `_dream_context/people/people.json`, then re-run `doctor`. |
| `person:<slug> resolved (…) but _dream_context/people/<slug>.md is missing` | The roster row exists, the constitution file does not: `dreamcontext people add "<Name>"` re-scaffolds it without touching existing prose. |

**Not the fix:** editing someone else's `people/<slug>.md`, or pinning to a teammate so
*something* renders. The pin is machine identity — `state/.brain-local.json`, gitignored,
and it never enters the synced brain.

**Known limitation:** the dashboard's **brain graph** does not render `people/` yet. People
are visible on the Core page (People group, `● active` badge) and through
`dreamcontext people list`, but they do not appear as nodes in the graph view. Follow-up
work, not a corrupted vault.

## `inbox/1.user-residue.md` is still there

**Symptom:** after upgrading to 0.23.0, `_dream_context/inbox/1.user-residue.md` exists and
stays there. `dreamcontext migrations pending` prints an instruction for step
`distribute-user-md-residue`.

**Cause:** also by design. Migration 0.23.0's `split-user-file` step moved the deterministic
parts of `core/1.user.md` — `## Identity`, `## Preferences`, `## Communication Style` into
the owner's `people/<slug>.md`, and the `## People` bullets into `people/people.json`. Every
**other** section was copied **verbatim** into the residue file, because deciding where prose
belongs is judgment, not a string transform. The remainder is an **agent task**, and it has
not been run yet.

**Fix — run the pending agent task (the sleep cycle dispatches `sleep-migration` for it, or
do it in-session):**

```bash
dreamcontext migrations pending    # prints the full instruction, id `distribute-user-md-residue`
```

The routing it prescribes: `## Project Details` / `## Skills & Capabilities` →
`core/4.tech_stack.md`; `## Project Rules` → `core/0.soul.md` as **unconditional**
one-liners (a conditional "when X, do Y" rule is a pattern → `knowledge/patterns/<slug>.md`);
`## Workflow Notes` → `knowledge/patterns/<slug>.md` **moved as-is** with honest frontmatter
and an explicit un-distilled note; brand / palette / tone / voice →
`core/3.style_guide_and_branding.md`; `## Preamble` (prose that sat before the first heading)
placed by meaning like any other section. Then record it:

```bash
dreamcontext migrations record --version 0.23.0 --step distribute-user-md-residue \
  --executor agent --summary "<what you did>"
```

**NOTHING IS DISCARDED.** A section with no sensible home **stays** in the residue file and
is reported. Delete `inbox/1.user-residue.md` only once every section has been placed — if
anything remains, leave the file and say what is left and why.

## Version drift — CLI vs project files

**Symptom:** the session snapshot shows an update nudge, or skill/agent files behave
older than the installed CLI.

**Fix:** two distinct things update — the CLI binary and the project's installed files:

```bash
dreamcontext upgrade   # the CLI itself
dreamcontext update    # this project's skill/agent/hook files, to match the CLI
```
