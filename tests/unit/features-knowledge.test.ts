import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateFeaturesToKnowledge,
  enrichFeatureFrontmatter,
} from '../../src/lib/features-migration.js';
import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { buildCorpus } from '../../src/lib/recall.js';

describe('enrichFeatureFrontmatter', () => {
  it('adds type, name, pinned, and date on bare frontmatter', () => {
    const out = enrichFeatureFrontmatter({}, 'my-feature');
    expect(out.type).toBe('feature');
    expect(out.name).toBe('my-feature');
    expect(out.description).toBe('');
    expect(out.pinned).toBe(false);
    expect(out.date).toBeTruthy();
  });

  it('preserves status/progress/released_version/related_tasks/id/created/updated/tags', () => {
    const src = {
      id: 'feat_abc123',
      status: 'in_progress',
      progress: 42,
      released_version: '0.9.0',
      related_tasks: ['some-task'],
      created: '2026-01-01',
      updated: '2026-02-02',
      tags: ['domain:foo'],
    };
    const out = enrichFeatureFrontmatter(src, 'my-feature');
    expect(out.id).toBe('feat_abc123');
    expect(out.status).toBe('in_progress');
    expect(out.progress).toBe(42);
    expect(out.released_version).toBe('0.9.0');
    expect(out.related_tasks).toEqual(['some-task']);
    expect(out.created).toBe('2026-01-01');
    expect(out.updated).toBe('2026-02-02');
    expect(out.tags).toEqual(['domain:foo']);
  });

  it('existing name/description win over the slug default', () => {
    const out = enrichFeatureFrontmatter({ name: 'Custom Name', description: 'Custom desc' }, 'my-feature');
    expect(out.name).toBe('Custom Name');
    expect(out.description).toBe('Custom desc');
  });

  it('pinned is ALWAYS forced false, even if source had pinned: true', () => {
    const out = enrichFeatureFrontmatter({ pinned: true }, 'my-feature');
    expect(out.pinned).toBe(false);
  });

  it('date falls back to created, then today()', () => {
    const withCreated = enrichFeatureFrontmatter({ created: '2025-05-05' }, 'x');
    expect(withCreated.date).toBe('2025-05-05');
    const withNothing = enrichFeatureFrontmatter({}, 'x');
    expect(withNothing.date).toBeTruthy();
  });
});

