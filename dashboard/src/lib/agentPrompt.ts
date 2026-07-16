import { api } from '../api/client';
import { getActiveVault } from '../api/client';

/**
 * How an initial prompt gets from the dashboard to a freshly-spawned `claude`.
 *
 * The terminal is a WebSocket, and the browser's WS API can't set request headers or send a
 * body with the handshake — so historically the only channel for the initial prompt was the
 * upgrade URL itself (`&prompt=<encoded>`). That lands the text in the HTTP REQUEST LINE,
 * which Node caps together with all headers at `--max-http-header-size` (16384 bytes by
 * default). Overflow is silent and total: the parser destroys the socket with
 * HPE_HEADER_OVERFLOW *before* the server's `upgrade` handler runs, so no PTY spawns, no
 * `claude` starts, and the user gets a dead session and a lost prompt.
 *
 * The old guard was to hard-truncate every prompt to {@link MAX_PROMPT_ENCODED} bytes
 * client-side. That kept the socket alive but capped what we could ever tell an agent — a
 * task's full spec (description + why + user stories + acceptance criteria) does not fit in
 * 6 KB, so a delegated agent received a head-sliced copy of its own brief.
 *
 * So: a prompt too big for the URL is POSTed to `/api/agent/prompt` (a normal request body —
 * no header limit) and exchanged for a short single-use token. Only the token rides the
 * upgrade URL, and the server redeems it back into the full text. Short prompts skip the
 * round-trip entirely and still inline.
 */

/**
 * Hard ceiling for a URL-INLINED prompt, in URL-encoded bytes.
 *
 * Not the ceiling on what an agent can be told any more — a prompt over this is routed via
 * {@link mintPromptToken} instead. It is only the point at which inlining stops being safe:
 * 6000 encoded bytes leaves >10 KB of headroom for the rest of the request line, the other
 * headers, and WKWebView's own URL handling. It also stays under the server's own 8000-char
 * `sanitizePrompt` cap, so an inlined prompt is never silently trimmed there either.
 */
export const MAX_PROMPT_ENCODED = 6000;

/** A slice can end mid-surrogate-pair; a LONE surrogate makes encodeURIComponent throw
 *  URIError (a task with an emoji would crash the caller). Drop the dangling half. */
function trimLoneSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** URL-encoded byte length — what actually counts against the request-line budget. */
export function encodedPromptLen(s: string): number {
  try { return encodeURIComponent(trimLoneSurrogate(s)).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

/** Does this prompt still fit in the upgrade URL, or does it need a token? */
export function promptFitsInline(prompt: string): boolean {
  return encodedPromptLen(prompt) <= MAX_PROMPT_ENCODED;
}

interface PromptTokenResponse { ok: boolean; token: string; expiresInMs: number }

/**
 * POST a prompt of any size and get back the single-use token that redeems it at the WS
 * upgrade. Throws if the server refuses (not desktop, unknown vault, empty after
 * sanitization) — callers must surface that rather than degrade to a truncated inline
 * prompt, because a session seeded with a silently-shortened brief is the exact failure this
 * whole path exists to remove.
 */
export async function mintPromptToken(prompt: string): Promise<string> {
  const vault = getActiveVault();
  if (!vault) throw new Error('No vault is active — cannot hand a prompt to an agent.');
  const res = await api.post<PromptTokenResponse>('/agent/prompt', { vault, prompt });
  if (!res?.ok || !res.token) throw new Error('The server did not return a prompt token.');
  return res.token;
}

/** How a prepared prompt should ride to the server: inlined in the URL, or by token. */
export interface PreparedPrompt {
  /** Non-empty only for the inline path — goes in `&prompt=`. */
  inline: string;
  /** Non-empty only for the token path — goes in `&promptToken=`. */
  token: string;
}

/**
 * Route a prompt to whichever transport can carry it, WITHOUT truncating it.
 *
 * Short prompts (Sleep, brain-resolve, a one-line ask) inline with no extra round-trip.
 * Anything larger mints a token first. The prompt the caller passes is the prompt the agent
 * receives, either way — so what a composer SHOWS is exactly what gets SENT.
 *
 * Rejects rather than degrading: see {@link mintPromptToken}.
 */
export async function preparePrompt(prompt: string): Promise<PreparedPrompt> {
  if (!prompt) return { inline: '', token: '' };
  if (promptFitsInline(prompt)) return { inline: prompt, token: '' };
  return { inline: '', token: await mintPromptToken(prompt) };
}
