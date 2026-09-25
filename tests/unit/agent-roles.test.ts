/**
 * The agent role registry (dashboard/src/lib/agentRoles.ts): which character a dispatch is,
 * and which quest stage its party advances. Every surface that draws an agent reads this, so a
 * wrong row here is a wrong face everywhere.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_ROLES, LEAD_NAME, QUEST_STAGE_LABELS, STAGE_ACTS, isJudgeRole, resolveAgentIdentity, roleHueVar, roleOf,
  type AgentRoleId,
} from '../../dashboard/src/lib/agentRoles.js';
import { JARGON_RE } from '../../dashboard/src/lib/quest.js';

describe('resolveAgentIdentity: named types', () => {
  const cases: Array<[string, AgentRoleId, string]> = [
    ['goal-planner', 'planner', 'draft'],
    ['Plan', 'planner', 'draft'],
    ['goal-implementer', 'implementer', 'build'],
    ['reviewer', 'reviewer', 'boss'],
    ['review-coordinator', 'reviewer', 'boss'],
    ['review-frontend', 'reviewer', 'boss'],
    ['review-cloud-functions', 'reviewer', 'boss'],
    ['review-router', 'reviewer', 'boss'],
    ['review-security', 'security', 'boss'],
    ['review-edge-cases', 'edge-cases', 'boss'],
    ['goal-validator', 'validator', 'trial'],
    ['Explore', 'explorer', 'scout'],
    ['dreamcontext-explore', 'explorer', 'scout'],
    ['dreamcontext-deep-research', 'explorer', 'scout'],
  ];
  for (const [type, role, stage] of cases) {
    it(`${type} → ${role} / ${stage}`, () => {
      expect(resolveAgentIdentity({ subagentType: type, name: 'anything' })).toEqual({ role, stage });
    });
  }

  it('a named type wins over a keyword in its name', () => {
    expect(resolveAgentIdentity({ subagentType: 'goal-validator', name: 'critic review' }))
      .toEqual({ role: 'validator', stage: 'trial' });
  });

  it('peer-* is another project', () => {
    expect(resolveAgentIdentity({ subagentType: 'peer-tilki', name: 'Ask Tilki' })).toEqual({ role: 'peer', stage: 'none' });
  });
});

describe('resolveAgentIdentity: plan-review lenses (L1)', () => {
  const lens = (name: string, prompt?: string) => resolveAgentIdentity({ subagentType: 'goal-plan-reviewer', name, prompt }).role;

  it('reads the lens from the dispatch name', () => {
    expect(lens('critic lens')).toBe('critic');
    expect(lens('Pragmatist lens')).toBe('pragmatist');
    expect(lens('edge-cases lens')).toBe('edge-cases');
    expect(lens('security lens')).toBe('security');
  });

  it('falls back to the first 400 chars of the brief', () => {
    expect(lens('Review the plan', 'You are the CRITIC. Attack the premise.')).toBe('critic');
    expect(lens('Review the plan', `${'x'.repeat(420)} security`)).toBe('plan-reviewer');
  });

  it('no lens → the generic plan reviewer, still in review', () => {
    expect(resolveAgentIdentity({ subagentType: 'goal-plan-reviewer', name: 'Review the plan' }))
      .toEqual({ role: 'plan-reviewer', stage: 'review' });
  });
});

describe('resolveAgentIdentity: command-line helpers', () => {
  const bash = (command: string) => resolveAgentIdentity({ taskType: 'local_bash', command, name: 'Run it' });

  it('--agent names the character', () => {
    expect(bash('claude -p "go" --agent reviewer --output-format json')).toEqual({ role: 'reviewer', stage: 'boss' });
    expect(bash('claude -p --agent=goal-validator "check"')).toEqual({ role: 'validator', stage: 'trial' });
  });

  it('a copied memory is a builder', () => {
    expect(bash('claude -p --resume p1 --fork-session "T1 lane"')).toEqual({ role: 'implementer', stage: 'build' });
  });

  it('anything else is a helper', () => {
    expect(bash('claude -p "summarise the log"')).toEqual({ role: 'headless', stage: 'none' });
    expect(AGENT_ROLES.headless.label).toBe('Helper');
  });
});

describe('resolveAgentIdentity: name keywords (L2) for general-purpose agents', () => {
  const gp = (name: string) => resolveAgentIdentity({ subagentType: 'general-purpose', name });

  it('the lens keywords come first, in review', () => {
    expect(gp('Critic pass on the plan')).toEqual({ role: 'critic', stage: 'review' });
    expect(gp('pragmatic scope check')).toEqual({ role: 'pragmatist', stage: 'review' });
    expect(gp('edge case hunt')).toEqual({ role: 'edge-cases', stage: 'review' });
    expect(gp('Security review')).toEqual({ role: 'security', stage: 'review' });
  });

  it('then validator, reviewer, builder, scout, planner', () => {
    expect(gp('Validate the build')).toEqual({ role: 'validator', stage: 'trial' });
    expect(gp('Code review of the diff')).toEqual({ role: 'reviewer', stage: 'boss' });
    expect(gp('Implement T3')).toEqual({ role: 'implementer', stage: 'build' });
    expect(gp('Wave 2 lane')).toEqual({ role: 'implementer', stage: 'build' });
    expect(gp('Build the tokens')).toEqual({ role: 'implementer', stage: 'build' });
    expect(gp('Explore the chat code')).toEqual({ role: 'explorer', stage: 'scout' });
    expect(gp('Scout the routes')).toEqual({ role: 'explorer', stage: 'scout' });
    expect(gp('Research OpenRouter pricing')).toEqual({ role: 'explorer', stage: 'scout' });
    expect(gp('Planning pass')).toEqual({ role: 'planner', stage: 'draft' });
  });

  it('the keywords read the NAME only, never the brief', () => {
    expect(resolveAgentIdentity({ subagentType: 'general-purpose', name: 'Tidy up', prompt: 'critic review' }))
      .toEqual({ role: 'agent', stage: 'none' });
  });

  it('is total: unknown or missing types are a plain teammate', () => {
    expect(gp('Summarise the notes')).toEqual({ role: 'agent', stage: 'none' });
    expect(resolveAgentIdentity({})).toEqual({ role: 'agent', stage: 'none' });
  });
});

describe('the role table', () => {
  const expected: Record<AgentRoleId, [string, string, string]> = {
    lead: [LEAD_NAME, 'face', 'neutral'],
    planner: ['Planner', 'pencil', 'maker'],
    critic: ['Critic', 'lens', 'judge'],
    pragmatist: ['Pragmatist', 'scissors', 'judge'],
    'edge-cases': ['Edge hunter', 'split', 'judge'],
    security: ['Security', 'shield', 'judge'],
    'plan-reviewer': ['Reviewer', 'lens', 'judge'],
    implementer: ['Builder', 'hammer', 'maker'],
    reviewer: ['Reviewer', 'crown', 'judge'],
    validator: ['Validator', 'scales', 'judge'],
    explorer: ['Scout', 'compass', 'neutral'],
    peer: ['Other project', 'diamond', 'neutral'],
    headless: ['Helper', 'prompt', 'neutral'],
    agent: ['Teammate', 'face', 'neutral'],
  };

  it('matches the pinned label / glyph / hue for every role', () => {
    expect(Object.keys(AGENT_ROLES).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, [label, glyph, hue]] of Object.entries(expected)) {
      const role = AGENT_ROLES[id as AgentRoleId];
      expect(role.id).toBe(id);
      expect([role.label, role.glyph, role.hue]).toEqual([label, glyph, hue]);
    }
  });

  it('the lead is Claude, everywhere', () => {
    expect(LEAD_NAME).toBe('Claude');
    expect(AGENT_ROLES.lead.label).toBe(LEAD_NAME);
  });

  it('isJudgeRole is exactly the judge hue', () => {
    const judges = (Object.keys(AGENT_ROLES) as AgentRoleId[]).filter(isJudgeRole).sort();
    expect(judges).toEqual(['critic', 'edge-cases', 'plan-reviewer', 'pragmatist', 'reviewer', 'security', 'validator']);
  });

  it('roleOf is total, and immune to prototype keys', () => {
    expect(roleOf('reviewer').id).toBe('reviewer');
    expect(roleOf('zzz').id).toBe('agent');
    expect(roleOf(undefined).id).toBe('agent');
    expect(roleOf(null).id).toBe('agent');
    expect(roleOf('constructor').id).toBe('agent');
    expect(roleOf('__proto__').id).toBe('agent');
  });

  it('roleHueVar names the token for each family', () => {
    expect(roleHueVar('maker')).toBe('--role-hue-maker');
    expect(roleHueVar('judge')).toBe('--role-hue-judge');
    expect(roleHueVar('neutral')).toBe('--role-hue-neutral');
  });

  it('STAGE_ACTS covers every party stage', () => {
    expect(Object.keys(STAGE_ACTS).sort())
      .toEqual(['ask', 'boss', 'build', 'draft', 'none', 'review', 'scout', 'task', 'trial']);
    expect(Object.keys(QUEST_STAGE_LABELS).sort()).toEqual(['ask', 'boss', 'build', 'draft', 'review', 'task', 'trial']);
  });
});

describe('copy discipline', () => {
  const copy = [
    ...Object.values(AGENT_ROLES).flatMap((r) => [r.label, r.blurb, r.noun.one, r.noun.many]),
    ...Object.values(STAGE_ACTS).flatMap((a) => [a.present, a.past]),
    ...Object.values(QUEST_STAGE_LABELS),
  ];

  it('no plumbing words, no em dash, no emoji, never "Sleepy"', () => {
    for (const text of copy) {
      expect(JARGON_RE.test(text), text).toBe(false);
      expect(text, text).not.toContain('—');
      expect(/\p{Extended_Pictographic}/u.test(text), text).toBe(false);
      expect(text, text).not.toMatch(/sleepy/i);
    }
  });
});
