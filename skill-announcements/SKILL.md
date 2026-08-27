---
name: announcements
description: >-
  Author the dreamcontext "What's New" page for a RELEASE — a screenshot-driven
  landing page (a git-tracked JSON story plus its manifest entry), one per
  version — so it renders in the dashboard Announcements page and the on-load
  popup. Every announcement SHOWS what the version shipped: real screenshots of
  the app, captured by driving it, with short copy between them. Use when asked
  to "add/create an announcement", "announce the new version / this feature",
  "add a What's New entry", "update the release notes", or "/announcements". NOT
  for writing the app that renders them (that already exists) — this authors the
  content.
---

# Announcements — author a release's "What's New" story

An announcement is a **story**: a JSON landing page rendered by
`AnnouncementStory.tsx` as a scrolling page of screenshots and short copy, in the
app's own type and colours.

It is **not** markdown, and (since 0.22) **no longer an Excalidraw board**. A
board had to be panned and zoomed to read, and could only ever draw a *picture
of* the product. A story shows the product: you drive the real dashboard, take
the shot, and write two lines next to it.

**Four rules carry everything else:**

1. **One announcement per version.** The feed is a release history, not a feature
   stream. A version that shipped three things is three BLOCKS in one story —
   never three entries. `parseAnnouncements` enforces it: `version` is required,
   and a second entry claiming the same version is silently dropped.
2. **Every claim gets a screenshot** — or a clip, if the thing IS motion — or it
   doesn't go in.
3. **Nothing personal, ever.** These files ship inside the npm tarball and the
   desktop bundle, so whatever was on your screen when you took the shot is
   PUBLISHED, to everyone, permanently. Shoot the demo vault set — never your own
   machine. See **The privacy rule** below; it is not advisory, and a test
   enforces the copy half of it.
4. **Cover the whole window.** The story announces a RELEASE, not the feature you
   happened to finish last. Everything that shipped between the previous
   announced version and this one is either in the story or explicitly folded via
   `covers` — see **The coverage gate**.

## Where everything lives

Everything for a release is named after it — `id` IS the version slug
(`0.22.0` → `v0-22-0`), and the story and its shots follow:

| Thing | Path |
|---|---|
| Story document (the deliverable) | `dashboard/public/announcements/v0-22-0.json` |
| Screenshots | `dashboard/public/announcements/shots/v0-22-0/<name>.png` |
| Clips + their posters | `dashboard/public/announcements/clips/v0-22-0/<name>.mp4` + `.png` |
| Manifest (metadata + unread tracking) | `dashboard/public/announcements.json` |
| **Demo vault set** (shoot against THIS) | `e2e/announce-demo-vaults.mjs` |
| Capture scripts (Playwright) | `e2e/announce-shots*.mjs`, `e2e/announce-clip.mjs` |
| Renderer + parser (do not usually touch) | `dashboard/src/components/announcements/AnnouncementStory.tsx`, `dashboard/src/lib/announcementStory.ts` |
| Pure data layer + tests | `dashboard/src/lib/announcements.ts`, `tests/unit/announcements.test.ts`, `tests/unit/announcement-story.test.ts` |

`id` must be stable and unique — unread state is tracked by `id` in the viewer's
localStorage. **`id` is forever**: changing one makes the story re-appear as
unread for everyone. Naming it after the version is what keeps that honest; a
release ships once, so its id never needs to change.

`tests/unit/announcements.test.ts` checks the SHIPPED manifest, not just the
parser: one entry per version, `story` named after `id`, every referenced
screenshot on disk under `shots/<id>/`, and no orphaned screenshots. Run it
before you call an announcement done.

## The privacy rule

An announcement is the one artifact in this repo built by **photographing a running
machine**. Everything else you write, you choose word by word; a screenshot ships
whatever happened to be in frame. And it ships far: into `dashboard/public/`, into the
npm tarball, into the `.app` bundle, into every install — and a published tarball
cannot be recalled.

This has already gone wrong four times, in three released versions:

| Shipped in | What it published |
|---|---|
| `v0-24-0/chip-strip.png` | A client's entire task board — every card title and description, in Turkish — plus four private project names |
| `v0-24-0/chip-status.png` | The same four project names, cropped |
| `v0-23-1/core.png` + `people.png` | The owner's full legal name, under a PEOPLE heading |
| `v0-26-1/launcher.png` | Five private project names and their logos |
| `v0-26-1/peer-mention.png` | A peer product's positioning statement — market, customer, pricing model |
| `v0-26-1.json` (copy) | A real client file path and an internal field name, in a `terminal` block |

**So: shoot the demo vault set.**

