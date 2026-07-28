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
 * The vault this window is pinned to. Set once at boot from the `?vault=` URL
 * param (see setActiveVault). When present it is forwarded on every request as
 * the X-Dreamcontext-Vault header, which the server resolves per-request to the
 * matching context root. Null in launcher mode (no vault pinned).
 */
let activeVault: string | null = null;

export function setActiveVault(v: string | null): void {
  activeVault = v;
}

/**
 * The pinned vault name, for callers that can't use the header — notably the
 * agent-terminal WebSocket (the browser WS API can't set request headers), which
 * carries the vault as a `?vault=<name>` query param instead.
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
 * `raw` asks for the bytes (range-streamed, so video seeks); without it the endpoint
 * answers the JSON text preview that `api.get` reads.
 */
export function agentFileUrl(path: string, opts: { raw?: boolean } = {}): string {
  const raw = opts.raw ? '&raw=1' : '';
  const vault = activeVault ? `&vault=${encodeURIComponent(activeVault)}` : '';
  return `${BASE_URL}/agent/file?path=${encodeURIComponent(path)}${raw}${vault}`;
}

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    };
    if (activeVault) {
      headers['X-Dreamcontext-Vault'] = activeVault;
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

export const api = new ApiClient();
