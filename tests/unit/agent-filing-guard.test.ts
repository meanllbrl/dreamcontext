/**
 * The awake-agent guard on `tasks create` (audit TK-1, TK-2): a Super child never files, an agent
 * never opens a sub-task, agents share a daily budget. Every refusal names its reason AND the way
 * out (owner rule: a guard asks or explains, it never silently locks).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_TASK_BUDGET,
  agentSessionOf,
  agentTasksFiledOn,
  checkAgentFiling,
  resolveAgentTaskBudget,
  sanitizeAgentTaskBudget,
} from '../../src/lib/agent-filing-guard.js';

const OWNER_WORDS = 'bunun için ayrı bir görev aç lütfen';
const base = { filedBy: 'agent', parent: null, ownerAsked: null, superChild: false, filedToday: 0, budget: 3 };

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
  it('passes an agent under its budget, top-level, not a Super child', () => {
    expect(checkAgentFiling({ ...base, filedToday: 2 })).toEqual({ ok: true, ownerAsked: false });
  });

  it('never touches sleep or the owner', () => {
    expect(checkAgentFiling({ ...base, filedBy: 'sleep', superChild: true, parent: 'p', filedToday: 99 }).ok).toBe(true);
    expect(checkAgentFiling({ ...base, filedBy: 'human', superChild: true, parent: 'p', filedToday: 99 }).ok).toBe(true);
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

  it('refuses past the daily budget and names how the owner changes it', () => {
    const v = checkAgentFiling({ ...base, filedToday: 3 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.code).toBe('daily_budget');
    expect(v.message).toContain('3 tasks today (budget 3 a day)');
    expect(v.message).toContain('dreamcontext config agent-task-budget <n>');
    expect(v.message).toContain('--owner-asked');
  });

  it('a budget of 0 says so in plain words', () => {
    const v = checkAgentFiling({ ...base, budget: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain('agent task budget = 0');
  });

  it('the owner\'s words lift all three', () => {
    const v = checkAgentFiling({ ...base, superChild: true, parent: 'p', filedToday: 50, ownerAsked: OWNER_WORDS });
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

describe('the budget', () => {
  it('counts only agent and plan filings created that day without the owner\'s words', () => {
    const tasks = [
      { created_at: '2026-11-12', filed_by: 'agent' },
      { created_at: '2026-11-12T08:00:00Z', filed_by: 'plan' },
      { created_at: '2026-11-12', filed_by: 'human' },
      { created_at: '2026-11-12', filed_by: 'sleep' },
      { created_at: '2026-11-11', filed_by: 'agent' },
      { created_at: '2026-11-12', filed_by: null },
      // Filed on the owner's words (--owner-asked records an ask): his, so it spends no budget.
      { created_at: '2026-11-12', filed_by: 'agent', filing_basis: { kind: 'ask', quote: 'bunun için ayrı bir görev aç' } },
      { created_at: '2026-11-12', filed_by: 'agent', filing_basis: { kind: 'note' } },
      // A one-word "ask" is no way out of the count.
      { created_at: '2026-11-12', filed_by: 'agent', filing_basis: { kind: 'ask', quote: 'yes' } },
    ];
    expect(agentTasksFiledOn(tasks, '2026-11-12')).toBe(4);
  });

  it('defaults to 3 and accepts only a whole number 0..50', () => {
    expect(DEFAULT_AGENT_TASK_BUDGET).toBe(3);
    expect(resolveAgentTaskBudget(undefined)).toBe(3);
    expect(resolveAgentTaskBudget(0)).toBe(0);
    expect(resolveAgentTaskBudget(7)).toBe(7);
    for (const bad of [-1, 51, 2.5, Number.NaN, '4' as unknown]) expect(sanitizeAgentTaskBudget(bad)).toBeUndefined();
  });
});
