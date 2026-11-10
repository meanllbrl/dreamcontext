# The dreamcontext App SDK

```js
// page
import { dc } from '/__dc/sdk.js';
// backend
import { dc } from './lib/dc.mjs';
```

| call | page | backend | what |
|---|---|---|---|
| `dc.insights.list()` / `.get(slug)` / `.boards()` / `.board(slug)` / `.explore(slug)` | ✓ | ✓ | Lab insights and boards |
| `dc.tasks.list(query)` / `.get(slug)` | ✓ | ✓ | this project's tasks |
| `dc.tasks.create({name, why, description, priority, urgency, tags})` | ✓ | ✓ | opens a task, labelled as coming from this app |
| `dc.tasks.update(slug, {priority, urgency, tags, start_date, due_date})` | ✓ | ✓ | |
| `dc.tasks.update(slug, {status, …anything else})` | ✗ `backend_only` | ✓ | closing a task can end a live agent job |
| `dc.roadmap.get()` / `.objectives()` | ✓ | ✓ | |
| `dc.team.list()` | ✓ (narrowed) | ✓ | the AI Team |
| `dc.ask(text)` | ✗ | ✓ | the app's assistant answers one question, `{ok, answer}` or `{ok:false, code}`. Read-only: it reads the app's files and runs nothing. Own assistant or bound member, same call. 3 at once, 20 a minute |
| `dc.learn(text)` | ✗ | ✓ | one lesson this app learned (≤600 characters, no personal data) for sleep, which writes `knowledge/apps/<slug>.md`; `{ok, id}`, 20 waiting → `learn_full` |
| `dc.team.ask(member, text)` | ✗ | ✓ | a fresh run of that agent, labelled "from the app" |
| `dc.team.thread(member)` | ✗ | ✓ | |
| `dc.mcp.call(server, tool, args)` | ✗ | ✓ | key-based MCP only (no Claude, no OAuth connectors) |
| `dc.notify({body, sound, banner, notch, path})` | ✓ | ✓ | Mac banner + notch row titled with the app's name, wearing the app's icon; 30/min. See "dc.notify" below |
| `dc.automations.create(manifest)` / `.list()` | ✗ | ✓ | agent automations owned by this app |
| `dc.schedules.list()` | ✓ | ✓ | next/last runs |
| `dc.theme()` | ✓ | ✓ | `light` / `dark` / `system`; the page also gets `<html data-theme>` and a `dc-theme` event |
| `dc.copy(text)` | ✓ | ✗ | the Mac pasteboard, Turkish intact |
| `dc.embed(view, params)` | ✓ | ✓ | URL of an embeddable screen: chat, insight, tasks, roadmap, team. params: `theme`, `bg`, `surface`, `text`, `accent` |
| `dc.mountEmbed(host, view, params)` | ✓ | ✗ | draws that screen into `host`, with the height it needs and the page's colours; the iframe's `dcRetheme()` reloads it after a theme change |
| `dc.api(method, path, body)` | subset | ✓ | any dashboard API route |
| `dc.data.status()` | ✓ | ✓ | where this app's data lives: `{ mode: 'shared'\|'pending'\|'local'\|'undecided'\|'sync_off', shared: string[], pending: string[], held: {path, reason}[] }`. See "dc.data" below |
| `dc.data.read(path, validate)` | ✓ | ✓ | one file of the app's data folder, passed through `validate` (shared data is someone else's) |
| `dc.data.write(path, content)` | ✗ | ✓ | writes one file atomically (temp name, then rename) |
| `dc.data.remove(path)` | ✗ | ✓ | the only real delete of a shared file: it reaches the team |

**An embedded screen reaches this Mac only.** Nothing drawn inside it (a picture, a board, a PDF)
can load or open anything from the internet: the screen's policy and the window both refuse it, and
the window has WebRTC, preconnect and DNS prefetch switched off. A remote picture or video in a chat
answer and the board's handwritten fonts do not draw there. The app's own page keeps its own rules.

**An app chat draws no HTML the assistant wrote**, in the app window and in the main app alike: a
`dream-html` block, a question's previews, a board's HTML and web widgets, a board's live web embed
(YouTube, Figma) and an HTML insight body. Each leaves a line saying it was not drawn, a block with
its source behind a fold; a question keeps its labels and is answered by them. Markdown, tables,
code, pictures from the project, boards and PDFs draw. Write the assistant's role for that: it
answers in text, not in drawn layouts.

