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
import { createRequire } from 'node:module';
import type { ServerResponse } from 'node:http';
import { handleKnowledgeAssets } from '../../src/server/routes/knowledge.js';

import {
  extractExcalidrawText,
  isExcalidrawPath,
  diagramFolderDirs,
  isDarkDiagramSibling,
} from '../../src/lib/excalidraw-text.js';
import { buildKnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { REGISTRY, pendingMigrations } from '../../src/migrations/index.js';
import { detectFlatDiagramBoards, migrateDiagramsToFolders } from '../../src/lib/diagrams-migration.js';
import { readLedger } from '../../src/lib/migration-ledger.js';
import { existsSync, readFileSync as fsReadFileSync } from 'node:fs';

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

// ─── Mirror of buildKnowledgeTree / countTreeCards from KnowledgePage.tsx ──────
//
// Same rationale as leafName above: the production function is pure but lives in
// a React file vitest can't import. Kept in lock-step with
// dashboard/src/pages/KnowledgePage.tsx. Drives the Bug A regression below.

interface KnowledgeTreeNode {
  name: string;
  path: string;
  label: string;
  folders: KnowledgeTreeNode[];
  cards: KnowledgeListEntry[];
}

function prettyFolder(folder: string): string {
  return folder
    .split(/[-_]/)
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function countTreeCards(node: KnowledgeTreeNode): number {
  return node.cards.length + node.folders.reduce((sum, f) => sum + countTreeCards(f), 0);
}

function buildKnowledgeTree(
  entries: KnowledgeListEntry[],
): { roots: KnowledgeListEntry[]; folders: KnowledgeTreeNode[] } {
  const roots: KnowledgeListEntry[] = [];
  const top: KnowledgeTreeNode = { name: '', path: '', label: '', folders: [], cards: [] };

  const folderOccupants = new Map<string, number>();
  for (const e of entries) {
    const segs = e.slug.split('/');
    for (let i = 1; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join('/');
      folderOccupants.set(ancestor, (folderOccupants.get(ancestor) ?? 0) + 1);
    }
  }

  const childFolder = (parent: KnowledgeTreeNode, seg: string): KnowledgeTreeNode => {
    let child = parent.folders.find(f => f.name === seg);
    if (!child) {
      const path = parent.path ? `${parent.path}/${seg}` : seg;
      child = { name: seg, path, label: prettyFolder(seg), folders: [], cards: [] };
      parent.folders.push(child);
    }
    return child;
  };

  for (const e of entries) {
    const segments = e.slug.split('/');
    const leaf = segments[segments.length - 1];
    let chain = segments.slice(0, -1);
    if (isExcalidrawSlug(e.slug) && chain.length > 0) {
      const base = leaf.replace(/\.excalidraw$/, '');
      const wrapper = chain.join('/');
      if (chain[chain.length - 1] === base && (folderOccupants.get(wrapper) ?? 0) <= 1) {
        chain = chain.slice(0, -1);
      }
    }
    if (chain.length === 0) { roots.push(e); continue; }
    let node = top;
    for (const seg of chain) node = childFolder(node, seg);
    node.cards.push(e);
  }
  return { roots, folders: top.folders };
}

function findNode(folders: KnowledgeTreeNode[], path: string): KnowledgeTreeNode | undefined {
  for (const f of folders) {
    if (f.path === path) return f;
    const hit = findNode(f.folders, path);
    if (hit) return hit;
  }
  return undefined;
}

function mkEntry(slug: string, name?: string): KnowledgeListEntry {
  return { slug, name: name ?? slug, description: '', tags: [], pinned: false };
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

  it('generator script + spec + frontmatter-less sibling .md inside a diagram folder appear nowhere', () => {
    const boardDir = join(tmpDir, 'knowledge', 'diagrams', 'my-board');

    // Board file
    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'my-board', 'my-board.excalidraw.md'),
      'My Board',
      'My board description',
      buildBoard({ textElements: ['Board content here'] }),
    );

    // Dark siblings — note: the helper .md has NO frontmatter, so it stays dark.
    writeFileSync(join(boardDir, 'my-board.board.cjs'), '// generator script\n');
    writeFileSync(join(boardDir, 'my-board.json'), '{"elements": []}\n');
    writeFileSync(join(boardDir, 'notes.md'), 'Some notes without frontmatter\n');

    const entries = buildKnowledgeIndex(tmpDir);

    // Board should appear
    const boardEntry = entries.find((e) =>
      e.slug === 'diagrams/my-board/my-board.excalidraw',
    );
    expect(boardEntry).toBeDefined();

    // notes.md should NOT appear (frontmatter-less dark sibling)
    const notesEntry = entries.find((e) => e.slug.includes('notes'));
    expect(notesEntry).toBeUndefined();

    // Non-.md files are already excluded by glob (markdown only)
    // — confirmed by: only frontmatter-less .md dark siblings need explicit exclusion
    expect(entries).toHaveLength(1);
  });

  it('a companion .md WITH name: frontmatter beside a board is indexed and recalls', () => {
    const boardDir = join(tmpDir, 'knowledge', 'diagrams', 'my-board');

    writeExcalidrawFile(
      tmpDir,
      join('knowledge', 'diagrams', 'my-board', 'my-board.excalidraw.md'),
      'My Board',
      'My board description',
      buildBoard({ textElements: ['Board content here'] }),
    );

    // Companion knowledge with frontmatter — a detailed teardown beside the board.
    const COMPANION_TERM = 'companionteardownuniquetoken';
    writeFileSync(
      join(boardDir, 'my-board.teardown.md'),
      `---\nname: My Board Teardown\ndescription: Detailed teardown\ntags: [teardown]\n---\n\n# Teardown\n\n${COMPANION_TERM} detailed analysis.\n`,
    );

    // A frontmatter-less helper stays dark.
    writeFileSync(join(boardDir, 'scratch.md'), 'no frontmatter scratch note\n');

    const entries = buildKnowledgeIndex(tmpDir);

    // Companion IS indexed (first-class knowledge), with its frontmatter name.
    const companion = entries.find(
      (e) => e.slug === 'diagrams/my-board/my-board.teardown',
    );
    expect(companion).toBeDefined();
    expect(companion!.name).toBe('My Board Teardown');

    // Board still indexed.
    expect(
      entries.find((e) => e.slug === 'diagrams/my-board/my-board.excalidraw'),
    ).toBeDefined();

    // Frontmatter-less scratch stays dark.
    expect(entries.find((e) => e.slug.includes('scratch'))).toBeUndefined();

    // Companion is recallable by its unique term.
    const corpus = buildCorpus(tmpDir, { types: ['knowledge'] });
    const hits = bm25Search(COMPANION_TERM, corpus);
    expect(hits.find((h) => h.doc.slug === 'my-board.teardown')).toBeDefined();
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

  it('isDarkDiagramSibling: board + frontmatter knowledge stay; tooling notes go dark', () => {
    const files = [
      '/root/knowledge/diagrams/my-board/my-board.excalidraw.md',
      '/root/knowledge/diagrams/my-board/notes.md',
      '/root/knowledge/diagrams/my-board/my-board.teardown.md',
    ];

    const dirs = diagramFolderDirs(files);

    // Board itself: NEVER a dark sibling (3rd arg irrelevant)
    expect(
      isDarkDiagramSibling(
        '/root/knowledge/diagrams/my-board/my-board.excalidraw.md',
        dirs,
        false,
      ),
    ).toBe(false);

    // Frontmatter-less note (isIndexableKnowledge=false): IS a dark sibling
    expect(
      isDarkDiagramSibling(
        '/root/knowledge/diagrams/my-board/notes.md',
        dirs,
        false,
      ),
    ).toBe(true);

    // Companion .md WITH name: frontmatter (isIndexableKnowledge=true): NOT dark
    expect(
      isDarkDiagramSibling(
        '/root/knowledge/diagrams/my-board/my-board.teardown.md',
        dirs,
        true,
      ),
    ).toBe(false);

    // Backward-safe: omitting the 3rd arg keeps the original dark behaviour
    expect(
      isDarkDiagramSibling('/root/knowledge/diagrams/my-board/notes.md', dirs),
    ).toBe(true);

    // File not in a board dir: NEVER a dark sibling
    expect(isDarkDiagramSibling('/root/knowledge/other.md', dirs, false)).toBe(false);
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
    // Diagrams are foldered per-title and grouped under a category subfolder
    // (diagrams/<category>/<title>/<title>.excalidraw.md), so the index slug
    // carries the full containing path. architecture lives under the `system` category.
    const FLAT_BOARD_SLUG = 'diagrams/system/architecture/architecture.excalidraw';

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
  it('skill surfaces the context-folder convention and documents board rules in the reference', () => {
    const ROOT = '/Users/mehmetnuraydin/projects/dreamcontext';
    const skillContent = readFileSync(join(ROOT, 'skill', 'SKILL.md'), 'utf-8');
    const refContent = readFileSync(
      join(ROOT, 'skill', 'references', 'knowledge-and-recall.md'),
      'utf-8',
    );

    // The always-loaded SKILL.md surfaces the PROMOTED convention: diagrams live
    // inside their context folder (not a segregated top-level diagrams/ dump).
    expect(skillContent).toContain('context folder');
    expect(skillContent).toContain('INSIDE their context folder');

    // The knowledge-and-recall reference carries the board depth:
    // context-folder placement, do-not-hand-edit, required frontmatter, dark siblings.
    expect(refContent).toContain('context folder');
    expect(refContent).toContain('.excalidraw.md');
    expect(refContent).toContain('Do NOT hand-edit');
    expect(refContent).toContain('REQUIRED frontmatter');
    expect(refContent).toContain('Dark siblings');
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

  it('agentTask present with apply-diagrams safe-command contract', () => {
    const migration072 = REGISTRY.find((m) => m.version === '0.7.2');
    expect(migration072).toBeDefined();
    expect(migration072!.agentTask).toBeDefined();
    expect(migration072!.agentTask!.id).toBe('diagrams-folder-convention');
    // Instruction must point at the safe CLI command (not hand-editing wikilinks)
    expect(migration072!.agentTask!.instruction).toContain('apply-diagrams');
    // Instruction must mention the behavioral judgment step
    expect(migration072!.agentTask!.instruction).toContain('canonical');
    // Instruction must mention wikilinks are handled atomically by the command
    expect(migration072!.agentTask!.instruction).toContain('wikilinks');
    // Instruction must NOT say to call rewriteWikilinks directly
    expect(migration072!.agentTask!.instruction).not.toContain('call rewriteWikilinks');
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

// ─── apply-diagrams behavior ──────────────────────────────────────────────────

describe('apply-diagrams-behavior', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(join(tmpDir, 'knowledge', 'diagrams'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('board + generator + spec moved into per-title folder; inbound wikilink rewritten; ledger entry written', () => {
    const diagramsDir = join(tmpDir, 'knowledge', 'diagrams');

    // Flat board
    writeFileSync(
      join(diagramsDir, 'foo.excalidraw.md'),
      '---\nname: Foo Board\ndescription: Foo architecture\ntags: [architecture]\n---\n\n## Text Elements\nFoo label\n%%\n## Drawing\n```json\n{"type":"excalidraw","version":2,"elements":[]}\n```\n%%\n',
    );

    // Same-basename generator script (dark sibling to be moved)
    writeFileSync(join(diagramsDir, 'foo.board.cjs'), '// generator\n');

    // A doc elsewhere containing an inbound wikilink to the flat board
    mkdirSync(join(tmpDir, 'core'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'core', 'arch-notes.md'),
      '---\nname: Arch Notes\n---\n\nSee [[diagrams/foo.excalidraw]] for details.\n',
    );

    // Run the migration function (same function the apply-diagrams command calls)
    const result = migrateDiagramsToFolders(tmpDir);

    // Board should be moved
    expect(result.moved).toContain('foo');
    expect(result.skipped).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(0);

    // Board file should be at the new location
    expect(existsSync(join(diagramsDir, 'foo', 'foo.excalidraw.md'))).toBe(true);

    // Old flat location should be gone
    expect(existsSync(join(diagramsDir, 'foo.excalidraw.md'))).toBe(false);

    // Generator script should also be moved
    expect(existsSync(join(diagramsDir, 'foo', 'foo.board.cjs'))).toBe(true);
    expect(existsSync(join(diagramsDir, 'foo.board.cjs'))).toBe(false);

    // Inbound wikilink should be rewritten to new slug
    const archNotes = fsReadFileSync(join(tmpDir, 'core', 'arch-notes.md'), 'utf-8');
    expect(archNotes).toContain('[[diagrams/foo/foo.excalidraw]]');
    expect(archNotes).not.toContain('[[diagrams/foo.excalidraw]]');
  });

  it('already-nested boards are skipped; flat boards are moved', () => {
    const diagramsDir = join(tmpDir, 'knowledge', 'diagrams');

    // One flat board
    writeFileSync(
      join(diagramsDir, 'flat-board.excalidraw.md'),
      '---\nname: Flat\ndescription: flat\n---\n\n## Text Elements\nFlat text\n',
    );

    // One already-nested board
    mkdirSync(join(diagramsDir, 'nested-board'), { recursive: true });
    writeFileSync(
      join(diagramsDir, 'nested-board', 'nested-board.excalidraw.md'),
      '---\nname: Nested\ndescription: nested\n---\n\n## Text Elements\nNested text\n',
    );

    const result = migrateDiagramsToFolders(tmpDir);

    expect(result.moved).toContain('flat-board');
    // skipped entries have EXCALIDRAW_SUFFIX stripped: nested-board/nested-board.excalidraw.md -> nested-board/nested-board
    expect(result.skipped).toContain('nested-board/nested-board');
    expect(result.ambiguous).toHaveLength(0);
  });

  it('no flat boards returns empty moved list (no-op)', () => {
    const diagramsDir = join(tmpDir, 'knowledge', 'diagrams');

    // Only a nested board — nothing flat to move
    mkdirSync(join(diagramsDir, 'my-board'), { recursive: true });
    writeFileSync(
      join(diagramsDir, 'my-board', 'my-board.excalidraw.md'),
      '---\nname: My Board\ndescription: already nested\n---\n\n## Text Elements\nContent\n',
    );

    const result = migrateDiagramsToFolders(tmpDir);

    expect(result.moved).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(0);
  });

  it('a crafted board filename cannot escape diagrams/ (no write outside the tree)', () => {
    const diagramsDir = join(tmpDir, 'knowledge', 'diagrams');
    // A file literally named `...excalidraw.md` would strip to boardBase `..`,
    // whose dest dir resolves to knowledge/ (one level up). Two layers prevent a
    // traversal: fast-glob skips dotfiles, and the containment guard rejects any
    // boardBase that resolves outside diagrams/. Net effect: nothing escapes.
    writeFileSync(
      join(diagramsDir, '...excalidraw.md'),
      '---\nname: Evil\ndescription: traversal attempt\n---\n\n## Text Elements\nx\n',
    );
    const before = fsReadFileSync(join(diagramsDir, '...excalidraw.md'), 'utf-8');

    const result = migrateDiagramsToFolders(tmpDir);

    // It is never moved, and nothing is written into knowledge/ (the parent dir).
    expect(result.moved).toHaveLength(0);
    expect(existsSync(join(diagramsDir, '...excalidraw.md'))).toBe(true);
    expect(fsReadFileSync(join(diagramsDir, '...excalidraw.md'), 'utf-8')).toBe(before);
    expect(existsSync(join(tmpDir, 'knowledge', '...excalidraw.md'))).toBe(false);
  });
});

// ─── Bug A: co-located board folder is NOT split in the knowledge tree ─────────

describe('dashboard board-folder grouping (Bug A)', () => {
  it('keeps the .excalidraw inside a co-located folder that also holds a teardown', () => {
    // The reported layout: a self-contained board folder holding both the board
    // and its teardown. Previously the board's self-named wrapper was always
    // collapsed, hoisting the .excalidraw to `competitors/ads` while the teardown
    // stayed in the folder — a split. Both must now group under the folder.
    const { roots, folders } = buildKnowledgeTree([
      mkEntry('competitors/ads/ad-creative-transcripts', 'Ad Creative Transcripts'),
      mkEntry('competitors/ads/fitness-ad-creative-teardown', 'Fitness Ad Teardown'),
      mkEntry('competitors/ads/dietpal-creative-board/dietpal-creative-board.teardown', 'Dietpal Teardown'),
      mkEntry('competitors/ads/dietpal-creative-board/dietpal-creative-board.excalidraw'),
    ]);

    expect(roots).toHaveLength(0);

    const boardFolder = findNode(folders, 'competitors/ads/dietpal-creative-board');
    expect(boardFolder).toBeDefined();
    // Both the board AND the teardown live under the folder — count is 2, not 1.
    expect(countTreeCards(boardFolder!)).toBe(2);
    const slugs = boardFolder!.cards.map(c => c.slug).sort();
    expect(slugs).toContain('competitors/ads/dietpal-creative-board/dietpal-creative-board.excalidraw');
    expect(slugs).toContain('competitors/ads/dietpal-creative-board/dietpal-creative-board.teardown');

    // The .excalidraw must NOT be hoisted as a sibling at the `Ads` level.
    const adsFolder = findNode(folders, 'competitors/ads');
    expect(adsFolder!.cards.some(c => isExcalidrawSlug(c.slug))).toBe(false);
  });

  it('still collapses a LONE board wrapper (legacy `<title>/<title>.excalidraw`)', () => {
    // Regression guard: when the board is the only artifact in its self-named
    // folder, the redundant wrapper is still dropped (board renders directly
    // under its category as `<title>.excalidraw`).
    const { folders } = buildKnowledgeTree([
      mkEntry('diagrams/recall/recall.excalidraw'),
    ]);
    const diagrams = findNode(folders, 'diagrams');
    expect(diagrams).toBeDefined();
    // No `diagrams/recall` wrapper node — the board collapsed up into `diagrams`.
    expect(findNode(folders, 'diagrams/recall')).toBeUndefined();
    expect(diagrams!.cards.map(c => c.slug)).toEqual(['diagrams/recall/recall.excalidraw']);
  });

  it('keeps the board when its only co-located sibling lives in a NESTED subfolder', () => {
    // Multi-reviewer finding: occupancy must count the whole subtree, not just
    // direct children. A board folder whose other content sits in a subfolder
    // (`<board>/research/notes.md`) must still keep its wrapper — otherwise the
    // board re-splits exactly as Bug A described.
    const { roots, folders } = buildKnowledgeTree([
      mkEntry('competitors/ads/dietpal-creative-board/dietpal-creative-board.excalidraw'),
      mkEntry('competitors/ads/dietpal-creative-board/research/competitor-notes', 'Competitor Notes'),
    ]);

    expect(roots).toHaveLength(0);

    const boardFolder = findNode(folders, 'competitors/ads/dietpal-creative-board');
    expect(boardFolder).toBeDefined();
    // The board stays as a card directly under its wrapper (not hoisted).
    expect(
      boardFolder!.cards.some(c => c.slug.endsWith('dietpal-creative-board.excalidraw')),
    ).toBe(true);
    // The nested note still nests under research/, and the whole subtree counts as 2.
    expect(findNode(folders, 'competitors/ads/dietpal-creative-board/research')).toBeDefined();
    expect(countTreeCards(boardFolder!)).toBe(2);
    // The .excalidraw must NOT be hoisted as a sibling at the `Ads` level.
    const ads = findNode(folders, 'competitors/ads');
    expect(ads!.cards.some(c => isExcalidrawSlug(c.slug))).toBe(false);
  });
});

// ─── Bug B(1): embedded images resolve against the co-located `assets/` dir ────

// A valid 1×1 transparent PNG so the resolver (and optionally sharp) has real bytes.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function fakeRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) { (res as { _status: number })._status = status; return res; },
    end(body?: string) { (res as { _body: string })._body = body ?? ''; return res; },
    setHeader() { /* noop */ },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

describe('knowledge-assets co-located assets/ resolution (Bug B1)', () => {
  let tmpDir: string;
  let contextRoot: string;
  let boardDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    contextRoot = join(tmpDir, '_dream_context');
    boardDir = join(contextRoot, 'knowledge', 'competitors', 'ads', 'dietpal-creative-board');
    mkdirSync(join(boardDir, 'assets'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a bare wikilink to the sibling assets/ folder; skips a dangling ref', async () => {
    // Embedded image lives in the board's own `assets/` subfolder (the
    // self-contained convention). A bare `[[calai-01.png]]` link previously
    // resolved only via Obsidian's vault-wide index → blank in-app.
    writeFileSync(join(boardDir, 'assets', 'calai-01.png'), PNG_1x1);

    const presentId = '4cfdf315aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const danglingId = 'dab9506dbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    writeFileSync(
      join(boardDir, 'dietpal-creative-board.excalidraw.md'),
      '---\nname: Dietpal Creative Board\ndescription: board\ntags: [excalidraw]\nexcalidraw-plugin: parsed\n---\n\n' +
        '# Excalidraw Data\n\n## Embedded Files\n' +
        `${presentId}: [[calai-01.png]]\n` +
        `${danglingId}: [[ctwa-04.png]]\n`,
    );

    const res = fakeRes();
    await handleKnowledgeAssets(
      {} as never,
      res,
      { slug: 'competitors/ads/dietpal-creative-board/dietpal-creative-board.excalidraw' },
      contextRoot,
    );

    expect(res._status).toBe(200);
    const json = JSON.parse(res._body) as { files: Record<string, { dataURL: string }> };
    // The asset under assets/ now resolves.
    expect(json.files[presentId]).toBeDefined();
    expect(json.files[presentId].dataURL).toMatch(/^data:image\//);
    // The dangling reference (no file on disk) is simply absent — never invented.
    expect(json.files[danglingId]).toBeUndefined();
  });
});

// ─── Bug B(2): the board builder refuses to write dangling embeds ─────────────

describe('build_excalidraw dangling-asset guard (Bug B2)', () => {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildExcalidraw } = require('../../skill-packs/excalidraw/scripts/build_excalidraw.js');

  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('fails (and writes no board) when a referenced image is missing, naming every gap', () => {
    const ok = join(tmpDir, 'ok.png');
    writeFileSync(ok, PNG_1x1);
    const out = join(tmpDir, 'board.excalidraw.md');

    let err: Error | undefined;
    try {
      buildExcalidraw({
        out,
        vaultRoot: tmpDir,
        elements: [
          { type: 'image', x: 0, y: 0, width: 100, path: ok },
          { type: 'image', x: 200, y: 0, width: 100, path: join(tmpDir, 'ctwa-04.png') },
          { type: 'image', x: 400, y: 0, width: 100, path: join(tmpDir, 'ctwa-05.png') },
        ],
      });
    } catch (e) {
      err = e as Error;
    }

    expect(err).toBeDefined();
    expect(err!.message).toMatch(/missing or not a file/);
    // Lists ALL missing assets, not just the first.
    expect(err!.message).toContain('ctwa-04.png');
    expect(err!.message).toContain('ctwa-05.png');
    // No board with dangling embeds is ever written.
    expect(existsSync(out)).toBe(false);
  });

  it('writes the board when every referenced image exists', () => {
    const img = join(tmpDir, 'real.png');
    writeFileSync(img, PNG_1x1);
    const out = join(tmpDir, 'good.excalidraw.md');

    const res = buildExcalidraw({
      out,
      vaultRoot: tmpDir,
      elements: [{ type: 'image', x: 0, y: 0, width: 100, path: img }],
    });

    expect(res.images).toBe(1);
    expect(existsSync(out)).toBe(true);
    const md = fsReadFileSync(out, 'utf-8');
    expect(md).toContain('## Embedded Files');
    expect(md).toMatch(/\[\[real\.png\]\]/);
  });
});
