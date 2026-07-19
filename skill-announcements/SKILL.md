---
name: announcements
description: >-
  Author a new dreamcontext "What's New" announcement — a git-tracked Excalidraw
  landing-page board plus its manifest entry — so it renders in the dashboard
  Announcements page and the on-load popup. Every announcement tells a three-act
  story (problem → solution → proof). Use when asked to "add/create an
  announcement", "announce the new version / this feature", "add a What's New
  entry", "update the release notes board", or "/announcements". NOT for writing
  the app that renders them (that already exists) — this authors the content.
---

# Announcements — author a new "What's New" board

An announcement is **not markdown**. It is a landscape **Excalidraw board** (a
visual landing page) that ships as a static asset with the dashboard and is
rendered live by `ExcalidrawPreview`. Each one tells the same three-act story so
a reader *feels* what shipped:

**① The problem (red) → ② The solution (blue) → ③ The proof (green)**

with big momentum arrows between the acts and KPI tiles for the numbers.

## Where everything lives

| Thing | Path |
|---|---|
| Board generator (source of truth) | `dashboard/scripts/announcements/generate.cjs` |
| Generated boards (deliverables, shipped) | `dashboard/public/announcements/<id>.excalidraw.md` |
| Manifest (metadata + unread tracking) | `dashboard/public/announcements.json` |
| Renderers (do not usually touch) | `dashboard/src/pages/AnnouncementsPage.tsx`, `.../layout/AnnouncementsModal.tsx` |
| Pure data layer + tests | `dashboard/src/lib/announcements.ts`, `tests/unit/announcements.test.ts` |

The board file is named `<id>.excalidraw.md` and the manifest entry's `board`
field points at that filename. `id` must be stable and unique — unread state is
tracked by `id` in the viewer's localStorage.

## The workflow (four steps)

### 1. Add a SPEC to the generator

Append an entry to the `SPECS` array in
`dashboard/scripts/announcements/generate.cjs`. Use the `storyBoard(...)`
helper — you only supply copy, never geometry:

```js
{
  id: 'my-feature',                                   // → my-feature.excalidraw.md
  name: 'Announcement — My Feature',                  // board frontmatter name
  description: 'One line on what this board shows.',   // board frontmatter description
  build: () => storyBoard({
    chipText: 'v0.20.0  ·  2026-08-01',                // version · date
    headline: 'My Feature',                            // big display headline
    hook: 'One punchy sentence — the promise, not the mechanism.',
    problem: [                                          // 2–3 items, the pain BEFORE
      { title: 'What hurt', text: 'One or two lines. Concrete, not abstract.' },
      { title: 'Why it hurt', text: 'The cost the reader actually felt.' },
    ],
    solution: [                                        // 2–3 items, the fix
      { title: 'The headline fix', text: 'What we built.', color: 'purple' }, // purple = hero card
      { title: 'A second angle', text: 'Another facet of the solution.' },
      { title: 'A third', text: 'Keep each to ~2 lines.' },
    ],
    proof: [                                           // numbers + a ✓ result
      { kind: 'kpis', tiles: [
        { label: 'Metric', value: '3×', delta: 'before → after' },
        { label: 'Another', value: '0' },
      ] },
      { title: '✓ It works', text: 'A concrete proof line — dogfooded, measured, shipped.', color: 'mint', minH: 130 },
    ],
  }),
}
```

**Item kinds** inside `problem` / `solution` / `proof`:
- **callout** (default): `{ title, text, color?, minH? }` — a titled card. `color`
  defaults to the act color (red/blue/green); override with `purple` for the
  hero solution card or `mint` for a result. Keep `text` to ~2 lines.
- **kpis**: `{ kind: 'kpis', tiles: [{ label, value, delta?, color? }] }` — a row
  of 2 metric tiles. Use in the **proof** act; `value` is the number/headline,
  `delta` the small caption under it. This is what makes proof pop.

Palette colors: `red` (pain) · `blue` (system) · `purple` (core/hero) ·
`green` (win) · `mint` (result) · `yellow` · `gray`.

### 2. Add the manifest entry

Add an object to the array in `dashboard/public/announcements.json`. Entries are
sorted newest-first by `date`, so ordering in the file does not matter:

```json
{
  "id": "my-feature",
  "date": "2026-08-01",
  "version": "0.20.0",
  "title": "My Feature — a descriptive one-liner for the list + accessibility",
  "summary": "A sentence of context shown in the list card and the popup meta row.",
  "tags": ["dashboard", "excalidraw"],
  "board": "my-feature.excalidraw.md"
}
```

Required fields (validation drops entries missing any): `id`, `date`, `title`,
`summary`, `board`. Optional: `version`, `tags`. The `id` MUST match the SPEC
`id` and the `board` filename.

### 3. Regenerate + render-verify (mandatory)

```bash
node dashboard/scripts/announcements/generate.cjs
```

Every board must report `overlaps=0 buriedText=0 longLines=0` (the generator
prints a `[excalidraw]` warning otherwise). A clean audit is necessary but **not
sufficient — LOOK at the board**:

```bash
node scripts/diagrams/render-excalidraw.mjs \
  dashboard/public/announcements/<id>.excalidraw.md /tmp/ann.png 1
```

Read the PNG. Check the three acts read left-to-right, the arrows sit in the
gutters (not through cards), KPI numbers are legible, and no card is cramped.

### 4. Ship it

The board + manifest are plain static assets under `dashboard/public/`, picked
up by the dev server immediately (`npm run dev` in `dashboard/`) and copied into
`dist/` on `npm run build`. Nothing else to wire. Hard-reload the dashboard to
see it; the new `id` is unread, so it also surfaces in the on-load "What's New"
popup and adds a badge to the sidebar footer.

## Writing guidance — make people excited

- **Lead with the promise, not the mechanism.** The `hook` is a benefit the
  reader feels ("Ship big goals without the token burn"), not an implementation
  note.
- **Problem must sting.** Name the concrete pain the reader lived ("The numbers
  lied", "Sessions vanished"). Vague problems kill the story.
- **Proof must be specific.** Prefer a number in a KPI tile (`7.6×→1×`,
  `~45 min vs ~1.5h`, `3 rounds`) over an adjective. Prefix result callouts with
  `✓`.
- **Two lines per card, max.** Long text shrinks the font and flattens the board.
  Split an idea across two cards instead of overfilling one.
- **2–3 items per act.** Solution is usually the fullest (3); problem and proof
  are tighter (2). The columns need not be equal height.

## Gotchas

- **`id` is forever.** Changing an existing `id` makes it re-appear as unread for
  everyone. Pick it once.
- **The board IS the content.** Don't reintroduce a markdown `body` on the
  manifest entry — the renderer expects `board`.
- **Don't hand-edit the generated `.excalidraw.md`.** It is derived from the
  SPEC; edit the SPEC and regenerate, or your change is lost on the next run.
- **Boards are self-contained.** No embedded images/screenshots — `storyBoard`
  uses only shapes + text, so no `slug`/asset resolution is needed.
