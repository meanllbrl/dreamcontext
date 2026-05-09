import { describe, it, expect } from 'vitest';
import {
  extractMermaidNodes,
  nodeStatus,
  countCheckboxes,
} from '../../src/lib/markdown.js';

describe('extractMermaidNodes', () => {
  it('returns [] when no mermaid block', () => {
    expect(extractMermaidNodes('# Hello\nno chart here')).toEqual([]);
  });

  it('parses simple flowchart with inline classes', () => {
    const md = `
\`\`\`mermaid
flowchart TD
  A1[First]:::done
  A2[Second]:::todo
  A1 --> A2
\`\`\`
`;
    const nodes = extractMermaidNodes(md);
    expect(nodes.map((n) => n.id).sort()).toEqual(['A1', 'A2']);
    expect(nodeStatus(nodes.find((n) => n.id === 'A1')!)).toBe('done');
    expect(nodeStatus(nodes.find((n) => n.id === 'A2')!)).toBe('todo');
  });

  it('parses subgraph + quoted labels', () => {
    const md = `
\`\`\`mermaid
flowchart TD
  subgraph M1 ["Build"]
    A1["First criterion"]:::done
    A2["Second criterion"]:::active
  end
\`\`\`
`;
    const nodes = extractMermaidNodes(md);
    expect(nodes.length).toBe(2);
    expect(nodes.find((n) => n.id === 'A1')?.label).toBe('First criterion');
  });

  it('handles separate `class` line assignments', () => {
    const md = `
\`\`\`mermaid
flowchart TD
  A1[a]
  A2[b]
  class A1,A2 done;
\`\`\`
`;
    const nodes = extractMermaidNodes(md);
    expect(nodes.every((n) => nodeStatus(n) === 'done')).toBe(true);
  });

  it('handles bare `:::class` references', () => {
    const md = `
\`\`\`mermaid
flowchart TD
  A1[a]
  A1:::blocked
\`\`\`
`;
    const nodes = extractMermaidNodes(md);
    expect(nodeStatus(nodes[0])).toBe('blocked');
  });
});

describe('countCheckboxes', () => {
  it('counts done and total', () => {
    const body = `
- [x] one
- [ ] two
- [X] three
- not a checkbox
- [ ] four
`;
    expect(countCheckboxes(body)).toEqual({ total: 4, done: 2 });
  });

  it('returns zeros for empty', () => {
    expect(countCheckboxes('')).toEqual({ total: 0, done: 0 });
  });
});
