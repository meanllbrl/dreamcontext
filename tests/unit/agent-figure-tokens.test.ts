/**
 * The agent figure's drawing and colour, pinned to the approved board (ajan-figur/NOT.md):
 * the 8 identity tones in BOTH theme blocks of tokens.css with the approved values, the 16
 * drawings bundled (8 shapes, a large and a small cut), painting only through `--fc-*`, and the
 * approve-filing gate of the task header.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIGURE_TONES } from '../../src/lib/agents/figure.js';
import { canApprove } from '../../dashboard/src/lib/taskObjection.js';

const ROOT = join(__dirname, '..', '..');
const TOKENS = readFileSync(join(ROOT, 'dashboard', 'src', 'styles', 'tokens.css'), 'utf-8');
const FIG_DIR = join(ROOT, 'dashboard', 'src', 'components', 'agents', 'figure');

const LIGHT: Record<string, string> = { violet: '#7b68ee', plum: '#8200a6', indigo: '#2535e2', sky: '#0091ff', teal: '#0e9a9a', coral: '#ff5b36', amber: '#e08c0c', rose: '#d63f95' };
const DARK: Record<string, string> = { violet: '#9d8cff', plum: '#c26be0', indigo: '#7280ff', sky: '#38a9ff', teal: '#22d3ee', coral: '#ff7a5c', amber: '#ffae3b', rose: '#f472b6' };

function block(start: string): string {
  const i = TOKENS.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  return TOKENS.slice(i, TOKENS.indexOf('\n}\n', i));
}

describe('agent figure tokens', () => {
  it('every tone is declared in the light and the dark block with the approved value', () => {
    const light = block(':root {');
    const dark = block("[data-theme='dark'],\n.surface-night {");
    expect([...FIGURE_TONES].sort()).toEqual(Object.keys(LIGHT).sort());
    for (const tone of FIGURE_TONES) {
      expect(light).toContain(`--agent-face-${tone}: ${LIGHT[tone]};`);
      expect(dark).toContain(`--agent-face-${tone}: ${DARK[tone]};`);
    }
  });
});

describe('agent figure drawings', () => {
  it('8 shapes, each with a large and a small cut, painting only through --fc-*', () => {
    const files = readdirSync(FIG_DIR).sort();
    const expected = Array.from({ length: 8 }, (_, i) => [`shape-${i}-24.svg`, `shape-${i}.svg`]).flat().sort();
    expect(files).toEqual(expected);
    for (const f of files) {
      const svg = readFileSync(join(FIG_DIR, f), 'utf-8');
      expect(svg).toMatch(/var\(--fc-body/);
      // Every fill is a variable (a hex appears only as its fallback); the mask is black/white.
      const paints = [...svg.matchAll(/(?:fill|stroke):([^;"]+)/g)].map((m) => m[1].trim());
      for (const paint of paints) expect(paint).toMatch(/^(none|var\(--fc-(body|facet|eye),)/);
      // The small cut drops the dream-stone (no facet).
      if (f.endsWith('-24.svg')) expect(svg).not.toContain('--fc-facet');
    }
  });
});

describe('task header: Approve', () => {
  const cancelled = (s: string) => s === 'cancelled';
  it('only on a task someone else opened, still open, not yet approved, not objected to', () => {
    expect(canApprove({ filed_by: 'agent', status: 'todo', objection: null }, cancelled)).toBe(true);
    expect(canApprove({ filed_by: 'human', status: 'todo', objection: null }, cancelled)).toBe(false);
    expect(canApprove({ filed_by: 'sleep', status: 'cancelled', objection: null }, cancelled)).toBe(false);
    expect(canApprove({ filed_by: 'plan', status: 'todo', objection: null, filing_approved: { at: '2026-10-24T09:00:00Z' } }, cancelled)).toBe(false);
    expect(canApprove({ filed_by: 'agent', status: 'todo', objection: { applied: '2026-10-24', pending: false } as never }, cancelled)).toBe(false);
  });
});
