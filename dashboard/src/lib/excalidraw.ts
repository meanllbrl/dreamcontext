import { decompressFromBase64 } from 'lz-string';

// Obsidian Excalidraw boards (`*.excalidraw.md`) store the scene in a `## Drawing`
// fenced block. Freshly generated boards use plain ```json; once Obsidian opens
// and re-saves them the block becomes ```compressed-json (LZString base64, split
// across lines). We handle both so a board renders whether or not it's been
// touched in Obsidian.
const DRAWING_BLOCK = /##\s*Drawing\s*```(compressed-json|json)\s*([\s\S]*?)```/;

export interface ExcalidrawScene {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown> | null;
}

/**
 * Pull the Excalidraw scene out of a knowledge file's body (frontmatter already
 * stripped by the API). Returns null when the content isn't an Excalidraw board
 * or the drawing block can't be decoded — callers fall back to markdown.
 */
export function extractExcalidrawScene(content: string): ExcalidrawScene | null {
  const match = content.match(DRAWING_BLOCK);
  if (!match) return null;

  const [, kind, raw] = match;
  let json: string;
  if (kind === 'compressed-json') {
    // The plugin wraps the base64 payload across multiple lines — strip all
    // whitespace before decompressing.
    const decoded = decompressFromBase64(raw.replace(/\s+/g, ''));
    if (!decoded) return null;
    json = decoded;
  } else {
    json = raw;
  }

  try {
    const scene = JSON.parse(json) as ExcalidrawScene;
    if (!Array.isArray(scene.elements)) return null;
    return scene;
  } catch {
    return null;
  }
}

/** True when a knowledge entry is an Excalidraw board worth rendering as a drawing. */
export function isExcalidrawSlug(slug: string): boolean {
  return slug.endsWith('.excalidraw');
}

/**
 * The React identity of ONE rendered board.
 *
 * The canvas freezes its scene at mount and owns its viewport (zoom/scroll) for its whole
 * life, so two different boards sharing a key means the second silently inherits the
 * first's scene AND its zoom whenever one slot swaps between them. Identity therefore has
 * to be derived from WHAT the board is — its file path or knowledge slug — never from the
 * slot it happens to land in. The `'board'` fallback exists only so a caller that knows
 * nothing still renders; every caller in this app names its board.
 */
export function boardInstanceKey(identity: string | null | undefined): string {
  return (identity ?? '').trim() || 'board';
}
