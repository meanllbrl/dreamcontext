import matter from 'gray-matter';
import { WhiteboardCorruptError } from './errors.js';
import { widgetPayloadOf, type WhiteboardElement } from './widgets.js';

/**
 * The on-disk whiteboard format (D2): an Obsidian Excalidraw board, the same shape the
 * `/excalidraw` skill builder and the parked composer sketch writer emit, so the dashboard's
 * `extractExcalidrawScene`, memory's `extractExcalidrawText` and Obsidian itself all read it.
 *
 *   - frontmatter: `name` (verbatim), `description`, `dreamcontext-whiteboard: 1`,
 *     `tags: [excalidraw]`, `excalidraw-plugin: parsed`
 *   - `## Text Elements`: one `<label> ^<id>` per live text element and widget title — the
 *     board's only human-readable surface, and the only part memory indexes
 *   - an `## Embedded Files` section from a hand-made board, carried through byte-for-byte
 *     and never read (D10: no images in Phase 1)
 *   - `## Drawing` + a PLAIN ```json fence holding the scene, wrapped in `%%`
 *
 * {@link serializeWhiteboard} is byte-deterministic (D11): elements in `(index, id)` order,
 * object keys sorted recursively, no timestamp in the frontmatter. That is what lets the store
 * skip a write whose bytes would not change.
 *
 * One accepted sharp edge, inherited from the dashboard's parser: labels are written into
 * `## Text Elements` verbatim, and the drawing block is found by the FIRST `## Drawing` +
 * json-fence match. A label that itself contains both a `## Drawing` heading and a json fence
 * false-matches ahead of the real block. No escaping scheme is introduced for it.
 */

export interface Whiteboard {
  frontmatter: Record<string, unknown>;
  elements: WhiteboardElement[];
  appState: Record<string, unknown>;
  /** Scene `files` from a hand-made board — carried through, never added to (D10). */
  files: Record<string, unknown>;
  /** Raw `## Embedded Files` section (header line included), or null. */
  embeddedFiles: string | null;
}

const PLUGIN_SOURCE = 'https://github.com/zsviczian/obsidian-excalidraw-plugin';

const OBSIDIAN_BANNER =
  '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== '
  + "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. "
  + "For more info check in plugin settings under 'Saving'";

/** Same expression as `dashboard/src/lib/excalidraw.ts` DRAWING_BLOCK (separate build roots). */
const DRAWING_BLOCK = /##\s*Drawing\s*```(compressed-json|json)\s*([\s\S]*?)```/;

const DEFAULT_APP_STATE = { gridSize: null, viewBackgroundColor: '#ffffff' };

/** An Embedded Files line: `<fileId>: <link>` — and never a text entry's `… ^<id>` tail. */
const EMBEDDED_LINE = /^[A-Za-z0-9_-]+: .+$/;
const BLOCKREF_TAIL = /\s\^[A-Za-z0-9_-]{4,}\s*$/;

export function emptyWhiteboard(name: string, description = ''): Whiteboard {
  return {
    frontmatter: { name, description },
    elements: [],
    appState: { ...DEFAULT_APP_STATE },
    files: {},
    embeddedFiles: null,
  };
}

/** Parse a board. Throws {@link WhiteboardCorruptError} when there is nothing safe to write back over. */
export function parseWhiteboard(md: string): Whiteboard {
  let data: Record<string, unknown> = {};
  let content = md;
  try {
    // A copy: gray-matter caches parse results by input string and hands out the same object.
    const parsed = matter(md);
    data = JSON.parse(JSON.stringify(parsed.data ?? {})) as Record<string, unknown>;
    content = parsed.content;
  } catch (err) {
    throw new WhiteboardCorruptError(`frontmatter does not parse: ${(err as Error).message}`);
  }

  const match = DRAWING_BLOCK.exec(content);
  if (!match) throw new WhiteboardCorruptError('no ## Drawing json block found');
  if (match[1] === 'compressed-json') {
    throw new WhiteboardCorruptError(
      'the drawing block is compressed (saved by Obsidian); run "Decompress current Excalidraw file" in Obsidian before editing it here',
    );
  }
  let scene: unknown;
  try {
    scene = JSON.parse(match[2]);
  } catch (err) {
    throw new WhiteboardCorruptError(`the drawing JSON does not parse: ${(err as Error).message}`);
  }
  if (!scene || typeof scene !== 'object') throw new WhiteboardCorruptError('the drawing JSON is not an object');
  const s = scene as Record<string, unknown>;
  if (!Array.isArray(s.elements)) throw new WhiteboardCorruptError('the drawing has no elements array');
  for (const el of s.elements) {
    if (!el || typeof el !== 'object' || typeof (el as Record<string, unknown>).id !== 'string') {
      throw new WhiteboardCorruptError('an element in the drawing has no string id');
    }
  }
  const appState = s.appState && typeof s.appState === 'object' && !Array.isArray(s.appState)
    ? (s.appState as Record<string, unknown>)
    : { ...DEFAULT_APP_STATE };
  const files = s.files && typeof s.files === 'object' && !Array.isArray(s.files)
    ? (s.files as Record<string, unknown>)
    : {};

  return {
    frontmatter: data,
    elements: s.elements as WhiteboardElement[],
    appState,
    files,
    embeddedFiles: findEmbeddedFiles(content, match.index),
  };
}

