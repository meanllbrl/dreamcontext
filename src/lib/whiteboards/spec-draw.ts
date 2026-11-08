import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhiteboardValidationError } from './errors.js';
import { readImportSource } from './ops.js';
import type { WhiteboardElement } from './widgets.js';

/**
 * A WHITEBOARD DRAWING FROM A SPEC (owner, 2026-10-21: "whiteboard'a yazı yazma ve çizim yapma
 * excalidraw skill'ine göre olsun").
 *
 * The drawing kit is the `draw` core skill's own builder (`skill-draw/scripts/build_excalidraw.js`,
 * shipped in this package), so a flow on a whiteboard and a board in Obsidian come out of the same
 * builders, the same type and the same build audit. Going through the CLI is what lets an agent
 * without skills or `node` (a home-board agent) draw: it writes a JSON spec into its scratch folder
 * and `whiteboard draw <board> --spec` builds and places it.
 */

/** The kit's build audit: any non-zero count is a drawing that reads badly (see the skill). */
export interface SpecAudit {
  overlaps: number;
  buriedText: number;
  longLines: number;
  wallOfText: number;
}

interface Builder {
  buildExcalidraw(spec: Record<string, unknown>): SpecAudit;
  SPEC_TYPES: readonly string[];
  /** The types whose `items` are child specs. */
  LAYOUT_TYPES: readonly string[];
}

const MISSING_KIT = 'the draw kit is missing; run `dreamcontext update`';

/**
 * The draw skill's folder in THIS package, or null in an install that lost it. Its builder is code
 * this process runs, so it is looked for only inside dreamcontext itself: first the copy beside the
 * running file (`dist/skill-draw`, copied there at build; also how the desktop app finds it, since
 * it ships `dist` and has no package.json at its resources root), then `skill-draw/` at the first
 * folder up whose package.json is named "dreamcontext" (running from source). Never a project folder.
 */
export function kitDir(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  const has = (dir: string): boolean => existsSync(join(dir, 'scripts', 'build_excalidraw.js'));
  const beside = join(from, 'skill-draw');
  if (has(beside)) return beside;
  let dir = resolve(from);
  for (;;) {
    if (isDreamcontextRoot(dir)) {
      const own = join(dir, 'skill-draw');
      return has(own) ? own : null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Is `dir` the dreamcontext package's own root (its package.json is named "dreamcontext")? */
function isDreamcontextRoot(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as { name?: unknown }).name === 'dreamcontext';
  } catch {
    return false;
  }
}

const loaded = new Map<string, Builder>();

/** The draw skill's builder module, loaded once per folder. */
export function loadBuilder(dir: string | null = kitDir()): Builder {
  if (!dir) throw new WhiteboardValidationError(MISSING_KIT);
  const cached = loaded.get(dir);
  if (cached) return cached;
  const builder = createRequire(import.meta.url)(join(dir, 'scripts', 'build_excalidraw.js')) as Builder;
  loaded.set(dir, builder);
  return builder;
}

/** The kit's reference for drawing on a whiteboard, printed by `whiteboard kit`. */
export function readKitReference(dir: string | null = kitDir()): string {
  if (!dir) throw new WhiteboardValidationError(MISSING_KIT);
  return readFileSync(join(dir, 'references', 'whiteboard-kit.md'), 'utf-8');
}

/**
 * What a spec may carry; `out`, the vault and the frontmatter keys belong to a file build, and
 * `audit` is not the spec's to switch off (a board drawing is always audited).
 */
const SPEC_KEYS = ['elements', 'background', 'measure'] as const;

const KIT_HINT = '`dreamcontext whiteboard kit` lists every type with its fields';

/**
 * Read a spec: `{ "elements": [...] }` or the bare elements array, and the picture paths it names
 * (`{ "type": "image", "path": "docs/a.png" }`, resolved against the working folder as the builder
 * resolves them). Refused, naming the spot: bad JSON, no elements, a `type` the kit does not have
 * (nested `items` included), and a picture without a path.
 */
export function parseSpec(
  text: string,
  filename: string,
  types: readonly string[],
  layouts: readonly string[] = ['stack', 'row', 'panel'],
): { spec: Record<string, unknown>; pictures: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new WhiteboardValidationError(`${filename} is not valid JSON: ${(err as Error).message}`);
  }
  const raw = (Array.isArray(parsed) ? { elements: parsed } : parsed) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.elements) || raw.elements.length === 0) {
    throw new WhiteboardValidationError(`${filename} holds no elements: write { "elements": [ … ] }; ${KIT_HINT}`);
  }
  const known = new Set(types);
  const pictures: string[] = [];
  // One item of a stack/row/panel may itself be a list of elements (drawn as one block); a list
  // anywhere else is not something the builder reads.
  const walk = (list: unknown[], path: string, item = false): void => {
    list.forEach((el, i) => {
      const at = `${path}[${i}]`;
      if (Array.isArray(el) && item) return walk(el, at);
      if (!el || typeof el !== 'object' || Array.isArray(el)) throw new WhiteboardValidationError(`${filename}: ${at} is not an element object; ${KIT_HINT}`);
      const type = (el as { type?: unknown }).type;
      if (type === 'image') {
        const path = (el as { path?: unknown }).path;
        if (typeof path !== 'string' || !path.trim()) {
          throw new WhiteboardValidationError(`${filename}: ${at} is a picture with no "path" (a PNG, JPEG, GIF or WebP file)`);
        }
        pictures.push(resolve(path));
      }
      if (typeof type !== 'string' || !known.has(type)) {
        throw new WhiteboardValidationError(`${filename}: ${at} has type ${JSON.stringify(type ?? null)}, which the kit does not draw; ${KIT_HINT}`);
      }
      const items = (el as { items?: unknown }).items;
      if (Array.isArray(items) && layouts.includes(type)) walk(items, `${at}.items`, true);
    });
  };
  walk(raw.elements as unknown[], 'elements');
  const spec: Record<string, unknown> = {};
  for (const key of SPEC_KEYS) if (raw[key] !== undefined) spec[key] = raw[key];
  return { spec, pictures: [...new Set(pictures)] };
}

