---
name: mehmet-nuraydin
type: person
updated: "2026-09-21"
---

## Preferences
- UI copy names the lead agent **Claude**; "Sleepy" is reserved for the mascot visual (reaffirmed 2026-09-25).

- Decide on clear choices and explain why; never ask permission on an obvious path. **"devam" means keep going autonomously**, no check-ins (2026-09-08, 4th obs).
- **Orchestrations must be fast** (2026-09-11): minimal ceremony, reviewers in parallel, implementer waves at full width, no extra rounds without a new finding.
- **He holds the sign-off an agent cannot close** (2026-09-20, 2nd obs): a UX gate is read in the real app and the verdict is his. Present the evidence and stop there — never mark a task done on his behalf.
- **The agent does the whole release except `npm login` and `npm publish`** (2026-09-13, 2nd obs): version surfaces, checklist, announcement, tag are agent work; the release record flips to `released` only after the registry confirms.
- **Verify in the real app, not just in tests** (2026-09-11, 5th obs): full local desktop rollout, confirm in the installed `.app`, then report done. Say plainly when a browser test cannot reach a desktop-gated surface.
- **Don't commit unless asked** — parallel sessions sweep in-flight work. When asked: commit everything and push, as separate coherent commits per logical unit.
- **Hands off long sessions rather than pushing on** (2026-09-20): handed off at 336k with a written task log. ECO discipline is his own practice, not just the product's.
- **Short answers, lead with the conclusion** — "in a nutshell", even for architecture questions.
- **No em dashes.** No implementation detail in user-facing copy; label an unfinished capability honestly (J.A.R.V.I.S shipped marked ALPHA, "not even beta", 2026-09-13). Template placeholders are failure.
- **Turkish must survive every transform**: he writes names, tags and directives in Turkish. Slugs fold to ASCII, display uses the frontmatter name verbatim, search is case-insensitive. Mangling Turkish is a bug, not cosmetics.
- Brand, palette, typography, density and UI naming: `core/3.style_guide_and_branding.md`.

## Communication Style

- Direct, technical, no over-explanation. Concise progress; don't narrate steps.
- Options: 2-3 max, recommendation first, one line each.
- Problems: one line plus a proposed fix. No apologies.
- **Bugs arrive as screenshots** (2026-09-08, 3rd obs): diagnose from the image and the code, don't ask what happened.
