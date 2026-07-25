---
id: know_C9fbD0LE
name: dashboard-server-security
description: >-
  Threat model and four mitigations for the local dreamcontext dashboard HTTP
  server: loopback binding, network-exposure token gate, Origin/Host CSRF check,
  and path-traversal guard.
tags:
  - security
  - backend
  - decisions
  - architecture
pinned: false
date: '2026-07-18'
---

## Why This Exists

The dreamcontext dashboard server exposes unauthenticated read/write routes over an HTTP server (`src/server/index.ts`). Before first npm publish a security review (session `f007d91a`) identified three exploitable gaps. This file captures the threat model and the mitigations that shipped in v0.5.0 so future contributors understand the constraints and don't regress them.

## Threat Model

The server edits files in `_dream_context/` — including soul, memory, and task files — over plain HTTP with no authentication token. This is intentional for the local-only use case but creates three threat vectors when left unconfigured:

**Threat 1 — LAN reachability**
`server.listen(port)` with no hostname binds to `0.0.0.0` (all interfaces). Any machine on the same LAN can read or write the user's project context. Shared offices, coffee shops, and home networks are all affected.

**Threat 2 — Browser CSRF**
`Access-Control-Allow-Origin: *` plus `Content-Type` in allowed CORS headers means any webpage the user has open can issue a cross-origin `POST/PUT/PATCH` to `http://localhost:<port>/api/...` and the browser will not block it. A malicious ad on any website could overwrite soul, user, or memory files.

**Threat 3 — Path traversal**
`PUT /api/core/:filename` constructed the file path as `join(getCoreDir(contextRoot), filename)` where `filename` came from the URL. `path.join()` resolves `..` components, so `PUT /api/core/../../etc/passwd` would attempt to write outside `_dream_context/core/`. Because the handler checked `existsSync`, only existing files were writable — but the surface was still exploitable against any file the server's process can reach that already exists.

## Decision: Fix Before npm Publish

The review established that these are **must-fix before first npm publish**. The package would be installed by users with real projects, open browsers, and possibly networked machines. The fixes are inexpensive and non-breaking; deferring them would be irresponsible.

## The Three Mitigations (v0.5.0)

### 1. Loopback bind (`src/server/index.ts`)```typescript
export interface ServerOptions {
  host?: string; // Defaults to '127.0.0.1'
}

