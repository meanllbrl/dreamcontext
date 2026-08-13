/**
 * The flow interpreter.
 *
 * Two claims are under test and the second is what makes the first safe:
 *   1. the graph really DRIVES the run — `needsHitl` and `reportTarget` are
 *      branches with observable consequences, not decoration on a prompt;
 *   2. nothing here executes anything, so a node — known or unknown — cannot
 *      acquire a capability.
 *
 * Everything degrades toward "the run still happens, and says what was wrong".
 * A scheduled job with nobody watching must not stop over a drawing mistake.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeFlow, renderFlowBlock } from '../../src/lib/automations/flow-runner.js';
import type { FlowGraph, FlowGraphNode, FlowGraphEdge } from '../../src/lib/automations/types.js';

function graph(nodes: FlowGraphNode[], edges: FlowGraphEdge[] = []): FlowGraph {
  return { version: 'automation-flow/v1', nodes, edges };
}

const LINEAR = graph(
  [
    { id: 'trigger', kind: 'trigger', label: 'Every weekday 18:00' },
    { id: 'gather', kind: 'agent', label: "Read today's commits" },
    { id: 'ask', kind: 'hitl', label: 'Send the digest?' },
    { id: 'out', kind: 'report', label: 'Daily digest' },
  ],
  [
    { from: 'trigger', to: 'gather' },
    { from: 'gather', to: 'ask' },
    { from: 'ask', to: 'out' },
  ],
);

describe('the graph drives the run', () => {
  it('reports needsHitl when the graph has a stopping point', () => {
    const r = executeFlow(LINEAR);
    expect(r.needsHitl).toBe(true);
    expect(r.hitlPrompt).toBe('Send the digest?');
  });

  it('reports needsHitl FALSE when it does not — the two runs must differ observably', () => {
    // This is the pair that proves the graph executes rather than decorating a
    // prompt: same manifest, one node different, materially different outcome.
    const withoutAsk = graph(
      LINEAR.nodes.filter((n) => n.kind !== 'hitl'),
      [{ from: 'trigger', to: 'gather' }, { from: 'gather', to: 'out' }],
    );
    expect(executeFlow(withoutAsk).needsHitl).toBe(false);
    expect(executeFlow(withoutAsk).hitlPrompt).toBeNull();
  });

  it('asks the FIRST hitl node\'s question — the run stops before reaching a later one', () => {
    const two = graph(
      [
        { id: 'a', kind: 'hitl', label: 'First gate?' },
        { id: 'b', kind: 'hitl', label: 'Second gate?' },
      ],
      [{ from: 'a', to: 'b' }],
    );
    expect(executeFlow(two).hitlPrompt).toBe('First gate?');
  });

  it('falls back to a plain question when a hitl node has no label', () => {
    const r = executeFlow(graph([{ id: 'a', kind: 'hitl' }]));
    expect(r.needsHitl).toBe(true);
    expect(r.hitlPrompt).toBeTruthy();
  });

  it('surfaces a report node\'s dir VERBATIM, doing no path math of its own', () => {
    // Containment is the runner's job via `resolveOutputDir`. This module must
    // not "helpfully" normalise a path, or the check would run against something
    // other than what the graph actually said.
    const r = executeFlow(graph([{ id: 'out', kind: 'report', config: { dir: '../../etc' } }]));
    expect(r.reportTarget).toBe('../../etc');
  });

  it('leaves reportTarget null when the graph names none', () => {
    expect(executeFlow(LINEAR).reportTarget).toBeNull();
  });

  it('takes the FIRST report node that names a dir', () => {
    const r = executeFlow(graph([
      { id: 'a', kind: 'report', config: { dir: 'first/' } },
      { id: 'b', kind: 'report', config: { dir: 'second/' } },
    ]));
    expect(r.reportTarget).toBe('first/');
  });
});

describe('execution order follows the wiring, not the array', () => {
  it('orders by the edges when the array disagrees', () => {
    const scrambled = graph(
      [
        { id: 'out', kind: 'report' },
        { id: 'trigger', kind: 'trigger' },
        { id: 'gather', kind: 'agent' },
      ],
      [{ from: 'trigger', to: 'gather' }, { from: 'gather', to: 'out' }],
    );
    expect(executeFlow(scrambled).order).toEqual(['trigger', 'gather', 'out']);
  });

  it('is deterministic — the same graph gives byte-identical results', () => {
    expect(JSON.stringify(executeFlow(LINEAR))).toBe(JSON.stringify(executeFlow(LINEAR)));
  });

  it('breaks ties by manifest order, so parallel branches read as authored', () => {
    const fan = graph(
      [
        { id: 'root', kind: 'trigger' },
        { id: 'left', kind: 'agent', label: 'left' },
        { id: 'right', kind: 'agent', label: 'right' },
      ],
      [{ from: 'root', to: 'left' }, { from: 'root', to: 'right' }],
    );
    expect(executeFlow(fan).order).toEqual(['root', 'left', 'right']);
  });
});

describe('a broken graph still produces a run', () => {
  it('does not hang or throw on a cycle, and runs every node exactly once', () => {
    // A manifest is hand-editable. A loop is a drawing mistake, not a reason to
    // stop a scheduled job.
    const cyclic = graph(
      [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }, { id: 'c', kind: 'agent' }],
      [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }],
    );
    const r = executeFlow(cyclic);
    expect(r.order.sort()).toEqual(['a', 'b', 'c']);
    expect(r.order).toHaveLength(3);
    expect(r.warnings.join(' ')).toMatch(/cycle/i);
  });

  it('runs the acyclic part in order and appends only the stranded nodes', () => {
    const partial = graph(
      [{ id: 'start', kind: 'trigger' }, { id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    );
    const r = executeFlow(partial);
    expect(r.order[0]).toBe('start');
    expect(r.order).toHaveLength(3);
  });

  it('ignores an edge naming a node that is not in the graph', () => {
    const dangling = graph(
      [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'agent' }],
      [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'ghost', to: 'b' }],
    );
    expect(executeFlow(dangling).order).toEqual(['a', 'b']);
  });

  it('a null or empty graph is a well-formed no-op', () => {
    for (const g of [null, graph([])]) {
      const r = executeFlow(g);
      expect(r.fragments).toEqual([]);
      expect(r.needsHitl).toBe(false);
      expect(r.reportTarget).toBeNull();
      expect(r.warnings).toEqual([]);
    }
  });
});

describe('an unknown kind passes through — present, honest, and inert', () => {
  it('contributes nothing, stops nothing, and is named in the warnings', () => {
    const r = executeFlow(graph([
      { id: 'a', kind: 'agent', label: 'real step' },
      { id: 'x', kind: 'slack-post', label: 'Post to #eng' },
    ], [{ from: 'a', to: 'x' }]));
    expect(r.passedThrough).toEqual(['slack-post']);
    expect(r.warnings.join(' ')).toContain('slack-post');
    expect(r.order).toContain('x');
    expect(r.fragments.join('\n')).not.toContain('Post to #eng');
  });

  it('an unknown node can never set needsHitl — only a real hitl node gates', () => {
    // The gate is a code path, not a word. A node claiming to be a stop would
    // otherwise be able to invent one, or (worse) a renamed one could remove it.
    const r = executeFlow(graph([{ id: 'x', kind: 'hitl-ish', label: 'sort of a gate' }]));
    expect(r.needsHitl).toBe(false);
    expect(r.hitlPrompt).toBeNull();
  });

  it('does not stop the known nodes around it from contributing', () => {
    const r = executeFlow(graph([
      { id: 'x', kind: 'mystery' },
      { id: 'a', kind: 'agent', label: 'still runs' },
    ], [{ from: 'x', to: 'a' }]));
    expect(r.fragments.join('\n')).toContain('still runs');
  });

  it('is not confused by a kind that collides with an Object prototype key', () => {
    const r = executeFlow(graph([{ id: 'a', kind: 'constructor' }]));
    expect(r.passedThrough).toEqual(['constructor']);
    expect(() => executeFlow(graph([{ id: 'a', kind: 'toString' }]))).not.toThrow();
  });
});

describe('spawn-free — the property the whole design rests on', () => {
  it('imports nothing that can start a process, open a socket, or touch disk', () => {
    // Structural, the way `automations-no-auto-reap.test.ts` proves the tick
    // never imports killRunGroup. There is no spawnImpl to inject a spy into
    // precisely BECAUSE there is no spawn — so the proof has to be about the
    // source, not about a call count.
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'automations', 'flow-runner.ts'), 'utf-8');
    for (const line of src.match(/^import .*$/gm) ?? []) {
      expect(line, `flow-runner.ts must not import: ${line}`).not.toMatch(
        /node:child_process|node:fs|node:net|node:http|\.\/runner\.js|\.\/verdict\.js|\.\/store\.js/,
      );
    }
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['spawn(', 'execFile', 'exec(', 'fetch(', 'require(', 'writeFileSync', 'readFileSync']) {
      expect(code, `flow-runner.ts must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is synchronous — it returns a result, never a promise', () => {
    expect(executeFlow(LINEAR)).not.toBeInstanceOf(Promise);
  });

  it('does not mutate the graph it was given', () => {
    const before = JSON.stringify(LINEAR);
    executeFlow(LINEAR);
    expect(JSON.stringify(LINEAR)).toBe(before);
  });
});

describe('renderFlowBlock', () => {
  it('frames the graph as the SHAPE of the job, ordered before the prompt', () => {
    const block = renderFlowBlock(executeFlow(LINEAR));
    expect(block).toContain('THE SHAPE OF THIS JOB');
    expect(block).toContain("Read today's commits");
  });

  it('is empty when the graph contributes nothing, so no stray header lands', () => {
    expect(renderFlowBlock(executeFlow(graph([{ id: 't', kind: 'trigger' }])))).toBe('');
    expect(renderFlowBlock(executeFlow(null))).toBe('');
  });

  it('carries no "untrusted notes" framing — flow is inside the approval hash', () => {
    // Unlike `## Pattern`, which the run rewrites itself and nothing re-reviews,
    // these exact bytes were approved by a human over the same sha256 as the
    // prompt. Framing them as untrusted would be false, and would teach the
    // model to discount an instruction the owner deliberately wrote.
    expect(renderFlowBlock(executeFlow(LINEAR))).not.toMatch(/untrusted/i);
  });
});
