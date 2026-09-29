import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { isSafeInsightSlug, labDir, resolveContainedLabFile, type LabFileKind } from './store.js';
import { LabError, MAX_HTML_BYTES } from './types.js';
import type { FrameKind } from './frameOps.js';

/**
 * The per-vault custom HTML block library: `lab/blocks/<slug>.md`, frontmatter
 * `title`, `description`, `inputs: [{name, kind}]`, body = the HTML. A board
 * card reuses an entry with `html: {ref: <slug>, inputs: {<name>: <binding>}}`;
 * the host answers `lab.data(name)` only for the names declared here.
 *
 * This file also owns the SAFE frontmatter parse the board store shares.
 * `src/lib/frontmatter.ts` (gray-matter defaults) honours a language tag on the
 * opening fence, and gray-matter's `javascript` engine is `eval`: a synced
 * `---js` file would run code on open. Board and block files come from
 * teammates through brain sync, so they only ever parse as YAML with
 * gray-matter's `js-yaml` `safeLoad` engine, and any tagged fence is refused.
 */

// ─── Safe frontmatter (shared with boards.ts) ───────────────────────────────

const REFUSED_ENGINE = {
  parse: (): never => {
    throw new Error('only YAML frontmatter is accepted');
  },
};

export interface SafeFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/** Parse `raw` as `---` YAML frontmatter + body. Throws on a tagged fence, bad YAML or a non-object. */
export function parseSafeFrontmatter(raw: string): SafeFrontmatter {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.startsWith('---')) {
    const firstLine = text.slice(0, text.search(/\r?\n|$/));
    if (firstLine.trim() !== '---') {
      throw new Error(`frontmatter fence "${firstLine.slice(0, 40)}" names a language; only a bare --- (YAML) is accepted`);
    }
  }
  const parsed = matter(text, {
    language: 'yaml',
    engines: { javascript: REFUSED_ENGINE, js: REFUSED_ENGINE, coffee: REFUSED_ENGINE },
  });
  const data = parsed.data as unknown;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter is not a YAML mapping');
  }
  return { data: data as Record<string, unknown>, content: parsed.content };
}

/** Drop `undefined` values recursively: the YAML dumper refuses them. */
function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val !== undefined) out[k] = stripUndefined(val);
    }
    return out;
  }
  return v;
}

/** Serialize frontmatter + body (gray-matter's `safeDump`). */
export function stringifySafeFrontmatter(data: Record<string, unknown>, body: string): string {
  const content = body.trim() === '' ? '' : `\n${body.trim()}\n`;
  return matter.stringify(content, stripUndefined(data) as Record<string, unknown>);
}

/** Short content hash used as a file's optimistic-concurrency `rev`. */
export function revOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Make `lab/<sub>/` exist and prove it is really inside the vault (neither
 * `lab/` nor `lab/<sub>/` a symlink out). Throws a LabError otherwise.
 */
export function ensureContainedLabDir(contextRoot: string, sub: string): string {
  const dir = join(labDir(contextRoot), sub);
  mkdirSync(dir, { recursive: true });
  if (realpathSync(dir) !== join(realpathSync(contextRoot), 'lab', sub)) {
    throw new LabError(`Refusing to write: lab/${sub}/ resolves outside the vault.`);
  }
  return dir;
}

/**
 * Atomic tmp + rename write of `lab/<dir>/<slug><ext>`. Refuses an unsafe slug
 * and never writes through an existing symlink at the target.
 */
export function writeContainedLabFile(
  contextRoot: string,
  kind: LabFileKind,
  sub: string,
  slug: string,
  ext: string,
  text: string,
): string {
  if (!isSafeInsightSlug(slug)) throw new LabError(`Invalid ${kind} slug "${slug}": use kebab-case.`);
  const dir = ensureContainedLabDir(contextRoot, sub);
  const path = join(dir, `${slug}${ext}`);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new LabError(`Refusing to write through a symlink: lab/${sub}/${slug}${ext}.`);
  } catch (err) {
    if (err instanceof LabError) throw err;
  }
  const tmp = join(dir, `.${slug}${ext}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf-8');
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return path;
}

export interface RejectedLabFile {
  /** The file name without its extension, as found on disk. */
  name: string;
  reason: 'unsafe-slug' | 'symlink' | 'not-contained';
}

const REJECT_LOCATIONS: Record<LabFileKind, { dir: string; ext: string }> = {
  insight: { dir: 'insights', ext: '.md' },
  cache: { dir: 'cache', ext: '.json' },
  board: { dir: 'boards', ext: '.md' },
  block: { dir: 'blocks', ext: '.md' },
};

/**
 * The `lab/<dir>/*<ext>` entries `resolveContainedLabFile` refuses (so every
 * reader skips them), for `lab doctor` to REPORT. Names and lstat only: a
 * rejected file's content is never read.
 */
export function listRejectedLabFiles(contextRoot: string, kind: LabFileKind): RejectedLabFile[] {
  const { dir, ext } = REJECT_LOCATIONS[kind];
  const path = join(labDir(contextRoot), dir);
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return [];
  }
  const out: RejectedLabFile[] = [];
  for (const entry of entries.filter((e) => e.endsWith(ext)).sort()) {
    const name = entry.slice(0, -ext.length);
    if (!isSafeInsightSlug(name)) {
      out.push({ name, reason: 'unsafe-slug' });
    } else if (!resolveContainedLabFile(contextRoot, kind, name)) {
      let symlink = false;
      try { symlink = lstatSync(join(path, entry)).isSymbolicLink(); } catch { /* vanished */ }
      out.push({ name, reason: symlink ? 'symlink' : 'not-contained' });
    }
  }
  return out;
}