const { host = '127.0.0.1' } = options;
server.listen(port, host, () => { ... });```The server now defaults to `127.0.0.1`. A `--host` flag exists for power users who knowingly want network exposure (dashboard.ts passes it through), but the default is safe. A warning is printed when `host !== '127.0.0.1'`.

### 2. Origin/Host CSRF check (`src/server/middleware.ts`)```typescript
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function isCrossSiteWrite(req: IncomingMessage): boolean {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (!origin) return false;  // non-browser clients (curl, CLI) have no Origin
  return !LOCAL_ORIGIN_RE.test(origin);
}```Mutating requests (`POST/PUT/PATCH/DELETE`) from a cross-site origin are rejected with 403. Non-browser clients (the CLI itself, `curl`) send no `Origin` header and pass through. CORS now reflects only loopback origins rather than `*`, so cross-origin reads from a third-party page are also blocked.

### 3. Path-traversal guard (`src/server/safe-path.ts`)```typescript
export function safeChildPath(baseDir: string, child: string): string | null {
  if (!child || child.includes('\0')) return null;
  const base = resolve(baseDir);
  const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}```Every route handler that builds a filesystem path from request input now calls `safeChildPath(dir, filename)` and returns 400 on null. This covers `GET /api/core/:filename`, `PUT /api/core/:filename`, `GET /api/knowledge/:slug`, and `PATCH /api/knowledge/:slug`.

### 4. Network-exposure token gate (`src/server/network-auth.ts`, 2026-07-18)

Threat 1's residual gap: a user who *deliberately* runs `--host 0.0.0.0` (e.g. to view the dashboard from a phone) exposed the fully unauthenticated read/write API to everyone on the same wifi — the café scenario. Now, whenever the bind host is not loopback, the server generates a per-process 256-bit token (`generateNetworkToken`) and `checkNetworkAuth` gates **every** request from a non-loopback peer:

- Loopback peers (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) bypass the gate — the CLI, hooks (`hook.ts` health/shutdown calls), and local browser keep working unchanged.
- Other devices must open the tokenized URL printed in the startup banner (`?token=...`), which sets an `HttpOnly; SameSite=Strict` cookie; subsequent requests authenticate via the cookie. Token comparison is `timingSafeEqual` with a length guard.
- Everything else gets 401 before CORS/routing runs.
- The banner enumerates external IPv4 interface addresses for a wildcard bind so the printed URLs are actually reachable from another device.
- The agent terminal WebSocket remains hard-gated to loopback peers regardless (`attachAgentTerminal`), token or not.

On the default loopback bind no token exists and behavior is identical to before. Tests: `tests/unit/network-auth.test.ts`; e2e smoke-verified via LAN-IP curl (401 bare / 200+cookie with token / 200 with cookie / 401 wrong token / 200 loopback).

## Tests

`tests/unit/server-security.test.ts` covers: `isCrossSiteWrite` for GET/POST/PUT with various Origin values; `handleCors` with loopback vs cross-site origins; `safeChildPath` for `..` traversal, absolute paths, null bytes, and valid relative paths.

## Constraints and Anti-Regressions

- The CSRF check relies on browsers always sending `Origin` on cross-origin state-changing requests. This is a browser behavior guaranteed by the Fetch spec and CORS standard — do not remove the `!origin → return false` path, as it is what lets the CLI and curl work.
- Never change the default `host` back to `0.0.0.0` or remove the check.
- Any new mutating route must call `isCrossSiteWrite` (it's enforced at the server level in `createServer`, so new routes inherit this automatically — but this must stay at the server level, not be moved per-route).
- Any new route that constructs a filesystem path from request input MUST use `safeChildPath`.
- The network token gate runs at the server level in `createServer` (before CORS and routing) — keep it there so new routes inherit it. Never allow a non-loopback peer through without the token, and never widen `isLoopbackAddress`.

## Related occurrences of this containment pattern elsewhere in the codebase

This threat model is specific to the dashboard HTTP server, but the SAME lexical-containment pattern (resolve → compare against a fixed base dir → reject anything that escapes it) recurs in other subsystems that turn externally-influenced input into a filesystem path. Each is documented in its own home (do not duplicate detail here — this is a pointer only):
- `GET /api/knowledge-assets/:slug` (board embedded-image resolution) — see `[[dashboard-knowledge-rendering]]`.
- GitHub task-image bridge (`isInsideRoot`, resolving image paths referenced from a REMOTE issue body) — see the Constraints & Decisions section of `core/features/task-management.md`. This one additionally needed a stat-gate-before-read for the size cap, since the input here is attacker-influenced (a synced GitHub issue), not just a URL param.

### Desktop-gated OS handoff (Agent Chat file access, 2026-07-25)

The Agent Chat view (`/api/agent/chat` WebSocket bridge + read surfaces) extends the containment pattern with a TWO-GATE model for files OUTSIDE the project root — a second occurrence of the narrow-allowlist shape:

**Gate 1: Explicit user grants** (`POST /api/agent/grant`, `GET /api/agent/file` with `resolveServablePath`)
- `GET /api/agent/file` serves files under the project root via `safeChildPath` (existing traversal guard); any path OUTSIDE the project root returns 403 `needs_grant` instead of a refusal.
- `POST /api/agent/grant` records ONE absolute file path per vault in `_dream_context/state/.file-grants.json` (max 500) on an explicit user click. **Files only** — a granted directory would widen into everything beneath it; nothing in the transcript needs that.
- Sibling files in the same folder still denied (each file is a separate grant).
- Traversal-hostile input (`..`, null bytes, non-absolute paths) rejected before touching the filesystem.

**Gate 2: Reveal-vs-open decision** (`POST /api/agent/reveal`)
- A file named in the transcript that cannot be shown inline is handed to the OS: **folders + view-harmless types** (media + `REVEAL_SAFE_DOC_EXT` documents: `.pdf`, `.txt`, `.md`, `.json`, etc.) are opened in the default app; **anything else** (`.sh`, `.command`, `.pkg`, `.app`, extension-less files) is **revealed in the file manager** (macOS `-R`, Windows `/select,`, Linux parent directory) instead of launched.
- A click in a chat bubble must never execute a script or installer.
- Desktop-gated, argv form (no shell interpretation), file existence verified before opener call.

**Constraints:**
- Never widen the `REVEAL_SAFE_DOC_EXT` allowlist casually — it is a small set of types a viewer displays rather than executes. A denylist is one unknown installer format away from launching something.
- Grants are vault-scoped (recorded per `contextRoot`), not app-global. A file granted in one project does not become accessible in another.
- The 500-grant cap prevents unbounded ledger growth from a long-running vault; the truncation is FIFO (oldest grants discarded first).

**Tests:** `tests/unit/agent-reveal-grant.test.ts` (17 tests) — desktop gate, body/existence guards, open-vs-reveal decision per type (a `.sh` is never handed to the opener bare), grant semantics end-to-end (refused → granted → served, sibling still refused), idempotency.

## Desktop-gated OS handoff (2026-07-25, Agent Chat view)

A second occurrence of the narrow-allowlist containment pattern shipped with the Chat view's file-opening surfaces. Three routes (`GET /api/agent/file`, `POST /api/agent/grant`, `POST /api/agent/reveal`) all apply project-root scoping and careful type-based gating to ensure a click in a transcript can never launch arbitrary code. All three are desktop-gated (`DREAMCONTEXT_DESKTOP=1`) and loopback-only.

### `/api/agent/file` — project-scoped read surface

Key file: `src/server/routes/agent-chat.ts`, `handleAgentFile()`.

Returns one of three answers depending on what the path resolves to (all under the **active vault's project root**, never `_dream_context/` alone — that's `graph/content`'s job):

1. **Text/markdown preview** — `{type:'markdown'|'text', content}`, 512 KB cap. The whole body goes into JSON so Chat can render it inline.
2. **Directory listing** — `{type:'dir', files:[]}`, folders first, 300 entries, then `truncated:true`. A folder named in a transcript is something to browse, not an error.
3. **Raw media bytes** with `?raw=1` — images (PNG/JPEG/GIF/WebP), video (mp4/m4v/webm/mov/ogv), audio (mp3/m4a/wav/oga/ogg/flac). Streamed with `Accept-Ranges` + correct `206 Partial Content` so `<video>`/`<audio>` can seek (a 200-with-everything makes clips unseekable in Safari). Capped at 2 GB.

**Security posture:**
- Traversal guard refuses any resolved path outside the project root (the same `safeChildPath` pattern used elsewhere).
- `X-Content-Type-Options: nosniff` on every response — the browser must honor the declared MIME, not sniff content.
- **SVG is always served as text preview, never as `image/svg+xml`**, because SVG can embed `<script>` and `<foreignObject>` — an attacker-controlled SVG rendered natively in the browser is XSS.

**Outside-root files:** instead of a dead refusal, an outside-root path returns **403 with `error:'needs_grant'`**. The Chat card offers *Allow access* → `POST /api/agent/grant` (below).

### `/api/agent/grant` — explicit single-file consent

Key file: `src/server/routes/agent-chat.ts`, `handleAgentGrant()`.

Records **ONE absolute file path per vault** in `state/.file-grants.json` (max 500, files only — never a directory, never a pattern). The consent is always a real user click on a named file: the agent cannot grant on its own behalf.

**Containment rules:**
- Files only, not directories (a `stat` check enforces this).
- `..` paths are rejected (`invalid_path`) — no traversal tricks.
- **One grant never widens to a folder** — the sibling file in the same folder still returns `needs_grant` until separately granted.

After a grant, `/api/agent/file` for that path succeeds.

### `/api/agent/reveal` — OS opener, allowlist-gated

Key file: `src/server/routes/agent-chat.ts`, `handleAgentReveal()`.

Hands a path to the OS, and the **two modes ARE the safety story**:

| Path type | Action |
|---|---|
| Folder | Open in file manager |
| Media file (image/video/audio) | Open in default app |
| Inert document (`.pdf .txt .md .markdown .json .yaml .yml .toml .csv .tsv .log .rtf .html .htm .xml .svg`) | Open in default app |
| **Anything else** | **Reveal in file manager** (`open -R` / `explorer /select,` / `xdg-open <dir>`), never launch |

A `.sh`, `.command`, `.pkg`, `.app`, or extension-less file named in a transcript can **never be executed** by a click in a chat bubble, while the user still gets to it in one step.

**Deliberately an allowlist of what's inert to view, not a denylist of what's dangerous.** A denylist is one unknown installer format away from launching something.

Requires:
- Desktop-gated (same as the other two)
- Argv form (no shell)
- File must exist (`existsSync` check)

### Tests

`tests/unit/agent-reveal-grant.test.ts` (17 tests) covers: the desktop gate, body/existence guards, the open-vs-reveal decision per type (a `.sh` is never handed to the opener bare), reaching a file outside the project root (the route's whole purpose), and grant semantics end-to-end — refused → granted → served, with the sibling file still refused, plus idempotency.

## Sources

- Session `f007d91a-b861-47c2-8154-033cf8899871` — security review + DECISION to pull hardening into v0.5.0
- `src/server/index.ts`, `src/server/middleware.ts`, `src/server/safe-path.ts`, `src/server/routes/core.ts`
- `tests/unit/server-security.test.ts`

## Last Verified

2026-07-25 — Desktop-gated OS handoff (Agent Chat file access: `/api/agent/grant`, `/api/agent/reveal`, `GET /api/agent/file` outside-root handling) added as a second occurrence of the narrow-allowlist containment pattern. Network-exposure token gate (mitigation 4) shipped in v0.18.0+. Original three mitigations (loopback bind, CSRF check, path-traversal guard) shipped in commit `0f3965f` as part of v0.5.0.
