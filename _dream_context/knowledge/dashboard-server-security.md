---
id: know_C9fbD0LE
name: dashboard-server-security
description: >-
  Threat model and three mitigations for the local dreamcontext dashboard HTTP
  server: loopback binding, Origin/Host CSRF check, and path-traversal guard.
tags:
  - security
  - backend
  - decisions
  - architecture
pinned: false
date: '2026-05-31'
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

## Tests

`tests/unit/server-security.test.ts` covers: `isCrossSiteWrite` for GET/POST/PUT with various Origin values; `handleCors` with loopback vs cross-site origins; `safeChildPath` for `..` traversal, absolute paths, null bytes, and valid relative paths.

## Constraints and Anti-Regressions

- The CSRF check relies on browsers always sending `Origin` on cross-origin state-changing requests. This is a browser behavior guaranteed by the Fetch spec and CORS standard — do not remove the `!origin → return false` path, as it is what lets the CLI and curl work.
- Never change the default `host` back to `0.0.0.0` or remove the check.
- Any new mutating route must call `isCrossSiteWrite` (it's enforced at the server level in `createServer`, so new routes inherit this automatically — but this must stay at the server level, not be moved per-route).
- Any new route that constructs a filesystem path from request input MUST use `safeChildPath`.

## Sources

- Session `f007d91a-b861-47c2-8154-033cf8899871` — security review + DECISION to pull hardening into v0.5.0
- `src/server/index.ts`, `src/server/middleware.ts`, `src/server/safe-path.ts`, `src/server/routes/core.ts`
- `tests/unit/server-security.test.ts`

## Last Verified

2026-05-31 — code shipped in commit `0f3965f` as part of v0.5.0.
