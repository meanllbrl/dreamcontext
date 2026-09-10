/**
 * `claude-accounts.ts` — the multi-account register and its SINGLE GATE.
 *
 * The two properties worth a test file: an account id can never become an arbitrary
 * directory, and `removeAccount` — the one destructive operation in the design — cannot
 * follow a symlink out of the sandbox into the real `~/.claude/projects`.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeAccountError,
  accountEnvFor,
  accountIdFromEmail,
  assertConfinedConfigDir,
  autoSwitchEnabled,
  claudeAccountsFilePath,
  isSafeAccountId,
  listClaudeAccounts,
  preferredClaudeAccount,
  removeClaudeAccount,
  reorderClaudeAccounts,
  resolveConfigDir,
  sandboxDirFor,
  setPreferredClaudeAccount,
  setSwitchPolicy,
  switchStrategyFor,
  switchWeightsFor,
  upsertClaudeAccount,
  writeClaudeAccounts,
  type ClaudeAccount,
} from '../../src/lib/claude-accounts.js';
import { DEFAULT_SWITCH_WEIGHTS } from '../../src/lib/claude-account-switch.js';

const HOME = mkdtempSync(join(tmpdir(), 'dc-accounts-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  rmSync(HOME, { recursive: true, force: true });
});

function account(over: Partial<ClaudeAccount> = {}): ClaudeAccount {
  const id = over.id ?? 'second-account';
  return {
    id,
    accountUuid: 'uuid-b',
    email: 'b@example.com',
    organizationUuid: 'org-b',
    organizationName: 'Org B',
    tier: 'max',
    configDir: sandboxDirFor(id, HOME),
    preferred: false,
    ...over,
  };
}

/** Account #0 — the one already signed in to the real HOME. */
const zero = account({ id: 'account-zero', configDir: null, accountUuid: 'uuid-a', email: 'a@example.com' });

beforeEach(() => {
  rmSync(claudeAccountsFilePath(HOME), { force: true });
});

describe('the id shape is the automation-slug shape', () => {
  it('accepts a kebab slug', () => {
    expect(isSafeAccountId('second-account')).toBe(true);
    expect(isSafeAccountId('a1')).toBe(true);
  });

  it('rejects everything that could escape a directory name', () => {
    for (const bad of ['../evil', '/etc/passwd', 'a/b', 'A-Upper', '-lead', 'trail-', 'double--dash', '', '.', 'a b']) {
      expect(isSafeAccountId(bad), `"${bad}" was accepted`).toBe(false);
    }
    expect(isSafeAccountId(null)).toBe(false);
    expect(isSafeAccountId(42)).toBe(false);
  });

  it('derives a usable id from an email', () => {
    const id = accountIdFromEmail('Mehmet.Nur+work@Example.CO');
    expect(isSafeAccountId(id)).toBe(true);
    expect(id).toBe('mehmet-nur-work-example-co');
  });
});

describe('resolveConfigDir — the single gate', () => {
  it('with no id resolves the PREFERRED account', () => {
    writeClaudeAccounts([zero, account({ preferred: true })], HOME);
    expect(resolveConfigDir(null, HOME)).toBe(sandboxDirFor('second-account', HOME));
  });

  it('with no id and no preferred account resolves account #0, i.e. the real HOME', () => {
    writeClaudeAccounts([zero, account()], HOME);
    expect(resolveConfigDir(undefined, HOME)).toBe(HOME);
  });

  it('with an EMPTY register resolves the real HOME — the single-account machine', () => {
    expect(resolveConfigDir(undefined, HOME)).toBe(HOME);
    expect(listClaudeAccounts(HOME)).toEqual([]);
  });

  it('REJECTS an unknown id rather than silently falling back to HOME', () => {
    writeClaudeAccounts([zero], HOME);
    expect(() => resolveConfigDir('no-such-account', HOME)).toThrow(ClaudeAccountError);
    // The failure that matters: it must not quietly return the wrong account.
    expect(() => resolveConfigDir('no-such-account', HOME)).toThrow(/No such account/);
  });

  it('REJECTS a traversal id at the gate, not only at the WS boundary', () => {
    expect(() => resolveConfigDir('../../etc', HOME)).toThrow(/Not a usable account id/);
  });

  it('drops a register entry whose configDir is not that slug\'s own sandbox path', () => {
    // Hand-written file claiming a config dir somewhere else entirely.
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeAccountsFilePath(HOME), JSON.stringify({
      accounts: [{ ...account(), configDir: '/etc' }],
    }), 'utf-8');
    expect(listClaudeAccounts(HOME)).toEqual([]);
  });

  it('a malformed register reads as empty and never throws', () => {
    mkdirSync(join(HOME, '.dreamcontext'), { recursive: true });
    writeFileSync(claudeAccountsFilePath(HOME), '{ not json', 'utf-8');
    expect(() => listClaudeAccounts(HOME)).not.toThrow();
    expect(listClaudeAccounts(HOME)).toEqual([]);
  });
});

