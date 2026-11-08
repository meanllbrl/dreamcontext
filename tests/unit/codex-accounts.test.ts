/**
 * Several Codex accounts (Track T W2, plan r5 §4b): every non-#0 account is a T3 instance with
 * `homePath ~/.codex` + a private `shadowHomePath` (0700), signs in with the file credential
 * store, never shares a login with another home, and its limits are read with no model call.
 * No real `codex`: the runner is scripted, the way the routes and the chat server receive it.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_PRIMARY_ID, codexLimitsFor, getCodexAccount, listCodexAccounts, probeCodexAccount, readCodexUsage, recordCodexUsage,
  reorderCodexAccounts, signInNewCodexAccount, type CodexRunner,
} from '../../src/lib/codex-accounts.js';
import { codexInstanceSettings, isCodexAccountId } from '../../src/lib/t3-bridge/accounts.js';
import { bridgeChatScript } from '../../src/lib/t3-bridge/spawn.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-codex-accounts-'));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
const inADay = new Date(Date.now() + 86_400_000).toISOString();

interface Call { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/** A scripted machine: `t3-account` answers JSON, `codex login` writes the account's own auth.json. */
function machine(emails: Record<string, string>, calls: Call[]): CodexRunner {
  return async (cmd, args, o) => {
    calls.push({ cmd, args, env: o.env });
    if (args[1] === 't3-account') {
      const account = args.includes('--account') ? args[args.indexOf('--account') + 1]! : CODEX_PRIMARY_ID;
      if (args[2] === 'prepare') return { spawned: true, timedOut: false, code: 0, stdout: JSON.stringify({ ok: true }) + '\n' };
      return {
        spawned: true, timedOut: false, code: 0,
        stdout: JSON.stringify({
          ok: true, signedIn: true, email: emails[account] ?? `${account}@example.test`, planType: 'plus', checkedAt: new Date().toISOString(),
          windows: [
            { id: 'primary', kind: 'session', label: 'Session', usedPercent: 12, resetsAt: inAnHour, windowDurationMins: 300 },
            { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 40, resetsAt: inADay, windowDurationMins: 10080 },
          ],
        }) + '\n',
      };
    }
    if (cmd === 'codex' && args.at(-1) === 'login') {
      const homeDir = o.env.CODEX_HOME!;
      writeFileSync(join(homeDir, 'auth.json'), '{"synthetic":true}');
      return { spawned: true, timedOut: false, code: 0, stdout: '' };
    }
    return { spawned: true, timedOut: false, code: 0, stdout: '' };
  };
}

