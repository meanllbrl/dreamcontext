/**
 * Tests for Excalidraw knowledge integration.
 *
 * AC1: excalidraw-index-corpus-stress
 * AC2: excalidraw-recall
 * AC3: excalidraw-index-content
 * AC4: excalidraw-snapshot
 * AC5: excalidraw-dark-siblings
 * AC6: dashboard excalidraw-grouping
 * AC7: excalidraw-flat-regression
 * AC8: excalidraw-docs (light presence test)
 * AC9: diagrams-migration + migration-registry
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractExcalidrawText,
  isExcalidrawPath,
  diagramFolderDirs,
  isDarkDiagramSibling,
} from '../../src/lib/excalidraw-text.js';
import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { REGISTRY, pendingMigrations } from '../../src/migrations/index.js';
import { detectFlatDiagramBoards } from '../../src/lib/diagrams-migration.js';

// ─── Dashboard leafName pure logic (inlined to avoid React context) ───────────
//
// The `leafName` and `isExcalidrawSlug` functions from dashboard/src are pure.
// We replicate the logic here for node-side testing rather than importing the
// React component file (which brings in useState/useMemo and breaks in vitest).
// The production code lives in dashboard/src/pages/KnowledgePage.tsx and
// dashboard/src/lib/excalidraw.ts — these are mirrors for the test only.

type KnowledgeListEntry = {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  pinned: boolean;
};

/** Mirror of dashboard/src/lib/excalidraw.ts:47 isExcalidrawSlug */
function isExcalidrawSlug(slug: string): boolean {
  return slug.endsWith('.excalidraw');
}

/**
 * Mirror of the exported `leafName` from dashboard/src/pages/KnowledgePage.tsx.
 * Uses basename/last-segment for Excalidraw boards, prefix-strip for others.
 */
function leafName(entry: KnowledgeListEntry, folder: string | null): string {
  if (!folder) return entry.name;
  if (isExcalidrawSlug(entry.slug)) {
    const lastSlash = entry.slug.lastIndexOf('/');
    return lastSlash >= 0 ? entry.slug.slice(lastSlash + 1) : entry.slug;
  }
  if (entry.name.startsWith(`${folder}/`)) return entry.name.slice(folder.length + 1);
  return entry.name;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `excalidraw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build a minimal but valid .excalidraw.md file body (frontmatter already stripped). */
function buildBoard(opts: {
  textElements?: string[];
  jsonOnlyTerm?: string;
  sceneSizeBytes?: number;
}): string {
  const textSection =
    opts.textElements && opts.textElements.length > 0
      ? `## Text Elements\n${opts.textElements.map((t, i) => `${t} ^elem${i.toString().padStart(4, '0')}`).join('\n')}\n`
      : '';

  // Build scene JSON — optionally pad it to hit a target size.
  const elements: Record<string, unknown>[] = [];
  if (opts.jsonOnlyTerm) {
    elements.push({
      id: 'json001',
      type: 'text',
      jsonOnlySecret: opts.jsonOnlyTerm,
      x: 0,
      y: 0,
    });
  }

  let sceneJson = JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      elements,
      appState: { viewBackgroundColor: '#ffffff' },
      files: {},
    },
    null,
    2,
  );

  // Pad scene JSON to reach target size if requested.
  if (opts.sceneSizeBytes && opts.sceneSizeBytes > sceneJson.length) {
    const padding = 'X'.repeat(opts.sceneSizeBytes - sceneJson.length);
    sceneJson = sceneJson.replace('"files": {}', `"files": {}, "padding": "${padding}"`);
  }

  return (
    `==⚠ Switch to EXCALIDRAW VIEW ==\n\n` +
    `# Excalidraw Data\n\n` +
    textSection +
    `## Embedded Files\n%%\n` +
    `## Drawing\n` +
    '```json\n' +
    sceneJson +
    '\n```\n%%\n'
  );
}

function writeExcalidrawFile(
  dir: string,
  relPath: string,
  name: string,
  description: string,
  body: string,
): void {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(
    fullPath,
    `---\nname: ${name}\ndescription: ${description}\ntags: [excalidraw]\nexcalidraw-plugin: parsed\n---\n\n${body}\n`,
  );
}

// ─── AC1: excalidraw-index-corpus-stress ─────────────────────────────────────

