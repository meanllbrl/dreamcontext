/**
 * The node registry.
 *
 * Two properties carry the whole design and both are asserted here rather than
 * assumed: an unknown kind is a LEGAL value that degrades visibly, and nothing
 * in this module ever spawns a process. The second is what makes the first safe
 * — a node that cannot execute anything cannot acquire a capability, whatever
 * its kind claims to be.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOW_FRAGMENT_MAX_CHARS,
  NODE_REGISTRY,
  UNKNOWN_NODE_ENTRY,
  isKnownNodeKind,
  nodeEntry,
} from '../../src/lib/automations/flow-registry.js';
import { KNOWN_NODE_KINDS, type FlowGraphNode } from '../../src/lib/automations/types.js';

const node = (overrides: Partial<FlowGraphNode> = {}): FlowGraphNode => ({
  id: 'n1',
  kind: 'agent',
  ...overrides,
});

describe('the registry covers what it documents', () => {
  it('has an entry for every KNOWN_NODE_KINDS member', () => {
    // types.ts documents the shipped set for readers who never open the
    // registry; a kind named there with no entry would render as unknown, which
    // would make the documentation a lie.
    for (const kind of KNOWN_NODE_KINDS) {
      expect(isKnownNodeKind(kind)).toBe(true);
    }
  });

  it('documents every entry it has — the two lists agree in both directions', () => {
    expect(Object.keys(NODE_REGISTRY).sort()).toEqual([...KNOWN_NODE_KINDS].sort());
  });

  it('every entry has a glyph, a variant, and a describe', () => {
    for (const [kind, entry] of Object.entries(NODE_REGISTRY)) {
      expect(entry.glyph, kind).toBeTruthy();
      expect(entry.variant, kind).toBeTruthy();
      expect(entry.describe(node({ kind })), kind).toBeTruthy();
    }
  });
});

describe('an unknown kind is legal, not fatal', () => {
  it('degrades to the generic entry rather than throwing or returning undefined', () => {
    expect(nodeEntry('a-kind-that-does-not-exist')).toBe(UNKNOWN_NODE_ENTRY);
    expect(nodeEntry('').variant).toBe('unknown');
  });

  it('renders as visibly UNRECOGNISED, naming the raw kind', () => {
    // Never dropped and never rendered as something it is not: a diagram that
    // silently omits a node lies about what the automation does.
    const described = nodeEntry('slack-post').describe(node({ kind: 'slack-post', label: 'Post to #eng' }));
    expect(described).toContain('slack-post');
    expect(described).toMatch(/unrecognised/i);
  });

  it('contributes NOTHING to the prompt — the run does not guess', () => {
    expect(nodeEntry('slack-post').execute!(node({ kind: 'slack-post' }))).toBeNull();
  });

  it('is not confused by a kind that collides with an Object prototype key', () => {
    // `Record<string, …>` lookups hit the prototype chain for names like
    // `constructor` and `toString`, which would otherwise return a function
    // instead of an entry.
    for (const hostile of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(nodeEntry(hostile)).toBe(UNKNOWN_NODE_ENTRY);
      expect(isKnownNodeKind(hostile)).toBe(false);
    }
  });
});

describe('execute is spawn-free — the property the whole design rests on', () => {
  it('imports nothing that can start a process, open a socket, or touch disk', () => {
    // Asserted against the SOURCE, the way `automations-no-auto-reap.test.ts`
    // proves the tick never imports killRunGroup. There is no spawn to inject a
    // spy into precisely because there is no spawn — so the proof has to be
    // structural rather than behavioural.
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'automations', 'flow-registry.ts'),
      'utf-8',
    );
    const imports = src.match(/^import .*$/gm) ?? [];
    for (const line of imports) {
      expect(line, `flow-registry.ts must not import: ${line}`).not.toMatch(
        /node:child_process|node:fs|node:net|node:http|\.\/runner\.js|\.\/verdict\.js/,
      );
    }
    // CODE only — the module doc says "spawn" a dozen times explaining that it
    // never does, and a scan that cannot tell prose from calls would forbid
    // documenting the property it exists to enforce.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['spawn(', 'execFile', 'exec(', 'fetch(', 'require(']) {
      expect(code, `flow-registry.ts must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('every entry returns a string or null, never a promise or a process', () => {
    for (const [kind, entry] of Object.entries(NODE_REGISTRY)) {
      const out = entry.execute?.(node({ kind, label: 'x', config: { a: 1 } }));
      expect(out === null || typeof out === 'string', kind).toBe(true);
    }
  });
});

describe('fragments are bounded — they are prepended to the real job', () => {
  it('caps one node\'s fragment', () => {
    // A count cap is not a size cap: the node count is already bounded, so an
    // unbounded per-node fragment would still crowd out the actual instructions.
    const fragment = nodeEntry('agent').execute!(node({ label: 'x'.repeat(5_000) }));
    expect(fragment!.length).toBeLessThanOrEqual(FLOW_FRAGMENT_MAX_CHARS);
  });

  it('caps a large config rather than pasting it whole', () => {
    const big = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(50)]));
    const fragment = nodeEntry('connector').execute!(node({ kind: 'connector', label: 'api', config: big }));
    expect(fragment!.length).toBeLessThanOrEqual(FLOW_FRAGMENT_MAX_CHARS);
  });

  it('stringifies config rather than interpolating it, so a value cannot restructure the prompt', () => {
    const fragment = nodeEntry('agent').execute!(
      node({ label: 'step', config: { note: 'line one\nline two' } }),
    );
    expect(fragment).not.toContain('\nline two');
    expect(fragment).toContain('\\n');
  });
});

describe('describing and naming', () => {
  it('falls back to the kind when a node has no label', () => {
    expect(nodeEntry('agent').describe(node({ kind: 'agent', label: undefined }))).toContain('agent');
  });

  it('a trigger contributes nothing — the preamble already states the fire', () => {
    expect(nodeEntry('trigger').execute!(node({ kind: 'trigger', label: 'daily 18:00' }))).toBeNull();
  });

  it('a hitl node says, in words, that nothing may take effect before an answer', () => {
    const fragment = nodeEntry('hitl').execute!(node({ kind: 'hitl', label: 'Send the digest?' }))!;
    expect(fragment).toMatch(/STOP AND ASK/);
    expect(fragment).toContain('Send the digest?');
  });
});
