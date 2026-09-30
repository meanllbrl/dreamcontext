/**
 * `POST /api/agent/accounts/relogin` — signing an ALREADY-CONNECTED account in again.
 *
 * The owner report behind it (Slack, 2026-09-30): a second account's credential expired and
 * nothing brought it back. Settings drew "Signed out" with no button, "Add an account" with
 * the same email answered `already_connected`, and Chat's sign-in banner ran `claude auth
 * login` in a plain shell, which signs in the machine's own `~/.claude` rather than the
 * sandbox the chat runs on.
 *
 * What is pinned here is everything that decides WHICH credential store a sign-in may touch,
 * none of which needs a real `claude`:
 *   • the machine's own account is refused as `primary_account`, which is the client's cue to
 *     keep the terminal flow — so a relogin can never be pointed at the real `~/.claude`;
 *   • an unknown or malformed id is a 422, never a silent fall back to some other account;
 *   • the register helpers the success path uses keep the list ORDER (position 0 is where
 *     new sessions start) and refuse a sign-in that landed on a different email.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAgentAccountsRelogin } from '../../src/server/routes/agent-accounts.js';
import {
  type ClaudeAccount,
  claudeAccountsFilePath,
  listClaudeAccounts,
  reloginLandedOnOtherAccount,
  sandboxDirFor,
  updateClaudeAccountIdentity,
  writeClaudeAccounts,
} from '../../src/lib/claude-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-relogin-'));
const REAL_HOME = process.env.HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  delete process.env.DREAMCONTEXT_DESKTOP;
  rmSync(HOME, { recursive: true, force: true });
});

function account(id: string, email: string, sandboxed: boolean, preferred = false): ClaudeAccount {
  return {
    id,
    accountUuid: '',
    email,
    organizationUuid: '',
    organizationName: '',
    tier: 'pro',
    configDir: sandboxed ? sandboxDirFor(id, HOME) : null,
    preferred,
  };
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const captured = { status: 0, body: null as any };
  const res = {
    writeHead(status: number) { captured.status = status; return this; },
    end(payload?: string) { captured.body = payload ? JSON.parse(payload) : null; },
  } as unknown as ServerResponse;
  // Buffers, not strings: `parseJsonBody` concatenates with `Buffer.concat`.
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]) as unknown as IncomingMessage;
  (req as any).url = '/api/agent/accounts/relogin';
  (req as any).method = 'POST';
  (req as any).headers = { host: '127.0.0.1:1234', 'content-type': 'application/json' };
  (req as any).socket = { remoteAddress: '127.0.0.1' };
  await handleAgentAccountsRelogin(req, res);
  return captured;
}

beforeEach(() => {
  process.env.HOME = HOME;
  process.env.DREAMCONTEXT_DESKTOP = '1';
  rmSync(claudeAccountsFilePath(HOME), { force: true });
});

describe('POST /api/agent/accounts/relogin — which store a sign-in may touch', () => {
  it('refuses the machine\'s own account, so the caller keeps the terminal flow', async () => {
    writeClaudeAccounts([account('main-example-com', 'main@example.com', false, true)], HOME);
    const out = await post({ id: 'main-example-com' });
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('primary_account');
  });

  it('with no id, resolves to the account new sessions start on — and refuses it when that is the machine\'s own', async () => {
    writeClaudeAccounts([
      account('main-example-com', 'main@example.com', false, true),
      account('second-example-com', 'second@example.com', true),
    ], HOME);
    const out = await post({});
    expect(out.body.error).toBe('primary_account');
  });

  it('a machine with no registered accounts is the machine\'s own account too', async () => {
    writeClaudeAccounts([], HOME);
    const out = await post({});
    expect(out.body.error).toBe('primary_account');
  });

  it('an unknown id is a 422, never a fall back to another account', async () => {
    writeClaudeAccounts([account('second-example-com', 'second@example.com', true, true)], HOME);
    const out = await post({ id: 'nobody-example-com' });
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('account_error');
  });

  it('a malformed id is refused before anything names a directory', async () => {
    const out = await post({ id: '../../etc' });
    expect(out.status).toBe(422);
  });

  it('is desktop-only, like every sibling account route', async () => {
    delete process.env.DREAMCONTEXT_DESKTOP;
    const out = await post({ id: 'second-example-com' });
    expect(out.status).toBe(403);
  });
});

describe('the register helpers behind a successful relogin', () => {
  it('updateClaudeAccountIdentity rewrites in place: order and the preferred flag survive', () => {
    writeClaudeAccounts([
      account('second-example-com', 'second@example.com', true, true),
      account('main-example-com', 'main@example.com', false),
    ], HOME);
    const updated = updateClaudeAccountIdentity('second-example-com', { tier: 'max', organizationUuid: 'org-1' }, HOME);
    expect(updated.tier).toBe('max');
    const after = listClaudeAccounts(HOME);
    expect(after.map((a) => a.id)).toEqual(['second-example-com', 'main-example-com']);
    expect(after[0].preferred).toBe(true);
    expect(after[0].configDir).toBe(sandboxDirFor('second-example-com', HOME));
  });

  it('an empty value the CLI did not report never blanks what was stored', () => {
    writeClaudeAccounts([account('second-example-com', 'second@example.com', true, true)], HOME);
    updateClaudeAccountIdentity('second-example-com', { tier: '', organizationUuid: '' }, HOME);
    expect(listClaudeAccounts(HOME)[0].tier).toBe('pro');
  });

  it('an unknown id throws rather than writing a new row', () => {
    writeClaudeAccounts([], HOME);
    expect(() => updateClaudeAccountIdentity('nobody-example-com', { tier: 'max' }, HOME)).toThrow(/No such account/);
    expect(listClaudeAccounts(HOME)).toEqual([]);
  });

  it('reloginLandedOnOtherAccount: a different email is a mismatch, case and a missing report are not', () => {
    expect(reloginLandedOnOtherAccount('second@example.com', 'main@example.com')).toBe(true);
    expect(reloginLandedOnOtherAccount('second@example.com', 'Second@Example.com')).toBe(false);
    expect(reloginLandedOnOtherAccount('second@example.com', undefined)).toBe(false);
  });
});
