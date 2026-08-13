/**
 * The flow interpreter — what it MEANS to "execute" a manifest's graph.
 *
 * PURE, SYNCHRONOUS, AND SPAWN-FREE. This module reads a graph and returns a
 * description of what the run should do. It starts no process, opens no socket,
 * touches no file. `runner.ts` remains the only code in this subsystem that
 * spawns `claude`.
 *
 * That is not an implementation detail, it is the security story. The graph is
 * DESCRIPTIVE OF ORCHESTRATION, NOT OF AUTHORITY: a node decides what the ONE
 * approved prompt says and which branch the runner takes, never what the run is
 * permitted to do. Because nothing here executes, an unknown node kind cannot be
 * a privilege-escalation vector — which is what makes passing it through safe
 * instead of fatal.
 *
 * ── WHAT THE RESULT ACTUALLY DRIVES
 *
 * A graph that only appended text to a free-form prompt would be indistinguish-
 * able from writing the same words into `## Prompt` prose — which is the
 * complaint this redesign exists to answer. So the result drives NAMED BRANCHES
 * in the runner, each with an observable difference:
 *
 *   - `needsHitl` ⇒ the run does NOT publish its document. It records a
 *     `flow-hitl` question and exits, leaving the watermark unadvanced so the
 *     fire is OWED rather than lost. Two runs of the same manifest, one with a
 *     `hitl` node and one without, therefore end in genuinely different states.
 *   - `reportTarget` ⇒ names where the document goes, overriding the default.
 *     A STRING ONLY — this module does no path arithmetic and performs no
 *     containment check. The runner resolves it through `resolveOutputDir`,
 *     which already refuses anything escaping the brain, so a graph cannot name
 *     its way outside no matter what it says.
 *   - `warnings` ⇒ ride `RunEvent.error` the way `degradeReason` already does,
 *     so an unrecognised node is SURFACED rather than silently absorbed.
 *
 * ── ORDER
 *
 * Fragments come out in graph order, not array order, so the prompt reads as the
 * wiring reads. Cycles are broken deterministically rather than hung on: a
 * manifest is hand-editable, and a graph that loops must still produce a run.
 */
import { nodeEntry, isKnownNodeKind } from './flow-registry.js';
import type { FlowGraph, FlowGraphNode } from './types.js';

export interface FlowExecResult {
  /** Each contributing node's prompt fragment, in execution order. */
  fragments: string[];
  /**
   * Does this graph stop and ask before its work takes effect?
   *
   * TRUE iff a `hitl` node is present. The runner branches on this; the model is
   * never the thing that decides, because a gate a model can talk itself out of
   * is not a gate.
   */
  needsHitl: boolean;
  /** The question a `hitl` node asks, for the record the runner creates. Null
   *  when the graph has no such node. */
  hitlPrompt: string | null;
  /** The `dir` a `report` node names, VERBATIM and unvalidated — the runner
   *  resolves and contains it. Null when the graph names none. */
  reportTarget: string | null;
  /** Execution order, by node id. Deterministic for a given graph. */
  order: string[];
  /** Kinds this build does not recognise, in the order encountered. Each
   *  contributed nothing and stopped nothing. */
  passedThrough: string[];
  /** Human-readable notes for `RunEvent.error` — never silently dropped. */
  warnings: string[];
}

/** A graph with no usable content still has to produce a well-formed result. */
const EMPTY: FlowExecResult = {
  fragments: [],
  needsHitl: false,
  hitlPrompt: null,
  reportTarget: null,
  order: [],
  passedThrough: [],
  warnings: [],
};

/**
 * Execution order: a topological sort, with `nodes[]` array order as the
 * tie-break so the same graph always yields the same order.
 *
 * A CYCLE DOES NOT THROW AND DOES NOT HANG. The manifest is a file a human edits
 * by hand, and a graph that loops back on itself must still run — the loop is a
 * drawing mistake, not a reason to stop a scheduled job. Nodes still unvisited
 * after the sort drains are appended in array order and reported as a warning,
 * so every node executes exactly once whatever the wiring says.
 */
