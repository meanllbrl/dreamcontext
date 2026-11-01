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
| `dc.notify({body, sound, banner, notch, path})` | ✓ | ✓ | Mac banner + notch row titled with the app's name; 30/min |
| `dc.automations.create(manifest)` / `.list()` | ✗ | ✓ | agent automations owned by this app |
| `dc.schedules.list()` | ✓ | ✓ | next/last runs |
| `dc.theme()` | ✓ | ✓ | `light` / `dark` / `system`; the page also gets `<html data-theme>` and a `dc-theme` event |
| `dc.copy(text)` | ✓ | ✗ | the Mac pasteboard, Turkish intact |
| `dc.embed(view, params)` | ✓ | ✓ | URL of an embeddable screen: chat, insight, tasks, roadmap, team |
| `dc.api(method, path, body)` | subset | ✓ | any dashboard API route |

Errors are `DcError` with a `code` (`backend_only`, `mcp_needs_key`, `mcp_needs_owner_ok`,
`mcp_definition_changed`, `rate_limited`, …) and a message that says how to fix it.

MCP: a server from `.mcp.json` needs the owner's one click in the notch before the app may use it
(Apps card → "Approve in the notch"); servers from Settings or `~/.claude.json` need none. `${VAR}`
in a definition is filled from the app's `.env` only.

A backend-less app (only `public/`) can use every ✓-page call; anything backend-only needs a backend.
