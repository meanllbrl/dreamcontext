/**
 * Unit tests for `parseAuthStatus` (src/lib/claude-auth.ts) — the "is Claude Code actually
 * signed in?" probe behind `GET /api/agent/capabilities`'s `claudeAuth` field.
 *
 * Why it exists: an INSTALLED CLI and a USABLE CLI are different things. Every agent surface
 * (embedded terminal, Chat, sleep runs, tab titling) spawns the user's `claude`, and an
 * unauthenticated one fails at the first turn — the headless surfaces answering with a remedy
 * (`/login`) they cannot themselves run. This probe is what lets the UI say so up front.
 *
 * The fixtures are REAL CLI output (2.1.220), captured both ways: signed in from this machine,
 * signed out from an isolated `HOME` with no credentials. The contract they pin is that a
 * probe which cannot answer reports `loggedIn: null` — "unknown" — and NEVER `false`: a
 * Bedrock/Vertex setup, an `apiKeyHelper`, or a CLI predating the `auth` subcommand are all
 * perfectly usable, and telling that user they are signed out would be a lie that sends them
 * into a sign-in flow they don't need.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAuthStatus, CLAUDE_LOGIN_COMMAND, CLAUDE_LOGIN_FALLBACK,
} from '../../src/lib/claude-auth.js';

/** Verbatim `claude auth status --json` from a signed-in machine (CLI 2.1.220). */
const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'someone@example.com',
  orgId: '6bf66284-a209-4bde-b81d-ba8fa553c2d1',
  orgName: "someone@example.com's Organization",
  subscriptionType: 'max',
}, null, 2);

/** Verbatim output from an isolated HOME with no credentials (same CLI, exit code 0). */
const SIGNED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty',
}, null, 2);

describe('parseAuthStatus', () => {
  it('reads a signed-in payload, carrying the identity the doctor row shows', () => {
    const s = parseAuthStatus(SIGNED_IN, '', 0);
    expect(s.loggedIn).toBe(true);
    expect(s.supported).toBe(true);
    expect(s.method).toBe('claude.ai');
    expect(s.email).toBe('someone@example.com');
    expect(s.subscription).toBe('max');
    expect(s.loginCommand).toBe(CLAUDE_LOGIN_COMMAND);
    expect(s.error).toBeUndefined();
  });

  it('reads a signed-out payload as a definite false, not as unknown', () => {
    const s = parseAuthStatus(SIGNED_OUT, '', 0);
    expect(s.loggedIn).toBe(false);
    expect(s.supported).toBe(true);
    expect(s.email).toBeUndefined();
  });

  it('trusts a parseable payload over the exit code — a logged-out CLI may exit non-zero', () => {
    expect(parseAuthStatus(SIGNED_OUT, '', 1).loggedIn).toBe(false);
  });

  it('survives a banner/update notice printed around the JSON', () => {
    const noisy = `A new version of Claude Code is available.\n${SIGNED_IN}\n`;
    const s = parseAuthStatus(noisy, '', 0);
    expect(s.loggedIn).toBe(true);
    expect(s.email).toBe('someone@example.com');
  });

  it('a CLI with no `auth` subcommand is UNKNOWN, and is offered the TUI command', () => {
    const s = parseAuthStatus('', "error: unknown command 'auth'", 1);
    expect(s.loggedIn).toBeNull();
    expect(s.supported).toBe(false);
    // Naming `claude auth login` to a CLI that doesn't have it would be a dead end; the
    // interactive TUI (where `/login` is typed) is the honest fallback.
    expect(s.loginCommand).toBe(CLAUDE_LOGIN_FALLBACK);
  });

  it('a failed/garbled probe is UNKNOWN and reports why, never a false "signed out"', () => {
    const s = parseAuthStatus('not json at all', 'spawn ENOENT', 127);
    expect(s.loggedIn).toBeNull();
    expect(s.supported).toBe(true); // no "unknown command" — the CLI just failed to answer
    expect(s.error).toContain('spawn ENOENT');
  });

  it('empty output on a clean exit is still UNKNOWN, not signed out', () => {
    expect(parseAuthStatus('', '', 0).loggedIn).toBeNull();
  });

  it('a payload without the boolean is not treated as an answer', () => {
    // A future/other shape (or a partial write) must not be read as "signed out".
    expect(parseAuthStatus('{"authMethod":"claude.ai"}', '', 0).loggedIn).toBeNull();
  });

  it('an error message is bounded so a runaway stderr can never bloat the payload', () => {
    const s = parseAuthStatus('', 'x'.repeat(5000), 1);
    expect(s.error!.length).toBeLessThanOrEqual(400);
  });
});
