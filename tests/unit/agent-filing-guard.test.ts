/**
 * The awake-agent guard on `tasks create` (audit TK-1, TK-2): a Super child never files, an agent
 * never opens a sub-task; there is no daily count (owner, 2026-11-12). Every refusal names its reason AND the way
 * out (owner rule: a guard asks or explains, it never silently locks).
 */
import { describe, it, expect } from 'vitest';
import {
  agentSessionOf,
  checkAgentFiling,
} from '../../src/lib/agent-filing-guard.js';

const OWNER_WORDS = 'bunun için ayrı bir görev aç lütfen';
const base = { filedBy: 'agent', parent: null, ownerAsked: null, superChild: false };

describe('agentSessionOf: who is an agent is read from the env, never from --by', () => {
  it('a Claude Code Bash tool, a Codex shell, the brain MCP and a spawned run are agents', () => {
    expect(agentSessionOf({ CLAUDECODE: '1' })).toBe('claude');
    expect(agentSessionOf({ CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toBe('claude');
    expect(agentSessionOf({ CODEX_THREAD_ID: 't1' })).toBe('codex');
    expect(agentSessionOf({ DREAMCONTEXT_VIA_BRAIN_MCP: '1' })).toBe('brain-mcp');
    expect(agentSessionOf({ DREAMCONTEXT_SPAWNED: 'develop' })).toBe('spawned');
    expect(agentSessionOf({ DREAMCONTEXT_AUTOMATION_RUN: 'r1' })).toBe('spawned');
  });

  it('the owner at his own terminal is not', () => {
    expect(agentSessionOf({ HOME: '/Users/x', PATH: '/usr/bin' })).toBeNull();
    expect(agentSessionOf({ CLAUDE_CODE_SESSION_ID: '  ', CODEX_THREAD_ID: '' })).toBeNull();
  });
});

describe('checkAgentFiling', () => {
  it('passes an agent filing top-level, not a Super child', () => {
    expect(checkAgentFiling(base)).toEqual({ ok: true, ownerAsked: false });
  });

  it('never touches sleep or the owner', () => {
    expect(checkAgentFiling({ ...base, filedBy: 'sleep', superChild: true, parent: 'p' }).ok).toBe(true);
    expect(checkAgentFiling({ ...base, filedBy: 'human', superChild: true, parent: 'p' }).ok).toBe(true);
  });

  it('refuses a Super child, names why and both ways out', () => {
    const v = checkAgentFiling({ ...base, superChild: true });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('super_child');
    expect(v.message).toContain('only the Super or the owner opens a task');
    expect(v.message).toContain('AskUserQuestion');
    expect(v.message).toContain('--owner-asked');
  });

  it('refuses a sub-task, a plan wave included, and names the criterion command on THAT parent', () => {
    for (const filedBy of ['agent', 'plan']) {
      const v = checkAgentFiling({ ...base, filedBy, parent: 'odev-ver-akisi' });
      expect(v.ok).toBe(false);
      if (v.ok) continue;
      expect(v.code).toBe('parent_needs_owner');
      expect(v.message).toContain('dreamcontext tasks insert odev-ver-akisi acceptance_criteria');
      expect(v.message).toContain('--owner-asked');
    }
  });

  it('has no daily count: an agent\'s top-level task files however many came before', () => {
    expect(checkAgentFiling(base)).toEqual({ ok: true, ownerAsked: false });
  });

  it('the owner\'s words lift both', () => {
    const v = checkAgentFiling({ ...base, superChild: true, parent: 'p', ownerAsked: OWNER_WORDS });
    expect(v).toEqual({ ok: true, ownerAsked: true });
  });

  it('a token instead of his words is refused, and says what is missing', () => {
    const v = checkAgentFiling({ ...base, superChild: true, ownerAsked: 'yes' });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('owner_asked_too_thin');
      expect(v.message).toContain('verbatim');
    }
  });
});