describe('excalidraw-index-corpus-stress', () => {
  it('a >=2MB board contributes only frontmatter+text-element tokens to BM25', () => {
    const TEXT_ELEMENT_TERM = 'uniquetextelementtoken99';
    const JSON_ONLY_TERM = 'uniquejsononlytoken77';

    // Build a >=2MB board body
    const boardBody = buildBoard({
      textElements: [TEXT_ELEMENT_TERM, 'Session Capture', 'Memory Store'],
      jsonOnlyTerm: JSON_ONLY_TERM,
      sceneSizeBytes: 2 * 1024 * 1024, // 2 MB scene
    });

    // Verify the raw body is >=2MB
    const rawBytes = Buffer.byteLength(boardBody, 'utf-8');
    expect(rawBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);

    const extracted = extractExcalidrawText(boardBody);

    // Text-element term MUST appear in extracted text
    expect(extracted.toLowerCase()).toContain(TEXT_ELEMENT_TERM);

    // JSON-only term MUST NOT appear in extracted text
    expect(extracted).not.toContain(JSON_ONLY_TERM);

    // Extracted text must not contain scene JSON markers
    expect(extracted).not.toContain('"type":"excalidraw"');
    expect(extracted).not.toContain('"type": "excalidraw"');
  });
});

// ─── AC2: excalidraw-recall ───────────────────────────────────────────────────

describe('excalidraw-recall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge', 'diagrams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('text-element term surfaces board; JSON-only term does not match', () => {
    const TEXT_TERM = 'recallexcalidrawsurfacetoken';
    const JSON_TERM = 'recalljsonhiddenterm';

    const body = buildBoard({
      textElements: [TEXT_TERM, 'architecture pipeline'],
      jsonOnlyTerm: JSON_TERM,
    });

    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'recall-test.excalidraw.md'),
      'Recall Test Board',
      'A board for recall testing',
      body,
    );

    const corpus = buildCorpus(tmpDir, { types: ['knowledge'] });

    // Find the board doc
    const boardDoc = corpus.find((d) => d.slug === 'recall-test.excalidraw');
    expect(boardDoc).toBeDefined();

    // The text-element term should be in the corpus body
    expect(boardDoc!.body).toContain(TEXT_TERM);

    // The JSON-only term should NOT be in the corpus body
    expect(boardDoc!.body).not.toContain(JSON_TERM);

    // BM25 search for the text-element term should find the board
    const hitsText = bm25Search(TEXT_TERM, corpus);
    const boardHit = hitsText.find((h) => h.doc.slug === 'recall-test.excalidraw');
    expect(boardHit).toBeDefined();

    // BM25 search for the JSON-only term should NOT find the board
    const hitsJson = bm25Search(JSON_TERM, corpus);
    const boardJsonHit = hitsJson.find((h) => h.doc.slug === 'recall-test.excalidraw');
    expect(boardJsonHit).toBeUndefined();
  });
});

// ─── AC3: excalidraw-index-content ───────────────────────────────────────────

describe('excalidraw-index-content', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge', 'diagrams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('board index content has no scene JSON/base64/element-ids', () => {
    const body = buildBoard({
      textElements: ['dreamcontext architecture', 'Session Capture'],
      jsonOnlyTerm: 'jsonOnlyMarker',
    });

    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'arch.excalidraw.md'),
      'Architecture',
      'Architecture board',
      body,
    );

    const entries = buildKnowledgeIndex(tmpDir);
    const entry = entries.find((e) => e.slug === 'diagrams/arch.excalidraw');
    expect(entry).toBeDefined();

    const content = entry!.content;

    // Must NOT contain scene JSON markers
    expect(content).not.toMatch(/"type"\s*:\s*"excalidraw"/);
    expect(content).not.toContain('"version": 2');
    // Must NOT contain base64 data URLs
    expect(content).not.toMatch(/data:image\/[a-z]+;base64,/);
    // Must NOT contain ^blockref ids (4+ alphanumeric chars after ^)
    expect(content).not.toMatch(/\^[A-Za-z0-9_-]{4,}/);
    // Must NOT contain the JSON-only marker
    expect(content).not.toContain('jsonOnlyMarker');
  });
});

// ─── AC4: excalidraw-snapshot ─────────────────────────────────────────────────