```bash
npm run build
node e2e/announce-demo-vaults.mjs
HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
  DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778
BASE=http://127.0.0.1:45778 node e2e/announce-shots-<version>.mjs
```

`announce-demo-vaults.mjs` builds five synthetic projects — wired to each other, each
with its own logo, one carrying a seeded board and a written soul — under a throwaway
`$HOME`. The isolation is the whole trick: `listVaults()` resolves its registry under
`homedir()`, and Node honours `$HOME` on POSIX, so the app reads a registry that
contains only the demo set. Your real `~/.dreamcontext/vaults.json` is never opened —
nothing to back up, nothing to restore, nothing to get wrong.

**Where you may shoot outside the demo home.** The test is not "is this my project"
but "is anything on this screen someone's private information". dreamcontext's own
vault is fine for surfaces whose content is this public repo's own work — the Lab
board (every insight here is a `demo-*` fixture with invented numbers), the knowledge
index, the sleep page. It is NOT fine for anything that frames the project list, a
peer, or a person. When in doubt, use the demo home; it costs one flag.

**Then check what you shot.** Open every new PNG and read it like a stranger would.
The leaks above were all *visible* — nobody looked.

- Project names in a chip, an orbit, a `@` picker, a peer row, a sidebar
- Task/knowledge titles from a real board
- A person's name under PEOPLE, in a commit, in a session tab
- Absolute paths (`/Users/...`), emails, tokens, customer names, real revenue
- **Hide the agent dock** (`.agent-dock, .agent-fab { display: none }` via
  `addStyleTag`) — your own docked session names float over every page

**The copy half is tested.** `tests/unit/announcements.test.ts` scans every string in
every story and the manifest, and fails on: any project registered in your local
`~/.dreamcontext/vaults.json` (except `dreamcontext`), your git `user.name`/
`user.email`, any `/Users/...`-shaped path, any email address. The denylist is read
from your machine at run time and never written down — putting those names in a test
file in a public repo would itself be the leak. On CI the registry is absent and those
cases self-skip, so **run the test locally before you call an announcement done.**

No test can read a PNG. That half is yours.

## The coverage gate

The feed is a release history, so the question a story answers is *"what did this
version give me?"* — not *"what did I finish most recently?"*. v0.26.1's first cut
announced peer mail and the Meeting Room and stopped, while the same window also
shipped the Lab reporting rework and the agent-written-HTML chat surface. A reader
upgrading got three features and a page about one.

**Before writing, build the list.** Everything between the previous ANNOUNCED version
and this one:

```bash
# every commit since the last announcement went in
git log --format='%h %ad %s' --date=short <last-announce-commit>..HEAD

# the brain's own account of the same window
node dist/index.js memory recall "<version>" --types task
```

Read `RELEASES.json` for each version in the range, and every `feat(` commit. Then for
each one decide, explicitly: **a block, a `points` item, or dropped to the changelog.**
Dropping is allowed. Forgetting is not — and forgetting is what happens when you write
the story from the session you are currently in.

**Mind the gap between npm and the repo.** The window is measured from the last
*published* version, not the last cut one. This project routinely carries versions
that were built and never published (0.22.0, 0.23.0, 0.24.2), so `npm view dreamcontext
version` and `package.json` disagree for weeks at a time. A user upgrading crosses
every version in between.

**`covers` folds a version into another story.** Not every patch earns a page: 0.23.1
carried the never-published 0.22.0, and 0.24.1 was a two-item patch. Fold it — add the
version to `covers` on the manifest entry AND put its payload in the story body:

```json
{ "id": "v0-24-0", "version": "0.24.0", "covers": ["0.24.1"], … }
```

`covers` is a claim, checked by test: `tests/unit/announcements.test.ts` fails if any
version marked `released` in `RELEASES.json` — at or after the feed's oldest entry — is
neither announced nor covered. It is what catches the 0.24.1 case, where npm's `latest`
was a version this feed had never heard of. Listing a version there without writing its
payload into the story passes the test and defeats the point.

## The workflow (five steps)

### 0. Decide what the RELEASE is about

Before anything else, work out what this version actually shipped — read its
`RELEASES.json` entry, the tasks attached to it, and the changelog since the last
release. Then pick **one title that names the version**: the promise the reader
feels, not the biggest ticket. Everything else the release contains becomes a
block underneath it, in descending order of who cares.

If the version you're announcing already has an entry, you are **editing that
entry**, not adding a sibling. Adding one silently drops a release from the feed.

### 1. Capture the screenshots FIRST

Copy the closest `e2e/announce-shots*.mjs` and adapt it. Build, stand up the demo
vault set, and serve it under the demo `$HOME` (see **The privacy rule**):