// ─── Library entries ────────────────────────────────────────────────────────

export const LIBRARY_INPUT_KINDS = ['series', 'table', 'value', 'funnel'] as const satisfies readonly FrameKind[];
export type LibraryInputKind = (typeof LIBRARY_INPUT_KINDS)[number];

export interface LibraryBlockInput {
  name: string;
  /** The frame kind the block expects, or null = the html default order. */
  kind: LibraryInputKind | null;
}

export interface LibraryBlock {
  slug: string;
  title: string;
  description: string | null;
  inputs: LibraryBlockInput[];
  html: string;
  rev: string;
}

export interface SaveLibraryBlockInput {
  title: string;
  description?: string | null;
  inputs?: LibraryBlockInput[];
  html: string;
}

/** An input name `lab.data(name)` may ask for: an identifier, 1-64 chars. */
export function isSafeInputName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

export function blocksDir(contextRoot: string): string {
  return join(labDir(contextRoot), 'blocks');
}

/** LENIENT inputs parse: bad names and duplicates are dropped; an unknown kind reads as null. */
export function parseLibraryInputs(v: unknown): LibraryBlockInput[] {
  if (!Array.isArray(v)) return [];
  const out: LibraryBlockInput[] = [];
  for (const raw of v) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const name = r ? r.name : raw;
    if (!isSafeInputName(name) || out.some((i) => i.name === name)) continue;
    const kind = r && (LIBRARY_INPUT_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as LibraryInputKind) : null;
    out.push({ name, kind });
  }
  return out;
}

function parseLibraryText(slug: string, text: string): LibraryBlock {
  const { data, content } = parseSafeFrontmatter(text);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : slug;
  const description = typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null;
  return { slug, title, description, inputs: parseLibraryInputs(data.inputs), html: content.trim(), rev: revOf(text) };
}

/** One library entry, read through the contained-path gate. Absent, unsafe or unparseable -> null. */
export function getLibraryBlock(contextRoot: string, slug: string): LibraryBlock | null {
  const path = resolveContainedLabFile(contextRoot, 'block', slug);
  if (!path) return null;
  try {
    return parseLibraryText(slug, readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/** Every readable library entry, sorted by slug. */
export function listLibraryBlocks(contextRoot: string): LibraryBlock[] {
  const dir = blocksDir(contextRoot);
  if (!existsSync(dir)) return [];
  const out: LibraryBlock[] = [];
  for (const file of fg.sync('*.md', { cwd: dir, onlyFiles: true }).sort()) {
    const block = getLibraryBlock(contextRoot, basename(file, '.md'));
    if (block) out.push(block);
  }
  return out;
}

/** STRICT write validation. Returns human-readable problems, each with its fix. */
export function validateLibraryBlock(slug: string, input: SaveLibraryBlockInput): string[] {
  const problems: string[] = [];
  if (!isSafeInsightSlug(slug)) problems.push(`slug "${slug}" is not kebab-case; fix: use e.g. "cohort-grid".`);
  if (typeof input.title !== 'string' || !input.title.trim()) problems.push('title is required; fix: add a short title.');
  if (typeof input.html !== 'string' || !input.html.trim()) problems.push('html is empty; fix: provide the block markup.');
  else if (Buffer.byteLength(input.html, 'utf-8') > MAX_HTML_BYTES) {
    problems.push(`html is over ${MAX_HTML_BYTES} bytes; fix: move data into inputs instead of inlining it.`);
  }
  const seen = new Set<string>();
  for (const [i, inp] of (input.inputs ?? []).entries()) {
    if (!isSafeInputName(inp?.name)) {
      problems.push(`inputs[${i}].name "${String(inp?.name)}" is not an identifier; fix: letters, digits, _ or -, starting with a letter.`);
      continue;
    }
    if (seen.has(inp.name)) problems.push(`inputs[${i}].name "${inp.name}" is declared twice; fix: remove the duplicate.`);
    seen.add(inp.name);
    if (inp.kind !== null && inp.kind !== undefined && !(LIBRARY_INPUT_KINDS as readonly string[]).includes(inp.kind)) {
      problems.push(`inputs[${i}].kind "${String(inp.kind)}" is unknown; fix: one of ${LIBRARY_INPUT_KINDS.join(', ')}.`);
    }
  }
  return problems;
}

/**
 * Save (create or replace) a library entry: strict validation, optional rev
 * check (`expectedRev` null = must not exist yet), atomic tmp + rename.
 */
export function saveLibraryBlock(
  contextRoot: string,
  slug: string,
  input: SaveLibraryBlockInput,
  expectedRev?: string | null,
): LibraryBlock {
  const problems = validateLibraryBlock(slug, input);
  if (problems.length > 0) throw new LabError(`Invalid library block:\n- ${problems.join('\n- ')}`);
  if (expectedRev !== undefined) {
    const current = getLibraryBlock(contextRoot, slug);
    const currentRev = current ? current.rev : null;
    if (currentRev !== expectedRev) throw new LabError(`Library block "${slug}" changed elsewhere (rev ${currentRev ?? 'none'}); reload and retry.`);
  }
  const data: Record<string, unknown> = {
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    inputs: (input.inputs ?? []).map((i) => (i.kind ? { name: i.name, kind: i.kind } : { name: i.name })),
  };
  const text = stringifySafeFrontmatter(data, input.html);
  writeContainedLabFile(contextRoot, 'block', 'blocks', slug, '.md', text);
  return parseLibraryText(slug, text);
}