describe('migrateFeaturesToKnowledge — branch table (N/T/D/E/S)', () => {
  let root: string;

  function writeSource(slug: string, frontmatter: string, body = 'PRD body here') {
    const dir = join(root, 'core', 'features');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  }

  function writeDest(slug: string, frontmatter: string, body: string) {
    const dir = join(root, 'knowledge', 'features');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  }

  function sourcePath(slug: string): string {
    return join(root, 'core', 'features', `${slug}.md`);
  }
  function destPath(slug: string): string {
    return join(root, 'knowledge', 'features', `${slug}.md`);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-feat-'));
  });
  afterEach(() => {
    // Undo any permission lockdown from the transient-failure test so cleanup never fails.
    const lockedDir = join(root, 'knowledge', 'features');
    try { chmodSync(lockedDir, 0o755); } catch { /* may not exist */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('no-ops when core/features/ is absent', () => {
    expect(migrateFeaturesToKnowledge(root)).toEqual({ migrated: [], skipped: [], failed: [] });
  });

  it('knowledge/features existing as a regular FILE: never throws, reports failed, touches no source', () => {
    writeSource('foo', 'id: feat_1', 'Body.');
    // Pre-create the destination PARENT as a plain file, not a directory — mkdirSync
    // (recursive) throws ENOTDIR/EEXIST in this case.
    mkdirSync(join(root, 'knowledge'), { recursive: true });
    writeFileSync(join(root, 'knowledge', 'features'), 'I am a file, not a directory.', 'utf-8');

    expect(() => migrateFeaturesToKnowledge(root)).not.toThrow();
    const result = migrateFeaturesToKnowledge(root);

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/cannot create knowledge\/features/);
    // Source untouched.
    expect(existsSync(sourcePath('foo'))).toBe(true);
    expect(readFileSync(join(root, 'knowledge', 'features'), 'utf-8')).toBe('I am a file, not a directory.');
  });

  // ── Case N: no dest ──────────────────────────────────────────────────────
  it('case N — no dest: writes enriched dest, unlinks source, removes empty old dir', () => {
    writeSource('foo', 'id: feat_1\nstatus: planning', 'Body content here.');
    const result = migrateFeaturesToKnowledge(root);

    expect(result.migrated).toEqual(['foo']);
    expect(result.failed).toEqual([]);
    expect(existsSync(destPath('foo'))).toBe(true);
    expect(existsSync(sourcePath('foo'))).toBe(false);
    expect(existsSync(join(root, 'core', 'features'))).toBe(false);

    const content = readFileSync(destPath('foo'), 'utf-8');
    expect(content).toContain('type: feature');
    expect(content).toContain('Body content here.');
  });

  it('slug (basename) is preserved unchanged', () => {
    writeSource('my-weird-slug-42', 'id: feat_2', 'body');
    migrateFeaturesToKnowledge(root);
    expect(existsSync(join(root, 'knowledge', 'features', 'my-weird-slug-42.md'))).toBe(true);
  });

  it('migrates multiple features in one run', () => {
    writeSource('alpha', 'id: feat_a', 'alpha body');
    writeSource('beta', 'id: feat_b', 'beta body');
    const result = migrateFeaturesToKnowledge(root);
    expect(result.migrated.sort()).toEqual(['alpha', 'beta']);
  });

  // ── Case T: torn/unparseable dest ────────────────────────────────────────
  it('case T — torn dest: failed, both files preserved, dest never overwritten', () => {
    writeSource('foo', 'id: feat_1', 'Body content here.');
    // Invalid YAML frontmatter — gray-matter/js-yaml throws on parse.
    mkdirSync(join(root, 'knowledge', 'features'), { recursive: true });
    writeFileSync(
      destPath('foo'),
      '---\ntype: feature\n  bad indent: [unclosed\n---\n\nsome dest body\n',
      'utf-8',
    );
    const before = readFileSync(destPath('foo'), 'utf-8');

    const result = migrateFeaturesToKnowledge(root);

    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].slug).toBe('foo');
    expect(result.failed[0].error).toMatch(/torn/);
    expect(existsSync(sourcePath('foo'))).toBe(true);
    expect(readFileSync(destPath('foo'), 'utf-8')).toBe(before);
    // Old dir survives — nothing to unlink safely.
    expect(existsSync(join(root, 'core', 'features'))).toBe(true);
  });

  // ── Case D: divergent body ───────────────────────────────────────────────
  it('case D — divergent dest body: failed on every run, never clobbers either side', () => {
    writeSource('foo', 'id: feat_1\ntype: feature', 'SOURCE body — version A.');
    writeDest('foo', 'id: feat_1\ntype: feature\nname: foo\npinned: false\ndate: "2026-01-01"', 'DEST body — version B (different!).');

    const result1 = migrateFeaturesToKnowledge(root);
    expect(result1.migrated).toEqual([]);
    expect(result1.skipped).toEqual([]);
    expect(result1.failed).toHaveLength(1);
    expect(result1.failed[0].error).toMatch(/divergent/);
    expect(existsSync(sourcePath('foo'))).toBe(true);
    expect(readFileSync(destPath('foo'), 'utf-8')).toContain('version B');

    // Re-run: still failed, never self-heals, never clobbers.
    const result2 = migrateFeaturesToKnowledge(root);
    expect(result2.failed).toHaveLength(1);
    expect(result2.failed[0].error).toMatch(/divergent/);
    expect(existsSync(sourcePath('foo'))).toBe(true);
    expect(readFileSync(destPath('foo'), 'utf-8')).toContain('version B');
    expect(readFileSync(sourcePath('foo'), 'utf-8')).toContain('version A');
  });

  // ── Case E: body matches, under-enriched frontmatter ─────────────────────
  it('case E — under-enriched dest (correct body, missing type:feature): re-enriches in ONE run and unlinks source', () => {
    writeSource('foo', 'id: feat_1\nstatus: active', 'Matching body content.');
    // Dest has the SAME parsed body but is missing the knowledge contract fields.
    writeDest('foo', 'id: feat_1\nstatus: active', 'Matching body content.');

    const result = migrateFeaturesToKnowledge(root);

    expect(result.failed).toEqual([]);
    expect(result.migrated).toEqual(['foo']);
    expect(existsSync(sourcePath('foo'))).toBe(false);

    const content = readFileSync(destPath('foo'), 'utf-8');
    expect(content).toContain('type: feature');
    expect(content).toContain('pinned: false');
    expect(content).toContain('Matching body content.');
  });

  it('case E never touches the body — only frontmatter is re-enriched', () => {
    writeSource('foo', 'id: feat_1', 'Exact body.\n\nMultiple lines.');
    writeDest('foo', 'id: feat_1', 'Exact body.\n\nMultiple lines.');
    migrateFeaturesToKnowledge(root);
    const content = readFileSync(destPath('foo'), 'utf-8');
    expect(content).toContain('Exact body.\n\nMultiple lines.');
  });

  // ── Case S: fully valid dest already ─────────────────────────────────────
  it('case S — fully valid dest: skipped, source unlinked, dest untouched (byte-identical)', () => {
    const destFrontmatter = 'id: feat_1\ntype: feature\nname: foo\ndescription: ""\npinned: false\ndate: "2026-01-01"\nstatus: shipped';
    writeSource('foo', 'id: feat_1\nstatus: shipped', 'Shared body.');
    writeDest('foo', destFrontmatter, 'Shared body.');
    const before = readFileSync(destPath('foo'), 'utf-8');

    const result = migrateFeaturesToKnowledge(root);

    expect(result.failed).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.skipped).toEqual(['foo']);
    expect(existsSync(sourcePath('foo'))).toBe(false);
    expect(readFileSync(destPath('foo'), 'utf-8')).toBe(before);
  });

  it('idempotent — a second run after a clean migration returns all-empty', () => {
    writeSource('foo', 'id: feat_1', 'Body.');
    const first = migrateFeaturesToKnowledge(root);
    expect(first.migrated).toEqual(['foo']);

    const second = migrateFeaturesToKnowledge(root);
    expect(second).toEqual({ migrated: [], skipped: [], failed: [] });
  });

  it('phase 1 sweeps stray *.tmp files in knowledge/features/ before writing', () => {
    writeSource('foo', 'id: feat_1', 'Body.');
    const destDir = join(root, 'knowledge', 'features');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'stray.tmp'), 'leftover from a crashed run', 'utf-8');

    migrateFeaturesToKnowledge(root);
    expect(existsSync(join(destDir, 'stray.tmp'))).toBe(false);
  });

  // ── Transient failure: write throws, both files preserved, retry succeeds ──
  it('transient write failure (case N): failed, both files preserved; a retry after the fault clears succeeds', () => {
    writeSource('foo', 'id: feat_1', 'Body.');
    const destDir = join(root, 'knowledge', 'features');
    mkdirSync(destDir, { recursive: true });
    // Make the destination directory read-only so the atomic tmp-write throws (EACCES).
    chmodSync(destDir, 0o555);

    let result;
    try {
      result = migrateFeaturesToKnowledge(root);
    } finally {
      chmodSync(destDir, 0o755); // restore before any assertion that touches the fs again
    }

    expect(result!.migrated).toEqual([]);
    expect(result!.failed).toHaveLength(1);
    expect(result!.failed[0].slug).toBe('foo');
    expect(existsSync(sourcePath('foo'))).toBe(true);

    // Retry with the fault cleared — legitimately different inputs between runs.
    const retry = migrateFeaturesToKnowledge(root);
    expect(retry.migrated).toEqual(['foo']);
    expect(retry.failed).toEqual([]);
    expect(existsSync(sourcePath('foo'))).toBe(false);
  });
});

