import { describe, it } from 'vitest';

/**
 * Test-first spec for #19 — graphify coexistence.
 * https://github.com/meanllbrl/dreamcontext/issues/19
 *
 * dreamcontext stays the decisions/tasks/knowledge layer; when a Graphify
 * code-structure graph (graphify-out/graph.json) exists in the project, we
 * detect it read-only and point the agent at it for structure questions.
 * We never build, refresh, or index the graph ourselves.
 *
 * Unblock by implementing `hasCodeGraph` in src/lib/code-graph.ts and wiring
 * snapshot + doctor, then convert each it.todo to a real test.
 */

describe('hasCodeGraph detection (#19)', () => {
  it.todo('returns true for a valid graphify-out/graph.json with a nodes array');
  it.todo('returns true for a root-level graph.json fallback location');
  it.todo('returns false when no graph file exists');
  it.todo('returns false (never throws) for malformed JSON');
  it.todo('returns false for valid JSON without a nodes array (not a graph)');
});

describe('snapshot nudge (#19)', () => {
  it.todo('includes the one-line code-graph nudge when a graph is detected');
  it.todo('emits byte-identical snapshot when no graph exists (zero cost for non-users)');
  it.todo('keeps the nudge under budget demotion — it is already the cheapest tier');
});

describe('doctor info line (#19)', () => {
  it.todo('prints a code-graph info line when graph present');
  it.todo('stays silent about graphs when absent (not a failure either way)');
});

describe('explore agent routing block (#19)', () => {
  it.todo('agents/dreamcontext-explore.md contains the structure-question routing directive');
  it.todo('.codex/agents/prompts/dreamcontext-explore.md mirror stays in sync with canonical');
});
