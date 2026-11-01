/**
 * A sign-in that finishes after the server that started it died leaves a signed-in account
 * folder with no row (live, 2026-10-31). Settings' "bring back" button finds and lists it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_PRIMARY_ID, adoptCodexAccounts, listCodexAccounts, orphanCodexAccountIds, removeCodexAccount, signInNewCodexAccount,
  type CodexRunner,
} from '../../src/lib/codex-accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-codex-orphans-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
const root = () => join(HOME, '.dreamcontext', 'codex-accounts');

function orphan(id: string, signedIn = true): string {
  const dir = join(root(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (signedIn) writeFileSync(join(dir, 'auth.json'), '{"synthetic":true}');
  return dir;
}

/** `t3-account probe` answers with the email in `emails` (default `<id>@example.test`). */
function machine(emails: Record<string, string>, log: string[]): CodexRunner {
  return async (cmd, args, o) => {
    log.push(`${cmd === 'codex' ? 'codex ' : ''}${args[2] ?? args.at(-1)}`);
    if (args[1] === 't3-account') {
      const account = args.includes('--account') ? args[args.indexOf('--account') + 1]! : CODEX_PRIMARY_ID;
      if (args[2] === 'prepare') return { spawned: true, timedOut: false, code: 0, stdout: '{"ok":true}\n' };
      return { spawned: true, timedOut: false, code: 0, stdout: JSON.stringify({ ok: true, signedIn: true, email: emails[account] ?? `${account}@example.test`, planType: 'plus', windows: [] }) + '\n' };
    }
    if (cmd === 'codex' && args.at(-1) === 'login') writeFileSync(join(o.env.CODEX_HOME!, 'auth.json'), '{}');
    return { spawned: true, timedOut: false, code: 0, stdout: '' };
  };
}

beforeEach(() => {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(HOME, '.codex'), { recursive: true, force: true });
  mkdirSync(join(HOME, '.codex'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"owner":true}');
});

describe('signed-in account folders the list lost', () => {
  it('only a plain, signed-in, unregistered folder with an account id is an orphan', () => {
    orphan('acct-464aff');
    orphan('acct-000001', false); // a sign-in that never finished: nothing to adopt
    orphan('Not_An_Id');
    mkdirSync(join(HOME, 'elsewhere'), { recursive: true });
    writeFileSync(join(HOME, 'elsewhere', 'auth.json'), '{}');
    symlinkSync(join(HOME, 'elsewhere'), join(root(), 'acct-11ee11')); // a link is never adopted
    expect(orphanCodexAccountIds(HOME)).toEqual(['acct-464aff']);
  });

  it('the button lists it, reads who it is, and it stops being an orphan', async () => {
    orphan('acct-464aff');
    const log: string[] = [];
    const out = await adoptCodexAccounts({ home: HOME, node: '/n', cli: '/x', run: machine({ [CODEX_PRIMARY_ID]: 'owner@example.test', 'acct-464aff': 'second@example.test' }, log) });
    expect(out).toEqual({ adopted: ['acct-464aff'], twins: [] });
    const rows = listCodexAccounts(HOME);
    expect(rows.map((a) => [a.id, a.email])).toEqual([[CODEX_PRIMARY_ID, 'owner@example.test'], ['acct-464aff', 'second@example.test']]);
    expect(orphanCodexAccountIds(HOME)).toEqual([]);
    expect(log.some((l) => l.includes('logout'))).toBe(false);
  });

  it('an orphan that is a second login of a listed account is undone like a twin sign-in; ~/.codex untouched', async () => {
    const dir = orphan('acct-6afed7');
    const log: string[] = [];
    const out = await adoptCodexAccounts({ home: HOME, node: '/n', cli: '/x', run: machine({ [CODEX_PRIMARY_ID]: 'owner@example.test', 'acct-6afed7': 'owner@example.test' }, log) });
    expect(out).toEqual({ adopted: [], twins: ['acct-6afed7'] });
    expect(existsSync(dir)).toBe(false);
    expect(log).toContain('codex logout');
    expect(listCodexAccounts(HOME).map((a) => a.id)).toEqual([CODEX_PRIMARY_ID]);
    expect(existsSync(join(HOME, '.codex', 'auth.json'))).toBe(true);
  });

  it('a hidden ~/.codex and an orphan come back with one press', async () => {
    await removeCodexAccount(CODEX_PRIMARY_ID, { home: HOME });
    orphan('acct-464aff');
    const out = await adoptCodexAccounts({ home: HOME, node: '/n', cli: '/x', run: machine({}, []) });
    expect(out.adopted).toEqual([CODEX_PRIMARY_ID, 'acct-464aff']);
  });

  it('nothing to adopt says so', async () => {
    await expect(adoptCodexAccounts({ home: HOME, node: '/n', cli: '/x', run: machine({}, []) })).rejects.toMatchObject({ code: 'nothing_to_adopt' });
  });

  it('a sign-in still running in this server is not offered as an orphan', async () => {
    let seen: string[] = ['unset'];
    const base = machine({}, []);
    const run: CodexRunner = async (cmd, args, o) => {
      const r = await base(cmd, args, o);
      if (cmd === 'codex' && args.at(-1) === 'login') seen = orphanCodexAccountIds(HOME); // auth.json just landed, row not yet written
      return r;
    };
    const acc = await signInNewCodexAccount({ home: HOME, node: '/n', cli: '/x', run });
    expect(seen).toEqual([]);
    expect(orphanCodexAccountIds(HOME)).toEqual([]);
    expect(listCodexAccounts(HOME).map((a) => a.id)).toContain(acc.id);
  });
});
