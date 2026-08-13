/**
 * The node registry — the ONE place a flow-graph node kind is wired up.
 *
 * An entry says three things about a kind: how it DRAWS (glyph + variant), how
 * it READS to a human (`describe`), and what it contributes to the run's prompt
 * (`execute`). Adding a connector is adding a key here; no runner edit, no
 * canvas edit, no union to widen.
 *
 * ── AN OPEN RECORD, AND WHY THAT DIFFERS FROM `chartRegistry.ts` ON PURPOSE
 *
 * `dashboard/src/components/lab/chartRegistry.ts` is a `Record<Render, …>`,
 * which deliberately WILL NOT COMPILE without an entry for every render. That is
 * right for charts: a fixed, curated set the dashboard is responsible for
 * drawing, where a missing entry is a bug caught at build time.
 *
 * This registry is the opposite case and is `Record<string, …>` on purpose. The
 * requirement is lego: adding a new MCP-tool / API / chat connector must never
 * mean editing a union in this repo and recompiling the world. So an unknown
 * kind is a LEGAL value, `nodeEntry` degrades to a generic entry the way
 * `chartEntry` degrades to `number`, and the node renders as visibly
 * unrecognised rather than being dropped or fatal.
 *
 * DO NOT "fix" this back to a closed record. Dropping an unknown node would make
 * the diagram LIE about what the automation does — the exact failure this
 * redesign exists to correct. Failing the run instead would make every manifest
 * written by a newer dreamcontext dead on arrival on an older one.
 *
 * ── `execute` NEVER SPAWNS ANYTHING
 *
 * The single most important line in this file. `execute` returns a TEXT
 * FRAGMENT, and `flow-runner.ts` folds the fragments into the ONE prompt sent by
 * the ONE spawn in `runner.ts`. Nothing here starts a process, opens a socket,
 * or touches the filesystem.
 *
 * That is what makes the whole "unknown kinds pass through" story safe: a node
 * cannot acquire a capability, because no node executes anything. The graph is
 * descriptive of ORCHESTRATION, not of AUTHORITY — the approved prompt and the
 * approval hash still decide what the run may do. If a future entry ever does
 * need to reach a process, it passes `config` values as ARGV ELEMENTS, never
 * interpolated into a shell string.
 *
 * `config` needs no "UNTRUSTED NOTES" framing the way `## Pattern` does, and the
 * distinction is worth stating: the pattern is rewritten by the run itself and
 * re-read unreviewed, whereas `flow` is inside the approval hash — a `config`
 * value is reviewed by the same human, at the same moment, over the same sha256
 * as `prompt` itself.
 */
import { FLOW_LABEL_MAX_CHARS, type FlowGraphNode } from './types.js';

/**
 * Ceiling on ONE node's prompt fragment.
 *
 * The same rule the pattern caps exist for: this text is prepended to the job's
 * actual instructions, and a graph with two dozen verbose nodes would crowd out
 * the work the run was asked to do. A count cap is not a size cap — the node
 * count is already bounded, so the per-node SIZE has to be bounded too.
 */
export const FLOW_FRAGMENT_MAX_CHARS = 400;

/** How a kind draws, reads, and contributes. */
export interface FlowNodeEntry {
  /** Drawn in the node box. One character — this is a diagram, not a legend. */
  glyph: string;
  /**
   * Maps to `FlowDiagram`'s node variant on the dashboard side. A plain string
   * rather than that union because `src/` has no import path into `dashboard/`
   * (and vice versa) — the same hand-mirroring `useAutomations.ts` does for
   * every other shared shape.
   */
  variant: string;
  /** One line naming what this node IS, for a card, a log line, or a tooltip. */
  describe(node: FlowGraphNode): string;
  /**
   * This node's contribution to the run's prompt, or null when it contributes
   * nothing. NEVER spawns — see the module doc.
   */
  execute?(node: FlowGraphNode): string | null;
}

/** A node's human name: its label, else its kind. A node is always nameable. */
function nameOf(node: FlowGraphNode): string {
  return node.label?.trim() || node.kind;
}

/** Render `config` as compact, bounded JSON. Stringified rather than
 *  interpolated so a value containing braces or newlines cannot restructure the
 *  prompt around it. */