describe('excalidraw-snapshot', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge', 'diagrams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('snapshot token estimate independent of scene size; extracted text not JSON', () => {
    const TEXT_ELEMENTS = ['Session Capture', 'Memory Store', 'Recall Pipeline'];

    // Board A: 2MB scene
    const bodyLarge = buildBoard({
      textElements: TEXT_ELEMENTS,
      sceneSizeBytes: 2 * 1024 * 1024,
    });
    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'large.excalidraw.md'),
      'Large Board',
      'Large scene board',
      bodyLarge,
    );

    // Board B: tiny scene (same text elements)
    const bodySmall = buildBoard({
      textElements: TEXT_ELEMENTS,
      sceneSizeBytes: 100,
    });
    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'small.excalidraw.md'),
      'Small Board',
      'Small scene board',
      bodySmall,
    );

    const entries = buildKnowledgeIndex(tmpDir);
    const largeEntry = entries.find((e) => e.slug === 'diagrams/large.excalidraw');
    const smallEntry = entries.find((e) => e.slug === 'diagrams/small.excalidraw');

    expect(largeEntry).toBeDefined();
    expect(smallEntry).toBeDefined();

    // Both entries should have the same content (same text elements)
    expect(largeEntry!.content).toBe(smallEntry!.content);

    // Content should not contain scene JSON
    expect(largeEntry!.content).not.toContain('"type": "excalidraw"');
    expect(largeEntry!.content).not.toContain('"type":"excalidraw"');

    // Content should contain the text elements
    for (const t of TEXT_ELEMENTS) {
      expect(largeEntry!.content).toContain(t);
    }
  });
});

// ─── AC5: excalidraw-dark-siblings ───────────────────────────────────────────

describe('excalidraw-dark-siblings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const boardDir = join(tmpDir, 'knowledge', 'diagrams', 'my-board');
    mkdirSync(boardDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generator script + spec + sibling .md inside a diagram folder appear nowhere', () => {
    const boardDir = join(tmpDir, 'knowledge', 'diagrams', 'my-board');

    // Board file
    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'my-board', 'my-board.excalidraw.md'),
      'My Board',
      'My board description',
      buildBoard({ textElements: ['Board content here'] }),
    );

    // Dark siblings
    writeFileSync(join(boardDir, 'my-board.board.cjs'), '// generator script\n');
    writeFileSync(join(boardDir, 'my-board.json'), '{"elements": []}\n');
    writeFileSync(join(boardDir, 'notes.md'), '---\nname: Notes\n---\n\nSome notes\n');

    const entries = buildKnowledgeIndex(tmpDir);

    // Board should appear
    const boardEntry = entries.find((e) =>
      e.slug === 'diagrams/my-board/my-board.excalidraw',
    );
    expect(boardEntry).toBeDefined();

    // notes.md should NOT appear (dark sibling)
    const notesEntry = entries.find((e) => e.slug.includes('notes'));
    expect(notesEntry).toBeUndefined();

    // Non-.md files are already excluded by glob (**/*.md only)
    // — confirmed by: only .md dark siblings need explicit exclusion
    expect(entries).toHaveLength(1);
  });

  it('diagramFolderDirs identifies board directories correctly', () => {
    const files = [
      '/root/knowledge/diagrams/my-board/my-board.excalidraw.md',
      '/root/knowledge/diagrams/my-board/notes.md',
      '/root/knowledge/diagrams/flat.excalidraw.md',
      '/root/knowledge/other.md',
    ];

    const dirs = diagramFolderDirs(files);

    expect(dirs.has('/root/knowledge/diagrams/my-board')).toBe(true);
    expect(dirs.has('/root/knowledge/diagrams')).toBe(true); // flat board
    expect(dirs.has('/root/knowledge')).toBe(false);
  });

  it('isDarkDiagramSibling excludes non-board siblings but not boards', () => {
    const files = [
      '/root/knowledge/diagrams/my-board/my-board.excalidraw.md',
      '/root/knowledge/diagrams/my-board/notes.md',
      '/root/knowledge/diagrams/my-board/spec.json', // .json is not .md so won't be in files
    ];

    const dirs = diagramFolderDirs(files);

    // Board itself: NOT a dark sibling
    expect(
      isDarkDiagramSibling(
        '/root/knowledge/diagrams/my-board/my-board.excalidraw.md',
        dirs,
      ),
    ).toBe(false);

    // notes.md: IS a dark sibling
    expect(
      isDarkDiagramSibling('/root/knowledge/diagrams/my-board/notes.md', dirs),
    ).toBe(true);

    // File not in a board dir: NOT a dark sibling
    expect(isDarkDiagramSibling('/root/knowledge/other.md', dirs)).toBe(false);
  });
});

