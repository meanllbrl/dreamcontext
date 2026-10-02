/**
 * The block list has ONE owner: `BLOCK_TYPES` / `BLOCK_CATALOG` in
 * src/lib/lab/blocks.ts. The dashboard reads its generated mirror
 * (dashboard/src/generated/block-catalog.json) and draws every type through
 * `BLOCK_REGISTRY` (components/lab/blocks/blockRegistry.ts). The registry is a
 * `Record<BlockType, ...>`, so tsc refuses a missing component; this test adds
 * the part tsc cannot see: registry keys == generated catalog types == engine
 * catalog, each key names a component that is actually imported, and the chart
 * registry's span defaults come from the catalog instead of literals.
 *
 * Parsed as text (not imported) so the test never loads the components' CSS
 * and markdown stack, the same approach lab-render-registry.test.ts takes.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_CATALOG, BLOCK_TYPES, RENDER_DEFAULT_SPAN } from '../../src/lib/lab/blocks.js';

const DASH = join(import.meta.dirname, '../../dashboard/src');
const REGISTRY = readFileSync(join(DASH, 'components/lab/blocks/blockRegistry.ts'), 'utf-8');
const CATALOG = JSON.parse(readFileSync(join(DASH, 'generated/block-catalog.json'), 'utf-8')) as {
  types: string[];
  blocks: Array<{ type: string }>;
  renderDefaultSpan: Record<string, number>;
};

function registryEntries(): Array<[string, string]> {
  const literal = /BLOCK_REGISTRY: Record<BlockType, ComponentType<BlockViewProps>> = \{([\s\S]*?)\n\};/.exec(REGISTRY);
  expect(literal, 'blockRegistry.ts must export a BLOCK_REGISTRY object literal').toBeTruthy();
  return [...literal![1].matchAll(/^ {2}([a-z]+): (\w+),$/gm)].map((m) => [m[1], m[2]]);
}

describe('block registry == generated catalog == engine catalog', () => {
  it('registry keys are exactly the catalog types, in catalog order', () => {
    const keys = registryEntries().map(([k]) => k);
    expect(keys).toEqual([...BLOCK_TYPES]);
    expect(keys).toEqual(CATALOG.types);
    expect(CATALOG.blocks.map((b) => b.type)).toEqual([...BLOCK_TYPES]);
    expect(Object.keys(BLOCK_CATALOG).sort()).toEqual([...keys].sort());
  });

  it('every entry names a distinct component imported from its own file', () => {
    const entries = registryEntries();
    const components = entries.map(([, c]) => c);
    expect(new Set(components).size).toBe(components.length);
    for (const component of components) {
      expect(REGISTRY, `${component} must be imported`).toMatch(new RegExp(`import \\{ ${component} \\} from './${component}';`));
      expect(existsSync(join(DASH, `components/lab/blocks/${component}.tsx`)), `${component}.tsx exists`).toBe(true);
    }
  });

  it('the dashboard BlockType union lists the same types', () => {
    const types = readFileSync(join(DASH, 'components/lab/board/boardTypes.ts'), 'utf-8');
    const union = /export type BlockType =([\s\S]*?);/.exec(types);
    expect(union).toBeTruthy();
    expect([...union![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...BLOCK_TYPES]);
  });
});

describe('chart registry span defaults come from the catalog', () => {
  const chartRegistry = readFileSync(join(DASH, 'components/lab/chartRegistry.ts'), 'utf-8');

  it('reads renderDefaultSpan from the generated catalog', () => {
    expect(chartRegistry).toContain("import blockCatalog from '../../generated/block-catalog.json';");
    expect(chartRegistry).toContain('blockCatalog.renderDefaultSpan');
  });

  it('holds no literal span of its own', () => {
    expect(chartRegistry).not.toMatch(/defaultSpan: \d/);
    const spans = [...chartRegistry.matchAll(/defaultSpan: spanOf\('([a-z_]+)'\),/g)].map((m) => m[1]);
    expect(spans.sort()).toEqual(Object.keys(RENDER_DEFAULT_SPAN).sort());
  });

  it('the mirror carries the engine table', () => {
    expect(CATALOG.renderDefaultSpan).toEqual(RENDER_DEFAULT_SPAN);
  });
});
