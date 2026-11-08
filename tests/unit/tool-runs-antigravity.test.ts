/**
 * Row 17, 18, 21, 29, 30, 34, 36: what runs without a chat knows Antigravity, under a fake HOME.
 * An Antigravity account is picked from its own store, a manifest keeps `tool: antigravity`, the
 * approval card names each tool's reach, a bridge chat is an agent for the owner guard, a Codex or
 * Antigravity prompt hook never calls Claude for recall, and its transcripts count in usage.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { pickToolRunAccount, toolRunAccountArg } from '../../src/lib/automations/codex-account.js';
import { runAccountIdOk, toolFieldsOf } from '../../src/lib/automations/store.js';
import { agentGuardRefuses, isAgentSession } from '../../src/lib/owner-guard-cli.js';
import { agentSessionId, inAgentSession } from '../../src/lib/session-id.js';
import { setHookTool } from '../../src/lib/hook-tool.js';
import { selectPromptRecall } from '../../src/cli/commands/hook.js';
import { ledgerRoots } from '../../src/lib/usage-ledger.js';
import { codexRunArgs } from '../../src/lib/t3-bridge/headless-envelope.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-runs-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); setHookTool(null); });

const signIn = (id: string) => {
  const acp = join(antigravityProfileDir(id, home), 'antigravity-acp');
  mkdirSync(acp, { recursive: true });
  writeFileSync(join(acp, 'acp_token.json'), '{}');
};

describe('an Antigravity run picks an Antigravity account', () => {
  it('none signed in: no account, so the run says so instead of going out', () => {
    expect(pickToolRunAccount('antigravity', { home })).toEqual({ none: true });
  });

  it('the first signed-in account, and no --account for it', () => {
    signIn('primary');
    expect(pickToolRunAccount('antigravity', { home })).toEqual({ account: 'primary' });
    expect(pickToolRunAccount('antigravity', { home, unattended: true })).toEqual({ account: 'primary' });
    expect(toolRunAccountArg('antigravity', 'primary')).toBeNull();
    expect(toolRunAccountArg('antigravity', 'acct-2')).toBe('acct-2');
    expect(codexRunArgs({ surface: 'automation', prompt: 'p', tool: 'antigravity', account: toolRunAccountArg('antigravity', 'acct-2') }))
      .toEqual(['t3-run', '--surface', 'automation', '--prompt=p', '--tool', 'antigravity', '--account', 'acct-2']);
  });

  it('a pinned account that is not signed in is never swapped for another', () => {
    signIn('primary');
    expect(pickToolRunAccount('antigravity', { home, pinned: 'acct-gone' })).toEqual({ none: true });
  });
});

describe('a manifest keeps its tool', () => {
  it('reads antigravity and its account, and nothing it does not know', () => {
    expect(toolFieldsOf({ tool: 'antigravity', account: 'acct-2' })).toEqual({ tool: 'antigravity', account: 'acct-2' });
    expect(toolFieldsOf({ tool: 'antigravity', account: 'primary' })).toEqual({ tool: 'antigravity' });
    expect(toolFieldsOf({ tool: 'codex' })).toEqual({ tool: 'codex' });
    expect(toolFieldsOf({ tool: 'opencode' })).toEqual({});
    expect(runAccountIdOk('antigravity', '../x')).toBe(false);
  });
});

describe('the session a command runs in', () => {
  it('Claude: its id; Codex: its thread, never a stray Claude id; Antigravity: an agent with no id', () => {
    expect(agentSessionId({ CLAUDE_CODE_SESSION_ID: 'c1' })).toBe('c1');
    expect(agentSessionId({ DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_THREAD_ID: 't-1', CLAUDE_CODE_SESSION_ID: 'lead' })).toBe('t-1');
    expect(agentSessionId({ DREAMCONTEXT_AGENT_TOOL: 'antigravity', CLAUDE_CODE_SESSION_ID: 'lead' })).toBeNull();
    expect(agentSessionId({ DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_THREAD_ID: '../../etc' })).toBeNull();
    expect(inAgentSession({ DREAMCONTEXT_AGENT_TOOL: 'antigravity' })).toBe(true);
    expect(inAgentSession({})).toBe(false);
  });

  it('the owner guard refuses a Codex or Antigravity chat as it refuses a Claude one', () => {
    for (const env of [{ DREAMCONTEXT_AGENT_TOOL: 'codex' }, { DREAMCONTEXT_AGENT_TOOL: 'antigravity' }, { CLAUDE_CODE_SESSION_ID: 'c1' }]) {
      expect(isAgentSession(env)).toBe(true);
      expect(agentGuardRefuses({ reach: 3 }, { reach: 5 }, false, false, env)).toBe(true);
    }
    expect(agentGuardRefuses({ reach: 3 }, { reach: 5 }, false, false, {})).toBe(false);
  });
});

describe('recall under another tool', () => {
  it('a Codex or Antigravity prompt hook never calls the Claude extractor', async () => {
    const root = join(home, 'proj', '_dream_context');
    mkdirSync(root, { recursive: true });
    for (const tool of ['codex', 'antigravity'] as const) {
      setHookTool(tool);
      const haiku = vi.fn(() => null);
      const r = await selectPromptRecall('how does checkout work', root, 'haiku', { haiku, home });
      expect(haiku).not.toHaveBeenCalled();
      expect(r.label).toBe('BM25 · Haiku is Claude only');
    }
    setHookTool(null);
    const haiku = vi.fn(() => null);
    await selectPromptRecall('how does checkout work', root, 'haiku', { haiku, home });
    expect(haiku).toHaveBeenCalledOnce();
  });
});

describe('usage', () => {
  it('reads the Antigravity transcripts as their own tool', () => {
    const dir = join(home, '.dreamcontext', 't3', 'transcripts');
    mkdirSync(dir, { recursive: true });
    expect(ledgerRoots(home).find((r) => r.tool === 'antigravity')?.dir).toContain(join('.dreamcontext', 't3', 'transcripts'));
  });
});
