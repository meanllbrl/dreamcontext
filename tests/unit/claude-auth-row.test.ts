/**
 * Unit tests for `claudeAuthRow` (dashboard/src/lib/claudeAuth.ts) — how the System doctor
 * reports Claude Code's sign-in state.
 *
 * Why it exists: the doctor's promise is that a broken prerequisite is NAMED before the
 * feature is attempted, and an installed-but-signed-out CLI used to read as a clean green
 * "Installed" while every surface it gates failed at the first turn.
 *
 * The contract worth pinning is the asymmetry between the three states. Only a definite
 * `false` may raise a warning and offer the sign-in button; `null` ("couldn't tell" — an old
 * CLI, Bedrock/Vertex, an apiKeyHelper, a failed probe) must stay muted and offer nothing,
 * because pushing a perfectly working machine into a sign-in flow is a worse failure than
 * staying quiet.
 */
import { describe, it, expect } from 'vitest';
import { claudeAuthRow, type ClaudeAuthInfo } from '../../dashboard/src/lib/claudeAuth.js';

const base: ClaudeAuthInfo = { loggedIn: null, supported: true, loginCommand: 'claude auth login' };

describe('claudeAuthRow', () => {
  it('no probe (no CLI, or not the desktop app) renders no row at all', () => {
    expect(claudeAuthRow(undefined)).toBeNull();
  });

  it('signed in shows who, and offers nothing to fix', () => {
    const row = claudeAuthRow({ ...base, loggedIn: true, email: 'someone@example.com', subscription: 'max' })!;
    expect(row.tone).toBe('ok');
    expect(row.statusKey).toBe('system.auth.signedIn');
    expect(row.identity).toBe('someone@example.com · max');
    expect(row.offerSignIn).toBe(false);
  });

  it('signed in without a reported plan still reads cleanly', () => {
    expect(claudeAuthRow({ ...base, loggedIn: true, email: 'someone@example.com' })!.identity)
      .toBe('someone@example.com');
    expect(claudeAuthRow({ ...base, loggedIn: true })!.identity).toBe('');
  });

  it('signed out is the ONE state that warns and offers the sign-in', () => {
    const row = claudeAuthRow({ ...base, loggedIn: false, method: 'none' })!;
    expect(row.tone).toBe('warn');
    expect(row.statusKey).toBe('system.auth.signedOut');
    expect(row.offerSignIn).toBe(true);
  });

  it('an unanswerable probe is muted and never offers a sign-in the user may not need', () => {
    const row = claudeAuthRow({ ...base, loggedIn: null, error: 'The sign-in check timed out.' })!;
    expect(row.tone).toBe('muted');
    expect(row.statusKey).toBe('system.auth.unknown');
    expect(row.offerSignIn).toBe(false);
  });

  it('a CLI too old for `claude auth` says so, rather than claiming an unknown state', () => {
    const row = claudeAuthRow({ ...base, loggedIn: null, supported: false, loginCommand: 'claude' })!;
    expect(row.tone).toBe('muted');
    expect(row.statusKey).toBe('system.auth.unsupported');
    expect(row.offerSignIn).toBe(false);
  });
});