describe('buildKnowledgeIndex excludes knowledge/features/', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-feat-ki-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a migrated feature under knowledge/features/ never appears in the knowledge index', () => {
    const kdir = join(root, 'knowledge');
    mkdirSync(join(kdir, 'features'), { recursive: true });
    writeFileSync(join(kdir, 'top-level.md'), '---\nname: Top Level\n---\nbody\n', 'utf-8');
    writeFileSync(
      join(kdir, 'features', 'my-feature.md'),
      '---\nname: My Feature\ntype: feature\npinned: false\ndate: "2026-01-01"\n---\nPRD body\n',
      'utf-8',
    );

    const slugs = buildKnowledgeIndex(root).map((e) => e.slug);
    expect(slugs).toContain('top-level');
    expect(slugs).not.toContain('features/my-feature');
  });

  it('includeFeatures: true opts features/ in, carrying frontmatter type/status (dashboard Knowledge page)', () => {
    const kdir = join(root, 'knowledge');
    mkdirSync(join(kdir, 'features'), { recursive: true });
    writeFileSync(join(kdir, 'top-level.md'), '---\nname: Top Level\n---\nbody\n', 'utf-8');
    writeFileSync(
      join(kdir, 'features', 'my-feature.md'),
      '---\nname: My Feature\ntype: feature\nstatus: active\npinned: false\ndate: "2026-01-01"\n---\nPRD body\n',
      'utf-8',
    );

    const entries = buildKnowledgeIndex(root, { includeFeatures: true });
    const feature = entries.find((e) => e.slug === 'features/my-feature');
    expect(feature).toBeDefined();
    expect(feature?.type).toBe('feature');
    expect(feature?.status).toBe('active');
    // Plain knowledge carries no type/status.
    const plain = entries.find((e) => e.slug === 'top-level');
    expect(plain?.type).toBeUndefined();
    expect(plain?.status).toBeUndefined();
  });
});

describe('buildCorpus — feature/knowledge single-counting', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dc-feat-corpus-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a migrated feature loads as type feature, not double-counted as knowledge', () => {
    const kdir = join(root, 'knowledge');
    mkdirSync(join(kdir, 'features'), { recursive: true });
    writeFileSync(
      join(kdir, 'features', 'my-feature.md'),
      '---\nname: My Feature\ntype: feature\npinned: false\ndate: "2026-01-01"\n---\nPRD body about widgets\n',
      'utf-8',
    );
    writeFileSync(join(kdir, 'other.md'), '---\nname: Other\n---\nunrelated knowledge\n', 'utf-8');

    const featureDocs = buildCorpus(root, { types: ['feature'] });
    expect(featureDocs.some((d) => d.type === 'feature' && d.slug === 'my-feature')).toBe(true);

    const knowledgeDocs = buildCorpus(root, { types: ['knowledge'] });
    expect(knowledgeDocs.some((d) => d.slug === 'my-feature')).toBe(false);
    expect(knowledgeDocs.some((d) => d.slug === 'other')).toBe(true);

    const both = buildCorpus(root, { types: ['feature', 'knowledge'] });
    const featureHits = both.filter((d) => d.slug === 'my-feature');
    expect(featureHits).toHaveLength(1);
    expect(featureHits[0].type).toBe('feature');
  });
});