```bash
npm run build
node e2e/announce-demo-vaults.mjs
HOME=$(node e2e/announce-demo-vaults.mjs --print-home) \
  DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45778 &
BASE=http://127.0.0.1:45778 node e2e/announce-shots-<version>.mjs
```

For the surfaces whose content is this repo's own public work — the Lab board, the
knowledge index — serve the real vault on 45777 instead and shoot those separately
(`e2e/announce-shots-0-26-coverage.mjs` is the pattern).

Rules learned the hard way:

- **A vault with no sessions has no `.agent-dock-chip`** — it docks a single
  `.agent-fab`. The demo vault is always that case, so a chip-only wait hangs for
  its full timeout and the scene silently drops. Try the chip, fall back to the fab.
- **`?vault=` REPLACES the open project; the strip's `+` ADDS one.** A shot that
  needs several chips has to click `.project-tabs-add` and pick from the menu.
- **Starting a chat and sending nothing costs nothing** — and it is what puts a live
  session count on a chip. That is the honest way to shoot "still running".
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
- **Hide the agent dock** (`.agent-dock { display: none }` via `addStyleTag`) —
  the author's own docked session names float over every page.

### 1b. Recording a clip

`e2e/announce-clip.mjs` is the pattern: Playwright records the session as webm,
then ffmpeg transcodes and pulls the poster.

- **Trim the lead-in.** Recording starts before the app paints, so the first
  seconds are a blank shell. The clip must OPEN on its subject — the script's
  `TRIM` seconds exist for this, and the poster is frame 1 of the trimmed clip.
