/**
 * Unit tests for `isSignInCommand` (dashboard/src/lib/agentComposer.ts) — the chat composer's
 * one intercepted slash command.
 *
 * Why it exists: the chat surface runs `claude -p --input-format stream-json`, and that engine
 * answers `/login` with "/login isn't available in this environment." (verified against CLI
 * 2.1.220 in an isolated HOME) — the OAuth flow only exists in the interactive TUI. So a user
 * typing exactly the right command got a dead end. The composer now hands `/login` to the
 * terminal surface instead of sending it.
 *
 * The gate must be narrow in one specific direction: intercepting a message that merely
 * MENTIONS the command would silently swallow a real question ("how do I /login?") and open an
 * unasked-for terminal tab, which is worse than the dead end it replaces.
 */
import { describe, it, expect } from 'vitest';
import { isSignInCommand } from '../../dashboard/src/lib/agentComposer.js';

describe('isSignInCommand', () => {
  it('the bare command is intercepted', () => {
    expect(isSignInCommand('/login')).toBe(true);
  });

  it('surrounding whitespace (a trailing newline from ↵-to-send) does not hide it', () => {
    expect(isSignInCommand('  /login  ')).toBe(true);
    expect(isSignInCommand('/login\n')).toBe(true);
  });

  it('arguments are carried along — `/login <method>` is still the sign-in flow', () => {
    expect(isSignInCommand('/login console')).toBe(true);
  });

  it('a message that MENTIONS the command still reaches the model', () => {
    expect(isSignInCommand('how do I /login?')).toBe(false);
    expect(isSignInCommand('explain /login')).toBe(false);
    expect(isSignInCommand('Run /login to authenticate')).toBe(false);
  });

  it('a longer command that merely starts with the same letters is not it', () => {
    expect(isSignInCommand('/loginfo')).toBe(false);
    expect(isSignInCommand('/login-help')).toBe(false);
  });

  it('other slash commands are untouched — only this one cannot work headlessly', () => {
    expect(isSignInCommand('/compact')).toBe(false);
    expect(isSignInCommand('/effort high')).toBe(false);
    expect(isSignInCommand('/logout')).toBe(false);
  });

  it('an empty draft is never the command', () => {
    expect(isSignInCommand('')).toBe(false);
    expect(isSignInCommand('   ')).toBe(false);
  });
});
