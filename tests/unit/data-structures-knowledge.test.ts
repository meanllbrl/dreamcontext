import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateDataStructures,
  enrichDataStructuresFrontmatter,
  ensureSqlFence,
  DATA_STRUCTURES_TAGS,
} from '../../src/lib/data-structures-migration.js';
import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';

describe('ensureSqlFence', () => {
  it('wraps an unfenced -- comment body in a ```sql fence', () => {
    const body = '-- CREATE TABLE users (\n--   id UUID PRIMARY KEY\n-- );';
    const result = ensureSqlFence(body);
    expect(result).toBe('```sql\n' + body + '\n```\n');
  });

  it('is idempotent — a body already starting with ``` is returned unchanged', () => {
    const body = '```sql\n-- schema here\n```\n';
    const first = ensureSqlFence(body);
    expect(first).toBe(body);
    const second = ensureSqlFence(first);
    expect(second).toBe(body);
  });

  it('is byte-identical on double-call (no drift)', () => {
    const body = '```sql\nCREATE TABLE x (id INT);\n```\n';
    expect(ensureSqlFence(ensureSqlFence(body))).toBe(ensureSqlFence(body));
  });

  it('preserves the inner content verbatim', () => {
    const inner = '-- line one\nCREATE TABLE foo (id UUID);\n-- end';
    const result = ensureSqlFence(inner);
    expect(result).toContain(inner);
  });

  it('returns an empty body unchanged', () => {
    expect(ensureSqlFence('')).toBe('');
  });

  it('returns a whitespace-only body unchanged', () => {
    expect(ensureSqlFence('   \n  ')).toBe('   \n  ');
  });
});

describe('enrichDataStructuresFrontmatter', () => {
  it('guarantees type, product, and the standard tag set', () => {
    const out = enrichDataStructuresFrontmatter({}, 'lina');
    expect(out.type).toBe('data-structures');
    expect(out.product).toBe('lina');
    expect(out.name).toBe('lina');
    expect(out.tags).toEqual(DATA_STRUCTURES_TAGS);
  });

  it('preserves existing frontmatter and unions tags (no duplicates)', () => {
    const out = enrichDataStructuresFrontmatter(
      { name: 'Lina API', product: 'lina-api', tags: ['database', 'graphql'] },
      'lina',
    );
    expect(out.name).toBe('Lina API');
    expect(out.product).toBe('lina-api'); // existing product wins
    expect(out.tags).toContain('graphql');
    expect(out.tags).toContain('data-structures');
    expect(out.tags).toContain('schema');
    // 'database' present once, not duplicated
    expect((out.tags as string[]).filter((t) => t === 'database')).toHaveLength(1);
  });
});

describe('migrateDataStructures', () => {
  let root: string;

  function writeOld(product: string, frontmatter: string, body = 'schema here') {
    const dir = join(root, 'core', 'data-structures');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${product}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-ds-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('no-ops when the old directory is absent', () => {
    expect(migrateDataStructures(root)).toEqual({ migrated: [], skipped: [] });
  });

  it('moves core/data-structures/*.md into knowledge/data-structures/, enriched', () => {
    writeOld('default', 'name: default\ntype: data-structures\nproduct: default', 'CREATE TABLE users();');
    const result = migrateDataStructures(root);

    expect(result.migrated).toEqual(['default']);
    const dest = join(root, 'knowledge', 'data-structures', 'default.md');
    expect(existsSync(dest)).toBe(true);
    const content = readFileSync(dest, 'utf-8');
    expect(content).toContain('type: data-structures');
    expect(content).toContain('CREATE TABLE users();');
    expect(content).toContain('data-structures'); // tag
    // Body must be wrapped in a ```sql fence for dashboard highlighting
    expect(content).toContain('```sql\n');
    expect(content).toContain('\n```');
  });

  it('migrated body is ```sql-fenced', () => {
    writeOld('lina', 'name: lina', '-- some schema\nCREATE TABLE items (id UUID);');
    migrateDataStructures(root);
    const dest = join(root, 'knowledge', 'data-structures', 'lina.md');
    const content = readFileSync(dest, 'utf-8');
    // The body section (after frontmatter) must start with the sql fence
    const bodyStart = content.indexOf('\n---\n', content.indexOf('---')) + 5;
    const body = content.slice(bodyStart).trim();
    expect(body).toMatch(/^```sql\n/);
    expect(body).toMatch(/\n```\s*$/);
  });

  it('does not double-wrap a body that is already fenced', () => {
    writeOld('memoryos', 'name: memoryos', '```sql\n-- schema\n```\n');
    migrateDataStructures(root);
    const dest = join(root, 'knowledge', 'data-structures', 'memoryos.md');
    const content = readFileSync(dest, 'utf-8');
    // Should contain exactly one opening ```sql, not two
    const fenceCount = (content.match(/```sql/g) ?? []).length;
    expect(fenceCount).toBe(1);
  });

  it('leaves the old directory in place (does not delete under the user)', () => {
    writeOld('default', 'name: default');
    migrateDataStructures(root);
    expect(existsSync(join(root, 'core', 'data-structures', 'default.md'))).toBe(true);
  });

  it('is idempotent — skips files already present at the destination', () => {
    writeOld('default', 'name: default', 'v1');
    const first = migrateDataStructures(root);
    expect(first.migrated).toEqual(['default']);

    // Second run: destination exists → skipped, never overwritten.
    const second = migrateDataStructures(root);
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toEqual(['default']);
    // The destination keeps the original content (not clobbered).
    expect(readFileSync(join(root, 'knowledge', 'data-structures', 'default.md'), 'utf-8')).toContain('v1');
  });

  it('migrates multiple products', () => {
    writeOld('lina', 'name: lina');
    writeOld('memoryos', 'name: memoryos');
    const result = migrateDataStructures(root);
    expect(result.migrated.sort()).toEqual(['lina', 'memoryos']);
  });
});

describe('buildKnowledgeIndex — recursion', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-ki-'));
    const kdir = join(root, 'knowledge');
    mkdirSync(join(kdir, 'data-structures'), { recursive: true });
    mkdirSync(join(kdir, 'products'), { recursive: true });
    writeFileSync(join(kdir, 'top-level.md'), '---\nname: Top Level\n---\nbody\n', 'utf-8');
    writeFileSync(
      join(kdir, 'data-structures', 'default.md'),
      '---\nname: DS Default\ntype: data-structures\n---\nschema\n',
      'utf-8',
    );
    writeFileSync(join(kdir, 'products', 'lina.md'), '---\nname: Lina\n---\nproduct knowledge\n', 'utf-8');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('includes subdir files with subdir-qualified slugs', () => {
    const slugs = buildKnowledgeIndex(root).map((e) => e.slug).sort();
    expect(slugs).toContain('top-level');
    expect(slugs).toContain('data-structures/default');
    expect(slugs).toContain('products/lina');
  });

  it('keeps top-level slugs as bare basenames (no subdir prefix)', () => {
    const top = buildKnowledgeIndex(root).find((e) => e.slug === 'top-level');
    expect(top).toBeTruthy();
    expect(top!.name).toBe('Top Level');
  });
});
