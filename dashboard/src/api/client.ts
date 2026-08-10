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
export function agentFileUrl(vault: string | null, path: string, opts: { raw?: boolean } = {}): string {
  const raw = opts.raw ? '&raw=1' : '';
  const scope = vault ? `&vault=${encodeURIComponent(vault)}` : '';
  return `${BASE_URL}/agent/file?path=${encodeURIComponent(path)}${raw}${scope}`;
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
 * One project's view of the local API. The vault is bound at CONSTRUCTION and forwarded on
 * every request as `X-Dreamcontext-Vault`, which the server resolves per-request to that
 * project's context root.
 *
 * Per-instance rather than a module singleton because one window now hosts several live
 * projects at once: a module-level "active vault" would make every in-flight request race
 * whichever chip the user touched last. Components get theirs from `useApi()`; the `null`
 * client below is the launcher/browser case, where no project is pinned.
 */
export class ApiClient {
  constructor(private readonly vault: string | null) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
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
}

/**
 * The unpinned client — no vault header, so the server answers for its own pinned root.
 * This is what the launcher, the capture bar, the perch and the checklist window use (and
 * what `useApi()` returns outside a `VaultProvider`), which is why it must stay exported.
 */
export const api = new ApiClient(null);
