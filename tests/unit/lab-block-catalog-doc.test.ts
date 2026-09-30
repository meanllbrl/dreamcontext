/**
 * The skill's block catalog table (skill/references/tasks-and-features.md,
 * between the `block-catalog` markers) is GENERATED from the dashboard's
 * mirror of the engine catalog (dashboard/src/generated/block-catalog.json):
 * every block, every option, its values and its default. This test keeps the
 * two in lockstep, so an option added to src/lib/lab/blocks.ts without a doc
 * row fails here instead of leaving the agent blind to it.
 *
 * Regenerate after a catalog change:
 *   UPDATE_BLOCK_CATALOG_DOC=1 npx vitest run tests/unit/lab-block-catalog-doc.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const DOC = join(ROOT, 'skill/references/tasks-and-features.md');
const START = '<!-- block-catalog:start (generated from dashboard/src/generated/block-catalog.json; see tests/unit/lab-block-catalog-doc.test.ts) -->';
const END = '<!-- block-catalog:end -->';

interface CatalogOption {
  key: string;
  type: string;
  enum?: string[];
  min?: number;
  max?: number;
  default?: unknown;
  label: { en: string };
}
interface CatalogBlock {
  type: string;
  description: { en: string };
  options: CatalogOption[];
}
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'dashboard/src/generated/block-catalog.json'), 'utf-8')) as { blocks: CatalogBlock[] };

/** An option's accepted values, in words an agent can write into a board file. */
function valuesOf(o: CatalogOption): string {
  switch (o.type) {
    case 'enum': return (o.enum ?? []).map((v) => `\`${v}\``).join(', ');
    case 'boolean': return '`true`, `false`';
    case 'number': return o.min !== undefined && o.max !== undefined ? `number ${o.min} to ${o.max}` : 'number';
    case 'string': return 'text';
    case 'string-list': return 'list of names';
    case 'markdown': return 'markdown';
    case 'where': return '`{dim: [values]}`';
    case 'sort': return '`desc`, `asc` (by value), `none` (source order), a column key (`-key` descending) or `{by, dir}`';
    case 'tabs': return '`[{label, blocks: [...]}]`';
    case 'html': return 'inline HTML';
    case 'inputs': return '`{name: <binding>}`';
    default: return o.type;
  }
}

function defaultOf(o: CatalogOption): string {
  if (o.default === undefined || o.default === null || o.default === '') return 'unset';
  return `\`${String(o.default)}\``;
}

function renderCatalogTable(blocks: readonly CatalogBlock[]): string {
  const rows = ['| block | option | what it sets | values | default |', '|---|---|---|---|---|'];
  for (const b of blocks) {
    const head = `\`${b.type}\`: ${b.description.en}`;
    if (b.options.length === 0) {
      rows.push(`| ${head} | none | | | |`);
      continue;
    }
    b.options.forEach((o, i) => {
      rows.push(`| ${i === 0 ? head : ''} | \`${o.key}\` | ${o.label.en} | ${valuesOf(o)} | ${defaultOf(o)} |`);
    });
  }
  return rows.join('\n');
}

describe('skill block catalog table', () => {
  it('matches the generated catalog, option for option', () => {
    const doc = readFileSync(DOC, 'utf-8');
    const s = doc.indexOf(START);
    const e = doc.indexOf(END);
    expect(s, `tasks-and-features.md must carry the ${START} marker`).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    const expected = renderCatalogTable(CATALOG.blocks);
    if (process.env.UPDATE_BLOCK_CATALOG_DOC === '1') {
      writeFileSync(DOC, `${doc.slice(0, s + START.length)}\n${expected}\n${doc.slice(e)}`);
      return;
    }
    expect(doc.slice(s + START.length, e).trim()).toBe(expected);
  });

  it('lists every catalog option key', () => {
    const table = renderCatalogTable(CATALOG.blocks);
    for (const b of CATALOG.blocks) for (const o of b.options) expect(table).toContain(`| \`${o.key}\` |`);
  });

  it('has no em dash in the generated copy', () => {
    expect(renderCatalogTable(CATALOG.blocks)).not.toMatch(/—/);
  });
});
