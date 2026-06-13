const BASE_URL = '/api';

interface ApiError {
  error: string;
  message: string;
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
      try {
        const err = await res.json() as ApiError;
        if (err.message) message = err.message;
      } catch { /* non-JSON error response */ }
      throw new Error(message);
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
