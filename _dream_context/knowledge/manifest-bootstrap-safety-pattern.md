---
id: manifest-bootstrap-safety-pattern
name: "Manifest Bootstrap First-Run Safety Pattern"
description: "Never delete on the first encounter of a manifest-tracked file: bootstrap a baseline, flag candidates, let the user review before any destructive action. Applies to any system that introduces retroactive file ownership tracking."
tags: ["architecture", "decisions", "devops"]
pinned: false
date: "2026-05-22"
---

## Why This Exists

When dreamcontext adopted manifest-based install tracking (v0.4), it gained the ability to delete stale files during `update`. But users upgrading from pre-manifest versions have no manifest — every file on disk would appear as "not in manifest" and thus a deletion candidate. Deleting all of them on the first run would be catastrophic.

This pattern defines the safe first-run contract and is worth recording because it applies to any system that begins tracking owned files retroactively.

## The Pattern

**Problem**: A new tracking mechanism (e.g., a manifest) is introduced. Existing files on disk pre-date the manifest. The diff between "nothing in manifest" and "files currently installed" produces a false-positive deletion list.

**Solution — Bootstrap + Flag, Never Delete**:
1. Detect that no manifest exists (first run after upgrading to manifest-aware version).
2. **Bootstrap** a manifest baseline from a disk scan (heuristic: known path prefixes + known file patterns). This records the current state as "what we think we own."
3. Run the install as normal to get the "new" manifest.
4. Diff old (bootstrapped) vs new (fresh install).
5. For any file in the diff's `removed` list: **flag it to the user but do not delete it**. Print a warning.
6. Persist the new manifest. On the _next_ `update`, the manifest is authoritative — deletion can proceed with a confirmation prompt (or `--yes`).

**Why not just skip deletion on first run entirely?**
Skipping silently would hide the staleness. Flagging tells the user "these files exist on disk but the new version doesn't ship them — you may want to review." The user can manually delete or keep them. On subsequent runs the manifest is accurate and auto-deletion is safe.

## Implementation in dreamcontext

- `src/lib/manifest.ts` — `bootstrapManifestFromScan(projectRoot)`: scans `.claude/`, `.agents/`, `.codex/` for files matching dreamcontext-owned path patterns.
- `src/cli/commands/update.ts` — `pruneStaleFiles()`: checks `isFirstRun` flag; if true, calls `warn()` for each candidate and returns `{ flagged: [...], removed: [], cancelled: true }`.
- `isFirstRun` is set to `true` when `getOrCreateManifest()` had to bootstrap (returned `bootstrapped: true`).
- `isSafeDeletePath(path)`: only paths under `.claude/`, `.agents/`, `.codex/` are ever deletion candidates. `_dream_context/` is never touched.

## When to Apply

Any time you introduce file-ownership tracking to a system with an existing userbase:
- Track that the current run used a bootstrapped (not authoritative) manifest.
- Flag candidates instead of acting on them.
- On subsequent runs with an authoritative manifest, enable deletion with confirmation.

The pattern is also applicable outside file deletion: any "destructive migration" that targets entities which might have been created before tracking was introduced should have a first-run grace period.

## Sources

- `src/cli/commands/update.ts` `pruneStaleFiles()` (v0.4, 2026-05-22).
- `src/lib/manifest.ts` `bootstrapManifestFromScan()` (v0.4, 2026-05-22).

## Last Verified

2026-05-22 (code shipped in v0.4 session).
