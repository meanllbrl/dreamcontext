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
| `dc.team.ask(member, text)` | ✗ | ✓ | a fresh run of that agent, labelled "from the app" |
| `dc.team.thread(member)` | ✗ | ✓ | |
| `dc.mcp.call(server, tool, args)` | ✗ | ✓ | key-based MCP only (no Claude, no OAuth connectors) |
| `dc.notify({body, sound, banner, notch, path})` | ✓ | ✓ | Mac banner + notch row titled with the app's name, wearing the app's icon; 30/min. See "dc.notify" below |
| `dc.automations.create(manifest)` / `.list()` | ✗ | ✓ | agent automations owned by this app |
| `dc.schedules.list()` | ✓ | ✓ | next/last runs |
| `dc.theme()` | ✓ | ✓ | `light` / `dark` / `system`; the page also gets `<html data-theme>` and a `dc-theme` event |
| `dc.copy(text)` | ✓ | ✗ | the Mac pasteboard, Turkish intact |
| `dc.embed(view, params)` | ✓ | ✓ | URL of an embeddable screen: chat, insight, tasks, roadmap, team |
| `dc.mountEmbed(host, view, params)` | ✓ | ✗ | draws that screen into `host`, with the height it needs |
| `dc.api(method, path, body)` | subset | ✓ | any dashboard API route |

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
