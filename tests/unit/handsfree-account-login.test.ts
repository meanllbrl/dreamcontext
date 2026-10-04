// `handsfree account-login` (D13): only builds/launches the gh codespace ssh line; ids are
// validated against this laptop's registry; nothing is captured.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountIdsFor, accountLoginArgv, accountLoginLine, AccountLoginError, launchAccountLogin } from '../../src/lib/handsfree/account-login.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-acct-'));
  mkdirSync(join(home, '.dreamcontext'), { recursive: true });
  const acc = (id: string) => ({ id, accountUuid: id, email: `${id}@example.com`, organizationUuid: 'o', organizationName: 'O', tier: 'max', configDir: null, preferred: false });
  writeFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), JSON.stringify({ accounts: [acc('main'), acc('work-two')] }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('account-login', () => {
  it('builds exactly the entrypoint claude-login line', () => {
    expect(accountLoginArgv('owner-cs-abc', 'work-two')).toEqual(['gh', 'codespace', 'ssh', '-c', 'owner-cs-abc', '-t', '--', 'sudo', '/opt/dc-hf/entrypoint.sh', 'claude-login', 'work-two']);
    expect(accountLoginLine('owner-cs-abc', 'main')).toBe('gh codespace ssh -c owner-cs-abc -t -- sudo /opt/dc-hf/entrypoint.sh claude-login main');
  });

  it('refuses shell-active names', () => {
    expect(() => accountLoginArgv('cs; rm -rf /', 'main')).toThrow(AccountLoginError);
    expect(() => accountLoginArgv('cs', '$(id)')).toThrow(AccountLoginError);
  });

  it('resolves one registered id or --all', () => {
    expect(accountIdsFor({ all: true }, home)).toEqual(['main', 'work-two']);
    expect(accountIdsFor({ id: 'main' }, home)).toEqual(['main']);
    expect(() => accountIdsFor({ id: 'nobody' }, home)).toThrow(/no registered Claude account/);
  });

  it('launches gh with inherited stdio and reads nothing back', async () => {
    const calls: Array<{ cmd: string; args: string[]; opts: { stdio?: unknown } }> = [];
    const fakeSpawn = ((cmd: string, args: string[], opts: { stdio?: unknown }) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    expect(await launchAccountLogin('owner-cs-abc', 'main', fakeSpawn)).toBe(0);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].opts.stdio).toBe('inherit');
  });
});
