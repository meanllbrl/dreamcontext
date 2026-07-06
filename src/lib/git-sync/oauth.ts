/**
 * GitHub OAuth **device flow** — the "sign into dreamcontext with GitHub"
 * path for the launcher/dashboard. Device flow is the correct grant for a
 * local, secret-less client: the user authorizes a short `user_code` at
 * github.com/login/device and we poll for the token.
 *
 * NO client_secret is ever used or stored (device flow is a public-client
 * grant). The registered OAuth App's public client_id ships embedded as
 * {@link DEFAULT_BRAIN_OAUTH_CLIENT_ID}; the `DREAMCONTEXT_GITHUB_CLIENT_ID`
 * env var overrides it (set it to {@link PLACEHOLDER_CLIENT_ID} to force
 * PAT-only mode).
 *
 * `fetchImpl` is injectable (default `globalThis.fetch`) so the unit tests
 * exercise the full flow with ZERO network.
 */

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/** The `repo` scope — needed to create/read/push a (private) brain repo. */
export const BRAIN_OAUTH_SCOPE = 'repo';

/**
 * PLACEHOLDER client_id, kept as the sentinel {@link isOAuthAppConfigured}
 * recognizes as "no OAuth App". Setting `DREAMCONTEXT_GITHUB_CLIENT_ID` to this
 * value explicitly disables the device flow (PAT-only mode).
 */
export const PLACEHOLDER_CLIENT_ID = 'Iv1.dreamcontext-placeholder';

/**
 * The registered "dreamcontext" GitHub OAuth App's public client_id (Device
 * Flow enabled, owned by the `meanllbrl` account). Device flow is a public-
 * client grant: this id is non-secret and safe to commit.
 */
export const DEFAULT_BRAIN_OAUTH_CLIENT_ID = 'Ov23lisakBMDeqzsr6Xg';

/**
 * The effective device-flow client_id, resolved LIVE (not frozen at import) so
 * the desktop main process can set `DREAMCONTEXT_GITHUB_CLIENT_ID` at any point
 * before the first request. Env override wins over the embedded default.
 */
export function resolveBrainOAuthClientId(): string {
  return (process.env.DREAMCONTEXT_GITHUB_CLIENT_ID || '').trim() || DEFAULT_BRAIN_OAUTH_CLIENT_ID;
}

/**
 * True when a REAL GitHub OAuth App is wired up — i.e. a non-empty client_id
 * that isn't the shipped placeholder. When false, the device flow cannot work
 * (GitHub 404s the placeholder) and the UI must steer users to the PAT path.
 */
export function isOAuthAppConfigured(clientId: string = resolveBrainOAuthClientId()): boolean {
  const id = clientId.trim();
  return id.length > 0 && id !== PLACEHOLDER_CLIENT_ID;
}

/**
 * @deprecated Frozen-at-import snapshot kept for backward compatibility. Prefer
 * {@link resolveBrainOAuthClientId} so a client_id set after module load is
 * honored.
 */
export const BRAIN_OAUTH_CLIENT_ID = resolveBrainOAuthClientId();

export type FetchImpl = typeof globalThis.fetch;

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Minimum seconds between polls (GitHub-supplied). */
  interval: number;
}

export type DevicePollResult =
  | { status: 'authorized'; token: string }
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'error'; message: string };

/**
 * Begin the device flow: request a device+user code pair from GitHub. Returns
 * the `deviceCode` (server-only — never exposed to the browser), the
 * `userCode` the user types, the verification URL, and GitHub's polling
 * interval.
 */
export async function startDeviceFlow(
  clientId: string = BRAIN_OAUTH_CLIENT_ID,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<DeviceFlowStart> {
  const body = new URLSearchParams({ client_id: clientId, scope: BRAIN_OAUTH_SCOPE });
  const res = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`GitHub device-code request failed (${res.status}).`);
  }
  const json = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };
  if (json.error || !json.device_code || !json.user_code) {
    throw new Error(json.error_description || json.error || 'GitHub returned no device code.');
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri || 'https://github.com/login/device',
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 900,
    interval: typeof json.interval === 'number' ? json.interval : 5,
  };
}

/**
 * Poll GitHub once for the device-flow token. Returns a discriminated union the
 * caller drives the poll loop with: `pending` (keep waiting), `slow_down`
 * (bump the interval), `authorized` (token in hand), or a terminal
 * `expired`/`denied`/`error`.
 */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<DevicePollResult> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const res = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    return { status: 'error', message: `GitHub token poll failed (${res.status}).` };
  }
  const json = (await res.json()) as {
    access_token?: string;
    error?: string;
    interval?: number;
  };
  if (json.access_token) return { status: 'authorized', token: json.access_token };
  switch (json.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'slow_down', interval: typeof json.interval === 'number' ? json.interval : 10 };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      return { status: 'error', message: json.error || 'Unknown device-flow error.' };
  }
}

/**
 * Validate a token (device-flow OR a pasted PAT) by reading the authenticated
 * user. Returns the login on success, or null when the token is invalid/expired
 * (401). NEVER logs the token.
 */
export async function fetchAuthenticatedLogin(
  token: string,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<string | null> {
  const res = await fetchImpl(GITHUB_USER_URL, {
    method: 'GET',
    headers: { Accept: 'application/vnd.github+json', Authorization: `token ${token}` },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`GitHub /user request failed (${res.status}).`);
  const json = (await res.json()) as { login?: string };
  return json.login ?? null;
}