function configFragment(node: FlowGraphNode): string {
  if (!node.config || Object.keys(node.config).length === 0) return '';
  const json = JSON.stringify(node.config);
  return json.length <= FLOW_LABEL_MAX_CHARS ? ` (${json})` : ` (${json.slice(0, FLOW_LABEL_MAX_CHARS - 1)}…)`;
}

function bound(fragment: string): string {
  const t = fragment.trim();
  if (!t) return '';
  return t.length <= FLOW_FRAGMENT_MAX_CHARS ? t : `${t.slice(0, FLOW_FRAGMENT_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * The kinds this build recognises. An OPEN record — see the module doc. Every
 * key here is also in `KNOWN_NODE_KINDS` (types.ts), which documents the same
 * set for readers who never open this file.
 */
export const NODE_REGISTRY: Record<string, FlowNodeEntry> = {
  trigger: {
    glyph: '⏱',
    variant: 'rem',
    describe: (n) => `Fires: ${nameOf(n)}`,
    // Contributes nothing. The trigger is WHY the run started, not something the
    // run has to be told to do — and the preamble already states the fire time.
    execute: () => null,
  },
  agent: {
    glyph: '◆',
    variant: 'hook',
    describe: (n) => `Step: ${nameOf(n)}`,
    execute: (n) => bound(`- ${nameOf(n)}${configFragment(n)}`),
  },
  connector: {
    glyph: '⚯',
    variant: 'accent',
    describe: (n) => `Uses: ${nameOf(n)}`,
    execute: (n) => bound(`- You may use ${nameOf(n)}${configFragment(n)} for this job.`),
  },
  branch: {
    glyph: '⑂',
    variant: 'region',
    describe: (n) => `Decides: ${nameOf(n)}`,
    execute: (n) => bound(`- Decide: ${nameOf(n)}${configFragment(n)}`),
  },
  hitl: {
    glyph: '✋',
    variant: 'accent',
    describe: (n) => `Asks: ${nameOf(n)}`,
    // The fragment tells the run what the STOP means. Whether the run actually
    // stops is not decided here — `flow-runner.ts` reports the presence of this
    // kind and `runner.ts` takes the branch, so the gate is a code path rather
    // than a sentence the model has to obey.
    execute: (n) =>
      bound(
        `- STOP AND ASK before this takes effect: ${nameOf(n)}${configFragment(n)}. ` +
        'Do not publish or send anything until a human answers.',
      ),
  },
  report: {
    glyph: '▤',
    variant: 'accent',
    describe: (n) => `Reports to: ${nameOf(n)}`,
    execute: (n) => bound(`- The result goes to ${nameOf(n)}${configFragment(n)}.`),
  },
};

/**
 * The generic entry for a kind this build does not know.
 *
 * Rendered as visibly UNRECOGNISED — dashed, with the raw kind shown — rather
 * than as something it is not, and it contributes NOTHING to the prompt. The
 * node is present and honest in the picture; the run simply does not act on it.
 */
export const UNKNOWN_NODE_ENTRY: FlowNodeEntry = {
  glyph: '◇',
  variant: 'unknown',
  describe: (n) => `Unrecognised node "${n.kind}"${n.label ? ` — ${n.label}` : ''}`,
  execute: () => null,
};

/**
 * The entry for a node kind. An unknown kind falls back to
 * {@link UNKNOWN_NODE_ENTRY} — mirroring `chartEntry(render)`'s degradation, but
 * over an open map (see the module doc for why the difference is deliberate).
 *
 * OWN properties only. `kind` is a free string read off a manifest, so it can be
 * `constructor`, `toString`, or any other name that lives on `Object.prototype`
 * — and a plain `NODE_REGISTRY[kind]` would return a FUNCTION for those, which
 * is truthy, so `??` would never reach the fallback and the caller would get an
 * "entry" with no `describe` to call. `chartRegistry` is not exposed to this
 * because its key type is a closed union; an open record has to check.
 */
export function nodeEntry(kind: string): FlowNodeEntry {
  return isKnownNodeKind(kind) ? NODE_REGISTRY[kind] : UNKNOWN_NODE_ENTRY;
}

/** Is this a kind this build actually recognises? For a renderer that wants to
 *  mark an unknown node, and for the runner's "passed through" warning.
 *  `hasOwnProperty`, not `in`, for the prototype-chain reason above. */
export function isKnownNodeKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(NODE_REGISTRY, kind);
}
