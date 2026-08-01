---
id: cli-derived-action-rows
name: "CLI-Derived Action Rows (the UI reads the command tree, not a hand-written list)"
description: >-
  A surface that renders a `dreamcontext …` call must derive what it knows from
  `createProgram()` — a generated manifest plus a drift test — never from a list of commands
  written by hand. The row then says entity + verb + subject, tones itself by whether the call
  changed the brain, and reads its outcome off the `✓`/`✗` every command already prints. Adding
  a CLI endpoint requires NO UI change.
tags: ["architecture", "design", "topic:frontend", "topic:cli", "domain:dashboard", "kind:pattern"]
pinned: false
date: "2026-08-01"
updated: "2026-08-01"
---

## Why This Exists

The agent does most of its work on this project **through** this project. A normal turn is
`dreamcontext memory recall …`, `dreamcontext tasks create …`, `dreamcontext tasks insert …` —
and every one of them reached the chat transcript as an anonymous `▶ Bash` row wearing whatever
sentence the agent happened to write in `description`:

```
▶ Bash   Create the task                    9.5s
▶ Bash   Insert remaining acceptance criteria   13s
```

Which task? What went into it? The row never said — while the command line it was hiding said
all of it. **The app could not see itself working.**

The fix is not "add a nice renderer for `tasks create`". Any per-command renderer is a second
copy of the command tree, and the second copy is the problem: this repo has already shipped a
hand-mirrored constant that drifted two rescales behind the backend while every test stayed
green. With ~300 endpoints and more landing every week, a hand-written list is drift with a
delivery date.

## The Pattern

### 1. Derive the command tree; never mirror it

One fact cannot be guessed from a command line: whether `create` is a **subcommand** of `tasks`
or an **argument** to it. That fact lives in `src/cli/program.ts`, so it is taken from there.

```
src/cli/program.ts            createProgram() — the tree, importable without running the CLI
  └─ src/lib/cli-manifest.ts  buildCliManifest() walks it into data
       └─ tests/unit/cli-manifest.test.ts   writes + guards the checked-in file
            └─ dashboard/src/generated/cli-manifest.json   what the UI imports
```

`npm run gen:cli-manifest` regenerates. The test fails the suite when the file and the tree
disagree, so the mirror cannot rot silently — the only way to break it is to ignore a red test.

**`createProgram()` had to move out of `index.ts` for this** — that module calls `main()` at
load, so anything importing it to *inspect* the program parsed the importing process's argv
instead. Entrypoint and tree are now separate modules; keep them that way.

The manifest carries exactly what a reader of the command line needs, and nothing else:

| Field | Why the parse breaks without it |
|---|---|
| `group` | `tasks create` vs `tasks <name>` — the token's role is unknowable otherwise |
| `args` | which positional is the subject, and what it is called |
| `valueFlags` | `tasks create -p high "Fix it"` is titled **"Fix it"**, not "high" |
| `aliases` | `dreamcontext mk …` is `marketing` |
| `desc` | the row explains itself in the CLI's own words, not in UI copy |

### 2. The row says entity + verb + subject

Same rule as every other tool row: **a row names its OBJECT, not its type.**

```
● ◆ Task created    [Chat rows name their object]                    0.4s ▸
● ◆ Memory recall   [context root resolution]   · 3 lines            0.4s ▸
● ◆ Task status     [chat-rows-name-their-object]  → in_progress     0.4s ▸
● ◆ Task inserted ×3  [chat-rows-…]  → Acceptance Criteria · +2 more 0.4s ▸
● ◆ Task deleted    [stale-task]   Task not found: stale-task   failed ▸
```

Each part is derived, not authored:

- **noun** ← the domain, singularised (`tasks` → `Task`). A lexicon holds only the words the
  rule gets wrong: `theses` → Thesis, `people` → Person, `roadmap` → Objective, `lab` → Insight.
- **verb** ← the action token, past-tensed where English wanted a different word. An unknown
  verb falls through to itself — `dreamcontext theses promote x` renders as `Thesis promote`
  with nothing added to the lexicon. **That fall-through is the pattern's promise; if a new
  endpoint ever needs a lexicon entry to render at all, the promise is broken.**
- **subject** ← the first positional argument.
- **detail** ← the remaining positionals, joined on ` · `.

### 3. Tone by consequence, not by domain

The one question a reader scanning a long turn is asking is *did this change something, or only
look something up?* — so `read` / `write` / `destructive` drives the tint. Verbs that are a
question with no argument and an order with one (`status`, `tag`, `version`, `field`) are
resolved **by arity**, because the ambiguity is in the English, not in the endpoint.

### 4. The outcome comes from the CLI's own output

Every command reports through `src/lib/format.ts`'s `success()` / `error()` / `warn()`, which
prefix `✓` / `✗` / `⚠`. Read the **last** such line: that is the outcome, for all ~300 endpoints,
with no per-command code. A new command that uses those helpers gets its outcome on the row for
free — the second half of the auto-detection promise.

Two consequences worth keeping:

- **A printed `✗` makes the row an error row even when the process exited 0.** Several commands
  print the glyph and exit clean; a green dot there is the card telling a nicer story than the
  output it is displaying.
- **A path is only ever taken from text the CLI actually printed**, never assembled from an
  argument. The CLI reports the *slugified* name; the argument is the raw title. A chip that
  opens nothing is worse than a chip that only names.

### 5. Be recognisable without being loud

The mark (the CSS diamond, shared with our own skill rows) plus a **tinted surface** — accent
`color-mix`'d into a theme surface, per `tinted-surface-not-filled-swatch` — plus a 3px accent
edge drawn as a pseudo-element so it cannot move a single pixel of the row's contents.

The header is the shared `ToolHeader` molecule, deliberately. Geometry, hit area, caret, aria
state and the 32px collapsed height all come from it, so a dreamcontext row sits in a column of
ordinary rows without disturbing the density the transcript was tuned to. Verified by
measurement (`scripts/verify/dream-actions.mjs`), not by reading the CSS.

### 6. These rows break the grouping

A contiguous stretch of tool calls collapses into one run card. dreamcontext calls do **not**
join it (`isPlainToolCard` in `ChatPane.tsx`): these are the calls that change the brain, and
folding them into a collapsed "12 steps" header hides the one class of row whose object the
reader most needs to see. A single Bash call that chains several actions with `&&` is still one
row — it says `×3` and lists them when opened.

## Adding a CLI endpoint

1. Register it in `src/cli/commands/…`, report through `success()`/`error()`.
2. `npm run gen:cli-manifest`.

That is the whole checklist. The row already reads correctly. Touch
`dreamCommand.ts`'s lexicon **only** if the generic English is wrong — and if you find yourself
adding a whole family of entries, the generic rule is what needs fixing, not the table.

## Proof

- `tests/unit/dream-command.test.ts` — parse, describe, outcome (28 cases)
- `tests/unit/cli-manifest.test.ts` — the manifest matches the real tree
- `npm run verify:dream-actions` — the real server, the real WS route, a real browser, both
  themes: identity, mark, tone, grouping, the honest `✗`, chains, and the 32px measurement
