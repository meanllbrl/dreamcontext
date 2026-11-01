/**
 * Antigravity's accounts, readiness and joins, from disk: no model call, no real account. Each row
 * of plan §4d that W5 touches has a line here; the fake-agent chat is antigravity-session.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityInstalled, antigravityInstanceId, antigravityProfileDir, antigravitySignedIn } from '../../../src/lib/antigravity-accounts.js';
import { recordToolRejection, recordToolSignedOut, type AccountReading } from '../../../src/lib/account-switch.js';
import {
  getInstanceAccount, instanceLimitsFor, isInstanceAccountId, listInstanceAccounts, noteInstanceAccount, readInstanceUsage,
  recordInstanceUsage, removeInstanceAccount, reorderInstanceAccounts,
} from '../../../src/lib/instance-accounts.js';
import { bypassNeedsOwner, instanceRuntimePolicy } from '../../../src/lib/t3-bridge/policy.js';
import { antigravityInfo, listTools, manifestModels, sanitizeTool } from '../../../src/lib/t3-bridge/registry.js';
import { continuationKey, planReplacement } from '../../../src/lib/t3-bridge/replace-session.js';
import { bridgeChatScript, bridgeResumeTarget } from '../../../src/lib/t3-bridge/spawn.js';
import { ecoJoins } from '../../../src/lib/t3-bridge/eco.js';
import { carriedText, instanceHistory, instanceThreadAccount, listInstanceSessions, recordThreadTurn } from '../../../src/lib/t3-bridge/instance-threads.js';
import { antigravityFailureKind } from '../../../src/lib/t3-bridge/to-wire.js';
import { resolveAgentSession, resolveAgentSessionAccount } from '../../../src/lib/agent-session-map.js';
import { decideInstanceTarget, instanceSpawnAccount, isAccountTool } from '../../../src/lib/tool-switch.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-acct-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function signIn(id: string): void {
  const dir = join(antigravityProfileDir(id, home), 'antigravity-acp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'acp_token.json'), '{}');
}

function install(): void {
  const dir = join(home, '.dreamcontext', 't3', 'tools', 'antigravity-acp', `${process.platform}-${process.arch}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'active.json'), '{}');
}

const lookup = (node: string | null = '/usr/bin/node') => ({ home, path: '', node });

describe('readiness: install → sign in → ready', () => {
  it('walks the three states from disk', () => {
    const none = antigravityInfo(lookup());
    expect(none).toMatchObject({ tool: 'antigravity', installed: false, signedIn: false, ready: false });
    install();
    expect(antigravityInfo(lookup())).toMatchObject({ installed: true, signedIn: false, ready: false });
    signIn('primary');
    expect(antigravityInfo(lookup())).toMatchObject({ installed: true, signedIn: true, ready: true });
  });

  it('is not ready without a Node at the bridge floor', () => {
    install();
    signIn('primary');
    expect(antigravityInfo(lookup(null))).toMatchObject({ nodeOk: false, ready: false });
  });

  it('finds an agent on PATH too, which is T3\'s other install route', () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'agy_acp_server.par'), '');
    expect(antigravityInstalled({ home, path: bin })).toBe(true);
    expect(antigravityInstalled({ home, path: '' })).toBe(false);
  });

  it('lists T3\'s manifest models, current ones first, with no efforts of their own', () => {
    const models = manifestModels('antigravity');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]!.id).toMatch(/^gemini-/);
    expect(models.every((m) => m.efforts.length === 0)).toBe(true);
    expect(antigravityInfo(lookup()).defaultModel).toBe(models[0]!.id);
  });

  it('is a tool a chat socket can name, listed after Claude and Codex', () => {
    expect(sanitizeTool('antigravity')).toBe('antigravity');
    expect(sanitizeTool('gemini')).toBeNull();
    expect(isAccountTool('antigravity')).toBe(true);
    expect(listTools({ ...lookup(), loginPath: null, run: () => ({ ok: false, stdout: '' }) as never }).map((t) => t.tool)).toEqual(['claude', 'codex', 'antigravity']);
  });
});

describe('accounts are T3 instances', () => {
  it('gives each account its own instance and profile', () => {
    expect(antigravityInstanceId('primary')).toBe('antigravity');
    expect(antigravityInstanceId('acct-1')).toBe('antigravity-acct-1');
    expect(antigravityProfileDir('primary', home)).not.toBe(antigravityProfileDir('acct-1', home));
    signIn('acct-1');
    expect(antigravitySignedIn('acct-1', home)).toBe(true);
    expect(antigravitySignedIn('primary', home)).toBe(false);
  });

  it('lists #0 before it signed in, and keeps the owner\'s order', () => {
    expect(listInstanceAccounts('antigravity', home).map((a) => a.id)).toEqual(['primary']);
    noteInstanceAccount('antigravity', 'acct-1', {}, home);
    const moved = reorderInstanceAccounts('antigravity', ['acct-1', 'primary'], home);
    expect(moved.map((a) => a.id)).toEqual(['acct-1', 'primary']);
    expect(moved[0]!.preferred).toBe(true);
  });

  it('refuses a list that is not the accounts', () => {
    expect(() => reorderInstanceAccounts('antigravity', ['nope'], home)).toThrow();
  });

  it('removes a non-#0 account with its profile, and never #0', () => {
    signIn('acct-1');
    noteInstanceAccount('antigravity', 'acct-1', {}, home);
    removeInstanceAccount('antigravity', 'acct-1', home);
    expect(getInstanceAccount('antigravity', 'acct-1', home)).toBeNull();
    expect(antigravitySignedIn('acct-1', home)).toBe(false);
    expect(() => removeInstanceAccount('antigravity', 'primary', home)).toThrow();
  });

  it('refuses ids that could reach outside the store', () => {
    for (const bad of ['../x', '', 'primary', 'A', 'a'.repeat(41)]) expect(isInstanceAccountId(bad)).toBe(false);
    expect(() => readInstanceUsage('antigravity', '../x', home)).not.toThrow();
    expect(readInstanceUsage('antigravity', '../x', home)).toBeNull();
  });

  it('keeps a reading in the chooser\'s shape', () => {
    const at = new Date().toISOString();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    recordInstanceUsage('antigravity', 'primary', [{ id: 's', kind: 'session', label: 'x', usedPercent: 91, resetsAt }], at, home);
    expect(instanceLimitsFor(readInstanceUsage('antigravity', 'primary', home)).limits[0]).toMatchObject({ key: 'session', percent: 91 });
  });
});

describe('the account-switch joins (plan §4d)', () => {
  beforeEach(() => {
    signIn('primary');
    signIn('acct-1');
    noteInstanceAccount('antigravity', 'acct-1', {}, home);
  });

  it('opens new chats on the first account with room', () => {
    expect(instanceSpawnAccount('antigravity', home)).toBe('primary');
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    recordInstanceUsage('antigravity', 'primary', [{ id: 's', kind: 'session', label: 'x', usedPercent: 95, resetsAt }], new Date().toISOString(), home);
    expect(instanceSpawnAccount('antigravity', home)).toBe('acct-1');
  });

  it('chooses the other account when this one was refused, with the same chooser as Codex', async () => {
    recordToolRejection('antigravity', 'primary', { window: 'unknown', resetsAtMs: Date.now() + 3_600_000, via: 'rateLimitEvent' }, home);
    const active: AccountReading = { id: 'primary', problem: 'unknown' };
    const choice = await decideInstanceTarget('antigravity', { activeId: 'primary', active, home, probe: async (id) => ({ id, problem: 'healthy-unmeasured' }) });
    expect(choice.target).toEqual({ tool: 'antigravity', accountId: 'acct-1' });
  });

  it('never shares a continuation key across accounts: a move is the Eco path, not a resume', () => {
    expect(continuationKey('antigravity', 'primary', home)).not.toBe(continuationKey('antigravity', 'acct-1', home));
    const plan = planReplacement({ tool: 'antigravity', accountId: 'primary', threadId: 't-1' }, { tool: 'antigravity', accountId: 'acct-1' }, home);
    expect(plan).toMatchObject({ resume: '', handoff: true });
  });

  it('resumes a thread only on the account that holds it', () => {
    const open = (accountId: string, mappedAccount: string, held: string[] = []) => bridgeResumeTarget({ tool: 'antigravity', mapped: 'thread-9', resumeId: 'pane', projectRoot: home, held: new Set(held), accountId, mappedAccount });
    expect(open('acct-1', 'acct-1')).toBe('thread-9');
    expect(open('primary', 'acct-1')).toBe('');
    expect(open('acct-1', 'acct-1', ['thread-9'])).toBe('');
    // What the route actually holds for a live pane: its pane id.
    expect(open('acct-1', 'acct-1', ['pane'])).toBe('');
    expect(bridgeResumeTarget({ tool: 'antigravity', mapped: '', resumeId: 'client-named', projectRoot: home, held: new Set(), accountId: '' })).toBe('');
  });

  it('the real Eco join writes the tab map a reopen reads: a plain thread id, with its account', () => {
    const root = join(home, 'proj');
    mkdirSync(join(root, '_dream_context', 'state'), { recursive: true });
    const tab = '11111111-1111-4111-8111-111111111111';
    const thread = '22222222-2222-4222-8222-222222222222';
    const eco = ecoJoins(root, { DREAMCONTEXT_TAB_SESSION: tab }, { tool: 'antigravity', accountId: 'acct-1' });
    eco.onResult(thread, 0);
    const context = join(root, '_dream_context');
    expect(resolveAgentSession(context, tab)).toBe(thread);
    expect(resolveAgentSessionAccount(context, tab)).toBe('acct-1');
  });

  it('a refused token reads as signed out even with the file on disk, so the picker offers Sign in', () => {
    install();
    expect(antigravityInfo(lookup()).ready).toBe(true);
    recordToolSignedOut('antigravity', 'primary', home);
    recordToolSignedOut('antigravity', 'acct-1', home);
    expect(antigravityInfo(lookup())).toMatchObject({ signedIn: false, ready: false });
  });

  it('reads a quota refusal and a lost sign-in out of Antigravity\'s words', () => {
    expect(antigravityFailureKind('429 RESOURCE_EXHAUSTED: quota')).toBe('limit');
    expect(antigravityFailureKind('Sign in to Antigravity in Settings')).toBe('signed-out');
    expect(antigravityFailureKind('network reset')).toBeNull();
  });

  it('starts the bridge on the account, with Codex\'s model default left out', () => {
    const line = bridgeChatScript({ tool: 'antigravity', model: '', effort: '', mode: 'auto', pane: '', resume: 'thread-9', briefingArg: [], account: 'acct-1', node: '/n', cli: '/c' })!;
    expect(line).toContain('"--tool" "antigravity"');
    expect(line).toContain('"--account" "acct-1"');
    expect(line).toContain('"--resume" "thread-9"');
    expect(line).not.toContain('--model');
    expect(bridgeChatScript({ tool: 'antigravity', model: '', effort: '', mode: 'auto', pane: '', resume: '', briefingArg: [], carry: 'thread-8', node: '/n', cli: '/c' })).toContain('"--carry" "thread-8"');
  });
});

describe('what a chat said survives the pane', () => {
  it('replays this project\'s thread, refuses another\'s, lists it and carries its end', () => {
    const root = join(home, 'proj');
    const other = join(home, 'other');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    mkdirSync(join(other, '_dream_context'), { recursive: true });
    recordThreadTurn('thread-1', root, 'user', 'first question', home);
    recordThreadTurn('thread-1', root, 'assistant', 'first answer', home);
    expect(instanceHistory({ thread: 'thread-1', contextRoot: join(root, '_dream_context'), home })).toEqual({ items: [
      expect.objectContaining({ kind: 'user', text: 'first question' }),
      expect.objectContaining({ kind: 'text', text: 'first answer' }),
    ] });
    expect(instanceHistory({ thread: 'thread-1', contextRoot: join(other, '_dream_context'), home })).toBe('refuse');
    expect(instanceHistory({ thread: '../x', contextRoot: join(root, '_dream_context'), home })).toEqual({ items: [] });
    expect(listInstanceSessions(root, { home }).map((r) => [r.id, r.title, r.tool])).toEqual([['thread-1', 'first question', 'antigravity']]);
    expect(listInstanceSessions(other, { home })).toEqual([]);
    expect(carriedText('thread-1', root, home)).toContain('first answer');
    expect(carriedText('thread-1', other, home)).toBe('');
  });
});

describe('a thread keeps its own account', () => {
  it('a History row with no tab-map entry reopens on its account, and on no other', () => {
    const root = join(home, 'proj');
    mkdirSync(root, { recursive: true });
    recordThreadTurn('thread-2', root, 'user', 'hello', home, 'acct-1');
    const open = (accountId: string) => bridgeResumeTarget({ tool: 'antigravity', mapped: '', resumeId: 'thread-2', projectRoot: root, held: new Set(), accountId, home });
    expect(instanceThreadAccount('thread-2', root, home)).toBe('acct-1');
    expect(open('acct-1')).toBe('thread-2');
    expect(open('primary')).toBe('');
    expect(bridgeResumeTarget({ tool: 'antigravity', mapped: '', resumeId: 'thread-2', projectRoot: join(home, 'elsewhere'), held: new Set(), accountId: 'acct-1', home })).toBe('');
  });

  it('a second move still carries the first thread, which is never replayed', () => {
    const root = join(home, 'proj');
    mkdirSync(join(root, '_dream_context'), { recursive: true });
    recordThreadTurn('t-2', root, 'carried', 'Owner: from the first thread', home, 'acct-1');
    recordThreadTurn('t-2', root, 'user', 'retry', home, 'acct-1');
    expect(carriedText('t-2', root, home)).toContain('from the first thread');
    expect(instanceHistory({ thread: 't-2', contextRoot: join(root, '_dream_context'), home })).toEqual({ items: [expect.objectContaining({ kind: 'user', text: 'retry' })] });
  });

  it('a moved chat replays as one conversation, and History lists it once', () => {
    const root = join(home, 'proj');
    const context = join(root, '_dream_context');
    mkdirSync(join(context, 'state', '.agent-session-map'), { recursive: true });
    const pane = '33333333-3333-4333-8333-333333333333';
    const next = '44444444-4444-4444-8444-444444444444';
    recordThreadTurn(pane, root, 'user', 'before the move', home, 'primary');
    recordThreadTurn(next, root, 'carried', 'Owner: before the move', home, 'acct-1', pane);
    recordThreadTurn(next, root, 'user', 'after the move', home, 'acct-1');
    writeFileSync(join(context, 'state', '.agent-session-map', `${pane}.json`), JSON.stringify({ current: next, updated: new Date().toISOString(), account: 'acct-1' }));
    expect(instanceHistory({ thread: next, contextRoot: context, home })).toEqual({ items: [
      expect.objectContaining({ text: 'before the move' }), expect.objectContaining({ text: 'after the move' }),
    ] });
    expect(listInstanceSessions(root, { home, contextRoot: context }).map((r) => r.id)).toEqual([pane]);
  });

  it('reads the ACP standard refusal as signed out, and not every word holding "sign"', () => {
    expect(antigravityFailureKind('Authentication required')).toBe('signed-out');
    expect(antigravityFailureKind('Please sign into your account')).toBe('signed-out');
    expect(antigravityFailureKind('assigning the design input failed')).toBeNull();
  });

  it('an edit with no real path goes to the owner even in Bypass', () => {
    expect(bypassNeedsOwner('Edit', { file_path: 'Edit file' }, '/p')).toBe(true);
    expect(bypassNeedsOwner('Edit', { file_path: 'C:\\p\\_dream_context\\marketing\\.env' }, '/p')).toBe(true);
  });
});

describe('permission modes: no OS sandbox, so the agent always asks', () => {
  it.each([
    ['default', 'default'], ['auto', 'default'], ['acceptEdits', 'default'], ['plan', 'plan'], ['nonsense', 'default'], ['bypassPermissions', 'default'],
  ])('%s', (mode, interactionMode) => {
    expect(instanceRuntimePolicy({ mode, cwd: '/p' })).toEqual({ runtimeMode: 'approval-required', interactionMode, cwd: '/p' });
  });

  it('Bypass still brings the writes Claude\'s hook refuses to the owner', () => {
    expect(bypassNeedsOwner('Edit', { file_path: '/p/_dream_context/marketing/.env' }, '/p')).toBe(true);
    expect(bypassNeedsOwner('Bash', { command: 'echo x > _dream_context/marketing/.env' }, '/p')).toBe(true);
    expect(bypassNeedsOwner('Edit', { file_path: '/p/src/a.ts' }, '/p')).toBe(false);
    expect(bypassNeedsOwner('Bash', { command: 'npm test' }, '/p')).toBe(false);
  });
});
