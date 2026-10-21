/**
 * A signed-out Claude account (task yeni-oturum-girisi-kapali-…): a new chat never opens on it
 * while a signed-in account exists, and a running chat refused for sign-in moves to one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SIGNED_OUT_FOR_MS, clearSignedOut, isAuthFailureFrame, readSignedOut, recordSignedOut,
} from '../../src/lib/claude-signed-out.js';
import { chatSpawnAccount } from '../../src/lib/automations/account.js';
import { sandboxDirFor, setAutoSwitchEnabled, upsertClaudeAccount } from '../../src/lib/claude-accounts.js';
import { EMPTY_USAGE_LIMITS } from '../../src/lib/claude-usage.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-signed-out-home-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function account(id: string, preferred: boolean, signedIn = true): void {
  upsertClaudeAccount({
    id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org',
    organizationName: 'Example Org', tier: 'max', configDir: sandboxDirFor(id, home), preferred,
  }, home);
  mkdirSync(sandboxDirFor(id, home), { recursive: true });
  writeFileSync(join(sandboxDirFor(id, home), '.claude.json'), JSON.stringify(signedIn ? { oauthAccount: { emailAddress: `${id}@example.test` } } : {}));
}

describe('the signed-out record', () => {
  it('records, expires and clears', () => {
    recordSignedOut('a', home, 1000);
    expect(readSignedOut(home, 2000)).toEqual({ a: 1000 });
    expect(readSignedOut(home, 1000 + SIGNED_OUT_FOR_MS + 1)).toEqual({});
    expect(clearSignedOut('a', home)).toBe(true);
    expect(clearSignedOut('a', home)).toBe(false);
    expect(readSignedOut(home)).toEqual({});
    recordSignedOut('', home);
    expect(readSignedOut(home)).toEqual({});
  });

  it.each([
    [{ type: 'assistant', error: 'authentication_failed', message: { content: [] } }, true],
    [{ type: 'result', error: 'authentication_failed' }, true],
    [{ type: 'assistant', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } }, true],
    [{ type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Please run /login' }] } }, true],
    [{ type: 'assistant', message: { content: [{ type: 'text', text: 'run /login to sign in' }] } }, false],
    [{ type: 'assistant', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Overloaded' }] } }, false],
    [null, false], ['x', false],
  ] as const)('auth failure frame %#', (frame, want) => {
    expect(isAuthFailureFrame(frame)).toBe(want);
  });
});

describe('a new chat never opens on a signed-out account', () => {
  const readUsage = () => EMPTY_USAGE_LIMITS;

  it('auto-switch ON: a preferred account with no credential is passed over', async () => {
    account('first', true, false);
    account('second', false);
    await setAutoSwitchEnabled(true, home);
    expect(chatSpawnAccount({ home, readUsage }).id).toBe('second');
  });

  it('auto-switch OFF too: a signed-out account is no forecast', async () => {
    account('first', true);
    account('second', false);
    await setAutoSwitchEnabled(false, home);
    recordSignedOut('first', home);
    expect(chatSpawnAccount({ home, readUsage }).id).toBe('second');
    // Signed in again (a turn went through, or a re-login): back on the preferred account.
    clearSignedOut('first', home);
    expect(chatSpawnAccount({ home, readUsage }).id).toBe('first');
  });

  it('every account signed out: the preferred one, so the sign-in banner is honest', async () => {
    account('first', true, false);
    account('second', false, false);
    await setAutoSwitchEnabled(true, home);
    expect(chatSpawnAccount({ home, readUsage }).id).toBe('first');
  });
});

describe('a running chat refused for sign-in moves (agent-chat.ts)', () => {
  const src = readFileSync(join(__dirname, '../../src/server/routes/agent-chat.ts'), 'utf-8');
  it('reads the frame, records it, and moves through the same switch as a refused turn', () => {
    expect(src).toMatch(/isAuthFailureFrame\(obj\)\) onAuthFailed\(\)/);
    const body = src.slice(src.indexOf('const onAuthFailed = (): void => {'), src.indexOf('const maybeSwitchAccount = async'));
    expect(body).toContain('recordSignedOut(activeAccountId)');
    expect(body).toContain("decideAndAnnounce(text ?? '', 'needs_relogin'");
    expect(body).not.toContain('autoSwitchEnabled');
  });

  it('a turn that went through clears the record, never the refused turn\'s own result', () => {
    expect(src).toMatch(/if \(!authFailedTurn && obj\.is_error !== true && activeAccountId\) clearSignedOut\(activeAccountId\)/);
  });
});