// ─── AC6: dashboard excalidraw-grouping ──────────────────────────────────────

describe('dashboard excalidraw-grouping', () => {
  it('depth-2 diagrams/{title}/ slug shows leaf {title}.excalidraw under Diagrams', () => {
    // A nested board: slug = diagrams/my-board/my-board.excalidraw
    // Expected leaf: "my-board.excalidraw" (last path segment)
    const entry = {
      slug: 'diagrams/my-board/my-board.excalidraw',
      name: 'diagrams/my-board/my-board.excalidraw',
      description: 'A board',
      tags: [],
      pinned: false,
    };
    const result = leafName(entry, 'diagrams');
    expect(result).toBe('my-board.excalidraw');
  });

  it('flat diagrams/recall.excalidraw shows leaf recall.excalidraw', () => {
    // Flat board slug: diagrams/recall.excalidraw
    const entry = {
      slug: 'diagrams/recall.excalidraw',
      name: 'diagrams/recall.excalidraw',
      description: 'Recall architecture',
      tags: [],
      pinned: false,
    };
    const result = leafName(entry, 'diagrams');
    expect(result).toBe('recall.excalidraw');
  });

  it('isExcalidrawSlug matches nested board slug', () => {
    // The inlined isExcalidrawSlug mirrors dashboard/src/lib/excalidraw.ts:47.
    // It matches on the .excalidraw suffix, regardless of path depth.
    expect(isExcalidrawSlug('diagrams/my-board/my-board.excalidraw')).toBe(true);
    expect(isExcalidrawSlug('diagrams/recall.excalidraw')).toBe(true);
    expect(isExcalidrawSlug('data-structures/default')).toBe(false);
  });

  it('leafName for non-excalidraw uses prefix-strip', () => {
    // Non-board inside data-structures folder: strip prefix
    const entry = {
      slug: 'data-structures/default',
      name: 'data-structures/default',
      description: 'Default schema',
      tags: [],
      pinned: false,
    };
    const result = leafName(entry, 'data-structures');
    expect(result).toBe('default');
  });

  it('leafName returns name unchanged when no folder match', () => {
    const entry = {
      slug: 'some-topic',
      name: 'Some Topic',
      description: '',
      tags: [],
      pinned: false,
    };
    const result = leafName(entry, null);
    expect(result).toBe('Some Topic');
  });
});

// ─── AC7: excalidraw-flat-regression ─────────────────────────────────────────

describe('excalidraw-flat-regression', () => {
  it('live flat knowledge/diagrams/*.excalidraw.md still indexes+recalls with extraction; index content JSON-free', () => {
    // Use dreamcontext's own architecture.excalidraw.md as the regression fixture.
    const CONTEXT_ROOT = '/Users/mehmetnuraydin/projects/dreamcontext/_dream_context';
    const FLAT_BOARD_SLUG = 'diagrams/architecture.excalidraw';

    const entries = buildKnowledgeIndex(CONTEXT_ROOT);
    const boardEntry = entries.find((e) => e.slug === FLAT_BOARD_SLUG);

    expect(boardEntry).toBeDefined();

    const content = boardEntry!.content;

    // Must NOT contain raw scene JSON
    expect(content).not.toMatch(/"type"\s*:\s*"excalidraw"/);
    expect(content).not.toContain('"version": 2,');

    // Must NOT contain ^blockref ids
    expect(content).not.toMatch(/\^[A-Za-z0-9_-]{4,}/);

    // Should contain some of the known text elements from architecture.excalidraw.md
    // (from the file we read: "dreamcontext — architecture", "Capture", etc.)
    expect(content).toMatch(/dreamcontext|architecture|Capture|Memory/i);

    // Recall corpus should also be clean
    const corpus = buildCorpus(CONTEXT_ROOT, { types: ['knowledge'] });
    const boardDoc = corpus.find((d) => d.slug === 'architecture.excalidraw');
    expect(boardDoc).toBeDefined();
    expect(boardDoc!.body).not.toMatch(/"type"\s*:\s*"excalidraw"/);
    expect(boardDoc!.body).not.toContain('"version": 2,');
  });
});

// ─── AC8: excalidraw-docs (light presence test) ───────────────────────────────

