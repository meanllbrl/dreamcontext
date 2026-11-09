import { fileSessionParam } from '../lib/chatAppBinding';
import { phoneAllows } from '../lib/phoneSurface';

const BASE_URL = '/api';

interface ApiError {
  error: string;
  message: string;
}

/**
 * A non-2xx answer from the local API, carrying the route's machine-readable `error` slug
 * alongside its prose. Still an `Error` with the server's `message`, so every existing
 * `catch (err: Error) { … err.message }` keeps working untouched.
 */
/** What the owner reads when his own click in the app is refused for want of the owner key. */
export const OWNER_REOPEN_LINE = 'dreamcontext has to be reopened before it can do this for you: quit it (⌘Q), open it again and try once more.';

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * The vault this WINDOW was pinned to at boot.
 *
 * @deprecated Legacy single-vault state. One window now holds N live projects, so the vault
 * is a property of the CLIENT (`new ApiClient(vault)`), not of the module — see
 * `context/VaultContext.tsx`'s `useApi()`. This variable exists solely to keep the two
 * deprecated accessors below working while the call sites migrate; it is deleted, together
 * with them, at the end of Faz 2. Nothing else in this module reads it.
 */
let activeVault: string | null = null;

/** @deprecated Removed at the end of Faz 2 — construct an `ApiClient` with the vault instead. */
export function setActiveVault(v: string | null): void {
  activeVault = v;
}

/**
 * The pinned vault name, for callers that can't use the header — notably the
 * agent-terminal WebSocket (the browser WS API can't set request headers), which
 * carries the vault as a `?vault=<name>` query param instead.
 *
 * @deprecated Removed at the end of Faz 2 — take the vault from `useVault()` and thread it.
 */
export function getActiveVault(): string | null {
  return activeVault;
}

/**
 * The URL for one project file, ready to hand to the BROWSER rather than to `fetch`.
 *
 * `<img src>`, `<video src>` and `<audio src>` are fetched by the browser itself, which
 * sends no custom headers — so the vault has to travel in the URL or the server has no way
 * to know which project the path belongs to. In launcher mode (nothing pinned server-side)
 * that was the entire failure: every inline picture and every clip in Chat came back 400
 * `no_vault`, and the transcript showed a can't-load card for a file sitting right there.
 * Anything that reaches the file endpoint as an element `src` must be built here.
 *
 * Deliberately a MODULE FUNCTION taking the vault, not an `ApiClient` method: two of its
 * callers are pure, non-React helpers (`chatEntities.ts`'s `rawUrl`, `PageView.tsx`'s
 * `resolveImage`) that render markdown and have no business holding a client just to read
 * one scalar. Same one-parameter shape as `uploadAgentFile`/`mintPromptToken` — one pattern.
 *
 * `raw` asks for the bytes (range-streamed, so video seeks); without it the endpoint
 * answers the JSON text preview that `api.get` reads.
 */
export function agentFileUrl(vault: string | null, path: string, opts: { raw?: boolean; session?: string | null } = {}): string {
  const raw = opts.raw ? '&raw=1' : '';
  const scope = vault ? `&vault=${encodeURIComponent(vault)}` : '';
  // The chat session the path was written in: a child working in its own worktree names files
  // relative to THAT tree, which only the server can map back (session-worktree.ts).
  const session = opts.session ? `&session=${encodeURIComponent(opts.session)}` : fileSessionParam();
  return `${BASE_URL}/agent/file?path=${encodeURIComponent(path)}${raw}${scope}${session}`;
}

/**
 * The URL for one file INSIDE the vault (`path` relative to `_dream_context/`), for the same
 * hand-it-to-the-browser reason as {@link agentFileUrl} — an `<iframe src>` is fetched by the
 * browser, which sends none of `api.get`'s headers, so the vault has to ride in the URL.
 *
 * Distinct from {@link agentFileUrl} because the two routes have different reach and different
 * gates: `/agent/file` covers the whole PROJECT and is desktop-only, while this one covers the
 * vault and works in a browser dashboard too. A knowledge note's link to the document it was
 * distilled from is a vault file being read by a vault page, so it belongs here — routing it
 * through the chat surface's endpoint would answer "desktop only" outside the app.
 */
export function graphContentUrl(vault: string | null, path: string, opts: { raw?: boolean } = {}): string {
  const raw = opts.raw ? '&raw=1' : '';
  const scope = vault ? `&vault=${encodeURIComponent(vault)}` : '';
  return `${BASE_URL}/graph/content?path=${encodeURIComponent(path)}${raw}${scope}`;
}

/**
 * The URL for one task attachment (`state/assets/<slug>/<path>`), for an `<img>`/`<video>`/
 * PDF frame — the same hand-it-to-the-browser reason as {@link graphContentUrl}: the vault
 * rides in `?vault=`. The route serves images, audio, video and PDF only (415 otherwise).
 */
export function taskAssetUrl(vault: string | null, slug: string, path: string): string {
  const scope = vault ? `&vault=${encodeURIComponent(vault)}` : '';
  return `${BASE_URL}/tasks/${encodeURIComponent(slug)}/assets/raw?path=${encodeURIComponent(path)}${scope}`;
}

/**
 * The URL for a connected PEER vault's logo (`_dream_context/assets/logo.*` in the peer's
 * own tree), for the same hand-it-to-the-browser reason as {@link agentFileUrl}: an
 * `<img src>` carries no headers, so the requesting vault rides in `?vault=` and the peer's
 * name in `?peer=`. The server gates on an active connection — same consent line as mail.
 */
export function peerLogoUrl(vault: string | null, peer: string): string {
  const scope = vault ? `&vault=${encodeURIComponent(vault)}` : '';
  return `${BASE_URL}/peer/logo?peer=${encodeURIComponent(peer)}${scope}`;
}

