---
name: patterns
description: Browse and load this project's reusable engineering/design patterns from _dream_context/knowledge/patterns/ — "/patterns" lists them, "/patterns <slug or keywords>" loads the matching one. Use when the user asks "which patterns do we have", "load the X pattern", "bir pattern var mıydı", or before building something a documented pattern already covers.
---

# Project Patterns (live from the brain)

The source of truth is `_dream_context/knowledge/patterns/*.md` — this skill carries NO
pattern content of its own; always read the live files.

1. **No argument** → list: run `ls _dream_context/knowledge/patterns/` and show each
   file's `name` + first sentence of `description` from its frontmatter (Read the files,
   headers only). If the folder is missing or empty, say the project has no documented
   patterns yet and stop — do not create the folder. Ask which to load if the user's
   intent is unclear.
2. **With argument** → resolve `<slug or keywords>` against the filenames/descriptions
   (recall fallback: `dreamcontext memory recall "<keywords>" --types knowledge`), then
   Read the matched pattern IN FULL and apply/summarize it per the user's ask.
3. When the current work is a NEW FEATURE, always surface
   `feature-integration-pattern.md` — applying it before finishing is mandatory
   (see the dreamcontext skill's Entity Router).

Do not copy pattern text into this file; do not edit patterns from here without
offer-and-confirm.

**You are usually not the first to know.** A pattern that the user's message
actually names is already in your context: the `UserPromptSubmit` hook runs a
deterministic gate and prints matching patterns with a MUST-READ directive. This
skill is the BROWSE surface for the other cases — "what do we have", "load the X
one". Each pattern also has its own generated `/` entry
(`.claude/commands/pattern-<name>.md`, kept in sync by `dreamcontext patterns
sync`). To see what a phrase would trigger, run
`dreamcontext patterns match "<prompt>"`.