beforeEach(() => {
  rmSync(join(HOME, '.dreamcontext'), { recursive: true, force: true });
  rmSync(join(HOME, '.codex'), { recursive: true, force: true });
  mkdirSync(join(HOME, '.codex', 'sessions'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{"owner":true}');
});

describe('Codex accounts are T3 instances (plan r5 §4b)', () => {
  it('account #0 is ~/.codex itself; every other account shares it as homePath and keeps a private shadow home with the file store', () => {
    expect(codexInstanceSettings(HOME, null)).toEqual({ homePath: join(HOME, '.codex'), shadowHomePath: '', launchArgs: '' });
    expect(codexInstanceSettings(HOME, CODEX_PRIMARY_ID).shadowHomePath).toBe('');
    const s = codexInstanceSettings(HOME, 'acct-1a2b3c');
    expect(s.homePath).toBe(join(HOME, '.codex'));
    expect(s.shadowHomePath).toBe(join(HOME, '.dreamcontext', 'codex-accounts', 'acct-1a2b3c'));
    expect(s.launchArgs).toContain('cli_auth_credentials_store="file"');
    expect(isCodexAccountId(CODEX_PRIMARY_ID)).toBe(false);
    expect(isCodexAccountId('../x')).toBe(false);
  });

  it('the bridge child is told its account, and never gets CODEX_HOME in its script', () => {
    const script = bridgeChatScript({ tool: 'codex', model: 'gpt-5.5', effort: '', mode: 'auto', pane: '', resume: '', briefingArg: [], account: 'acct-1a2b3c', node: '/usr/bin/node', cli: '/opt/dc/index.js', home: HOME });
    expect(script).toContain('"--account" "acct-1a2b3c"');
    expect(script).not.toContain('CODEX_HOME');
    const primary = bridgeChatScript({ tool: 'codex', model: 'gpt-5.5', effort: '', mode: 'auto', pane: '', resume: '', briefingArg: [], account: CODEX_PRIMARY_ID, node: '/usr/bin/node', cli: '/opt/dc/index.js', home: HOME });
    expect(primary).not.toContain('--account');
  });

  it('lists #0 first by default, signed in by the presence of its own auth.json', () => {
    const list = listCodexAccounts(HOME);
    expect(list.map((a) => [a.id, a.primary, a.preferred, a.signedIn])).toEqual([[CODEX_PRIMARY_ID, true, true, true]]);
  });

  it('adding an account: a 0700 home is laid out by T3 first, `codex login` runs INTO it with the file store, then a probe names it', async () => {
    const calls: Call[] = [];
    const acc = await signInNewCodexAccount({ home: HOME, node: '/usr/bin/node', cli: '/opt/dc/index.js', run: machine({}, calls), env: { PATH: '/usr/bin', CODEX_HOME: '/elsewhere' } });
    const home = join(HOME, '.dreamcontext', 'codex-accounts', acc.id);
    if (process.platform !== 'win32') expect(statSync(home).mode & 0o777).toBe(0o700); // Windows has no POSIX mode bits
    // The new account is read, then #0 (its email was never on record) for the twin check.
    expect(calls.map((c) => c.args[2] ?? c.args.at(-1))).toEqual(['prepare', 'login', 'probe', 'probe']);
    const login = calls[1]!;
    expect(login.cmd).toBe('codex');
    expect(login.args).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login']);
    expect(login.env.CODEX_HOME).toBe(home);
    // The owner's own sign-in is untouched; the new one is a separate file.
    expect(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf-8')).toBe('{"owner":true}');
    expect(existsSync(join(home, 'auth.json'))).toBe(true);
    expect(getCodexAccount(acc.id, HOME)?.email).toBe(`${acc.id}@example.test`);
  });

  it('no two homes share a login: a sign-in that lands on an account already connected is undone', async () => {
    const calls: Call[] = [];
    const first = await signInNewCodexAccount({ home: HOME, node: '/usr/bin/node', cli: '/x', run: machine({}, calls) });
    const sameEmail = machine(new Proxy({}, { get: () => `${first.id}@example.test` }) as Record<string, string>, calls);
    await expect(signInNewCodexAccount({ home: HOME, node: '/usr/bin/node', cli: '/x', run: sameEmail })).rejects.toMatchObject({ code: 'already_connected' });
    const ids = listCodexAccounts(HOME).map((a) => a.id);
    expect(ids).toEqual([CODEX_PRIMARY_ID, first.id]);
    // The undone account was logged out and its folder is gone.
    expect(calls.some((c) => c.args.at(-1) === 'logout')).toBe(true);
  });

  it('the same login as ~/.codex is caught even when #0 was never read (live, 2026-10-31)', async () => {
    // #0 has no email on record; the probe says it is the same ChatGPT login the new one lands on.
    const calls: Call[] = [];
    const same = machine(new Proxy({}, { get: () => 'owner@example.test' }) as Record<string, string>, calls);
    await expect(signInNewCodexAccount({ home: HOME, node: '/usr/bin/node', cli: '/x', run: same })).rejects.toMatchObject({ code: 'already_connected' });
    expect(listCodexAccounts(HOME).map((a) => a.id)).toEqual([CODEX_PRIMARY_ID]);
    expect(calls.filter((c) => c.args[2] === 'probe').map((c) => (c.args.includes('--account') ? 'new' : 'primary'))).toEqual(['new', 'primary']);
    expect(readFileSync(join(HOME, '.codex', 'auth.json'), 'utf-8')).toBe('{"owner":true}');
  });

  it('a sign-in that never completes saves nothing', async () => {
    const run: CodexRunner = async (cmd, args) => (args[1] === 't3-account'
      ? { spawned: true, timedOut: false, code: 0, stdout: '{"ok":true}\n' }
      : { spawned: true, timedOut: false, code: 1, stdout: '' });
    await expect(signInNewCodexAccount({ home: HOME, node: '/n', cli: '/x', run })).rejects.toMatchObject({ code: 'login_incomplete' });
    expect(listCodexAccounts(HOME)).toHaveLength(1);
  });

  it('limits are read without a model call: the probe is `t3-account probe` (account/read + account/rateLimits/read) and lands in the chooser shape', async () => {
    const calls: Call[] = [];
    const out = await probeCodexAccount(CODEX_PRIMARY_ID, { home: HOME, node: '/usr/bin/node', cli: '/opt/dc/index.js', run: machine({ primary: 'owner@example.test' }, calls) });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['/opt/dc/index.js', 't3-account', 'probe']);
    expect(out.status).toBe('ok');
    const limits = codexLimitsFor(readCodexUsage(CODEX_PRIMARY_ID, HOME));
    expect(limits.limits.map((l) => [l.key, l.percent])).toEqual([['session', 12], ['weekly', 40]]);
    expect(getCodexAccount(CODEX_PRIMARY_ID, HOME)?.email).toBe('owner@example.test');
    // The bridge job asks Codex only these two things, never for a turn.
    const src = readFileSync(join(__dirname, '../../src/lib/t3-bridge/account-cli.ts'), 'utf-8');
    expect([...src.matchAll(/client\.request\('([^']+)'/g)].map((m) => m[1])).toEqual(['account/read', 'account/rateLimits/read']);
    expect(src).not.toMatch(/turn\/start|startTurn|thread\/start/);
  });

  it('a live session update merges by window id; a probe replaces; monthly windows never reach the chooser', () => {
    recordCodexUsage(CODEX_PRIMARY_ID, [
      { id: 'primary', kind: 'session', label: 'Session', usedPercent: 10, resetsAt: inAnHour },
      { id: 'secondary', kind: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: inADay },
    ], new Date().toISOString(), 'probe', HOME);
    recordCodexUsage(CODEX_PRIMARY_ID, [{ id: 'primary', kind: 'session', label: 'Session', usedPercent: 93, resetsAt: inAnHour }], new Date().toISOString(), 'session', HOME);
    expect(codexLimitsFor(readCodexUsage(CODEX_PRIMARY_ID, HOME)).limits.map((l) => [l.key, l.percent])).toEqual([['weekly', 20], ['session', 93]]);
    recordCodexUsage(CODEX_PRIMARY_ID, [{ id: 'individual', kind: 'monthly', label: 'Monthly credit limit', usedPercent: 99, resetsAt: inADay }], new Date().toISOString(), 'probe', HOME);
    const r = readCodexUsage(CODEX_PRIMARY_ID, HOME)!;
    expect(r.windows.map((w) => w.kind)).toEqual(['monthly']);   // kept for Stats, as T3 built it
    expect(codexLimitsFor(r).limits).toEqual([]);
  });

  it('reorder names every account once; the top is preferred', async () => {
    const a = await signInNewCodexAccount({ home: HOME, node: '/n', cli: '/x', run: machine({}, []) });
    expect(() => reorderCodexAccounts([a.id], HOME)).toThrow(/every connected/);
    const list = reorderCodexAccounts([a.id, CODEX_PRIMARY_ID], HOME);
    expect(list.map((x) => [x.id, x.preferred])).toEqual([[a.id, true], [CODEX_PRIMARY_ID, false]]);
  });
});
