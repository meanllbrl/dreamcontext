---
type: knowledge
name: byte-surgical-section-editing
description: >-
  Pattern: when editing one section of a document where other parts are
  hash-verified, the edit operation must be byte-surgical everywhere outside its
  target section to preserve hash validity
tags:
  - kind:pattern
  - architecture
  - decisions
  - domain:security
created: '2026-07-27'
updated: '2026-07-27'
pinned: false
---

# Byte-Surgical Section Editing on Hash-Verified Documents

## Why This Exists

When a document has hash-verified fields or sections (approval hashes, signatures, integrity checks) coexisting with mutable content, any operation that edits the mutable part must preserve everything else byte-identically — including whitespace, blank lines, and formatting outside the target section. Otherwise, the edit rewrites a verified field, breaks the hash, and blocks the document from use.

This pattern emerged from a CRITICAL defect in the automations subsystem (Round 3, 2026-07-27) and applies broadly to any manifest, config, or document with integrity verification.

## The Defect That Established the Pattern

**Context:** Automation manifests have a `## Pattern` section (playbook + lessons) that runs can append to via `automations learn`. Six other fields (`## Prompt`, `## Output instructions`, model, effort, timeout, output dir) are approval-hashed — any change to these blocks the automation until a human re-approves it.

**The bug:** `upsertSection` (the helper that appends a lesson to `## Pattern`) ended with a whole-file normalization: `.replace(/\n{3,}/g, '\n\n')`, collapsing three-or-more consecutive blank lines to exactly two throughout the entire file.

**The failure:** The `## Prompt` section is approval-hashed via `normalizeText()`, which only strips `\r` and trims — it does NOT collapse blank lines. So:
1. An automation records its first lesson → takes the "append new section" branch → writes the file, normalization runs.
2. Blank lines inside `## Prompt` get collapsed from 3+ to 2.
3. The prompt text changed → the approval hash no longer matches.
4. The automation records a second lesson → `upsertSection` runs again, this time taking the "section exists, prepend" branch.
5. The approval check runs → hash mismatch → `status: blocked`.
6. Blocked runs notify nobody (by design — approval is a gate, not an event to broadcast).
7. **The automation went silent. The second lesson it recorded blocked it forever until a human noticed and manually re-approved.**

This is exactly the failure the approval design claimed impossible: the run's own write operation, operating only on an unhashed section, rewrote the hashed prompt and blocked itself.

## The Pattern: Byte-Surgical Section Editing

A function that edits one section of a hash-verified document MUST:

1. **Read the whole file** (you need the surrounding structure to re-slot the edited section correctly).
2. **Identify the exact byte boundaries** of the target section (start line, end line, or start/end markers).
3. **Rewrite ONLY the content between those boundaries.**
4. **Preserve everything else byte-identically** — frontmatter, other sections, blank lines, trailing whitespace, comments, ordering.
5. **Never run whole-file transformations** (normalizations, formatters, linters, blank-line collapsing) unless they are part of the hash computation itself.

### Reference Implementation (from automations `upsertSection`)

```typescript
// BEFORE (defect):
function upsertSection(filePath, sectionName, newContent) {
  let content = fs.readFileSync(filePath, 'utf8');
  const regex = new RegExp(`^## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `## ${sectionName}\n${newContent}`);
  } else {
    content += `\n## ${sectionName}\n${newContent}`;
  }
  // DEFECT: this line rewrites the entire file, including hashed sections
  content = content.replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(filePath, content, 'utf8');
}

// AFTER (byte-surgical):
function upsertSection(filePath, sectionName, newContent) {
  let content = fs.readFileSync(filePath, 'utf8');
  const regex = new RegExp(`^## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
  if (regex.test(content)) {
    // Only replace the matched section, nothing else
    content = content.replace(regex, `## ${sectionName}\n${newContent}`);
  } else {
    // Append the new section, touching nothing else
    content += `\n## ${sectionName}\n${newContent}`;
  }
  // NO whole-file normalization
  fs.writeFileSync(filePath, content, 'utf8');
}
```

The fixed version:
- Replaces only the matched section text (via the regex capture group).
- Appends only the new section when it doesn't exist.
- Never touches content outside the section boundaries.
- Frontmatter, other sections, and their formatting stay byte-identical.

**Validation:** A 6-lesson hash-stability regression test verifies that six consecutive `automations learn` calls leave the approval hash unchanged (the pattern grows, the prompt stays byte-identical, approval stays valid).

## Where This Applies

This pattern is mandatory whenever:

- A document has **hash-verified fields** (approval hashes, content signatures, integrity checks).
- **Mutable content coexists** with the verified fields in the same file.
- An **automated or programmatic write** operates on the mutable part (manual edits by a human can be re-approved; automated writes cannot).

**Examples beyond automations:**

- **Signed configuration files** — a script updates a `lastSynced` timestamp in a config that also holds a PGP signature block over other fields.
- **Approved skill/agent prompts** — a skill's instructions are approval-gated, but its changelog or metadata is auto-updated by tooling.
- **Checksummed package manifests** — `package.json` with an integrity hash over `dependencies`, but `scripts` or `devDependencies` are dynamically updated.
- **Git commit templates** — a commit message template with a verified preamble and a mutable body.

## Anti-Patterns (What NOT to Do)

1. **Whole-file formatters on partially-verified documents.** Running Prettier, a linter's auto-fix, or any normalization pass over a file where only some fields are hashed will rewrite the hashed fields and break verification.
2. **"Just re-compute the hash after the write."** This only works if the writer has the authority to approve. An unattended automation, a CI script, or a background sync job cannot approve itself — the whole point of the hash is to require human review.
3. **"Make the hash cover the whole file."** If mutable content exists, this blocks every write. The pattern exists exactly because mutable + verified content need to coexist.
4. **Guessing section boundaries by line count or heuristics.** Parse the structure explicitly (regex, a parser, or a known marker). A wrong boundary rewrites verified content.

## Detection and Prevention

**At write time:**
- Any function named `upsert*`, `edit*`, `append*`, or `update*` operating on a file with hash-verified fields MUST be byte-surgical by construction.
- Code review checklist: "Does this touch a file with an approval hash / signature / integrity check? Is the edit scoped to exactly the mutable section?"

**At test time:**
- Hash-stability regression tests: perform N consecutive writes to the mutable section, assert the hash-verified fields remain byte-identical.
- For the automations defect, this is the 6-lesson test: six `automations learn` calls, verify `manifestHash()` stays constant.

**At read time (defense-in-depth):**
- A reader that depends on hash validity can verify the hash on every read, not just at approval time. This won't prevent the defect but will detect it earlier (fail-fast instead of silent block).

## Related

- `_dream_context/knowledge/features/automations-scheduled-headless-claude-jobs.md` § Constraints & Decisions, 2026-07-27 — where the defect was found and fixed.
- `src/lib/automations/pattern.ts` — the reference implementation of byte-surgical `upsertSection`.
- `knowledge/patterns/pid-lockfile-concurrent-json.md` — a related pattern for preserving file integrity under concurrent writes (uses locking instead of hash verification, but the "don't corrupt what you don't own" principle is shared).

## Last Verified

2026-07-27 — extracted from the automations Round 3 retrospective.