**Embedding takes height.** Use `dc.mountEmbed`, not your own `<iframe>`: it fills `host` and keeps
both at the minimum or above (560px; insight 360px), so a shorter `host` grows. Give `host` a height
to fill it with `height`, e.g. the app's full height: the helper sets `min-height` on `host` itself,
replacing yours. An ancestor that clips `host` is still yours to fix.

Under the minimum the chat still works, but at 360px only about 155px of messages remain, and a long
draft leaves about 45px (about 120px at 560). An iframe you write yourself needs `min-height: 560px`.

Errors are `DcError` with a `code` (`backend_only`, `mcp_needs_key`, `mcp_needs_owner_ok`,
`mcp_definition_changed`, `rate_limited`, …) and a message that says how to fix it.

MCP: a server from `.mcp.json` needs the owner's one click in the notch before the app may use it
(Apps card → "Approve in the notch"); servers from Settings or `~/.claude.json` need none. `${VAR}`
in a definition is filled from the app's `.env` only.

### dc.notify

`sound`: `true` or `"default"` plays a sound (Glass), a name plays that sound (`Glass`, `Basso`,
`Ping`, `Pop`, `Purr`, `Submarine`, `Tink`, `Hero`, `Funk`, `Blow`, `Bottle`, `Frog`, `Morse`,
`Sosumi`), `false` or `"none"` is silent, and leaving it out is silent. Anything else is a
`bad_sound` error whose message lists the valid values. The sound belongs to the banner: with
`banner: false` there is none.

The banner leaves from the app's own bundle, so it wears the app's icon and a click opens the app.
The answer's `via` says which bundle posted: `app`, or `dreamcontext` when the bundle cannot post
yet (it predates this, or the app never opened). The next open with no window up rebuilds it,
and that takes a dreamcontext desktop app new enough to carry the runner's notify mode.
Each app has its own entry in System Settings → Notifications: the first banner makes macOS ask
for permission, and until the owner allows it banners stay silent and off screen, even though
the answer says `banner: true`. The notch row needs no permission.

A backend-less app (only `public/`) can use every ✓-page call; anything backend-only needs a backend.

### dc.data

The hand-made data the team makes in the app builds up in the brain; the manifest's `data` field
says which paths are shared and the owner approves them once (the `/apps` skill). `dc.data.status()`
is what the app SHOWS about it, never a fixed sentence of its own. `mode` says what is shared NOW:
- `shared`: at least one approved shared path is live and syncing to the team (even while a newly
  declared path still waits for the owner);
- `pending`: nothing approved yet, and a declared shared path waits for the owner;
- `local`: declared, nothing shared (`shared: []`, or the owner said "keep it local");
- `undecided`: no `data` field yet;
- `sync_off`: the brain's cloud sync is off.

`shared` lists the live shared paths, `pending` the declared paths still waiting for the owner's
approval, and `held` the files that stay here with a reason code (`too_big`, `db_file`, `name`,
`not_plain`, `writing`, `over_cap`, `not_approved_here`, `conflict`). Key the app's sentence on
`mode === 'shared'` alone: "8 records · shared with the team" then, "8 records · only on this Mac"
for `pending`, `local`, `undecided` and `sync_off` (nothing of it reaches the team yet).

Every `dc.data.*` path resolves inside the calling app's own data folder only; `..`, an absolute
path and a part starting with a dot are refused. Read shared files with a `validate` function and
draw them with `textContent`. A file missing on this Mac is never a delete; only `dc.data.remove`
deletes, and only a shared path of this app. While a team pull is landing the app is paused: calls
answer 503 `{error:'paused_for_sync'}` for a few seconds (until the merge finishes, if one is left
open). An older copy of `lib/dc.mjs` lacks these calls: `dreamcontext apps validate --fix-sdk`
refreshes it.

### dc.actions and dc.health (backend only)

`dc.actions(['snapshot', 'ask'])` says which manifest tools this backend serves (an object keyed by
tool id works too; only its keys are read). A tool in the manifest that the list lacks is written to
stderr at start. Answer the manifest's health route with `json(res, 200, dc.health())`: the body is
`{"ok": true, "dcActions": [...]}` plus whatever you pass (`dc.health({db: 'up'})`). dreamcontext
reads the first 4 KB of that answer on every start and shows "N tools · M change" on the app card,
with a warning when a listed tool is not served (`actions_drift`). An app whose health answers no
`dcActions` shows "not audited".
