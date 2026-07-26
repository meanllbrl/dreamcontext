---
name: announcements
description: >-
  Author a new dreamcontext "What's New" announcement — a screenshot-driven
  landing page (a git-tracked JSON story plus its manifest entry) — so it renders
  in the dashboard Announcements page and the on-load popup. Every announcement
  SHOWS the thing that shipped: real screenshots of the app, captured by driving
  it, with short copy between them. Use when asked to "add/create an
  announcement", "announce the new version / this feature", "add a What's New
  entry", "update the release notes", or "/announcements". NOT for writing the
  app that renders them (that already exists) — this authors the content.
---

# Announcements — author a new "What's New" story

An announcement is a **story**: a JSON landing page rendered by
`AnnouncementStory.tsx` as a scrolling page of screenshots and short copy, in the
app's own type and colours.

It is **not** markdown, and (since 0.22) **no longer an Excalidraw board**. A
board had to be panned and zoomed to read, and could only ever draw a *picture
of* the product. A story shows the product: you drive the real dashboard, take
the shot, and write two lines next to it.

**The rule that matters: every claim gets a screenshot, or it doesn't go in.**

## Where everything lives

| Thing | Path |
|---|---|
| Story documents (the deliverable) | `dashboard/public/announcements/<id>.json` |
| Screenshots | `dashboard/public/announcements/shots/<id>/<name>.png` |
| Manifest (metadata + unread tracking) | `dashboard/public/announcements.json` |
| Capture scripts (Playwright) | `e2e/announce-shots*.mjs` |
| Renderer + parser (do not usually touch) | `dashboard/src/components/announcements/AnnouncementStory.tsx`, `dashboard/src/lib/announcementStory.ts` |
| Pure data layer + tests | `dashboard/src/lib/announcements.ts`, `tests/unit/announcements.test.ts`, `tests/unit/announcement-story.test.ts` |

`id` must be stable and unique — unread state is tracked by `id` in the viewer's
localStorage. **`id` is forever**: changing one makes the story re-appear as
unread for everyone.

## The workflow (four steps)

### 1. Capture the screenshots FIRST

Copy the closest `e2e/announce-shots*.mjs` and adapt it. Build, then run the
dashboard on a real vault so the shots have real content in them:

```bash
npm run build
DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777 &
node e2e/announce-shots.mjs          # deterministic pages/panels/menus
node e2e/announce-shots-chat.mjs     # live-Claude scenes (costs a real turn)
```

Rules learned the hard way:

- **Back up `_dream_context/state/.agent-sessions.json` before driving the agent
  surface, and restore it after.** Opening and closing tabs rewrites the user's
  saved roster.
- **Scope agent-surface selectors with `:visible`.** Every other live session's
  pane stays mounted in an off-screen garage, so a bare `.chat-toolcard` matches
  a card in a different conversation and your poll returns instantly on something
  the camera can't see.
- **Wait on the DOM, not on a stopwatch.** A chat session's first turn includes
  the SessionStart brain preload — 90s+ before a token appears on a real vault.
  Poll for the element that proves the milestone happened.
- **Crop shots that will sit in a `split`.** A split gives its image about half of
  a 920px column; a whole 1600px window scaled into that is unreadable. Use an
  element/region screenshot and set `"frame": "plain"`.
- **Downscale to 1600px** (`sips -Z 1600 <file>`) — retina captures are ~3× the
  bytes for no visible gain at story size, and these ship in the app bundle.
- Capture in `colorScheme: 'dark'` for a consistent look across the feed.

### 2. Write the story document

`dashboard/public/announcements/<id>.json`:

```json
{
  "hero": {
    "eyebrow": "v0.22.0  ·  26 July 2026",
    "headline": "Six words, the promise not the mechanism",
    "sub": "One sentence a reader feels. What is different now.",
    "shot": { "src": "shots/<id>/hero.png", "alt": "…", "caption": "…" }
  },
  "blocks": [ … ],
  "closer": { "title": "Go do this", "body": "Where it lives, one line." }
}
```

**Block kinds** (unknown kinds and malformed blocks are dropped silently — check
your work in the app):

- `split` — copy on one side, screenshot on the other. The workhorse.
  `{ kind, title, body, shot, side: "left" | "right" }`. Alternate `side` down
  the page.
- `shot` — a full-width screenshot with optional `title`/`body`.
- `points` — 2–4 short cards. `{ kind, title?, items: [{ title, text }] }`.
- `stats` — a row of headline numbers. `{ kind, items: [{ value, label, note? }] }`.
  Only for numbers you actually measured.
- `terminal` — a monospace transcript, for the parts of the product with no UI
  (orchestration, CLI). `{ kind, title?, lines: [] }`; a line starting with `$ `
  renders as input.
- `note` — one highlighted sentence. The punchline or the caveat.

**Shots**: `{ src, alt, caption?, frame? }`. `src` is relative to
`/announcements/` and may not escape it (no URLs, no `..` — the parser rejects
them). `alt` is REQUIRED; a shot without it is dropped, because here the
screenshot *is* the content. `frame` defaults to `window` (app-window chrome);
use `plain` for crops and detail shots.

### 3. Add the manifest entry

Append to the array in `dashboard/public/announcements.json` (sorted
newest-first by `date` at read time, so file order doesn't matter):

```json
{
  "id": "my-feature",
  "date": "2026-08-01",
  "version": "0.22.0",
  "title": "A descriptive one-liner for the feed and the popup",
  "summary": "Two sentences of context. This is what people who never open the story will read.",
  "tags": ["dashboard", "agent"],
  "story": "my-feature.json"
}
```

Required (entries missing any are dropped): `id`, `date`, `title`, `summary`,
`story`. Optional: `version`, `tags`. `id` MUST match the story filename.

### 4. Verify in the real app

```bash
npm run build && DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
```

Then LOOK at it — feed hero card, the popup, and the full reader — and check:
every screenshot loads (a broken one renders as nothing, so a hole means a bad
path), the splits alternate, the story reads top-to-bottom without needing the
manifest summary to make sense, and each claim has a picture under it.

## Writing guidance

- **Lead with the promise.** The `hook`/`sub` is a benefit the reader feels
  ("Chat is the agent now"), not an implementation note.
- **Two to four lines per block body.** If it needs more, it needs another block.
- **Say what changed FOR THEM**, then what it means. "You don't have to find a
  beta toggle" beats "the default value of `chatView` was flipped".
- **Be honest about the caveat.** One `note` block carrying the limitation buys
  more trust than three paragraphs of upside.
- **3–6 blocks.** A story that scrolls forever gets skimmed to nothing.

## Gotchas

- **Don't reintroduce a `board` field.** The renderer reads `story`; a `board`
  entry fails validation and vanishes from the feed with no error.
- **A story with no screenshots is legal** (a CLI release — use `terminal` +
  `points`), but it renders no teaser in the feed. Don't make it the newest
  entry unless you mean it.
- **Screenshots ship in the app bundle.** Prune the intermediate captures your
  script took; keep only what a block references.