/**
 * A REGISTERED vault's logo, for the launcher's cards and Space chips. Distinct from
 * {@link peerLogoUrl} because the two routes have different gates: this one serves the
 * user their own registry (registration is the only check), while the peer route serves
 * another vault's file and rides the federation consent line.
 */
export function launcherLogoUrl(name: string): string {
  return `${BASE_URL}/launcher/logo?vault=${encodeURIComponent(name)}`;
}

/**
 * One project's view of the local API. The vault is bound at CONSTRUCTION and forwarded on
 * every request as `X-Dreamcontext-Vault`, which the server resolves per-request to that
 * project's context root.
 *
 * Per-instance rather than a module singleton because one window now hosts several live
 * projects at once: a module-level "active vault" would make every in-flight request race
 * whichever chip the user touched last. Components get theirs from `useApi()`; the `null`
 * client below is the launcher/browser case, where no project is pinned.
 */
/**
 * Each local `phone_unavailable` refusal, counted on `window.__dcPhoneRefused`. The network log
 * cannot see one (no request leaves), so this is how a check proves the phone's screens never
 * ask for a route the phone cannot have: the count stays 0 over a whole session.
 */
function countPhoneRefusal(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __dcPhoneRefused?: number };
  w.__dcPhoneRefused = (w.__dcPhoneRefused ?? 0) + 1;
}

export class ApiClient {
  constructor(private readonly vault: string | null) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    // On the phone only the allowed routes exist for this page: answer the
    // server's own refusal locally instead of sending a request it is built to refuse.
    if (!phoneAllows(options?.method ?? 'GET', `${BASE_URL}${path}`)) {
      countPhoneRefusal();
      throw new RequestError('Not available on the phone.', 403, 'phone_unavailable');
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    };
    if (this.vault) {
      headers['X-Dreamcontext-Vault'] = this.vault;
    }
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let message = `Request failed: ${res.status}`;
      let code = '';
      try {
        const err = await res.json() as ApiError;
        if (err.message) message = err.message;
        if (err.error) code = err.error;
      } catch { /* non-JSON error response */ }
      // The route's own `error` slug rides along. Callers that show a failure to a PERSON
      // need to pick their own words for it — matching on the English of `message` would be
      // a UI that breaks when a route reworded itself.
      throw new RequestError(message, res.status, code);
    }

    return await res.json() as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * A POST in the owner's name (shared apps: publish, install, update…): carries the key only the
   * shell holds, so an agent's request to the same route is refused. Null key = refused there.
   */
  async ownerPost<T>(path: string, body: unknown): Promise<T> {
    const { ownerKey, isDesktop } = await import('../lib/desktop');
    const key = await ownerKey();
    try {
      return await this.request<T>(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: key ? { 'X-Dreamcontext-Owner-Key': key } : {},
      });
    } catch (e) {
      // In the app this is the owner's own click: a refusal means this window holds no key the
      // server knows (a shell older than the page, a server it did not start). Only reopening
      // mends that, so the owner reads that, never "only the owner can" (2026-11-09).
      if (e instanceof RequestError && e.code === 'owner_page_only' && isDesktop()) {
        throw new RequestError(OWNER_REOPEN_LINE, e.status, e.code);
      }
      throw e;
    }
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  del<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' });
  }

  /**
   * POST raw bytes — a file, not a JSON envelope.
   *
   * Base64-in-JSON was the alternative and is worse on both ends: it inflates
   * the payload by a third, and it would make the server decode a string
   * before it could sniff the magic bytes it actually trusts. The vault still
   * rides the header, because this is a POST and the `?vault=` query channel
   * is deliberately GET-only (see `requestedVaultName`).
   *
   * `Content-Type` is `application/octet-stream` and is NOT a claim about what
   * the file is: the server derives the real type from the bytes.
   */
  postBytes<T>(path: string, bytes: Blob | ArrayBuffer): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }
}

/**
 * An agent's photo, as a URL an `<img>` can load.
 *
 * `?vault=` rather than the header for the reason `launcherLogoUrl` documents:
 * a browser subresource carries no custom headers, and the server accepts the
 * query channel on GET only.
 *
 * `v` is a CACHE BUSTER, not data: a photo is replaced in place at a stable
 * URL, so without it the owner uploads a new picture and keeps looking at the
 * old one. Callers pass something that changes when the photo does.
 */
export function automationPhotoUrl(vault: string | null, slug: string, v?: string | number): string {
  const params = new URLSearchParams();
  if (vault) params.set('vault', vault);
  if (v !== undefined) params.set('v', String(v));
  const qs = params.toString();
  return `${BASE_URL}/automations/${encodeURIComponent(slug)}/photo${qs ? `?${qs}` : ''}`;
}

/**
 * An AGENT's photo (`GET /api/agents/:slug/photo`), for the same `<img>` reasons as
 * {@link automationPhotoUrl}. Distinct because an agent may exist with no automation file of
 * its own slug (a new-format agent you only call), where the automations route answers 404.
 */
export function agentPhotoUrl(vault: string | null, slug: string, v?: string | number): string {
  const params = new URLSearchParams();
  if (vault) params.set('vault', vault);
  if (v !== undefined) params.set('v', String(v));
  const qs = params.toString();
  return `${BASE_URL}/agents/${encodeURIComponent(slug)}/photo${qs ? `?${qs}` : ''}`;
}

/**
 * The unpinned client — no vault header, so the server answers for its own pinned root.
 * This is what the launcher, the capture bar, the perch and the checklist window use (and
 * what `useApi()` returns outside a `VaultProvider`), which is why it must stay exported.
 */
export const api = new ApiClient(null);
