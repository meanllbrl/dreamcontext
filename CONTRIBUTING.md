# Contributing to dreamcontext

Thanks for your interest in improving dreamcontext.

## License of contributions

dreamcontext is licensed under the [Apache License 2.0](./LICENSE). By
submitting a contribution (pull request, patch, or any code/docs), you agree
that your contribution is licensed under the same Apache 2.0 terms. Apache 2.0
already includes an explicit patent grant from each contributor (Section 5),
which keeps the project safe to use commercially.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a CLA. It's lightweight: you certify that you wrote the contribution
(or have the right to submit it) by adding a `Signed-off-by` line to each commit:

```
Signed-off-by: Your Name <you@example.com>
```

Add it automatically with:

```bash
git commit -s -m "your message"
```

The name and email must match your real identity (no anonymous or pseudonymous
contributions). This signature is what lets the project keep clear provenance on
every line — and preserves the ability to evolve the project's licensing in the
future if that ever becomes necessary.

## Before you open a PR

- Run the build: `npm run build`
- Run the tests: `npm test`
- Keep changes focused; one concern per PR.
- For anything non-trivial, open an issue first so we can align on direction.
- **Keep the docs in lockstep.** Any change to dreamcontext's behavior or capabilities must also
  update, in the same PR: (1) the `dreamcontext` skill + its `references/` (`skill/SKILL.md`,
  `skill/references/*.md`) so the agent that loads them knows the new reality; (2) the related
  agents / skills (`agents/*.md`, `skill-*/`); and (3) `README.md`
  and the [deep-dive wiki](https://github.com/meanllbrl/dreamcontext/wiki). A feature without its docs is incomplete.

## Shipping a migration

Every change that leaves an install made before it behind (brain structure,
stored settings, members, routines, anything a user already has on disk) ships a
versioned migration, so existing projects follow it on their own when they run
`dreamcontext update` or `dreamcontext sleep start`. A change that needs nothing
says why.

### The decision line (every feature PR)

The PR body carries the decision, and the release refuses a feature without one
(`scripts/check-migration-decision.mjs --release` runs in the cut's gates,
`desktop-release.yml` and `prepublishOnly`; the `migration-decision` workflow
gives the same verdict early on the PR). Exactly one of:

```
Migration: src/migrations/<X.Y.Z>.ts
Migration: none - <why an existing install needs nothing>
```

One file line per migration file the PR adds or changes (each must be in the
diff, and every migration file the diff adds must be named); a `none` reason is
at least 10 characters and is only valid when the diff adds no migration file.
Release PRs (head `beta`, `dev`, `main` or `release/*` from this repo) are
exempt. `gh pr create --body` skips the template, so write the line yourself.
The fix for a refused release is one edit: `gh pr edit <n> --body-file <file>`.

### Checklist

1. **Create `src/migrations/<version>.ts`** — export a `Migration` object with
   a stable `version` string (= the release this change ships in) and one or
   more idempotent `steps`. See `src/migrations/0.7.0.ts` as the worked
   example.

2. **Register it** — add the export to `src/migrations/index.ts`:
   ```ts
   import { migrationXYZ } from './X.Y.Z.js';
   export const REGISTRY: Migration[] = [..., migrationXYZ];
   ```

3. **Version key** = the semver at which the structural change is introduced.
   Use the same version in the file name, export name, and `Migration.version`.

4. **Steps must be filesystem-idempotent** on their own. The ledger is an
   optimisation (dedup gate), not the safety net. A step that receives a
   filesystem already in the final state must return `detected: true` with
   `filesTouched: []`.

5. **agentTask** — add one when the migration needs judgment (e.g. choosing
   which of two conflicting schemas to keep, or asking the owner). It runs in a
   visible session of its own (in the app the Super opens a "Taşıma" child for
   it; every snapshot shows `## Migration waiting` until it is recorded), so it
   may change meaning, not only paths. Contract rules:
   - **Due work is named by task.** A step that finds work for a task returns
     `agentWorkFor: '<task id>'`; the runner ledgers that sighting once. A task
     nobody reported is never due, so a fresh install and a vault where
     detection found nothing stay quiet. A step whose verdict can change later
     is `everyRun`.
   - **`title`** is one plain line (at most 80 characters) shown in the
     snapshot block and the child's card; ids are unique across the registry.
   - The instruction states its scope, starts by checking the filesystem
     (idempotent), names what needs the owner's card, and ends with the record
     line: `dreamcontext migrations record ... --executor agent` on completion,
     never at the start. The owner saying no is recorded too
     (`--summary "owner declined: <his words>"`) and silences the task.
   - **Owner safety.** Anything that deletes, rebinds or re-approves the owner's
     things is asked first in ONE card listing every item with its proposed
     outcome; an approval hash that changes (e.g. `automations edit --agent`)
     goes through the existing approval card, never a stamp; only members
     `ownedBy` this machine (`src/lib/agents/owner.ts`) are touched; vault text
     placed in a prompt is slug-validated or wrapped as untrusted
     (`wrapUntrusted`).
   - **A fix that must happen is a code step**, never an agentTask alone:
     anyone with shell access can record a task as done.
   - After moving files, agent updates inbound `[[wikilinks]]` or lists
     broken links.

6. **Never guess, and know what counts as guessing.** A step may only do what is
   DETERMINISTIC. Two questions look mechanical and are not:
   - *"which fragment of this line is a person's NAME?"* — a `## People` bullet
     written as description has no parseable answer.
   - *"WHOSE prose is this?"* — when `resolveActivePerson` cannot name the person
     at the keyboard, neither can your step. Ranking the roster and taking the
     first entry is not a fallback: it wrote one teammate's constitution into
     another's file, decided by the alphabet.

   Route both to the `agentTask` and return CLEAN — `failedCount` is for
   RETRYABLE failures only (a step that reports it on deterministic input pins
   `setupVersion` forever). Beware gates whose verdict depends on incidental
   size: a slug-length check let a *short* description through and a long one
   fail. Test the SHAPE of what the renderer wrote, not its length.

   And judgment reaching the wrong file is worse than judgment left undone —
   a step that unlinks its source makes a wrong destination indistinguishable
   from a right one. `src/migrations/0.23.0.ts` `resolveOwner()` is the worked
   example; a source tripwire in the 0.23.0 test enforces the class.

7. **`everyRun` is for repairing what a NEWER build wrote**, nothing else. A vault
   stamped by a build this CLI predates (the reverted 0.33.0) has a
   `setupVersion` above the CLI, so no `(setupVersion, cli]` range reaches the
   repair. An `everyRun` migration runs on every pass up to the CLI version, a
   downgrade included, must cost one cheap check when there is nothing to do,
   and is ledgered only by the pass that touched files. `src/migrations/0.32.0.ts`
   is the worked example.

8. **Gotchas for agent tasks**:
   - **Gotcha 2**: wikilink hygiene — always update `[[old-slug]]` → `[[new-slug]]`
     after a file move, or list broken links.
   - **Gotcha 3**: prose the owner wrote changes only with his yes on the card.
   - **Gotcha 6**: code layer runs first; check the ledger before acting.

## Trademark

The code is Apache 2.0, but the **dreamcontext** name and brand are not — see
[TRADEMARK.md](./TRADEMARK.md). Fork freely; just ship it under your own name.

Questions: **mehmet@nuraydin.com**