function executionOrder(graph: FlowGraph): { order: FlowGraphNode[]; warnings: string[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const outgoing = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));

  for (const edge of graph.edges) {
    // `parseFlowSection` already drops dangling edges, but this module is also
    // called with hand-built graphs (tests, the creation agent) — an edge naming
    // a node that is not here must not corrupt the counts.
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // Seeded in array order, and drained from the front, so ties resolve the way
  // the author wrote them rather than by hash order.
  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: FlowGraphNode[] = [];
  const seen = new Set<string>();

  while (ready.length > 0) {
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(byId.get(id)!);
    for (const next of outgoing.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  const warnings: string[] = [];
  if (order.length < graph.nodes.length) {
    const stranded = graph.nodes.filter((n) => !seen.has(n.id));
    warnings.push(
      `flow graph has a cycle — ${stranded.length} node(s) ran in manifest order instead: ${stranded.map((n) => n.id).join(', ')}`,
    );
    order.push(...stranded);
  }

  return { order, warnings };
}

/** A node's `config.dir`, when it names one as a plain string. */
function configDir(node: FlowGraphNode): string | null {
  const dir = node.config?.dir;
  return typeof dir === 'string' && dir.trim() ? dir.trim() : null;
}

/**
 * Walk a graph and report what the run should do.
 *
 * Never throws. Every degradation is reported in `warnings` rather than raised,
 * because this runs inside a scheduled job with nobody watching: a graph problem
 * must produce a run that says what was wrong, not an automation that stops.
 */
export function executeFlow(graph: FlowGraph | null): FlowExecResult {
  if (!graph || graph.nodes.length === 0) return { ...EMPTY };

  const { order, warnings } = executionOrder(graph);
  const fragments: string[] = [];
  const passedThrough: string[] = [];
  let needsHitl = false;
  let hitlPrompt: string | null = null;
  let reportTarget: string | null = null;

  for (const node of order) {
    if (!isKnownNodeKind(node.kind)) {
      // PASS THROUGH: contributes nothing, stops nothing, and is named out loud.
      // Dropping it silently would make the run disagree with the diagram;
      // failing would make every manifest from a newer dreamcontext dead here.
      passedThrough.push(node.kind);
      warnings.push(`unknown flow node kind "${node.kind}" (${node.id}) — passed through`);
      continue;
    }

    if (node.kind === 'hitl') {
      needsHitl = true;
      // The FIRST hitl node's question is the one asked. A graph with several is
      // legal but the run stops at the first, so asking a later one's question
      // would describe a gate the run has not reached yet.
      if (hitlPrompt === null) hitlPrompt = node.label?.trim() || 'This run needs your answer before its work takes effect.';
    }

    if (node.kind === 'report' && reportTarget === null) reportTarget = configDir(node);

    const fragment = nodeEntry(node.kind).execute?.(node);
    if (fragment) fragments.push(fragment);
  }

  return {
    fragments,
    needsHitl,
    hitlPrompt,
    reportTarget,
    order: order.map((n) => n.id),
    passedThrough,
    warnings,
  };
}

/**
 * The graph's contribution to the run's prompt, as one block — or '' when it
 * contributes nothing.
 *
 * Framed as the SHAPE OF THE JOB rather than as instructions competing with the
 * approved prompt. It is ordered before the prompt in `composePrompt` for that
 * reason: this says what the steps are, the prompt says what to do, and the
 * prompt gets the last word.
 *
 * No "UNTRUSTED NOTES" framing, deliberately — unlike `## Pattern`, which the
 * run rewrites itself and nothing re-reviews, `flow` is inside the approval
 * hash. A human read these exact bytes and approved them, at the same moment and
 * over the same sha256 as `prompt` itself.
 */
export function renderFlowBlock(result: FlowExecResult): string {
  if (result.fragments.length === 0) return '';
  return ['--- THE SHAPE OF THIS JOB (from the approved flow graph) ---', ...result.fragments, '--- END SHAPE ---'].join('\n');
}
