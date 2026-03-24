import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildCoreIndex } from '../../src/lib/core-index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-cidx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('buildCoreIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when core directory does not exist', () => {
    const other = makeTmpDir();
    const entries = buildCoreIndex(other);
    expect(entries).toEqual([]);
    rmSync(other, { recursive: true, force: true });
  });

  it('returns empty array when no 3+ files exist', () => {
    writeFileSync(
      join(tmpDir, 'core', '0.soul.md'),
      '---\nname: test\ntype: soul\n---\n\nSoul content.\n',
    );
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toEqual([]);
  });

  it('does not include 0.soul, 1.user, 2.memory', () => {
    writeFileSync(join(tmpDir, 'core', '0.soul.md'), '---\nname: s\n---\n\nS\n');
    writeFileSync(join(tmpDir, 'core', '1.user.md'), '---\nname: u\n---\n\nU\n');
    writeFileSync(join(tmpDir, 'core', '2.memory.md'), '---\nname: m\n---\n\nM\n');
    writeFileSync(join(tmpDir, 'core', '3.style.md'), '---\nname: style\ntype: style\n---\n\nStyle.\n');
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('3.style.md');
  });

  it('does not include CHANGELOG.json or RELEASES.json', () => {
    writeFileSync(join(tmpDir, 'core', 'CHANGELOG.json'), '[]');
    writeFileSync(join(tmpDir, 'core', 'RELEASES.json'), '[]');
    writeFileSync(join(tmpDir, 'core', '3.style.md'), '---\nname: style\ntype: style\n---\n\nS\n');
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('3.style.md');
  });

  it('handles .json files without frontmatter parsing', () => {
    writeFileSync(join(tmpDir, 'core', '7.custom_data.json'), '[{"name":"test"}]');
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('7.custom_data.json');
    expect(entries[0].name).toBe('custom data');
    expect(entries[0].type).toBe('data');
    expect(entries[0].summary).toBe('');
    expect(entries[0].path).toBe('_dream_context/core/7.custom_data.json');
  });

  it('reads frontmatter from .md and .sql files', () => {
    writeFileSync(
      join(tmpDir, 'core', '4.tech_stack.md'),
      '---\nname: tech-stack\ntype: tech\nsummary: "Node.js + PostgreSQL"\n---\n\nNode.js\n',
    );
    writeFileSync(
      join(tmpDir, 'core', '5.data_structures.sql'),
      '---\nname: data-structures\ntype: schema\n---\n\nCREATE TABLE test();\n',
    );
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      filename: '4.tech_stack.md',
      name: 'tech-stack',
      type: 'tech',
      summary: 'Node.js + PostgreSQL',
      path: '_dream_context/core/4.tech_stack.md',
    });
    expect(entries[1]).toEqual({
      filename: '5.data_structures.sql',
      name: 'data-structures',
      type: 'schema',
      summary: '',
      path: '_dream_context/core/5.data_structures.sql',
    });
  });

  it('reads summary from frontmatter', () => {
    writeFileSync(
      join(tmpDir, 'core', '3.style.md'),
      '---\nname: style-guide\ntype: style\nsummary: "Tailwind CSS, dark theme, Inter font"\n---\n\nBranding details.\n',
    );
    const entries = buildCoreIndex(tmpDir);
    expect(entries[0].summary).toBe('Tailwind CSS, dark theme, Inter font');
  });

  it('defaults summary to empty string when missing', () => {
    writeFileSync(join(tmpDir, 'core', '3.style.md'), '---\nname: style\ntype: style\n---\n\nS\n');
    const entries = buildCoreIndex(tmpDir);
    expect(entries[0].summary).toBe('');
  });

  it('includes relative path for each entry', () => {
    writeFileSync(join(tmpDir, 'core', '3.style.md'), '---\nname: style\ntype: style\n---\n\nS\n');
    writeFileSync(join(tmpDir, 'core', '4.tech.md'), '---\nname: tech\ntype: tech\n---\n\nT\n');
    const entries = buildCoreIndex(tmpDir);
    expect(entries[0].path).toBe('_dream_context/core/3.style.md');
    expect(entries[1].path).toBe('_dream_context/core/4.tech.md');
  });

  it('sorts by filename', () => {
    writeFileSync(join(tmpDir, 'core', '5.z.md'), '---\nname: z\ntype: t\n---\n\nZ\n');
    writeFileSync(join(tmpDir, 'core', '3.a.md'), '---\nname: a\ntype: t\n---\n\nA\n');
    writeFileSync(join(tmpDir, 'core', '4.m.md'), '---\nname: m\ntype: t\n---\n\nM\n');
    const entries = buildCoreIndex(tmpDir);
    expect(entries.map(e => e.filename)).toEqual(['3.a.md', '4.m.md', '5.z.md']);
  });

  it('handles files with no frontmatter gracefully', () => {
    writeFileSync(join(tmpDir, 'core', '3.plain.md'), 'No frontmatter at all');
    const entries = buildCoreIndex(tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].filename).toBe('3.plain.md');
    expect(entries[0].path).toBe('_dream_context/core/3.plain.md');
  });
});
