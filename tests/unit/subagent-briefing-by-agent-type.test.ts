import { describe, it, expect } from 'vitest';
import { briefingFormForAgent } from '../../src/cli/commands/snapshot.js';

/**
 * Briefing by agent type (overnight audit MM-11, wave 2): the SubagentStart
 * hook reads `agent_type` and the brain's own agents (sleep, explore, curator,
 * initializer) keep the inventory form; everything else, and a missing type,
 * gets the lean form.
 */
describe('briefingFormForAgent', () => {
  it('gives the full form to every shipped brain agent', () => {
    for (const t of [
      'sleep-tasks', 'sleep-state', 'sleep-product', 'sleep-migration', 'sleep-learn',
      'dreamcontext-explore',
      'curator-auditor', 'curator-worker', 'curator-verifier',
      'initializer-scout', 'initializer-ingestor', 'initializer-verifier',
    ]) expect(briefingFormForAgent(t), t).toBe('full');
  });

  it('gives the lean form to reviewers, goal and council agents and the generic types', () => {
    for (const t of [
      'reviewer', 'review-router', 'review-security', 'review-edge-cases', 'review-coordinator',
      'goal-planner', 'goal-implementer', 'goal-plan-reviewer', 'goal-validator',
      'council-persona', 'council-synthesizer',
      'Explore', 'general-purpose', 'Plan', 'claude', 'peer-tilki', 'deneme-rutin',
    ]) expect(briefingFormForAgent(t), t).toBe('lean');
  });

  it('is lean for a missing, empty or non-string type', () => {
    for (const t of [undefined, null, '', '   ', 42, {}, ['sleep-state']]) {
      expect(briefingFormForAgent(t)).toBe('lean');
    }
  });

  it('reads a plugin-scoped type by its last segment, case-insensitively', () => {
    expect(briefingFormForAgent('dreamcontext:sleep-state')).toBe('full');
    expect(briefingFormForAgent('  Dreamcontext-Explore ')).toBe('full');
    expect(briefingFormForAgent('plugin:reviewer')).toBe('lean');
  });

  it('does not match a bare prefix or a name that only contains one', () => {
    for (const t of ['sleep', 'sleep-', 'curator', 'my-sleep-state', 'dreamcontext-explorer', 'deep-curator-x']) {
      expect(briefingFormForAgent(t), t).toBe('lean');
    }
  });
});
