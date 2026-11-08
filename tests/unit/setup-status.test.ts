/**
 * The setup status chip beside the sleep score (owner 2026-11-03, "bunda dikkat ol"): only BIG
 * problems draw it and only they are red. A false red is the worst failure, so every row of the
 * rule in `dashboard/src/lib/setupStatus.ts` is pinned here, the quiet cases first.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chipSummary, setupProblems } from '../../dashboard/src/lib/setupStatus.js';
import type { AgentToolInfo } from '../../dashboard/src/hooks/useAgentCapabilities.js';
import type { CheckId, ReadinessCheck, ReadinessReport } from '../../dashboard/src/lib/onboardingTypes.js';

const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const FIX: Partial<Record<CheckId, string>> = {
  node: 'node-shell-path', cli: 'cli-install', claude: 'claude-install', 'claude-auth': 'claude-signin',
  codex: 'codex-install', 'codex-auth': 'codex-signin', git: 'git-install', github: 'github-signin', gh: 'gh-install', terminal: 'pty-install',
};

function check(id: CheckId, status: ReadinessCheck['status'] = 'ok', extra: Partial<ReadinessCheck> = {}): ReadinessCheck {
  return {
    id, tier: 'required', scopes: ['machine'], status, dependsOn: [],
    fix: status === 'ok' || !FIX[id] ? null : { id: FIX[id] as never, kind: 'auto', runnable: true, editsShellProfile: false },
    ...extra,
  };
}

const ALL: CheckId[] = ['network', 'node', 'npm', 'cli', 'claude', 'claude-auth', 'codex', 'codex-auth', 'git', 'github', 'gh', 'terminal'];
function report(over: Partial<Record<CheckId, Partial<ReadinessCheck> & { status: ReadinessCheck['status'] }>> = {}): ReadinessReport {
  return {
    version: 1, platform: 'darwin', arch: 'arm64', surface: 'desktop', generatedAt: 0,
    ready: true, online: true, plan: [], next: null, activeFixes: [],
    checks: ALL.map((id) => { const o = over[id]; return o ? check(id, o.status, o) : check(id); }),
  };
}

const tool = (t: AgentToolInfo['tool'], installed: boolean, signedIn: boolean): AgentToolInfo => ({
  tool: t, label: t, ready: installed && signedIn, installed, signedIn, defaultModel: null, models: [],
});
const CLAUDE_ONLY = [tool('claude', true, true), tool('codex', false, false), tool('antigravity', false, false)];

// No Claude accounts recorded (a fresh machine): the report's own sign-in row decides.
const NO_ACCOUNTS: { state: string }[] = [];
const ids = (r: ReadinessReport, tools: AgentToolInfo[] | null = CLAUDE_ONLY, projectMissing = false, claudeAccounts: { state: string }[] | null = NO_ACCOUNTS) =>
  setupProblems({ report: r, tools, claudeAccounts, projectMissing }).map((p) => `${p.id}:${p.tone}`);

describe('nothing drawn', () => {
  it('(a) everything fine', () => {
    expect(ids(report())).toEqual([]);
    expect(chipSummary(setupProblems({ report: report(), tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: false }))).toBeNull();
  });

  it('(b) Codex, Antigravity, git, GitHub, gh and the terminal all missing', () => {
    const r = report({
      codex: { status: 'missing', reason: 'not-installed' }, 'codex-auth': { status: 'blocked', blockedBy: ['codex'] },
      git: { status: 'missing' }, github: { status: 'needs-action' }, gh: { status: 'missing' }, terminal: { status: 'missing' },
    });
    expect(ids(r)).toEqual([]);
  });

  it('Codex missing + Claude ok = nothing', () => {
    expect(ids(report({ codex: { status: 'missing' } }), CLAUDE_ONLY)).toEqual([]);
  });

  it('unknown and unsupported never alarm', () => {
    expect(ids(report({ node: { status: 'unknown' }, cli: { status: 'unsupported' }, 'claude-auth': { status: 'unknown' } }))).toEqual([]);
  });

  it('Claude on disk but off the shell PATH still runs in the app', () => {
    expect(ids(report({ claude: { status: 'needs-action', reason: 'not-on-path' } }))).toEqual([]);
  });

  it('a sign-in blocked only by the network is not "signed out"', () => {
    const r = report({ network: { status: 'missing', reason: 'offline' }, claude: { status: 'blocked', blockedBy: ['network'] }, 'claude-auth': { status: 'blocked', blockedBy: ['claude', 'network'] } });
    expect(setupProblems({ report: r, tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: false, offlineConfirmed: true }).map((p) => p.id)).toEqual(['network']);
  });

  it('one offline read (a slow 3 s ping, a proxy, a wake from sleep) is not "No internet"', () => {
    expect(ids(report({ network: { status: 'missing', reason: 'offline' } }))).toEqual([]);
  });

  it('node, npm or the CLI off the shell PATH (needs-action) is not red: the app runs anyway', () => {
    expect(ids(report({ node: { status: 'needs-action', reason: 'not-on-path' }, cli: { status: 'needs-action', reason: 'not-on-path' } }))).toEqual([]);
  });

  it("the owner's Mac: the report says Claude signed out, the app's own accounts work = nothing", () => {
    // Read from the real app on 2026-11-03: claude-auth needs-action/signed-out, five accounts ok.
    const r = report({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } });
    expect(ids(r, CLAUDE_ONLY, false, [{ state: 'ok' }, { state: 'ok' }])).toEqual([]);
    expect(ids(r, [tool('claude', true, true), tool('codex', true, true)], false, [{ state: 'ok' }])).toEqual([]);
  });

  it('Claude accounts unanswered: the sign-in is unknown, never red', () => {
    const r = report({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } });
    expect(ids(r, CLAUDE_ONLY, false, null)).toEqual([]);
  });

  it('agent rows wait for the tool list instead of guessing', () => {
    const r = report({ claude: { status: 'missing' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } });
    expect(ids(r, null)).toEqual([]);
  });

  it('no report yet: nothing but a missing folder', () => {
    expect(setupProblems({ report: undefined, tools: null, claudeAccounts: NO_ACCOUNTS, projectMissing: false })).toEqual([]);
  });
});

describe('the quiet gray note', () => {
  it('(c) Claude missing but Codex signed in: only the gray "Sleep needs Claude" row', () => {
    const r = report({ claude: { status: 'missing' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } });
    const problems = setupProblems({ report: r, tools: [tool('codex', true, true), tool('antigravity', false, false)], claudeAccounts: NO_ACCOUNTS, projectMissing: false });
    expect(problems.map((p) => `${p.id}:${p.tone}`)).toEqual(['claude-only:quiet']);
    expect(problems[0].fix).toBe('claude-install');
    expect(chipSummary(problems)?.tone).toBe('quiet');
  });

  it('Claude signed out + Antigravity signed in = gray line only', () => {
    const r = report({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } });
    expect(ids(r, [tool('claude', true, false), tool('codex', false, false), tool('antigravity', true, true)])).toEqual(['claude-only:quiet']);
  });
});

describe('red', () => {
  it('(d) Node missing: red, with its fix; what depends on it stays out', () => {
    const r = report({ node: { status: 'missing', reason: 'too-old' }, npm: { status: 'blocked', blockedBy: ['node'] }, cli: { status: 'blocked', blockedBy: ['npm'] } });
    const problems = setupProblems({ report: r, tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: false });
    expect(problems.map((p) => `${p.id}:${p.tone}`)).toEqual(['node:bad']);
    expect(chipSummary(problems)).toMatchObject({ tone: 'bad', more: 0, first: { labelKey: 'setupStatus.node' } });
  });

  it('npm and the CLI each count when missing', () => {
    expect(ids(report({ npm: { status: 'missing' } }))).toEqual(['npm:bad']);
    expect(ids(report({ cli: { status: 'missing', reason: 'not-installed' } }))).toEqual(['cli:bad']);
  });

  it('no network, confirmed by a second read', () => {
    const r = report({ network: { status: 'missing', reason: 'offline' } });
    expect(setupProblems({ report: r, tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: false, offlineConfirmed: true }).map((p) => `${p.id}:${p.tone}`)).toEqual(['network:bad']);
  });

  it('a Codex that is signed in but will not start does not make Claude optional', () => {
    const r = report({ claude: { status: 'missing' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } });
    expect(ids(r, [{ ...tool('codex', true, true), ready: false }])).toEqual(['no-signin:bad']);
  });

  it('(e) all three signed out = red "no agent signed in", with the Claude sign-in as its fix', () => {
    const r = report({ 'claude-auth': { status: 'needs-action', reason: 'signed-out' } });
    const problems = setupProblems({ report: r, tools: [tool('claude', true, false), tool('codex', true, false), tool('antigravity', true, false)], claudeAccounts: NO_ACCOUNTS, projectMissing: false });
    expect(problems.map((p) => `${p.id}:${p.tone}`)).toEqual(['no-signin:bad']);
    expect(problems[0].fix).toBe('claude-signin');
  });

  it('no agent installed at all = red "no agent installed"', () => {
    const r = report({ claude: { status: 'missing' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } });
    expect(ids(r, [tool('claude', false, false), tool('codex', false, false), tool('antigravity', false, false)])).toEqual(['no-agent:bad']);
    // A server that lists no other tool: Claude is the only one there is.
    expect(ids(r, [])).toEqual(['no-agent:bad']);
  });

  it("every account the app has for Claude needs a new sign-in, and nothing else is signed in = red", () => {
    expect(ids(report(), CLAUDE_ONLY, false, [{ state: 'needs-relogin' }])).toEqual(['no-signin:bad']);
  });

  it('Claude missing, Codex installed but signed out = nobody signed in', () => {
    const r = report({ claude: { status: 'missing' }, 'claude-auth': { status: 'blocked', blockedBy: ['claude'] } });
    expect(ids(r, [tool('codex', true, false)])).toEqual(['no-signin:bad']);
  });

  it('(f) the project folder is gone: red, naming the fix', () => {
    const problems = setupProblems({ report: report(), tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: true });
    expect(problems.map((p) => `${p.id}:${p.tone}`)).toEqual(['project-missing:bad']);
    expect(problems[0].detailKey).toBe('setupStatus.projectMissing.detail');
  });

  it('the chip counts only the other red rows', () => {
    const r = report({ node: { status: 'missing' }, cli: { status: 'missing' } });
    const s = chipSummary(setupProblems({ report: r, tools: CLAUDE_ONLY, claudeAccounts: NO_ACCOUNTS, projectMissing: true }));
    expect(s).toMatchObject({ tone: 'bad', more: 2, first: { id: 'project-missing' } });
  });
});

describe('the chip on screen', () => {
  const chip = read('dashboard/src/components/layout/newshell/SetupStatusChip.tsx');
  const controls = read('dashboard/src/components/layout/newshell/NewShellControls.tsx');

  it('sits left of the sleep score, behind the same phone guard', () => {
    expect(controls.indexOf('<SetupStatusChip />')).toBeGreaterThan(-1);
    expect(controls.indexOf('<SetupStatusChip />')).toBeLessThan(controls.indexOf('<SleepDebtTracker'));
    expect(controls).toMatch(/!phone && phoneAllows\('GET', '\/api\/onboarding\/readiness'\) && <SetupStatusChip \/>/);
  });

  it('never polls: one read on open, again on focus after 5 min, a re-read only while offline', () => {
    expect(chip).toMatch(/fetchReadiness\(false\)/);
    expect(chip).toMatch(/const FOCUS_STALE_MS = 5 \* 60_000;/);
    expect(chip.match(/refetchInterval: false/g)?.length).toBe(2);
    expect(chip).toMatch(/refetchInterval: \(q\) => \(q\.state\.data && !q\.state\.data\.online \? pollMs\(OFFLINE_REREAD_MS\) : false\)/);
    expect(chip).not.toMatch(/useReadiness\(|useAgentTools\(|useClaudeAccounts\(|fetchReadiness\(true\)/);
  });

  it('a failed re-read keeps the last answer; no answer is "cannot tell"', () => {
    expect(chip).toMatch(/const toolList = Array\.isArray\(tools\.data\) \? tools\.data : null;/);
    expect(chip).not.toMatch(/isError \? \[\]/);
  });

  it('ships Turkish copy', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    expect(i18n).toContain("'setupStatus.node': 'Node yok'");
    expect(i18n).toContain("'setupStatus.claudeOnly': 'Uyku Claude ister'");
  });
});

describe('Codex is optional in onboarding', () => {
  it('server tiers and the checklist\'s own group', async () => {
    const { CHECK_TIERS } = await import('../../src/lib/onboarding/types.js');
    expect(CHECK_TIERS.codex).toBe('optional');
    expect(CHECK_TIERS['codex-auth']).toBe('optional');
    const list = read('dashboard/src/pages/onboarding/ReadinessChecklist.tsx');
    expect(list).toMatch(/rows\.filter\(\(c\) => c\.tier === 'optional'\)/);
  });
});
