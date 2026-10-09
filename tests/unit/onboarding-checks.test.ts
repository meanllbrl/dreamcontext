import { describe, it, expect } from 'vitest';
import { evaluateChecks, applyBlocking, nodeMajor } from '../../src/lib/onboarding/checks.js';
import { CHECK_IDS, type ExtraFacts, type ReadinessCheck, type ShellFacts } from '../../src/lib/onboarding/types.js';

const READY_FACTS: ShellFacts = {
  shell: '/bin/zsh', node: '/opt/homebrew/bin/node', nodeVersion: 'v22.3.0', npm: '/opt/homebrew/bin/npm',
  dreamcontext: '/opt/homebrew/bin/dreamcontext', claude: '/Users/u/.local/bin/claude', gh: '/opt/homebrew/bin/gh',
  git: '/opt/homebrew/bin/git', cltInstalled: true,
};
const READY_EXTRA: ExtraFacts = {
  online: true, runningNodeVersion: '22.3.0', npmBesideExec: true, claudeBin: '/Users/u/.local/bin/claude',
  cliBinOffPath: null, claudeAuth: { loggedIn: true, email: 'ada@example.com' }, ghAuthed: true,
  github: { connected: true, needsReconnect: false, login: 'ada' }, ptyPresent: true,
};
const CTX = { surface: 'desktop' as const, platform: 'darwin' as const };