/**
 * Build a spec with the kit and return its elements, ready for `prepareImport`, plus the audit and
 * the pictures it placed. `checkPicture` sees every picture path BEFORE the builder reads it (the
 * caller's scope rule and type check); an image element names its picture by the sha1 of its
 * bytes, the same id a board stores it under (`fileIdFor`). The builder writes a file, so it
 * writes one into a fresh temp folder that is always removed.
 */
export function buildSpecDrawing(
  text: string,
  filename: string,
  opts: { builder?: Builder; checkPicture?: (path: string) => void } = {},
): { elements: WhiteboardElement[]; audit: SpecAudit; pictures: string[] } {
  const builder = opts.builder ?? loadBuilder();
  const { spec, pictures } = parseSpec(text, filename, builder.SPEC_TYPES, builder.LAYOUT_TYPES);
  for (const p of pictures) opts.checkPicture?.(p);
  const dir = mkdtempSync(join(tmpdir(), 'dc-wb-spec-'));
  try {
    const out = join(dir, 'drawing.excalidraw.md');
    let result: SpecAudit;
    try {
      result = builder.buildExcalidraw({ ...spec, out });
    } catch (err) {
      throw new WhiteboardValidationError(`${filename} did not build: ${(err as Error).message}; ${KIT_HINT}`);
    }
    const elements = readImportSource(readFileSync(out, 'utf-8'), 'drawing.excalidraw.md');
    const { overlaps, buriedText, longLines, wallOfText } = result;
    return { elements, audit: { overlaps, buriedText, longLines, wallOfText }, pictures };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The kit's own ceiling for one block of copy (`wallOfText` in the builder). */
export const NOTE_MAX_LINES = 5;
export const NOTE_MAX_WORDS = 45;

/**
 * The other half of the same rule: a note widget is free markdown the kit never audits, so a long
 * one is where a board turns into a wall of text. Null for a caption-sized note, else the warning
 * a writer sees (advisory: the owner may ask for text, and the write still lands).
 */
export function noteWarning(markdown: string): string | null {
  const lines = markdown.split('\n').filter((l) => l.trim()).length;
  const words = markdown.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (lines <= NOTE_MAX_LINES && words <= NOTE_MAX_WORDS) return null;
  return `this note is a wall of text (${lines} lines, ${words} words): a board is read at a glance, and a note `
    + `is a caption (at most ${NOTE_MAX_LINES} lines, ${NOTE_MAX_WORDS} words). To explain something, draw it: `
    + '`dreamcontext whiteboard kit`, then `whiteboard draw <slug> --spec <spec.json>`.';
}

/** One line naming what the audit found, or null for a clean drawing. */
export function auditWarning(a: SpecAudit): string | null {
  const parts = [
    a.overlaps && `${a.overlaps} overlapping box${a.overlaps === 1 ? '' : 'es'}`,
    a.buriedText && `${a.buriedText} buried label${a.buriedText === 1 ? '' : 's'}`,
    a.longLines && `${a.longLines} over-long line${a.longLines === 1 ? '' : 's'}`,
    a.wallOfText && `${a.wallOfText} wall${a.wallOfText === 1 ? '' : 's'} of text`,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `The drawing reads badly: ${parts.join(', ')}. Shorten the labels, split a long block into a flow or bullets, `
    + 'lay it out with stack/row/panel, then redraw it in place (remove --tag, draw --at the printed bbox).';
}
