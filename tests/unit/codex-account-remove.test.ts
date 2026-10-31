/**
 * Removing a Codex account (Track T W2, plan r5 §4b): it logs out FIRST, in its own home, then
 * deletes that home without following a single link. A shadow home is full of links into
 * `~/.codex` (sessions, config), so a delete that followed one would wipe every account's
 * conversations. Account #0 (`~/.codex`) is never logged out or deleted: removing it hides its row.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_PRIMARY_ID, adoptPrimaryCodexAccount, codexAccountsFile, listCodexAccounts, removeCodexAccount, removeCodexHome, type CodexRunner,
} from '../../src/lib/codex-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-codex-remove-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'dc-codex-outside-'));
afterAll(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(OUTSIDE, { recursive: true, force: true }); });

const ID = 'acct-0a0b0c';
const shadow = () => join(HOME, '.dreamcontext', 'codex-accounts', ID);

function setUp(): void {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(HOME, '.codex'), { recursive: true, force: true });
  // The shared home, with a conversation in it.
  mkdirSync(join(HOME, '.codex', 'sessions', '2026', '10', '31'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'sessions', '2026', '10', '31', 'rollout-x.jsonl'), '{"type":"session_meta"}\n');
  writeFileSync(join(HOME, '.codex', 'config.toml'), 'model = "gpt-5.5"\n');
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"owner":true}');
  // A shadow home laid out the way T3's materializeCodexShadowHome leaves it.
  mkdirSync(shadow(), { recursive: true, mode: 0o700 });
  writeFileSync(join(shadow(), 'auth.json'), '{"second":true}');
  symlinkSync(join(HOME, '.codex', 'sessions'), join(shadow(), 'sessions'));
  symlinkSync(join(HOME, '.codex', 'config.toml'), join(shadow(), 'config.toml'));
  mkdirSync(join(shadow(), 'log'));
  writeFileSync(join(shadow(), 'log', 'codex.log'), 'x');
  writeFileSync(codexAccountsFile(HOME), JSON.stringify({ accounts: [
    { id: CODEX_PRIMARY_ID, email: 'owner@example.test', planType: 'plus', addedAt: 0 },
    { id: ID, email: 'second@example.test', planType: 'plus', addedAt: 1 },
  ] }));
}

function recorder(order: string[]): CodexRunner {
  return async (cmd, args, o) => {
    order.push(`${cmd} ${args.join(' ')} @${o.env.CODEX_HOME ?? '~/.codex'}`);
    // At logout time the home must still be there (logout first, delete after).
    if (args.at(-1) === 'logout') order.push(existsSync(join(shadow(), 'auth.json')) ? 'home-present' : 'home-gone');
    return { spawned: true, timedOut: false, code: 0, stdout: '' };
  };
}

beforeEach(setUp);

describe('removing a Codex account', () => {
  it('logs out in its own home first, then deletes it without following links; shared sessions survive', async () => {
    const order: string[] = [];
    await removeCodexAccount(ID, { home: HOME, run: recorder(order) });
    expect(order).toEqual([`codex -c cli_auth_credentials_store="file" logout @${shadow()}`, 'home-present']);
    expect(existsSync(shadow())).toBe(false);
    expect(readFileSync(join(HOME, '.codex', 'sessions', '2026', '10', '31', 'rollout-x.jsonl'), 'utf-8')).toContain('session_meta');
    expect(existsSync(join(HOME, '.codex', 'config.toml'))).toBe(true);
    expect(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf-8')).toBe('{"owner":true}');
    expect(listCodexAccounts(HOME).map((a) => a.id)).toEqual([CODEX_PRIMARY_ID]);
  });

  it('account #0 is never logged out or deleted: it only leaves the list, and can be adopted back', async () => {
    const order: string[] = [];
    await removeCodexAccount(CODEX_PRIMARY_ID, { home: HOME, run: recorder(order) });
    expect(order).toEqual([]);
    expect(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf-8')).toBe('{"owner":true}');
    expect(listCodexAccounts(HOME).map((a) => a.id)).toEqual([ID]);
    expect(() => removeCodexHome(CODEX_PRIMARY_ID, HOME)).toThrow(/never deleted/);
    adoptPrimaryCodexAccount(HOME);
    expect(listCodexAccounts(HOME).map((a) => a.id)).toContain(CODEX_PRIMARY_ID);
  });

  it('a home that is itself a link is refused, and what it points at is untouched', async () => {
    rmSync(shadow(), { recursive: true, force: true });
    writeFileSync(join(OUTSIDE, 'precious.txt'), 'keep');
    symlinkSync(OUTSIDE, shadow());
    expect(() => removeCodexHome(ID, HOME)).toThrow(/not a plain folder/);
    expect(readFileSync(join(OUTSIDE, 'precious.txt'), 'utf-8')).toBe('keep');
  });

  it('a registered home that is a link to ~/.codex is refused BEFORE logout: #0 is never signed out through it', async () => {
    rmSync(shadow(), { recursive: true, force: true });
    symlinkSync(join(HOME, '.codex'), shadow());
    const order: string[] = [];
    await expect(removeCodexAccount(ID, { home: HOME, run: recorder(order) })).rejects.toMatchObject({ code: 'not_confined' });
    expect(order).toEqual([]);
    expect(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf-8')).toBe('{"owner":true}');
  });

  it('a row added while the logout ran survives the remove', async () => {
    const slow: CodexRunner = async () => {
      const reg = JSON.parse(readFileSync(codexAccountsFile(HOME), 'utf-8'));
      reg.accounts.push({ id: 'acct-1e1e1e', email: 'new@example.test', planType: 'plus', addedAt: 2 });
      writeFileSync(codexAccountsFile(HOME), JSON.stringify(reg));
      return { spawned: true, timedOut: false, code: 0, stdout: '' };
    };
    await removeCodexAccount(ID, { home: HOME, run: slow });
    expect(listCodexAccounts(HOME).map((a) => a.id)).toEqual([CODEX_PRIMARY_ID, 'acct-1e1e1e']);
  });

  it('an id that is not a folder name never names a path', () => {
    expect(() => removeCodexHome('../../.codex', HOME)).toThrow();
    expect(existsSync(join(HOME, '.codex', 'auth.json'))).toBe(true);
  });
});