const byId = (checks: ReadinessCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe('evaluateChecks', () => {
  it('a ready machine: every check ok, in CHECK_IDS order, account is an email, never a token', () => {
    const checks = evaluateChecks(READY_FACTS, READY_EXTRA, CTX);
    expect(checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(byId(checks)['claude-auth'].account).toBe('ada@example.com');
    expect(byId(checks).github.account).toBe('ada');
  });

  it('a fresh machine: missing pieces get their fixes; sign-in is unknown until Claude exists', () => {
    const facts: ShellFacts = { shell: '/bin/zsh', cltInstalled: false };
    const extra: ExtraFacts = {
      ...READY_EXTRA, npmBesideExec: true, claudeBin: null, claudeAuth: null, ghAuthed: null,
      github: { connected: false, needsReconnect: false, login: null }, ptyPresent: false,
    };
    const c = byId(evaluateChecks(facts, extra, CTX));
    expect(c.node).toMatchObject({ status: 'needs-action', reason: 'not-on-path', fix: { id: 'node-shell-path', kind: 'auto', editsShellProfile: true } });
    expect(c.npm.status).toBe('ok'); // npm next to the running node
    expect(c.cli).toMatchObject({ status: 'missing', fix: { id: 'cli-install' } });
    expect(c.claude).toMatchObject({ status: 'missing', reason: 'not-installed', fix: { id: 'claude-install' } });
    expect(c['claude-auth'].status).toBe('blocked');
    expect(c['claude-auth'].blockedBy).toEqual(['claude']);
    expect(c.git).toMatchObject({ status: 'missing', reason: 'needs-dialog', fix: { id: 'git-install', kind: 'system-dialog', manual: 'xcode-select --install' } });
    expect(c.github).toMatchObject({ status: 'needs-action', fix: { id: 'github-signin', kind: 'device-code' } });
    expect(c.gh).toMatchObject({ status: 'missing', fix: { id: 'gh-install', kind: 'auto' } });
    expect(c.terminal).toMatchObject({ status: 'missing', fix: { id: 'pty-install' } });
  });

  it('managed Node not on the shell PATH: needs-action with the shell-path fix', () => {
    const c = byId(evaluateChecks({ ...READY_FACTS, node: undefined, nodeVersion: undefined }, READY_EXTRA, CTX));
    expect(c.node).toMatchObject({ status: 'needs-action', reason: 'not-on-path', fix: { id: 'node-shell-path' } });
  });

  it('a shell Node older than 18 is too old', () => {
    const c = byId(evaluateChecks({ ...READY_FACTS, nodeVersion: 'v16.20.2' }, READY_EXTRA, CTX));
    expect(c.node).toMatchObject({ status: 'needs-action', reason: 'too-old', version: 'v16.20.2' });
  });

  it('claude only in ~/.local/bin: needs-action, not-on-path, PATH fix', () => {
    const c = byId(evaluateChecks({ ...READY_FACTS, claude: undefined }, READY_EXTRA, CTX));
    expect(c.claude).toMatchObject({ status: 'needs-action', reason: 'not-on-path', fix: { id: 'claude-path' } });
  });

  it('signed out → claude-signin (browser); an unanswerable probe → unknown, not a warning', () => {
    const out = byId(evaluateChecks(READY_FACTS, { ...READY_EXTRA, claudeAuth: { loggedIn: false } }, CTX));
    expect(out['claude-auth']).toMatchObject({ status: 'needs-action', reason: 'signed-out', fix: { id: 'claude-signin', kind: 'browser' } });
    const unk = byId(evaluateChecks(READY_FACTS, { ...READY_EXTRA, claudeAuth: { loggedIn: null } }, CTX));
    expect(unk['claude-auth']).toMatchObject({ status: 'unknown', reason: 'unverifiable', fix: null });
  });

  it('offline: network missing; network-dependent checks that are not ok become blocked, ok ones stay ok', () => {
    const c = byId(evaluateChecks({ ...READY_FACTS, claude: undefined, gh: undefined }, { ...READY_EXTRA, online: false, claudeBin: null }, CTX));
    expect(c.network).toMatchObject({ status: 'missing', reason: 'offline' });
    expect(c.claude).toMatchObject({ status: 'blocked', blockedBy: ['network'] });
    expect(c.gh.status).toBe('blocked');
    expect(c.cli.status).toBe('ok');
  });

  it('gh installed but signed out → gh-signin; unknown when it cannot tell', () => {
    expect(byId(evaluateChecks(READY_FACTS, { ...READY_EXTRA, ghAuthed: false }, CTX)).gh)
      .toMatchObject({ status: 'needs-action', reason: 'signed-out', fix: { id: 'gh-signin', kind: 'device-code' } });
    expect(byId(evaluateChecks(READY_FACTS, { ...READY_EXTRA, ghAuthed: null }, CTX)).gh.status).toBe('unknown');
  });

  it('the browser surface can run nothing; manual fixes are never runnable', () => {
    const c = byId(evaluateChecks({ shell: '/bin/zsh' }, { ...READY_EXTRA, claudeBin: null }, { surface: 'browser', platform: 'darwin' }));
    expect(c.claude.fix?.runnable).toBe(false);
    const linux = byId(evaluateChecks({ shell: '/bin/bash' }, READY_EXTRA, { surface: 'cli', platform: 'linux', linuxPm: 'apt' }));
    expect(linux.git.fix).toMatchObject({ kind: 'manual', runnable: false, manual: 'sudo apt install git' });
    expect(linux.gh.fix).toMatchObject({ kind: 'manual', manual: 'sudo apt install gh' });
  });

  it('the terminal check is unsupported off the desktop surface', () => {
    expect(byId(evaluateChecks(READY_FACTS, { ...READY_EXTRA, ptyPresent: null }, CTX)).terminal)
      .toMatchObject({ status: 'unsupported', reason: 'desktop-only' });
  });
});

describe('applyBlocking', () => {
  it('cascades through a blocked dependency', () => {
    const base = evaluateChecks({ shell: '/bin/zsh' }, { ...READY_EXTRA, online: false, claudeBin: null, claudeAuth: { loggedIn: false } }, CTX);
    const c = byId(applyBlocking(base));
    expect(c.claude.status).toBe('blocked');
    expect(c['claude-auth'].blockedBy).toEqual(['claude', 'network']);
  });
});

describe('nodeMajor', () => {
  it('parses v-prefixed and bare versions', () => {
    expect(nodeMajor('v24.9.0')).toBe(24);
    expect(nodeMajor('18.0.1')).toBe(18);
    expect(nodeMajor('garbage')).toBeNull();
    expect(nodeMajor(undefined)).toBeNull();
  });
});
