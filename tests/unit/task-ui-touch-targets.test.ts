/**
 * At a phone's width (≤640px, the 390px proof viewport) every task-screen control a finger
 * presses is at least 44px both ways (end review, open question (c)). Desktop sizes are not
 * touched: each rule sits inside the 640px media block. A source scan: root vitest has no DOM.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', '..', 'dashboard', 'src');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf-8');

/** The bodies of every `@media (max-width: 640px)` block, joined. */
function phoneRules(css: string): string {
  const out: string[] = [];
  const re = /@media \(max-width: 640px\) \{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    out.push(css.slice(start, i - 1));
  }
  return out.join('\n');
}

/** Whether a phone rule whose selector list names `selector` sets `prop` to 44px. */
function sets(rules: string, selector: string, prop: 'min-width' | 'min-height'): boolean {
  for (const m of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (selectors.includes(selector) && new RegExp(`${prop}:\\s*var\\(--space-11\\)`).test(m[2])) return true;
  }
  return false;
}

const CASES: [string, string][] = [
  ['components/tasks/Board.css', '.bd-col-add'],
  ['components/tasks/Board.css', '.bd-rollup'],
  ['components/planning/Planning.css', '.pln-icon-btn'],
  ['components/agent-door/GiveToAgentDialog.css', '.gta-close'],
];

describe('task-screen touch targets are 44px at a phone width', () => {
  for (const [file, selector] of CASES) {
    it(`${selector} (${file})`, () => {
      const rules = phoneRules(read(file));
      expect(sets(rules, selector, 'min-height'), `${selector} min-height`).toBe(true);
      expect(sets(rules, selector, 'min-width'), `${selector} min-width`).toBe(true);
    });
  }

  it('the column "+" keeps its 24px desktop square, which the phone min-width overrides', () => {
    expect(read('components/tasks/BoardColumn.tsx')).toMatch(/className="bd-hover bd-hover-text bd-col-add"[^>]*style=\{\{ width: 24, height: 24,/);
  });
});