/** The LAST `## Embedded Files` section before the drawing, if every line in it looks like one. */
function findEmbeddedFiles(content: string, drawingIdx: number): string | null {
  const before = content.slice(0, drawingIdx);
  const re = /^## Embedded Files[ \t]*$/gm;
  let start = -1;
  for (let m = re.exec(before); m; m = re.exec(before)) start = m.index;
  if (start < 0) return null;
  // The section ends at the `%%` line that opens the hidden drawing block.
  let end = before.lastIndexOf('\n%%');
  end = end > start ? end + 1 : before.length;
  const raw = before.slice(start, end);
  const body = raw.split('\n').slice(1);
  for (const line of body) {
    if (!line.trim()) continue;
    if (!EMBEDDED_LINE.test(line) || BLOCKREF_TAIL.test(line)) return null;
  }
  return raw.endsWith('\n') ? raw : `${raw}\n`;
}

// ─── serialize ────────────────────────────────────────────────────────────

export function compareElementOrder(a: WhiteboardElement, b: WhiteboardElement): number {
  // Excalidraw compares fractional indices as plain strings. An element with no index yet sorts
  // last, where Excalidraw's own `syncInvalidIndices` would place it.
  const ai = typeof a.index === 'string' ? a.index : null;
  const bi = typeof b.index === 'string' ? b.index : null;
  if (ai !== bi) {
    if (ai === null) return 1;
    if (bi === null) return -1;
    return ai < bi ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortElements(elements: readonly WhiteboardElement[]): WhiteboardElement[] {
  return [...elements].sort(compareElementOrder);
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortKeysDeep(child);
    }
    return out;
  }
  return v;
}

/** YAML scalar/flow value. JSON strings are valid YAML double-quoted scalars — Turkish-safe. */
function yamlValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  return JSON.stringify(v);
}

const FIXED_KEYS = ['name', 'description', 'dreamcontext-whiteboard', 'tags', 'excalidraw-plugin'];

function frontmatterLines(fm: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(`name: ${yamlValue(typeof fm.name === 'string' ? fm.name : '')}`);
  lines.push(`description: ${yamlValue(typeof fm.description === 'string' ? fm.description : '')}`);
  lines.push('dreamcontext-whiteboard: 1');
  const tags = Array.isArray(fm.tags) && fm.tags.length > 0 ? fm.tags : ['excalidraw'];
  lines.push(`tags: ${yamlValue(tags)}`);
  lines.push('excalidraw-plugin: parsed');
  for (const k of Object.keys(fm).sort()) {
    if (FIXED_KEYS.includes(k) || fm[k] === undefined) continue;
    lines.push(`${JSON.stringify(k)}: ${yamlValue(fm[k])}`);
  }
  return lines;
}

/**
 * The `## Text Elements` entries: live text (`originalText`, pre-wrap) and widget titles, in
 * scene order. Deleted elements are skipped — an erased label must not be what recall reads.
 */
export function textEntries(elements: readonly WhiteboardElement[]): { text: string; id: string }[] {
  const out: { text: string; id: string }[] = [];
  for (const el of elements) {
    if (el.isDeleted === true) continue;
    let text = '';
    if (el.type === 'text') {
      text = typeof el.originalText === 'string' ? el.originalText : typeof el.text === 'string' ? el.text : '';
    } else {
      const dc = widgetPayloadOf(el);
      if (dc?.title) text = dc.title;
    }
    if (!text.trim()) continue;
    out.push({ text, id: el.id });
  }
  return out;
}

export function serializeWhiteboard(board: Whiteboard): string {
  const elements = sortElements(board.elements);
  const scene = sortKeysDeep({
    type: 'excalidraw',
    version: 2,
    source: PLUGIN_SOURCE,
    elements,
    appState: board.appState ?? DEFAULT_APP_STATE,
    files: board.files ?? {},
  });

  const lines: string[] = [];
  lines.push('---', ...frontmatterLines(board.frontmatter), '---');
  lines.push(OBSIDIAN_BANNER);
  lines.push('', '', '# Excalidraw Data', '');
  lines.push('## Text Elements');
  for (const t of textEntries(elements)) lines.push(`${t.text} ^${t.id}`, '');
  let head = `${lines.join('\n')}\n`;
  if (board.embeddedFiles) head += board.embeddedFiles;
  // Every backtick is written as the JSON escape ```: the drawing block is found by a lazy
  // match up to the next triple backtick, so a note whose markdown holds a code fence would
  // otherwise end the block mid-string. Backticks only ever occur inside JSON strings, where the
  // escape parses back to the same character.
  const json = JSON.stringify(scene, null, '\t').replace(/`/g, '\\u0060');
  const tail = ['%%', '## Drawing', '```json', json, '```', '%%'];
  return `${head}${tail.join('\n')}\n`;
}
