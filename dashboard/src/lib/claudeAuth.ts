import type { Capabilities } from '../components/sleepy/agentSession';
import { emitInstance } from '../context/VaultContext';

/**
 * What the System doctor says about Claude Code's sign-in state, and the bridge that
 * gets a user from "not signed in" to a terminal that signs them in.
 *
 * The doctor's whole premise is "a missing prerequisite is named and fixable BEFORE the
 * feature is attempted". An installed-but-unauthenticated CLI broke that premise: the row
 * read a clean green "Installed" while every agent surface it gates (embedded terminal,
 * Chat, sleep runs, tab titling) would die at its first turn. The server now probes it
 * (`Capabilities.claudeAuth` ← src/lib/claude-auth.ts); this is how the answer is shown.
 */

export type ClaudeAuthInfo = NonNullable<Capabilities['claudeAuth']>;

export interface ClaudeAuthRow {
  tone: 'ok' | 'warn' | 'muted';
  /** i18n key for the status phrase. */
  statusKey: string;
  /** Who is signed in ("someone@example.com · max"), empty when nobody is. */
  identity: string;
  /** Offer the one-click sign-in? Only when we KNOW it is needed — an "unknown" probe
   *  (an old CLI, a Bedrock/Vertex or apiKeyHelper setup, a probe that failed) must not
   *  push a working machine into a sign-in flow it doesn't need. */
  offerSignIn: boolean;
}

/**
 * Map the probe onto the doctor's row. `undefined` (no CLI here, or not the desktop app)
 * returns null: no probe ran, so there is nothing honest to say.
 *
 * `loggedIn: null` is deliberately MUTED, never a warning. It means the probe couldn't
 * answer, and a machine that authenticates through Bedrock/Vertex or an `apiKeyHelper`
 * lands there while working perfectly — flagging it red would be a false alarm on a setup
 * that has nothing wrong with it.
 */
export function claudeAuthRow(auth: ClaudeAuthInfo | undefined): ClaudeAuthRow | null {
  if (!auth) return null;
  if (auth.loggedIn === true) {
    return {
      tone: 'ok',
      statusKey: 'system.auth.signedIn',
      identity: [auth.email, auth.subscription].filter(Boolean).join(' · '),
      offerSignIn: false,
    };
  }
  if (auth.loggedIn === false) {
    return { tone: 'warn', statusKey: 'system.auth.signedOut', identity: '', offerSignIn: true };
  }
  return {
    tone: 'muted',
    statusKey: auth.supported ? 'system.auth.unknown' : 'system.auth.unsupported',
    identity: '',
    offerSignIn: false,
  };
}

/**
 * Settings → the agent surface. The sign-in flow needs an interactive terminal, which only
 * `AgentSurface` can open (it owns every session), and Settings is a page BELOW it in the
 * tree with no handle on it — so the request travels as an event, the same
 * page-dispatches/surface-listens bridge the sleep tracker and Delegate already use.
 *
 * It rides the INSTANCE bus, not `window`. Sign-in is one machine-wide act, so N of them is
 * not dangerous the way N sleeps or N delegates are — it is simply wrong: every project the
 * window holds would open its own "Sign in" shell tab, and the user would be looking at one
 * login while three more sat in the dock behind it. The Settings page that asked is inside
 * exactly one project; exactly one surface should answer.
 */
export const CLAUDE_SIGNIN_EVENT = 'dreamcontext-claude-signin';

export function requestClaudeSignIn(bus: EventTarget): void {
  emitInstance(bus, CLAUDE_SIGNIN_EVENT);
}
