import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Super Agent chat card's head stays one row at every width (owner 2026-10-28: the name
 * wrapped to two lines and spilled under the head's border). The rendered proof is
 * scripts/verify/super-head.mjs; this pins the rules it rests on.
 */

const CSS = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'super', 'SuperSurface.css'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the Super centre head never wraps or spills', () => {
  it('the name stays on one line and is cut with an ellipsis', () => {
    const name = rule('.super-centre-name');
    for (const decl of ['white-space: nowrap', 'text-overflow: ellipsis', 'overflow: hidden', 'min-width: 0']) expect(name).toContain(decl);
  });

  it('the subtitle only takes the space left over, so it gives way first', () => {
    expect(rule('.super-centre-sub')).toContain('flex: 1 1 0');
  });

  it('the head is a fixed-height row', () => {
    expect(rule('.super-card-large-head')).toContain('height: 40px');
  });

  it('narrow, the subtitle goes and the buttons keep only their glyph', () => {
    const queries = [...CSS.matchAll(/@container super-centre \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)].map((m) => ({ px: Number(m[1]), body: m[2] }));
    const subGone = queries.find((q) => /^\s*\.super-centre-sub \{ display: none; \}/.test(q.body));
    const labelGone = queries.find((q) => /^\s*\.super-fresh-btn \{[^}]*\}\s*\.super-fresh-btn-label \{ display: none; \}/.test(q.body));
    expect(subGone && labelGone).toBeTruthy();
    expect(subGone!.px).toBeGreaterThan(labelGone!.px);
  });
});