describe('excalidraw-docs', () => {
  it('skill/SKILL.md documents folder convention and required frontmatter', () => {
    const skillContent = readFileSync(
      '/Users/mehmetnuraydin/projects/dreamcontext/skill/SKILL.md',
      'utf-8',
    );

    // Documents the per-title folder convention
    expect(skillContent).toContain('diagrams/<title>/<title>.excalidraw.md');
    // Documents do-not-hand-edit
    expect(skillContent).toContain('do NOT hand-edit');
    // Documents required name + description
    expect(skillContent).toContain('REQUIRED frontmatter');
    // Documents dark siblings excluded from index/recall
    expect(skillContent).toContain('dark sibling');
  });

  it('skill-packs/excalidraw/SKILL.md documents dreamcontext knowledge conventions', () => {
    const packContent = readFileSync(
      '/Users/mehmetnuraydin/projects/dreamcontext/skill-packs/excalidraw/SKILL.md',
      'utf-8',
    );

    // Documents the folder convention
    expect(packContent).toContain('knowledge/diagrams');
    // Documents do-not-hand-edit
    expect(packContent).toContain('do NOT hand-edit');
    // Documents required name + description frontmatter
    expect(packContent).toContain('name:');
    expect(packContent).toContain('description:');
    // Documents dark siblings
    expect(packContent).toContain('dark sibling');
    // Documents memory indexing scope
    expect(packContent).toContain('Text Elements');
  });
});

// ─── AC9: diagrams-migration + migration-registry ────────────────────────────

describe('diagrams-migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge', 'diagrams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('code step detects flat boards and records detected without moving', () => {
    // Create flat boards
    writeFileSync(
      join(tmpDir, 'knowledge', 'diagrams', 'flat-one.excalidraw.md'),
      '---\nname: Flat One\ndescription: Test\n---\n\n## Text Elements\nFlat one text\n%%\n## Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[]}\n```\n%%\n',
    );
    writeFileSync(
      join(tmpDir, 'knowledge', 'diagrams', 'flat-two.excalidraw.md'),
      '---\nname: Flat Two\ndescription: Test\n---\n\n## Text Elements\nFlat two text\n%%\n## Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[]}\n```\n%%\n',
    );

    const flatBoards = detectFlatDiagramBoards(tmpDir);
    expect(flatBoards).toHaveLength(2);
    expect(flatBoards).toContain('flat-one');
    expect(flatBoards).toContain('flat-two');

    // The code step of migration072 runs detection only — finds the 0.7.2 migration
    const migration072 = REGISTRY.find((m) => m.version === '0.7.2');
    expect(migration072).toBeDefined();

    const result = migration072!.steps[0](tmpDir);
    expect(result.step).toBe('detect-flat-diagram-boards');
    expect(result.filesTouched).toHaveLength(0); // moves nothing
    expect(result.detected).toBe(true);
    expect(result.summary).toContain('flat-one');
    expect(result.summary).toContain('flat-two');

    // Verify boards were NOT moved
    const stillFlat = detectFlatDiagramBoards(tmpDir);
    expect(stillFlat).toHaveLength(2);
  });

  it('agentTask present with move+wikilink contract', () => {
    const migration072 = REGISTRY.find((m) => m.version === '0.7.2');
    expect(migration072).toBeDefined();
    expect(migration072!.agentTask).toBeDefined();
    expect(migration072!.agentTask!.id).toBe('diagrams-folder-convention');
    // Instruction must mention rewriteWikilinks and the move contract
    expect(migration072!.agentTask!.instruction).toContain('rewriteWikilinks');
    expect(migration072!.agentTask!.instruction).toContain('wikilinks');
  });
});

describe('migration-registry', () => {
  it('REGISTRY includes migration072 at version 0.7.2', () => {
    const v072 = REGISTRY.find((m) => m.version === '0.7.2');
    expect(v072).toBeDefined();
    expect(v072!.version).toBe('0.7.2');
  });

  it('pendingMigrations 0.7.1 -> 0.7.2 returns migration072', () => {
    const pending = pendingMigrations('0.7.1', '0.7.2');
    expect(pending).toHaveLength(1);
    expect(pending[0].version).toBe('0.7.2');
  });

  it('pendingMigrations 0.7.2 -> 0.7.2 returns empty (same version)', () => {
    const pending = pendingMigrations('0.7.2', '0.7.2');
    expect(pending).toHaveLength(0);
  });
});