- **`-pix_fmt yuv420p` + even dimensions + `-movflags +faststart`.** Without the
  first two, WKWebView (the desktop app's engine) refuses the file outright;
  without the third it won't start until the whole clip has downloaded.
- **`deviceScaleFactor: 1`.** A retina recording triples the shipped bytes for no
  visible gain at clip size.
- **No audio** (`-an`) unless the clip genuinely narrates something — then set
  `sound: true` on the clip so it doesn't autoplay.

For a produced promo (motion graphics, VO, brand type) rather than a screen
recording, that is the `dreamcontext-reel` skill's job — it renders with Remotion
and hands back an mp4. This format takes either; it only cares about the file.

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
- `video` — a full-width clip with optional `title`/`body`. `{ kind, title?, body?, clip }`.
- `note` — one highlighted sentence. The punchline or the caveat.
  `{ kind: "note", text }` — **`text`, not `body`.** It is the one block that
  breaks the pattern, and getting it wrong is invisible: the block is dropped at
  parse time, so the punchline simply is not on the page. The v0.25.0 and v0.26.1
  stories both shipped with every `note` silently missing for exactly this reason.

**Shots**: `{ src, alt, caption?, frame? }`. `src` is relative to
`/announcements/` and may not escape it (no URLs, no `..` — the parser rejects
them). `alt` is REQUIRED; a shot without it is dropped, because here the
screenshot *is* the content. `frame` defaults to `window` (app-window chrome);
use `plain` for crops and detail shots.

**Clips**: `{ src, poster, alt, caption?, frame?, sound? }` — same path rules,
plus:

- `src` must be `.mp4` (h.264/yuv420p) or `.webm`. Anything else is dropped
  rather than rendered as a black rectangle.
- `poster` is **required**, and is a real frame from the clip. Three surfaces
  render a story as a still — the feed teaser, the popup, and the frame before
  the bytes arrive — and none of them can run a video. A hero clip's poster
  becomes the story's cover automatically.
- `sound: true` gives the clip controls and stops it autoplaying. Leave it off
  for silent product loops: they autoplay muted and loop, like the GIF they
  replace. A viewer who asked for reduced motion gets the poster and controls
  either way, so the caption and `alt` must carry the same claim the motion does.
- The hero may take a `clip` instead of (or as well as) a `shot`; the clip wins.

**Use a clip only when motion IS the point** — a pane opening, an agent working,
a transition. A still you can study beats a clip you have to re-watch, and every
clip costs bytes in a package people install. Budget: **under 3MB** (the manifest
test fails above it), ideally 10–15s at 1280px, CRF ~30.

### 3. Add the manifest entry

Append to the array in `dashboard/public/announcements.json` (sorted
newest-first by `date` at read time, so file order doesn't matter):

```json
{
  "id": "v0-23-0",
  "date": "2026-08-01",
  "version": "0.23.0",
  "title": "The title that names this release, in the reader's language",
  "summary": "Two sentences of context covering what the version shipped. This is what people who never open the story will read.",
  "tags": ["dashboard", "agent"],
  "covers": ["0.22.1"],
  "story": "v0-23-0.json"
}
```

Required (entries missing any are dropped): `id`, `date`, `title`, `summary`,
`story`, `version`. Optional: `tags`, `covers`. `id` MUST match the story filename,
and `version` must be one no other entry claims — the UI leads with it.

`covers` lists other RELEASED versions this story also speaks for; add the payload to
the story body when you add the version here. See **The coverage gate**.

`date` is the RELEASE date, and it is the sort key: the feed is ordered by date,
not by version number.

### 4. Run the manifest tests

```bash
npx vitest run tests/unit/announcements.test.ts
```

Run this **locally**, not just on CI — two of its checks read your own machine and
self-skip where that machine isn't there.

They fail loudly on exactly the mistakes that are invisible in the app:

- a duplicate version, a story filename that doesn't match its id, a shot path with
  a typo, a capture you took and never referenced, a clip over budget
- **a released version nobody announced** — neither its own entry nor anyone's `covers`
- **your own data in the copy** — a project from your local vault registry, your git
  identity, a `/Users/...` path, an email address

### 5. Verify in the real app

```bash
npm run build && DREAMCONTEXT_DESKTOP=1 node dist/index.js dashboard --no-open -p 45777
```

Then LOOK at it — feed hero card, the version rail underneath, the popup, and the
full reader — and check: every screenshot loads (a broken one renders as nothing,
so a hole means a bad path), the splits alternate, the story reads top-to-bottom
without needing the manifest summary to make sense, and each claim has a picture
under it.

## Writing guidance

- **Lead with the promise.** The `hook`/`sub` is a benefit the reader feels
  ("Chat is the agent now"), not an implementation note.
- **Two to four lines per block body.** If it needs more, it needs another block.
- **Say what changed FOR THEM**, then what it means. "You don't have to find a
  beta toggle" beats "the default value of `chatView` was flipped".
- **Be honest about the caveat.** One `note` block carrying the limitation buys
  more trust than three paragraphs of upside.
- **4–7 blocks.** A release story covers everything the version shipped, so it
  runs longer than a single-feature page — but one that scrolls forever gets
  skimmed to nothing. Rank ruthlessly: the headline feature earns three blocks,
  the rest of the release earns one `points` block between them.
- **The secondary items still need evidence.** "Also in this version" is not a
  licence to list things you can't show. Either shoot it, or leave it to the
  changelog.

## Gotchas

- **Never add a second entry for a version that already has one.** It is dropped
  at parse time — the release you thought you announced silently isn't in the
  feed. Edit the existing story instead.
- **Don't reintroduce a `board` field.** The renderer reads `story`; a `board`
  entry fails validation and vanishes from the feed with no error.
- **The app does NOT serve `dashboard/public/`.** It serves the build-time copy
  under `dashboard/dist/announcements/`. Editing a story and restarting the
  server shows you the OLD one, so a verification pass can come back green
  against markup you already replaced. `npm run build:dashboard` is what copies
  it across — re-run it after every story edit, before you look.
- **A story with no screenshots is legal** (a CLI release — use `terminal` +
  `points`), but it renders no teaser in the feed. Don't make it the newest
  entry unless you mean it.
- **Screenshots and clips ship in the app bundle.** Prune the intermediate
  captures your script took; the manifest test fails on any asset no story
  references, and on any clip over 3MB.
- **A clip that plays in `npm run dev` can still be dead in the desktop app.**
  Video is served by `src/server/static.ts` with byte ranges (206) — WKWebView
  refuses a clip the server won't range-serve, silently. If you change how
  assets are served, `tests/unit/server-static.test.ts` is what catches it.
- **Hide the agent dock before shooting a page** (`.agent-dock, .agent-fab
  { display: none }` via `addStyleTag`) — the author's own docked session names
  float over every page and read as clutter in someone else's release notes.
- **A screenshot cannot be unpublished.** Scrubbing the working tree fixes the next
  install; the tarballs already on npm keep whatever they shipped, and so does git
  history. That is why the rule is "don't shoot it", not "check it before release".
- **The story is written from the RELEASE, not from your session.** The single most
  reliable way to under-cover a version is to write its page in the session that
  built its last feature. Build the commit list first (**The coverage gate**), then
  write.
- **Don't claim in `alt` what the picture doesn't show.** The re-shot chip strip has
  one live count, not four with unread dots — so the caption says what is there. An
  `alt` describing a better screenshot than the one you took is the one form of
  dishonesty in this format nobody catches, because the two are never read together.
