/**
 * `AutomationFlowCanvas.tsx` composes `flowLayout.ts` (already covered by
 * `automations-flow-layout.test.ts`) with `FlowDiagram` (a pure SVG renderer
 * with no React-render test infra in this repo — vitest runs in `node`, no
 * jsdom). There is nothing about the component's own JSX worth pinning
 * without a DOM.
 *
 * What IS worth pinning, in plain node/fs, is the exact gap that made this
 * task risky (C10 in the plan): `FlowDiagram.tsx`'s `FlowNodeVariant` union is
 * a plain, closed list of strings, and `FlowDiagram.css` supplies each
 * variant's look via a separate `.fd-node--<variant> rect` rule that the
 * TypeScript compiler cannot check for you — nothing stops a future variant
 * from being added to the union without a matching rule, which silently
 * degrades that node to the base `.fd-node rect` look (readable, but with no
 * variant-specific signal) instead of failing a build. `region` and `plain`
 * are the two EXISTING variants that already choose to have no override (they
 * keep the shared inline gradient fill) — that is documented in the CSS
 * itself and deliberate, so this test treats them as an explicit allowlist,
 * not as evidence the check doesn't matter for every other variant.
 *
 * A source-text scan (regex over the two files) is exactly what a
 * node-environment test can honestly assert here: it needs no DOM, and it
 * would have caught the C10 gap this task exists to close (adding `'unknown'`
 * to the union with no CSS rule to back it) before it ever reached a browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FLOW_DIAGRAM_TSX = fileURLToPath(
  new URL('../../dashboard/src/components/about/FlowDiagram.tsx', import.meta.url),
);
const FLOW_DIAGRAM_CSS = fileURLToPath(
  new URL('../../dashboard/src/components/about/FlowDiagram.css', import.meta.url),
);

/** Variants that deliberately have NO dedicated `.fd-node--<variant> rect`
 *  rule — they keep the shared inline gradient fill applied to every node's
 *  `<rect>` regardless of variant. Documented in `FlowDiagram.css` itself
 *  ("region & plain variants keep the inline gradient fill — no fill set
 *  here."). Any variant NOT in this set must have its own rule. */
const NO_DEDICATED_RULE_BY_DESIGN = new Set(['region', 'plain']);

function readFlowNodeVariants(): string[] {
  const src = readFileSync(FLOW_DIAGRAM_TSX, 'utf8');
  const m = src.match(/export type FlowNodeVariant =\s*([^;]+);/);
  expect(m, 'FlowNodeVariant type alias must exist in FlowDiagram.tsx').not.toBeNull();
  const union = m![1];
  return [...union.matchAll(/'([a-z]+)'/g)].map((mm) => mm[1]);
}

function readVariantRuleBodies(): Map<string, string> {
  const css = readFileSync(FLOW_DIAGRAM_CSS, 'utf8');
  const bodies = new Map<string, string>();
  for (const m of css.matchAll(/\.fd-node--([a-z]+)\s+rect\s*\{([^}]*)\}/g)) {
    bodies.set(m[1], m[2]);
  }
  return bodies;
}

describe('FlowDiagram variant/CSS parity (the C10 gap)', () => {
  it('the FlowNodeVariant union includes the standard variants plus the additive `unknown`', () => {
    const variants = readFlowNodeVariants();
    expect(variants).toEqual(['hook', 'region', 'agent', 'rem', 'accent', 'plain', 'unknown']);
  });

  it('every variant either has a dedicated rect rule or is on the documented no-rule allowlist', () => {
    const variants = readFlowNodeVariants();
    const ruleBodies = readVariantRuleBodies();
    const uncovered = variants.filter(
      (v) => !ruleBodies.has(v) && !NO_DEDICATED_RULE_BY_DESIGN.has(v),
    );
    expect(uncovered, `variant(s) with neither a CSS rule nor an allowlist entry: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('`unknown` renders dashed, from design tokens only — never a raw hex/rgb literal', () => {
    const ruleBodies = readVariantRuleBodies();
    const body = ruleBodies.get('unknown');
    expect(body, '.fd-node--unknown rect rule must exist').toBeDefined();
    expect(body).toMatch(/stroke-dasharray\s*:/);
    expect(body).toMatch(/var\(--color-/);
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(body).not.toMatch(/rgb\(/);
  });
});
