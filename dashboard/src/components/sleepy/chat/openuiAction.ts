/**
 * The ONE thing a `dream-ui` block is allowed to do to the app: hand a line of TEXT to the
 * conversation.
 *
 * A separate module from the renderer, and not for tidiness. This is a POLICY — the boundary
 * that makes "agent-authored UI may ask, never act" a property rather than an intention — and
 * a policy that can only be exercised by mounting React, a CSS import and a 2MB component
 * tree is a policy nobody tests. Here it is a pure function over an untrusted object.
 */

/** A follow-up is a question, not an essay: this becomes a message in the USER's voice, and
 *  an unbounded string from agent-authored markup is an unbounded prompt. */
export const ASK_MAX_CHARS = 400;

/**
 * Reduce an OpenUI action event to the text it carries, or refuse it.
 *
 * A WHITELIST OF ONE. The package defines two builtin action types — `continue_conversation`
 * and `open_url` — and only the first is accepted. `open_url` is refused for a specific
 * reason rather than a general nervousness: `dream-actions` already offers a `url` action and
 * gates it to https twice, once on the client and again in Rust. An OpenUrl arriving through
 * a rendered component would be a second route to the same affordance with none of that. One
 * gate or none.
 *
 * Anything unrecognised — a new builtin from a dependency bump, a custom type, a string, a
 * null — falls through to `null`, so widening this is an explicit edit rather than an
 * accident of upgrading.
 */
export function askTextFor(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: unknown; params?: Record<string, unknown>; humanFriendlyMessage?: unknown };
  if (e.type !== 'continue_conversation') return null;
  const fromParams = typeof e.params?.message === 'string' ? e.params.message : '';
  const fromLabel = typeof e.humanFriendlyMessage === 'string' ? e.humanFriendlyMessage : '';
  const text = (fromParams || fromLabel).trim();
  if (!text || text.length > ASK_MAX_CHARS) return null;
  // Only the string leaves. Whatever else the event held — form state, a url, a tool name —
  // has no way through this return.
  return text;
}