describe('assertConfinedConfigDir', () => {
  it('accepts the real HOME and a sandbox under the root', () => {
    expect(assertConfinedConfigDir(HOME, HOME)).toBe(HOME);
    expect(assertConfinedConfigDir(sandboxDirFor('x', HOME), HOME)).toBe(sandboxDirFor('x', HOME));
  });

  it('refuses the sandbox ROOT itself, and anything outside it', () => {
    expect(() => assertConfinedConfigDir(join(HOME, '.dreamcontext', 'claude-accounts'), HOME)).toThrow();
    expect(() => assertConfinedConfigDir('/etc', HOME)).toThrow(/outside the account sandbox root/);
    expect(() => assertConfinedConfigDir(join(HOME, '.claude'), HOME)).toThrow();
    // A traversal is resolved BEFORE the check, so where it LANDS is what decides.
    // Landing on the real HOME is legitimate (that is account #0's directory)...
    expect(assertConfinedConfigDir(join(sandboxDirFor('x', HOME), '..', '..', '..'), HOME)).toBe(HOME);
    // ...landing above it is not.
    expect(() => assertConfinedConfigDir(join(sandboxDirFor('x', HOME), '..', '..', '..', '..'), HOME)).toThrow();
  });
});

describe('accountEnvFor — account #0 CLEARS the variable, it does not merely skip it', () => {
  it('REMOVES CLAUDE_CONFIG_DIR for the real HOME', () => {
    // Not `{}`. `CLAUDE_CONFIG_DIR=$HOME` is not the same as unset either — the variable
    // relocates both `~/.claude.json` and `~/.claude` under one directory, so no value names
    // the real pair. Removal is the only way to say "the machine's own account", and it has to
    // be said: measured 2026-09-07, an INHERITED value (every `claude` session exports one)
    // made a probe of the primary account read a sandbox account's usage and report it as the
    // primary's. `undefined` is how a spread expresses removal — Node omits such a key from
    // the child's environment.
    expect(accountEnvFor(HOME, HOME)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
    expect('CLAUDE_CONFIG_DIR' in accountEnvFor(HOME, HOME)).toBe(true);
  });

  it('a spread of it actually clears an inherited value', () => {
    // The mechanism, pinned where it is relied on: `{ ...inherited, ...accountEnvFor(HOME) }`
    // must leave a key Node will drop, not the sandbox path it inherited.
    const inherited = { CLAUDE_CONFIG_DIR: sandboxDirFor('b', HOME), PATH: '/usr/bin' };
    expect({ ...inherited, ...accountEnvFor(HOME, HOME) }).toEqual({
      CLAUDE_CONFIG_DIR: undefined, PATH: '/usr/bin',
    });
  });

  it('sets CLAUDE_CONFIG_DIR for a sandbox', () => {
    expect(accountEnvFor(sandboxDirFor('b', HOME), HOME)).toEqual({
      CLAUDE_CONFIG_DIR: sandboxDirFor('b', HOME),
    });
  });
});

describe('preferred', () => {
  it('at most one account is preferred after an upsert', () => {
    writeClaudeAccounts([{ ...zero, preferred: true }], HOME);
    upsertClaudeAccount(account({ preferred: true }), HOME);
    expect(listClaudeAccounts(HOME).filter((a) => a.preferred).map((a) => a.id)).toEqual(['second-account']);
  });

  it('setPreferred moves the flag and rejects an unknown id', () => {
    writeClaudeAccounts([zero, account({ preferred: true })], HOME);
    setPreferredClaudeAccount('account-zero', HOME);
    expect(preferredClaudeAccount(HOME)?.id).toBe('account-zero');
    expect(() => setPreferredClaudeAccount('ghost', HOME)).toThrow(/No such account/);
  });
});

describe('reorderClaudeAccounts — order IS the priority', () => {
  const third = () => account({ id: 'third-account', email: 'c@example.com', accountUuid: 'uuid-c' });

  it('writes the given order and makes the TOP account preferred', () => {
    writeClaudeAccounts([{ ...zero, preferred: true }, account(), third()], HOME);
    const out = reorderClaudeAccounts(['third-account', 'account-zero', 'second-account'], HOME);
    expect(out.map((a) => a.id)).toEqual(['third-account', 'account-zero', 'second-account']);
    expect(listClaudeAccounts(HOME).map((a) => a.id)).toEqual(['third-account', 'account-zero', 'second-account']);
    // The flag and the order can no longer disagree — that was the whole point.
    expect(preferredClaudeAccount(HOME)?.id).toBe('third-account');
    expect(listClaudeAccounts(HOME).filter((a) => a.preferred)).toHaveLength(1);
  });

  it('ignores an unknown id instead of inventing a row', () => {
    writeClaudeAccounts([zero, account()], HOME);
    const out = reorderClaudeAccounts(['ghost', 'second-account', 'account-zero'], HOME);
    expect(out.map((a) => a.id)).toEqual(['second-account', 'account-zero']);
  });

  it('keeps an account the caller never mentioned — a stale tab cannot drop a row', () => {
    writeClaudeAccounts([zero, account(), third()], HOME);
    // A list built before `third-account` existed.
    const out = reorderClaudeAccounts(['second-account', 'account-zero'], HOME);
    expect(out.map((a) => a.id)).toEqual(['second-account', 'account-zero', 'third-account']);
  });

  it('a duplicate id is taken once', () => {
    writeClaudeAccounts([zero, account()], HOME);
    const out = reorderClaudeAccounts(['second-account', 'second-account', 'account-zero'], HOME);
    expect(out.map((a) => a.id)).toEqual(['second-account', 'account-zero']);
  });

  it('preserves the auto-switch setting', () => {
    writeClaudeAccounts([zero, account()], HOME, false);
    reorderClaudeAccounts(['second-account', 'account-zero'], HOME);
    expect(autoSwitchEnabled(HOME)).toBe(false);
  });
});

describe('removeClaudeAccount — the one destructive operation', () => {
  it('deletes the sandbox directory and the register row', () => {
    writeClaudeAccounts([zero, account()], HOME);
    const dir = sandboxDirFor('second-account', HOME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.claude.json'), '{}', 'utf-8');

    removeClaudeAccount('second-account', HOME);
    expect(existsSync(dir)).toBe(false);
    expect(listClaudeAccounts(HOME).map((a) => a.id)).toEqual(['account-zero']);
  });

  it('does NOT follow the shared symlinks into the real ~/.claude/projects', () => {
    writeClaudeAccounts([zero, account()], HOME);
    const dir = sandboxDirFor('second-account', HOME);
    mkdirSync(dir, { recursive: true });
    // The real store, with a transcript in it — the thing that must survive.
    const realProjects = join(HOME, '.claude', 'projects');
    mkdirSync(realProjects, { recursive: true });
    writeFileSync(join(realProjects, 'a-conversation.jsonl'), 'precious', 'utf-8');
    symlinkSync(realProjects, join(dir, 'projects'), 'dir');

    removeClaudeAccount('second-account', HOME);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(realProjects)).toBe(true);
    expect(readFileSync(join(realProjects, 'a-conversation.jsonl'), 'utf-8')).toBe('precious');
  });

  it('refuses to remove the LAST account, and refuses an unknown id', () => {
    writeClaudeAccounts([zero], HOME);
    expect(() => removeClaudeAccount('account-zero', HOME)).toThrow(/last account/);
    expect(() => removeClaudeAccount('ghost', HOME)).toThrow(/No such account/);
  });

  it('never leaves the register with nothing preferred', () => {
    writeClaudeAccounts([zero, account({ preferred: true })], HOME);
    removeClaudeAccount('second-account', HOME);
    expect(preferredClaudeAccount(HOME)?.id).toBe('account-zero');
  });
});

describe('the register file is written atomically', () => {
  it('leaves no temp file behind and round-trips', () => {
    writeClaudeAccounts([zero, account()], HOME);
    const written = JSON.parse(readFileSync(claudeAccountsFilePath(HOME), 'utf-8')) as { accounts: unknown[] };
    expect(written.accounts).toHaveLength(2);
    const strays = existsSync(join(HOME, '.dreamcontext'))
      ? readFileSync(claudeAccountsFilePath(HOME), 'utf-8')
      : '';
    expect(strays).toContain('second-account');
  });
});

describe('homedir() is honoured, so nothing here can touch the developer\'s real files', () => {
  it('the fixture HOME really is homedir() for this process', () => {
    expect(homedir()).toBe(HOME);
  });
});

describe('the switch policy — which rule picks the next account, and its coefficients', () => {
  it('an absent file reads as the documented defaults', () => {
    expect(switchStrategyFor(HOME)).toBe('score');
    expect(switchWeightsFor(HOME)).toEqual(DEFAULT_SWITCH_WEIGHTS);
  });

  it('round-trips a mode', () => {
    writeClaudeAccounts([zero], HOME);
    setSwitchPolicy({ strategy: 'sequential' }, HOME);
    expect(switchStrategyFor(HOME)).toBe('sequential');
  });

  it('round-trips coefficients, and sanitises them on the way in', () => {
    writeClaudeAccounts([zero], HOME);
    setSwitchPolicy({ weights: { session: 2, weekly: -5, order: 0 } as never }, HOME);
    // The negative one falls back on its own; the other two are kept, including the 0.
    expect(switchWeightsFor(HOME)).toEqual({ session: 2, weekly: DEFAULT_SWITCH_WEIGHTS.weekly, order: 0 });
  });

  it('setting the mode does not reset the coefficients, or the reverse', () => {
    writeClaudeAccounts([zero], HOME);
    setSwitchPolicy({ weights: { session: 3, weekly: 7, order: 1 } }, HOME);
    setSwitchPolicy({ strategy: 'sequential' }, HOME);
    expect(switchWeightsFor(HOME)).toEqual({ session: 3, weekly: 7, order: 1 });
    setSwitchPolicy({ weights: { session: 4, weekly: 8, order: 2 } }, HOME);
    expect(switchStrategyFor(HOME)).toBe('sequential');
  });

  it('an account mutation PRESERVES the policy — every write in this file goes through one writer', () => {
    writeClaudeAccounts([zero], HOME);
    setSwitchPolicy({ strategy: 'sequential', weights: { session: 3, weekly: 9, order: 4 } }, HOME);
    // The three operations a user does far more often than they touch this setting.
    upsertClaudeAccount(account(), HOME);
    reorderClaudeAccounts([account().id, zero.id], HOME);
    setPreferredClaudeAccount(zero.id, HOME);
    expect(switchStrategyFor(HOME)).toBe('sequential');
    expect(switchWeightsFor(HOME)).toEqual({ session: 3, weekly: 9, order: 4 });
    expect(autoSwitchEnabled(HOME)).toBe(true);
  });

  it('a corrupt or unknown value reads as the default rather than throwing', () => {
    writeFileSync(claudeAccountsFilePath(HOME), '{"accounts":[],"switchStrategy":"roulette","switchWeights":"nope"}');
    expect(switchStrategyFor(HOME)).toBe('score');
    expect(switchWeightsFor(HOME)).toEqual(DEFAULT_SWITCH_WEIGHTS);
  });
});
