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
  agents / skills / skill packs (`agents/*.md`, `skill-*/`, `skill-packs/**`); and (3) `README.md`
  and the [deep-dive wiki](https://github.com/meanllbrl/dreamcontext/wiki). A feature without its docs is incomplete.

## Shipping a migration

Every PR that changes the brain STRUCTURE (file paths, frontmatter conventions,
content format) must ship a versioned migration so existing projects upgrade
automatically when they run `dreamcontext update` or `dreamcontext sleep start`.

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

5. **agentTask** — add one when the migration requires human judgment (e.g.
   choosing which of two conflicting schemas to keep). Contract rules:
   - Agent starts by checking the filesystem (no-content assumption).
   - Agent may move/rename files, normalise frontmatter, wrap fences — but
     NEVER alters body prose.
   - After moving files, agent updates inbound `[[wikilinks]]` or lists
     broken links.
   - Agent writes the ledger via `dreamcontext migrations record` on
     completion (never at the start).

6. **Gotchas for agent tasks**:
   - **Gotcha 2**: wikilink hygiene — always update `[[old-slug]]` → `[[new-slug]]`
     after a file move, or list broken links.
   - **Gotcha 3**: no prose edits — structure only.
   - **Gotcha 6**: code layer runs first; check the ledger before acting.

## Trademark

The code is Apache 2.0, but the **dreamcontext** name and brand are not — see
[TRADEMARK.md](./TRADEMARK.md). Fork freely; just ship it under your own name.

Questions: **mehmet@nuraydin.com**
