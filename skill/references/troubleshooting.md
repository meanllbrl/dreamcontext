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
by hand.

## Version drift — CLI vs project files

**Symptom:** the session snapshot shows an update nudge, or skill/agent files behave
older than the installed CLI.

**Fix:** two distinct things update — the CLI binary and the project's installed files:

```bash
dreamcontext upgrade   # the CLI itself
dreamcontext update    # this project's skill/agent/hook files, to match the CLI
```
