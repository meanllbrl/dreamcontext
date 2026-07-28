import type { FlowSpec, FlowEdge } from '../about/FlowDiagram';
import { makeLink, type Box } from '../about/flow-geometry';

/**
 * Automations' signature diagram — the cadence, left-to-right, closing on itself.
 * Several manifests (each one a plain-language prompt plus a `{days, at}` schedule)
 * feed the ONE dispatcher, which wakes every five minutes and asks what is due.
 * Nothing crosses to the run until the machine-local SHA256 approval matches, so
 * the gate is drawn ON the wire, not beside it. The run is a headless
 * `claude -p` session under `bypassPermissions`; it writes a dated markdown file
 * and a notification that carries what the run actually found. What it learned
 * drops into the manifest's bounded pattern, which the NEXT run reads back as
 * untrusted notes — the dashed return wire is the loop that makes a scheduled job
 * stop repeating its mistakes.
 *
 * Distinct in shape from its two Lab siblings on purpose: Council is a round
 * table (many agents, one verdict), Lab is a straight pipe (many sources, one
 * series), Automations is a pipe that feeds back into itself (one job, every day,
 * a little better).
 *
 * Authored as data and rendered by the shared {@link FlowDiagram} engine, so it
 * animates via CSS Motion Path (compositor-friendly) and is reduced-motion safe.
 */

// Three example manifests on the left. Titles are what the job IS, subs are when
// it fires — the same two facts an automation card leads with.
const SRC_W = 126;
const SRC_H = 46;
const SOURCES: { id: string; x: number; y: number; title: string; sub: string; delay: number }[] = [
  { id: 'm1', x: 8, y: 30, title: 'digest', sub: 'daily · 18:00', delay: 0.0 },
  { id: 'm2', x: 8, y: 107, title: 'report', sub: 'fri · 17:00', delay: 0.4 },
  { id: 'm3', x: 8, y: 184, title: 'research', sub: 'tue · 09:00', delay: 0.8 },
];

// Downstream stages, authored once (x/y/w/h) — NODES and the rendered `nodes:`
// array below both derive from this, so a nudge here moves box AND wires together.
// `sub` is given as an explicit string[] wherever the line breaks are deliberate,
// which also skips the auto-wrapper (see FlowDiagram.wrapSub).
const STAGES: {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string | string[];
  variant: 'rem' | 'accent' | 'hook' | 'region';
}[] = [
  { id: 'disp', x: 174, y: 78, w: 134, h: 104, title: 'dispatcher', sub: ['↻ every 5 min', 'what’s due'], variant: 'rem' },
  // The run is the star of the diagram, so it takes the `hook` variant (accent
  // stroke + glow) rather than `agent` (flat onyx fill): the dark card reads as a
  // black slab in light mode but sinks into the stage's own dark panel at night.
  { id: 'run', x: 404, y: 82, w: 142, h: 96, title: 'claude -p', sub: ['headless session', 'bypassPermissions'], variant: 'hook' },
  { id: 'out', x: 576, y: 66, w: 118, h: 56, title: 'output.md', sub: 'dated file', variant: 'accent' },
  { id: 'note', x: 576, y: 166, w: 118, h: 56, title: 'notify', sub: ['what it found'], variant: 'accent' },
  { id: 'pat', x: 377, y: 270, w: 196, h: 58, title: 'pattern', sub: ['playbook · 20 lessons'], variant: 'region' },
];

const NODES: Record<string, Box> = {};
for (const s of SOURCES) NODES[s.id] = { cx: s.x + SRC_W / 2, cy: s.y + SRC_H / 2, w: SRC_W, h: SRC_H };
for (const s of STAGES) NODES[s.id] = { cx: s.x + s.w / 2, cy: s.y + s.h / 2, w: s.w, h: s.h };

// Directed wires A→B: edge-to-edge with arrowhead clearance (shared geometry —
// see flow-geometry.ts). Positive bow fans a wire out to one side.
const link = makeLink(NODES);

const manifests: FlowEdge[] = SOURCES.map((s, i) => ({
  id: `${s.id}-disp`,
  d: link(s.id, 'disp'),
  arrow: true,
  thin: true,
  dur: 2.4 + (i % 3) * 0.2,
  delay: (i * 0.5) % 2.4,
}));

export const AUTOMATIONS_SHOWCASE: FlowSpec = {
  // Content spans y 30..328 (centre 179) — a 358-high box centres it with an even
  // 30 units of air top and bottom.
  viewBox: '0 0 700 358',
  ariaLabel:
    'Several automation manifests — a daily digest, a Friday report, a Tuesday research run — feed one dispatcher that wakes every five minutes and asks what is due. Only an approved manifest crosses to a headless claude session, which writes a dated markdown file and a notification saying what it found, and records what it learned in a bounded pattern the next run reads back.',
  nodes: [
    ...SOURCES.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      w: SRC_W,
      h: SRC_H,
      title: s.title,
      sub: s.sub,
      variant: 'region' as const,
      breathe: true,
      breatheDelay: s.delay,
    })),
    ...STAGES,
  ],
  edges: [
    ...manifests,
    // The tripwire is a gate on the wire, not a station beside it: an unapproved
    // manifest simply never crosses this arrow.
    {
      id: 'disp-run',
      d: link('disp', 'run'),
      arrow: true,
      dur: 2.3,
      delay: 0.4,
      // The gap is 96 units wide and the rendered label ~78 — centre it, or it
      // touches the run node.
      label: { text: '✓ approved', x: 356, y: 116 },
    },
    // What a run leaves behind.
    { id: 'run-out', d: link('run', 'out', 0.06), arrow: true, dur: 2.2, delay: 1.0 },
    { id: 'run-note', d: link('run', 'note', -0.06), arrow: true, dur: 2.2, delay: 1.4 },
    // The learning loop — written after the run, read (as untrusted notes) before
    // the next one. The two arcs share a bow sign, which puts them on opposite
    // sides of the same axis and reads as one circuit.
    {
      id: 'run-pat',
      d: link('run', 'pat', 0.45),
      arrow: true,
      dur: 2.6,
      delay: 1.8,
      label: { text: 'learns', x: 423, y: 221 },
    },
    {
      id: 'pat-run',
      d: link('pat', 'run', 0.45),
      arrow: true,
      dashed: true,
      dur: 2.6,
      delay: 0.6,
      label: { text: 'reads', x: 527, y: 221 },
    },
  ],
};
