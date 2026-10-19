import { Command } from 'commander';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, info } from '../../lib/format.js';
import {
  createWhiteboard,
  renameWhiteboard,
  listWhiteboards,
  mutateWhiteboard,
  nextIndices,
  readWhiteboard,
  boardName,
  DEFAULT_WHITEBOARD,
} from '../../lib/whiteboards/store.js';
import { WhiteboardError, WhiteboardValidationError } from '../../lib/whiteboards/errors.js';
import { getBoard } from '../../lib/lab/boards.js';
import { getAgent } from '../../lib/agents/store.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV } from '../../lib/automations/types.js';
import { agentsOnElements } from '../../lib/whiteboards/agents.js';
import { boardFileRelPath, fileIdFor, imageBox, imageSize, makeImageElement, sniffImageType, writeBoardFile } from '../../lib/whiteboards/files.js';
import { checkWebUrl, isValidRef, isValidTag, isValidWidgetRef } from '../../lib/whiteboards/validate.js';
import {
  WIDGET_KINDS,
  WIDGET_SIZES,
  DEFAULT_WIDGET_BOXES, DEFAULT_WIDGET_SIZES,
  isWidgetKind,
  isCardColor,
  CARD_COLORS,
  type CardColor,
  isWidgetSize,
  isValidPageRef,
  makeWidgetElement,
  pageRefKind,
  splitLabCardRef,
  type WidgetKind,
  type WidgetSize,
  type WidgetPayload,
} from '../../lib/whiteboards/widgets.js';
import {
  applyUpdate,
  describeElement,
  elementBBox,
  formatBBox,
  liveElements,
  newTodoItem,
  prepareImport,
  readImportSource,
  removeElements,
  sourceBBox,
  unionBBox,
  type BBox,
  type ElementView,
} from '../../lib/whiteboards/ops.js';
import {
  assertFree,
  GRID_PITCH,
  hasAnchor,
  occupantsOf,
  placeFree,
  tagBBox,
  tagGroups,
  WhiteboardOverlapError,
  type Anchor,
} from '../../lib/whiteboards/layout.js';
import { foldOwnWrite, noteShow, type SinceLastShow } from '../../lib/whiteboards/seen.js';
import { contentRegion, fitScale, MAX_SIDE, renderScene } from '../../lib/whiteboards/render.js';
import type { MutateResult } from '../../lib/whiteboards/store.js';
import type { WhiteboardElement } from '../../lib/whiteboards/widgets.js';
import {
  addPage,
  addSection,
  applyWikiEdit,
  findSectionIndex,
  movePage,
  moveSection,
  removePage,
  removeSection,
  resolveWikiCard,
  wikiCards,
  wikiCardView,
  type WikiCardView,
  type WikiNav,
} from '../../lib/whiteboards/nav.js';

/**
 * `dreamcontext whiteboard` — the agent's hands on a board. Every write goes through
 * `mutateWhiteboard` (lock, read, merge-safe edit, atomic write), so a CLI edit and a browser
 * save interleave without losing either. `show --json` is how an agent reads back what the
 * user did — which todos they ticked, where they moved things.
 */

const collect = (v: string, prev: string[]): string[] => [...prev, v];

/** The placement flags `add` and `draw` share. */
interface PlaceOpts {
  at?: string;
  below?: string;
  rightOf?: string;
  alignLeft?: string;
  allowOverlap?: boolean;
}

function parsePair(raw: string | undefined, label: string): [number, number] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
    throw new WhiteboardValidationError(`${label} must be two numbers, e.g. 100,200 (got '${raw}')`);
  }
  return [parts[0], parts[1]];
}

function parseAt(raw: string | undefined): { x: number; y: number } | undefined {
  const p = parsePair(raw, '--at');
  return p ? { x: p[0], y: p[1] } : undefined;
}

/** `--below` / `--right-of` / `--align-left`: tags checked, and never together with `--at`. */
function parseAnchor(opts: { at?: string; below?: string; rightOf?: string; alignLeft?: string }): Anchor {
  const anchor: Anchor = { below: opts.below, rightOf: opts.rightOf, alignLeft: opts.alignLeft };
  for (const [flag, tag] of [['--below', opts.below], ['--right-of', opts.rightOf], ['--align-left', opts.alignLeft]] as const) {
    if (tag !== undefined && !isValidTag(tag)) throw new WhiteboardValidationError(`invalid tag '${tag}' for ${flag}`);
  }
  if (opts.at !== undefined && hasAnchor(anchor)) {
    throw new WhiteboardValidationError('use --at or --below / --right-of / --align-left, not both');
  }
  if (opts.below !== undefined && opts.rightOf !== undefined) throw new WhiteboardValidationError('use --below or --right-of, not both');
  return anchor;
}

/** The elements a write touched, folded into this session's "last show" note. */
function noteOwnWrite(root: string, slug: string, res: MutateResult, touched: readonly string[]): void {
  foldOwnWrite(root, slug, { before: res.before, rev: res.rev, elements: res.board.elements }, touched);
}

/**
 * The one line after a placing write that tells the agent how to look at what it did. Said
 * here, at the moment it wants to look, because the wrong way to look (a browser on the
 * user's dashboard) is the one within reach.
 */
function lookHint(slug: string, tag: string | undefined, box: BBox | null): string | null {
  if (!tag && !box) return null;
  const dir = process.env[AGENT_SCRATCH_ENV]?.trim() ? `$${AGENT_SCRATCH_ENV}` : process.platform === 'win32' ? tmpdir() : '/tmp';
  const where = tag ? `--tag ${tag}` : `--region ${formatBBox(box!)}`;
  return `  Look at it: dreamcontext whiteboard render ${slug} ${where} --out ${dir}/${slug}${tag ? `-${tag}` : ''}.png (never a browser or the user's dashboard)`;
}

/**
 * `--size s|m|l|xl` is a grid preset (A17); `--size w,h` (back-compat) is a free-form size
 * that leaves `dc.size` unset, so the dashboard shows it at the nearest preset.
 */
function parseSize(raw: string | undefined): WidgetSize | { w: number; h: number } | undefined {
  if (raw !== undefined && isWidgetSize(raw.trim().toLowerCase())) return raw.trim().toLowerCase() as WidgetSize;
  if (raw !== undefined && !raw.includes(',')) {
    throw new WhiteboardValidationError(`--size must be one of ${Object.keys(WIDGET_SIZES).join('|')} or w,h (got '${raw}')`);
  }
  const p = parsePair(raw, '--size');
  if (!p) return undefined;
  if (!(p[0] > 0 && p[1] > 0)) throw new WhiteboardValidationError('--size must be positive (w,h > 0)');
  return { w: p[0], h: p[1] };
}

function readTextOpt(opts: { text?: string; file?: string }): string | undefined {
  if (opts.text !== undefined && opts.file !== undefined) throw new WhiteboardValidationError('use --text or --file, not both');
  if (opts.file !== undefined) return readFileSync(assertFileInScope(opts.file), 'utf-8');
  return opts.text;
}

// ── The board agent's second layer ───────────────────────────────────────────────────────────
// A home-board agent runs with `DREAMCONTEXT_AGENT_BOARD` set and a permission allowlist that
// already limits its writes to its own board. These checks are the CLI's own copy of that
// rule, so a rule that is mis-spelled or widened upstream still cannot reach another board.

/** The board this process is limited to, or null when no board agent is running it. */
function scopedBoard(): string | null {
  const v = process.env[AGENT_BOARD_ENV]?.trim();
  return v ? v : null;
}

/** Refuse a write to any board other than the running agent's own. */
function assertBoardInScope(slug: string): void {
  const home = scopedBoard();
  if (home !== null && slug !== home) {
    throw new WhiteboardValidationError(`this agent acts only on its own board '${home}', not '${slug}'`);
  }
}

/** The real path of `dir`, or null when it is unset or does not resolve. */
function realDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * While a board agent runs, `--file` may come ONLY from its two writable folders: its scratch
 * folder (`$DREAMCONTEXT_AGENT_SCRATCH`) and `<brain>/automations/output/<self>/`. The content
 * lands on a synced board, and the agent's Read deny rules bind Claude's tools, not this child
 * process, so anywhere else in the project (`.env`, `.claude/settings.local.json`) is refused
 * too. A symlink is refused outright, and both sides are compared by real path. Returns the
 * path to read.
 */
function assertFileInScope(file: string): string {
  if (scopedBoard() === null) return file;
  const self = process.env[AGENT_SELF_ENV]?.trim();
  const allowed = [
    realDir(process.env[AGENT_SCRATCH_ENV]?.trim()),
    self ? realDir(join(ensureContextRoot(), 'automations', 'output', self)) : null,
  ].filter((d): d is string => d !== null);
  const refuse = (why: string): never => {
    throw new WhiteboardValidationError(
      `--file '${file}' ${why}; a board agent may only read files from its scratch folder ($${AGENT_SCRATCH_ENV}) `
      + `or _dream_context/automations/output/${self || '<self>'}/`,
    );
  };
  let real: string;
  try {
    if (lstatSync(file).isSymbolicLink()) refuse('is a symlink');
    real = realpathSync(file);
  } catch (err) {
    if (err instanceof WhiteboardValidationError) throw err;
    throw new WhiteboardValidationError(`cannot read --file '${file}': ${(err as Error).message}`);
  }
  if (!allowed.some((dir) => isInside(dir, real))) refuse('is outside the folders this agent may read from');
  return real;
}

/** Where a page ref points: a knowledge slug in the brain, or a file relative to the project. */
function pageExists(root: string, ref: string): boolean {
  if (pageRefKind(ref) === 'knowledge') return existsSync(join(root, 'knowledge', `${ref}.md`));
  return existsSync(join(dirname(root), ref));
}

/** Where a ref of this kind lives in the brain — only used for the does-it-exist warning. */
function refExists(root: string, kind: WidgetKind, ref: string): boolean {
  if (kind === 'insight') return existsSync(join(root, 'lab', 'insights', `${ref}.md`));
  if (kind === 'knowledge') return pageExists(root, ref);
  if (kind === 'task') return existsSync(join(root, 'state', `${ref}.md`));
  if (kind === 'lab-card') {
    const parts = splitLabCardRef(ref);
    if (!parts) return false;
    try {
      return !!getBoard(root, parts.board)?.cards.some((c) => c.id === parts.card);
    } catch {
      return false;
    }
  }
  return true;
}

/** Wrap an action: a whiteboard failure prints its message and exits non-zero. */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void> | void): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      // A refused placement is data an agent acts on: under --json it goes to stdout whole.
      if (err instanceof WhiteboardOverlapError && process.argv.includes('--json')) {
        console.log(JSON.stringify(err.toJSON(), null, 2));
        process.exitCode = 1;
        return;
      }
      if (err instanceof WhiteboardError || err instanceof Error) {
        error((err as Error).message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  };
}

function printView(v: ElementView): void {
  const what = v.kind ? `${v.kind}${v.ref ? `:${v.ref}` : ''}` : v.type;
  const label = v.title ?? v.text ?? v.url ?? '';
  const tag = v.tag ? chalk.cyan(` #${v.tag}`) : '';
  const color = v.color ? chalk.dim(` color:${v.color}`) : '';
  console.log(`  ${chalk.dim(v.id)}  ${chalk.bold(what)}  ${label.split('\n')[0]}${tag}${color}  ${chalk.dim(`@${formatBBox(v.bbox)}`)}`);
  if (v.items) {
    v.items.forEach((it, i) => console.log(`      ${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}  ${chalk.dim(it.id)}`));
  }
}

function countByTag(list: readonly { tag: string | null }[]): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const c of list) m.set(c.tag, (m.get(c.tag) ?? 0) + 1);
  return m;
}

function sinceJson(s: SinceLastShow): Record<string, unknown> {
  const tags = new Set([...s.added, ...s.changed, ...s.removed].map((c) => c.tag));
  const [a, c, r] = [countByTag(s.added), countByTag(s.changed), countByTag(s.removed)];
  return {
    lastShow: s.at,
    added: s.added.length,
    changed: s.changed.length,
    removed: s.removed.length,
    byTag: [...tags].map((tag) => ({ tag, added: a.get(tag) ?? 0, changed: c.get(tag) ?? 0, removed: r.get(tag) ?? 0 })),
    ids: { added: s.added.map((x) => x.id), changed: s.changed.map((x) => x.id), removed: s.removed.map((x) => x.id) },
  };
}

function sinceLine(s: SinceLastShow): string {
  const part = (n: number, verb: string, list: readonly { tag: string | null }[]) => {
    if (n === 0) return null;
    const tags = [...countByTag(list).entries()].map(([t, k]) => `${t ? `#${t}` : 'untagged'} ${k}`).join(', ');
    return `${n} ${verb} (${tags})`;
  };
  const parts = [part(s.added.length, 'added', s.added), part(s.changed.length, 'moved or edited', s.changed), part(s.removed.length, 'removed', s.removed)]
    .filter(Boolean)
    .join(', ');
  return `Changed by someone else since your last show (${s.at.slice(0, 16).replace('T', ' ')} UTC): ${parts}. Re-check free space before you place anything.`;
}

function printNav(nav: WikiNav): void {
  nav.sections.forEach((s, i) => {
    console.log(`  ${i}. ${chalk.bold(s.title)}  ${chalk.dim(s.id)}`);
    s.pages.forEach((p, j) => {
      const label = p.label ? `  ${p.label}` : '';
      console.log(`      ${j}. ${p.ref}${chalk.dim(`  ${pageRefKind(p.ref) === 'knowledge' ? 'knowledge' : pageRefKind(p.ref)}`)}${label}`);
    });
  });
}

function parseIndex(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new WhiteboardValidationError(`${label} must be an integer (got '${raw}')`);
  return n;
}

/** Run a list edit on one wiki card under the board's lock; returns the card as written. */
async function editWikiCard(
  root: string,
  slug: string,
  cardId: string | undefined,
  fn: (nav: WikiNav) => WikiNav,
): Promise<WikiCardView> {
  assertBoardInScope(slug);
  let out: WikiCardView | null = null;
  const res = await mutateWhiteboard(root, slug, (board) => {
    const card = resolveWikiCard(board.elements, slug, cardId);
    const i = board.elements.indexOf(card);
    board.elements[i] = applyWikiEdit(card, fn);
    out = wikiCardView(board.elements[i]);
  });
  const card = out as unknown as WikiCardView;
  noteOwnWrite(root, slug, res, [card.id]);
  return card;
}

function cardName(card: WikiCardView): string {
  return card.title ? `wiki card "${card.title}"` : `wiki card ${card.id}`;
}

function registerNavCommands(wb: Command): void {
  const nav = wb
    .command('nav')
    .description('A wiki card\'s list: sections of pages (knowledge slugs or project .md/.pdf/.html paths), stored in the card on the board');
  const cardOpt = '--card <widget-id>';
  const cardHelp = 'The wiki card to edit (may be left out when the board has exactly one)';

  // --- nav list ---
  nav.command('list <slug>', { isDefault: true })
    .description('List a wiki card\'s sections and pages, with their 0-based positions')
    .option(cardOpt, cardHelp)
    .option('--json', 'Machine-readable output')
    .action(run((slug: string, opts: { card?: string; json?: boolean }) => {
      const { board } = readWhiteboard(ensureContextRoot(), slug);
      const card = wikiCardView(resolveWikiCard(board.elements, slug, opts.card));
      if (opts.json) {
        console.log(JSON.stringify({ slug, card }, null, 2));
        return;
      }
      if (card.sections.length === 0) {
        info(`The ${cardName(card)} on ${slug} is empty. Add a section: dreamcontext whiteboard nav add ${slug} --card ${card.id} --section "<title>"`);
        return;
      }
      printNav(card);
    }));

  // --- nav add ---
  nav.command('add <slug>')
    .description('Add a section (--section <title>), or a page to a section (--section <id|title> --page <ref>); a page into a missing section creates it')
    .requiredOption('--section <id|title>', 'Section id or title (a new section\'s title)')
    .option('--page <ref>', 'Knowledge slug or project-relative .md/.pdf/.html path')
    .option('--label <text>', 'Label for the page (default: the page\'s own title)')
    .option('--at <index>', '0-based position to insert at (default: the end)')
    .option(cardOpt, cardHelp)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: { section: string; page?: string; label?: string; at?: string; card?: string; json?: boolean }) => {
      const root = ensureContextRoot();
      const at = parseIndex(opts.at, '--at');
      if (opts.page !== undefined && !isValidPageRef(opts.page)) {
        throw new WhiteboardValidationError(`invalid page ref '${opts.page}' (a knowledge slug, or a project-relative .md/.pdf/.html path with no '..')`);
      }
      if (opts.page === undefined && opts.label !== undefined) throw new WhiteboardValidationError('--label applies to a page (--page <ref>)');
      let created = false;
      const card = await editWikiCard(root, slug, opts.card, (cur) => {
        if (opts.page === undefined) {
          created = true;
          return addSection(cur, opts.section, { at }).nav;
        }
        let next = cur;
        let key = opts.section;
        try {
          findSectionIndex(cur, key);
        } catch (err) {
          if (!(err instanceof WhiteboardValidationError) || !/^no section/.test(err.message)) throw err;
          const added = addSection(cur, opts.section);
          next = added.nav;
          key = added.section.id;
          created = true;
        }
        return addPage(next, key, { ref: opts.page, label: opts.label }, { at });
      });
      const warning = opts.page !== undefined && !pageExists(root, opts.page)
        ? `no page '${opts.page}' exists yet; the card will show it as "not found" until it does`
        : null;
      if (opts.json) {
        if (warning) console.error(`⚠ ${warning}`);
        console.log(JSON.stringify({ slug, card }, null, 2));
        return;
      }
      if (warning) console.log(chalk.yellow('⚠') + ' ' + warning);
      if (opts.page === undefined) success(`Added section ${chalk.bold(opts.section)} to the ${cardName(card)} on ${slug}`);
      else success(`Added ${chalk.bold(opts.page)} to ${created ? 'new ' : ''}section ${chalk.bold(opts.section)} of the ${cardName(card)} on ${slug}`);
      printNav(card);
    }));

  // --- nav remove ---
  nav.command('remove <slug>')
    .description('Remove a section (and its pages), or one page from it with --page')
    .requiredOption('--section <id|title>', 'Section id or title')
    .option('--page <ref|#n>', 'The page\'s ref, or its 0-based position (#n)')
    .option(cardOpt, cardHelp)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: { section: string; page?: string; card?: string; json?: boolean }) => {
      let removed = '';
      const card = await editWikiCard(ensureContextRoot(), slug, opts.card, (cur) => {
        if (opts.page === undefined) {
          const r = removeSection(cur, opts.section);
          removed = `section ${r.removed.title}`;
          return r.nav;
        }
        const r = removePage(cur, opts.section, opts.page);
        removed = r.removed.ref;
        return r.nav;
      });
      if (opts.json) {
        console.log(JSON.stringify({ slug, removed, card }, null, 2));
        return;
      }
      success(`Removed ${chalk.bold(removed)} from the ${cardName(card)} on ${slug}`);
      if (card.sections.length > 0) printNav(card);
    }));

  // --- nav move ---
  nav.command('move <slug>')
    .description('Reorder: move a section, or a page (--page) within its section or into --to-section, to 0-based --to')
    .requiredOption('--section <id|title>', 'Section id or title')
    .option('--page <ref|#n>', 'The page\'s ref, or its 0-based position (#n)')
    .requiredOption('--to <index>', 'Target 0-based position (negative counts from the end)')
    .option('--to-section <id|title>', 'Move the page into this section')
    .option(cardOpt, cardHelp)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: { section: string; page?: string; to: string; toSection?: string; card?: string; json?: boolean }) => {
      const to = parseIndex(opts.to, '--to')!;
      if (opts.page === undefined && opts.toSection !== undefined) throw new WhiteboardValidationError('--to-section applies to a page (--page <ref|#n>)');
      const card = await editWikiCard(ensureContextRoot(), slug, opts.card, (cur) => (opts.page === undefined
        ? moveSection(cur, opts.section, to)
        : movePage(cur, opts.section, opts.page, to, opts.toSection)));
      if (opts.json) {
        console.log(JSON.stringify({ slug, card }, null, 2));
        return;
      }
      success(`Moved ${chalk.bold(opts.page ?? opts.section)} on the ${cardName(card)} on ${slug}`);
      printNav(card);
    }));
}

function parseQuad(raw: string, label: string): BBox {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new WhiteboardValidationError(`${label} must be four numbers x,y,w,h, e.g. 0,900,2400,1000 (got '${raw}')`);
  }
  if (!(parts[2] > 0 && parts[3] > 0)) throw new WhiteboardValidationError(`${label} needs a positive width and height`);
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/**
 * Where `render` may write. Always a `.png`, never through a symlink or onto a folder; while a
 * board agent runs, only inside its scratch folder or `automations/output/<self>/` (the same
 * two folders `--file` may read from).
 */
function assertOutInScope(out: string): string {
  const target = resolve(out);
  if (!/\.png$/i.test(target)) throw new WhiteboardValidationError(`--out must name a .png file (got '${out}')`);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink() || !st.isFile()) throw new WhiteboardValidationError(`--out '${out}' exists and is not a plain file`);
  } catch (err) {
    if (err instanceof WhiteboardValidationError) throw err;
  }
  const parent = realDir(dirname(target));
  if (!parent) throw new WhiteboardValidationError(`--out '${out}': its folder does not exist`);
  if (scopedBoard() !== null) {
    const self = process.env[AGENT_SELF_ENV]?.trim();
    const allowed = [
      realDir(process.env[AGENT_SCRATCH_ENV]?.trim()),
      self ? realDir(join(ensureContextRoot(), 'automations', 'output', self)) : null,
    ].filter((d): d is string => d !== null);
    if (!allowed.some((dir) => dir === parent || isInside(dir, parent))) {
      throw new WhiteboardValidationError(
        `--out '${out}' is outside the folders this agent may write to; use $${AGENT_SCRATCH_ENV} or _dream_context/automations/output/${self || '<self>'}/`,
      );
    }
  }
  return join(parent, basename(target));
}

function registerPlaceAndRender(wb: Command): void {
  // --- place ---
  wb.command('place <slug>')
    .description(`Find free space: a grid-aligned x,y (multiples of ${GRID_PITCH}) where a box of --size covers nothing and keeps 16px clear; read-only`)
    .requiredOption('--size <w,h|s|m|l|xl>', 'The box to place: w,h (e.g. the bbox a draw printed) or a widget size')
    .option('--below <tag>', 'Under the group with this tag, lined up with its left edge')
    .option('--right-of <tag>', 'Right of the group with this tag, lined up with its top')
    .option('--align-left <tag>', 'Line it up with this group\'s left edge (with --below, or alone: the first free slot in its column)')
    .option('--json', 'Machine-readable output')
    .action(run((slug: string, opts: { size: string; below?: string; rightOf?: string; alignLeft?: string; json?: boolean }) => {
      const parsed = parseSize(opts.size)!;
      const [w, h] = typeof parsed === 'string' ? WIDGET_SIZES[parsed] : [parsed.w, parsed.h];
      const anchor = parseAnchor(opts);
      const { board } = readWhiteboard(ensureContextRoot(), slug);
      const pos = placeFree(board.elements, { w, h }, anchor);
      const where = anchor.below ? ` below #${anchor.below}` : anchor.rightOf ? ` right of #${anchor.rightOf}` : '';
      if (opts.json) {
        console.log(JSON.stringify({ slug, x: pos.x, y: pos.y, w, h, at: `${pos.x},${pos.y}`, grid: GRID_PITCH }, null, 2));
        return;
      }
      console.log(`${pos.x},${pos.y}`);
      console.log(chalk.dim(`  A ${w}x${h} box at ${pos.x},${pos.y}${where} covers nothing on ${slug} and sits on the ${GRID_PITCH}px grid.`));
      console.log(chalk.dim(`  This is a read; another session can take the spot before you write. draw/add --at re-check under the board lock,`));
      console.log(chalk.dim(`  and draw/add ${anchor.below ? `--below ${anchor.below}` : anchor.rightOf ? `--right-of ${anchor.rightOf}` : '--below <tag>'} picks the spot under the lock itself.`));
    }));

  // --- render ---
  wb.command('render [slug]')
    .description('Draw a board, a tagged group or a region as a PNG, without a browser: shapes, arrows and text as laid out, widgets as titled cards, pictures as placeholders')
    .requiredOption('--out <file.png>', 'Where to write the PNG')
    .option('--tag <tag>', 'Frame the group with this tag (outlined in red); everything around it is drawn too, so an overlap shows')
    .option('--region <x,y,w,h>', 'Draw exactly this board rectangle')
    .option('--band <y0,y1>', 'Draw the board between two y coordinates, full width: walk a tall board in strips')
    .option('--file <path>', 'Render an .excalidraw.md or scene .json instead of a board (e.g. one the excalidraw skill just built)')
    .option('--scale <n>', `Output pixels per board unit (default 1, shrunk so the longest side stays within 2000px; at most ${MAX_SIDE}px either way)`)
    .option('--json', 'Machine-readable output')
    .action(run((slug: string | undefined, opts: { out: string; tag?: string; region?: string; band?: string; file?: string; scale?: string; json?: boolean }) => {
      if ((slug === undefined) === (opts.file === undefined)) throw new WhiteboardValidationError('name a board <slug> or pass --file <path>, one of the two');
      if ([opts.tag, opts.region, opts.band].filter((v) => v !== undefined).length > 1) {
        throw new WhiteboardValidationError('use one of --tag, --region, --band');
      }
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
      const out = assertOutInScope(opts.out);
      let elements: WhiteboardElement[];
      let name: string;
      if (slug !== undefined) {
        elements = readWhiteboard(ensureContextRoot(), slug).board.elements;
        name = slug;
      } else {
        const file = assertFileInScope(opts.file!);
        elements = readImportSource(readFileSync(file, 'utf-8'), basename(opts.file!));
        name = basename(opts.file!);
      }
      const live = liveElements(elements);
      let region = contentRegion(live);
      let outline: { box: BBox; label: string } | undefined;
      let foreign: ReturnType<typeof occupantsOf> = [];
      if (opts.tag !== undefined) {
        const box = tagBBox(live, opts.tag);
        region = { x: box.x - 120, y: box.y - 120, w: box.w + 240, h: box.h + 240 };
        outline = { box, label: `#${opts.tag}` };
        foreign = occupantsOf(live, box).filter((o) => o.tag !== opts.tag);
      } else if (opts.region !== undefined) {
        region = parseQuad(opts.region, '--region');
      } else if (opts.band !== undefined) {
        const band = parsePair(opts.band, '--band')!;
        if (!(band[1] > band[0])) throw new WhiteboardValidationError('--band needs y0 < y1');
        region = { x: region.x, y: band[0], w: region.w, h: band[1] - band[0] };
      }
      let scale = fitScale(region);
      if (opts.scale !== undefined) {
        scale = Number(opts.scale);
        if (!(scale > 0 && scale <= 8)) throw new WhiteboardValidationError(`--scale must be a number above 0 and at most 8 (got '${opts.scale}')`);
      }
      scale = Math.min(scale, MAX_SIDE / Math.max(region.w, region.h, 1));
      const r = renderScene(live, { region, scale, outline });
      writeFileSync(out, r.png);
      const rounded = Math.round(scale * 1000) / 1000;
      if (opts.json) {
        console.log(JSON.stringify({
          out, width: r.width, height: r.height, scale: rounded, region, drawn: r.drawn,
          ...(opts.tag !== undefined ? { tag: opts.tag, overlaps: foreign } : {}),
        }, null, 2));
        return;
      }
      success(`Rendered ${name} → ${out}  ${chalk.dim(`(${r.width}x${r.height}px, scale ${rounded}, ${r.drawn} element${r.drawn === 1 ? '' : 's'}, region ${formatBBox(region)})`)}`);
      if (foreign.length > 0) {
        const counts = new Map<string, number>();
        for (const o of foreign) counts.set(o.tag ? `#${o.tag}` : 'untagged', (counts.get(o.tag ? `#${o.tag}` : 'untagged') ?? 0) + 1);
        const list = [...counts.entries()].map(([t, n]) => `${t} ${n}`).join(', ');
        console.log(chalk.yellow('⚠') + ` ${foreign.length} element${foreign.length === 1 ? '' : 's'} not tagged ${opts.tag} sit inside its box (${list}); \`--json\` lists them.`);
      }
      if (scale < 0.75) console.log(chalk.dim(`  Text is small at scale ${rounded}; render a --band or --region to read it.`));
    }));
}

export function registerWhiteboardCommand(program: Command): void {
  const wb = program
    .command('whiteboard')
    .description('Read and edit whiteboards: excalidraw boards carrying live widgets (insight, knowledge, task, todo, note, html, web, wiki)');

  // --- list ---
  wb.command('list', { isDefault: true })
    .description('List whiteboards')
    .option('--json', 'Machine-readable output')
    .action(run((opts: { json?: boolean }) => {
      const boards = listWhiteboards(ensureContextRoot());
      if (opts.json) {
        console.log(JSON.stringify(boards, null, 2));
        return;
      }
      if (boards.length === 0) {
        info('No whiteboards yet. Create one: dreamcontext whiteboard create "<name>"');
        return;
      }
      for (const b of boards) {
        const note = b.corrupt ? chalk.red(`  (does not parse: ${b.corrupt})`) : chalk.dim(`  ${b.elements} element${b.elements === 1 ? '' : 's'}`);
        const mark = b.isDefault ? chalk.cyan('  (default)') : '';
        console.log(`  ${chalk.bold(b.name)}  ${chalk.dim(b.slug)}${mark}${note}`);
      }
      if (!boards.some((b) => b.isDefault)) {
        console.log(chalk.dim(`  The default board "${DEFAULT_WHITEBOARD.name}" (${DEFAULT_WHITEBOARD.slug}) is created the first time the dashboard opens it.`));
      }
    }));

  // --- create ---
  wb.command('create <name>')
    .description('Create a whiteboard (the name is kept verbatim; the slug is derived from it)')
    .option('-d, --description <text>', 'One-line description', '')
    .option('--json', 'Machine-readable output')
    .action(run((name: string, opts: { description: string; json?: boolean }) => {
      // A new board is "another board" by definition.
      const home = scopedBoard();
      if (home !== null) throw new WhiteboardValidationError(`this agent acts only on its own board '${home}' and cannot create boards`);
      const created = createWhiteboard(ensureContextRoot(), name, opts.description);
      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
        return;
      }
      success(`Created whiteboard ${chalk.bold(name)} → ${created.slug}`);
      console.log(chalk.dim(`  ${created.path}`));
    }));

  // --- rename ---
  wb.command('rename <slug> <name>')
    .description('Rename a whiteboard: the display name changes, the slug (and every link to it) stays')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, name: string, opts: { json?: boolean }) => {
      assertBoardInScope(slug);
      const renamed = await renameWhiteboard(ensureContextRoot(), slug, name);
      if (opts.json) {
        console.log(JSON.stringify(renamed, null, 2));
        return;
      }
      success(`Renamed ${chalk.dim(slug)} → ${chalk.bold(renamed.name)}`);
    }));

  // --- show ---
  wb.command('show <slug> [id]')
    .description('Show a board\'s live elements (or one element with --full); the board form opens with each tag\'s count and box, and what changed since this session last ran show')
    .option('--json', 'Machine-readable output')
    .option('--full', 'Do not truncate note markdown / html payloads')
    .action(run((slug: string, id: string | undefined, opts: { json?: boolean; full?: boolean }) => {
      const root = ensureContextRoot();
      const { board, rev } = readWhiteboard(root, slug);
      const live = liveElements(board.elements);
      if (id) {
        const el = live.find((e) => e.id === id);
        if (!el) throw new WhiteboardValidationError(`no live element '${id}' on ${slug}`);
        const view = describeElement(el, !!opts.full);
        if (opts.json) console.log(JSON.stringify(view, null, 2));
        else {
          printView(view);
          if (view.markdown ?? view.html) console.log(view.markdown ?? view.html);
        }
        return;
      }
      const views = live.map((e) => describeElement(e, !!opts.full));
      const wikis = wikiCards(live).map((el) => ({ ...wikiCardView(el), size: describeElement(el).size }));
      const groups = tagGroups(live);
      const content = unionBBox(live.map(elementBBox));
      const { since, first } = noteShow(root, slug, rev, board.elements);
      if (opts.json) {
        console.log(JSON.stringify({
          slug,
          name: boardName(board, slug),
          description: typeof board.frontmatter.description === 'string' ? board.frontmatter.description : '',
          // The board at a glance: what is where, by tag (`tag: null` = untagged).
          summary: { elements: live.length, content, groups },
          // What changed since this session's last `show` (null: nothing did, or first look).
          since: since ? sinceJson(since) : null,
          firstShow: first,
          elements: views,
          wikis,
          // Who is on this board: `home` agents act only here, the rest are attached.
          agents: agentsOnElements(root, slug, live),
        }, null, 2));
        return;
      }
      console.log(chalk.bold(boardName(board, slug)) + chalk.dim(`  (${slug}, ${views.length} element${views.length === 1 ? '' : 's'}${content ? `, content @${formatBBox(content)}` : ''})`));
      if (groups.length > 0) {
        const width = Math.max(...groups.map((g) => (g.tag ? g.tag.length + 1 : 8)));
        for (const g of groups) {
          const name = g.tag ? `#${g.tag}` : 'untagged';
          console.log(`  ${chalk.cyan(name.padEnd(width))}  ${String(g.count).padStart(4)} element${g.count === 1 ? ' ' : 's'}  ${chalk.dim(`@${formatBBox(g.bbox)}`)}`);
        }
      }
      if (since) console.log(chalk.yellow('⚠') + ' ' + sinceLine(since));
      else if (first) console.log(chalk.dim('  First show of this board in this session; the next show says what anyone else changed in between.'));
      else console.log(chalk.dim('  Unchanged by anyone else since your last show.'));
      for (const v of views) printView(v);
      for (const w of wikis) {
        if (w.sections.length === 0) continue;
        console.log(chalk.bold(cardName(w)) + chalk.dim(`  ${w.id}`));
        printNav(w);
      }
    }));

  // --- add ---
  wb.command('add <slug> <kind>')
    .description(`Add a widget: ${WIDGET_KINDS.join(' | ')}; or a picture: image --file <png|jpg|gif|webp>`)
    .option('--ref <ref>', 'insight / task slug; for knowledge (a page): a knowledge slug or a project-relative .md/.pdf/.html path; for lab-card: <board>/<card-id>')
    .option('--title <text>', 'Widget title (a wiki card needs one)')
    .option('--text <text>', 'Note markdown or HTML block content')
    .option('--file <path>', 'Read note markdown / HTML block content from a file; for image, the picture (PNG, JPEG, GIF or WebP)')
    .option('--url <url-or-path>', 'Web embed: an https URL, http://localhost[:port], or a .html/.pdf/picture file (project-relative or absolute)')
    .option('--item <text>', 'Todo item (repeatable)', collect, [])
    .option('--at <x,y>', 'Top-left position (default: next free grid slot right of / below existing content); refused when it would cover a live element')
    .option('--below <tag>', 'Place it in the first free grid slot under the group with this tag, lined up with its left edge (decided under the board lock)')
    .option('--right-of <tag>', 'Place it in the first free grid slot right of the group with this tag, lined up with its top')
    .option('--align-left <tag>', 'With --below (or alone): line it up with this group\'s left edge instead')
    .option('--allow-overlap', 'Write it even where it covers live elements')
    .option('--size <s|m|l|xl|w,h>', `Grid size S 180x180, M 376x180, L 376x376, XL 768x376, or free-form w,h (default per kind: ${Object.entries(DEFAULT_WIDGET_SIZES).map(([k, v]) => `${k} ${v}`).join(', ')}; an image comes in at its own shape, longest side 640)`)
    .option('--tag <tag>', 'Group tag, for `remove --tag`')
    .option('--color <color>', `Card tint: ${CARD_COLORS.join(' | ')}`)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, kind: string, opts: PlaceOpts & {
      ref?: string; title?: string; text?: string; file?: string; url?: string; item: string[];
      size?: string; tag?: string; color?: string; json?: boolean;
    }) => {
      if (kind === 'image') {
        await addImage(slug, opts);
        return;
      }
      if (!isWidgetKind(kind)) throw new WhiteboardValidationError(`unknown widget kind '${kind}' (one of ${WIDGET_KINDS.join(', ')}, image)`);
      assertBoardInScope(slug);
      const root = ensureContextRoot();
      const at = parseAt(opts.at);
      const anchor = parseAnchor(opts);
      const size = parseSize(opts.size);
      const body = readTextOpt(opts);
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
      if (opts.color !== undefined && !isCardColor(opts.color)) {
        throw new WhiteboardValidationError(`invalid card color '${opts.color}' (one of ${CARD_COLORS.join(', ')})`);
      }

      const payload: Omit<WidgetPayload, 'v' | 'kind'> = {
        title: opts.title,
        tag: opts.tag,
        size: typeof size === 'string' ? size : undefined,
        color: opts.color as CardColor | undefined,
      };
      if (kind === 'insight' || kind === 'knowledge' || kind === 'task' || kind === 'lab-card') {
        if (!opts.ref) throw new WhiteboardValidationError(`${kind} widget needs --ref ${kind === 'lab-card' ? '<board>/<card-id>' : '<slug>'}`);
        if (!isValidWidgetRef(kind, opts.ref)) {
          throw new WhiteboardValidationError(kind === 'knowledge'
            ? `invalid page ref '${opts.ref}' (a knowledge slug, or a project-relative .md/.pdf/.html path with no '..')`
            : kind === 'lab-card'
              ? `invalid lab card ref '${opts.ref}' (expected <board>/<card-id>, e.g. growth/c-signups; \`dreamcontext lab board show <board>\` lists card ids)`
              : `invalid ref '${opts.ref}'`);
        }
        payload.ref = opts.ref;
      } else if (kind === 'todo') {
        payload.items = opts.item.map(newTodoItem);
      } else if (kind === 'note') {
        payload.markdown = body ?? '';
      } else if (kind === 'html') {
        if (body === undefined) throw new WhiteboardValidationError('html widget needs --text or --file');
        payload.html = body;
      } else if (kind === 'web') {
        payload.url = checkWebUrl(opts.url);
      } else if (kind === 'wiki') {
        if (!opts.title?.trim()) throw new WhiteboardValidationError('wiki widget needs --title "<title>"');
        payload.sections = [];
      }
      if (kind === 'agent') {
        // Unlike an insight or a task, an agent cannot "come later" on its own: a card for an
        // unknown slug is a typo, so it is refused rather than warned about.
        if (!opts.ref) throw new WhiteboardValidationError('agent widget needs --ref <agent-slug> (`dreamcontext agents list` lists them)');
        if (!isValidWidgetRef(kind, opts.ref)) throw new WhiteboardValidationError(`invalid agent slug '${opts.ref}'`);
        if (!getAgent(root, opts.ref)) {
          throw new WhiteboardValidationError(`no agent '${opts.ref}' in this project (\`dreamcontext agents list\` lists them)`);
        }
        payload.ref = opts.ref;
      }

      let id = '';
      let box: BBox | null = null;
      const res = await mutateWhiteboard(root, slug, (board) => {
        const free = typeof size === 'object' ? size : undefined;
        const own = free || payload.size ? undefined : DEFAULT_WIDGET_BOXES[kind];
        const [w, h] = free ? [free.w, free.h] : own ?? WIDGET_SIZES[payload.size ?? DEFAULT_WIDGET_SIZES[kind]];
        // Placed on the board this lock just read: a write another session made since your
        // last `show` is in it.
        const pos = at ?? placeFree(board.elements, { w, h }, anchor);
        const [index] = nextIndices(board.elements, 1);
        const el = makeWidgetElement(kind, payload, { x: pos.x, y: pos.y, w: free?.w, h: free?.h }, index);
        box = elementBBox(el);
        if (!opts.allowOverlap) assertFree(board.elements, box, { slug, what: `add this ${kind} widget` });
        id = el.id;
        board.elements.push(el);
      });
      noteOwnWrite(root, slug, res, [id]);

      // A dangling ref renders "not found" on the board; warn, never fail (the entity may come later).
      const dangling = payload.ref && !refExists(root, kind, payload.ref);
      const warning = dangling ? `no ${kind} '${payload.ref}' exists yet; the widget will show "not found" until it does` : null;
      if (opts.json) {
        if (warning) console.error(`⚠ ${warning}`);
        console.log(JSON.stringify({ id, slug, kind }, null, 2));
        return;
      }
      if (warning) console.log(chalk.yellow('⚠') + ' ' + warning);
      success(`Added ${kind} widget ${chalk.bold(id)} to ${slug}${box ? ` @${formatBBox(box)}` : ''}`);
      const look = lookHint(slug, opts.tag, box);
      if (look) console.log(chalk.dim(look));
      if (kind === 'wiki') {
        console.log(chalk.dim(`  Fill it: dreamcontext whiteboard nav add ${slug} --card ${id} --section "<title>" --page <ref>`));
      }
    }));

  /**
   * `add <slug> image --file <path>`: the picture is stored beside the board under its content
   * hash (the same picture twice is one file), then placed as an Excalidraw image element at its
   * own shape. The board is checked first, so a picture is never stored for a missing board.
   */
  async function addImage(slug: string, opts: PlaceOpts & { file?: string; size?: string; tag?: string; json?: boolean }): Promise<void> {
    assertBoardInScope(slug);
    const root = ensureContextRoot();
    if (!opts.file) throw new WhiteboardValidationError('image needs --file <path> (a PNG, JPEG, GIF or WebP picture)');
    if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
    const at = parseAt(opts.at);
    const anchor = parseAnchor(opts);
    const size = parseSize(opts.size);
    if (typeof size === 'string') throw new WhiteboardValidationError('an image takes --size w,h (it has no grid size)');
    const bytes = readFileSync(assertFileInScope(opts.file));
    const mime = sniffImageType(bytes);
    if (!mime) throw new WhiteboardValidationError(`'${opts.file}' is not a PNG, JPEG, GIF or WebP picture`);
    const box = size ? { width: size.w, height: size.h } : imageBox(imageSize(bytes, mime));
    // Checked once before the picture is stored, so a refused --at leaves no file behind; the
    // check that decides runs again under the lock.
    const { board: current } = readWhiteboard(root, slug);
    if (at && !opts.allowOverlap) assertFree(current.elements, { x: at.x, y: at.y, w: box.width, h: box.height }, { slug, what: 'add this image' });
    const fileId = fileIdFor(bytes);
    writeBoardFile(root, slug, fileId, bytes);
    let id = '';
    const res = await mutateWhiteboard(root, slug, (board) => {
      const pos = at ?? placeFree(board.elements, { w: box.width, h: box.height }, anchor);
      const [index] = nextIndices(board.elements, 1);
      const el = makeImageElement(fileId, { x: pos.x, y: pos.y, ...box }, index);
      if (opts.tag !== undefined) el.customData = { dcTag: opts.tag };
      if (!opts.allowOverlap) assertFree(board.elements, elementBBox(el), { slug, what: 'add this image' });
      id = el.id;
      board.elements.push(el);
    });
    noteOwnWrite(root, slug, res, [id]);
    const file = boardFileRelPath(root, slug, fileId);
    if (opts.json) {
      console.log(JSON.stringify({ id, slug, kind: 'image', fileId, file }, null, 2));
      return;
    }
    success(`Added image ${chalk.bold(id)} to ${slug}`);
    if (file) console.log(chalk.dim(`  ${file}`));
  }

  // --- update ---
  wb.command('update <slug> <id>')
    .description('Update a widget (or a text element\'s text)')
    .option('--title <text>', 'New title')
    .option('--text <text>', 'New note markdown / HTML / text')
    .option('--file <path>', 'Read the new content from a file')
    .option('--url <url-or-path>', 'New web target (https URL, localhost URL or file path)')
    .option('--ref <ref>', 'New insight / task slug, knowledge page ref (slug or project-relative .md/.pdf/.html path), or lab-card <board>/<card-id>')
    .option('--item <text>', 'Append a todo item (repeatable)', collect, [])
    .option('--check <n>', 'Tick todo item n (1-based) or item id (repeatable)', collect, [])
    .option('--uncheck <n>', 'Untick todo item n (1-based) or item id (repeatable)', collect, [])
    .option('--at <x,y>', 'Move to x,y')
    .option('--size <s|m|l|xl|w,h>', 'Resize a widget to a grid size, or any element to w,h')
    .option('--color <color>', `Tint a card: ${CARD_COLORS.join(' | ')}, or none to clear it`)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, id: string, opts: {
      title?: string; text?: string; file?: string; url?: string; ref?: string; item: string[];
      check: string[]; uncheck: string[]; at?: string; size?: string; color?: string; json?: boolean;
    }) => {
      assertBoardInScope(slug);
      const update = {
        title: opts.title,
        text: readTextOpt(opts),
        url: opts.url !== undefined ? checkWebUrl(opts.url) : undefined,
        ref: opts.ref,
        addItems: opts.item,
        check: opts.check,
        uncheck: opts.uncheck,
        at: parseAt(opts.at),
        size: parseSize(opts.size),
        color: opts.color as CardColor | 'none' | undefined,
      };
      // The kind-specific check (a knowledge page also takes a path) runs in applyUpdate.
      if (update.ref !== undefined && !isValidRef(update.ref) && !isValidPageRef(update.ref)) {
        throw new WhiteboardValidationError(`invalid ref '${update.ref}'`);
      }
      let view: ElementView | null = null;
      const root = ensureContextRoot();
      const res = await mutateWhiteboard(root, slug, (board) => {
        const i = board.elements.findIndex((e) => e.id === id && e.isDeleted !== true);
        if (i < 0) throw new WhiteboardValidationError(`no live element '${id}' on ${slug}`);
        board.elements[i] = applyUpdate(board.elements[i], update);
        view = describeElement(board.elements[i]);
      });
      noteOwnWrite(root, slug, res, [id]);
      if (opts.json) {
        console.log(JSON.stringify(view, null, 2));
        return;
      }
      success(`Updated ${id} on ${slug}`);
      if (view) printView(view);
    }));

  // --- remove ---
  wb.command('remove <slug> [ids...]')
    .description('Remove elements by id or by --tag; prints the removed group\'s bbox (x,y,w,h)')
    .option('--tag <tag>', 'Remove every element carrying this tag')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, ids: string[], opts: { tag?: string; json?: boolean }) => {
      assertBoardInScope(slug);
      if (ids.length === 0 && opts.tag === undefined) throw new WhiteboardValidationError('name element ids or --tag <tag>');
      let result: ReturnType<typeof removeElements> | null = null;
      const root = ensureContextRoot();
      const res = await mutateWhiteboard(root, slug, (board) => {
        result = removeElements(board.elements, { ids, tag: opts.tag });
        board.elements = result.elements;
      });
      const r = result as unknown as ReturnType<typeof removeElements>;
      noteOwnWrite(root, slug, res, r.removed);
      if (opts.json) {
        console.log(JSON.stringify({ removed: r.removed, bbox: r.bbox }, null, 2));
        return;
      }
      if (r.removed.length === 0) {
        info(`Nothing to remove on ${slug}${opts.tag ? ` tagged '${opts.tag}'` : ''}.`);
        return;
      }
      success(`Removed ${r.removed.length} element${r.removed.length === 1 ? '' : 's'} from ${slug}`);
      if (r.bbox) console.log(`bbox ${formatBBox(r.bbox)}`);
    }));

  registerNavCommands(wb);

  // --- draw ---
  wb.command('draw <slug>')
    .description('Import a drawing built by the excalidraw skill (.excalidraw.md or scene .json) onto a board; refused where it would cover live elements')
    .requiredOption('--file <path>', 'x.excalidraw.md or x.json')
    .option('--at <x,y>', 'Top-left of the imported group (default: right of existing content); refused when the group would cover a live element')
    .option('--below <tag>', 'Place the group in the first free grid slot under the group with this tag, lined up with its left edge (decided under the board lock)')
    .option('--right-of <tag>', 'Place the group in the first free grid slot right of the group with this tag, lined up with its top')
    .option('--align-left <tag>', 'With --below (or alone): line it up with this group\'s left edge instead')
    .option('--allow-overlap', 'Write it even where it covers live elements')
    .option('--tag <tag>', 'Tag every imported element, for `remove --tag`')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: PlaceOpts & { file: string; tag?: string; json?: boolean }) => {
      assertBoardInScope(slug);
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
      const source = readImportSource(readFileSync(assertFileInScope(opts.file), 'utf-8'), basename(opts.file));
      const at = parseAt(opts.at);
      const anchor = parseAnchor(opts);
      const size = sourceBBox(source);
      let imported: ReturnType<typeof prepareImport> | null = null;
      const root = ensureContextRoot();
      // A picture already beside this board (one `show` handed out) comes back as it was.
      const hasFile = (fileId: string) => boardFileRelPath(root, slug, fileId) !== null;
      const res = await mutateWhiteboard(root, slug, (board) => {
        // Placed and checked on the board this lock just read, so a section another session
        // drew after your last `show` is seen here, not after the fact.
        const pos = at ?? (hasAnchor(anchor) && size ? placeFree(board.elements, { w: size.w, h: size.h }, anchor) : undefined);
        imported = prepareImport(source, board.elements, { at: pos, tag: opts.tag, hasFile });
        if (!opts.allowOverlap && imported.bbox) assertFree(board.elements, imported.bbox, { slug, what: `draw ${basename(opts.file)}` });
        board.elements.push(...imported.elements);
      });
      const r = imported as unknown as ReturnType<typeof prepareImport>;
      noteOwnWrite(root, slug, res, r.elements.map((e) => e.id));
      if (opts.json) {
        console.log(JSON.stringify({ ids: r.elements.map((e) => e.id), bbox: r.bbox }, null, 2));
        return;
      }
      success(`Imported ${r.elements.length} element${r.elements.length === 1 ? '' : 's'} onto ${slug}`);
      if (r.bbox) console.log(`bbox ${formatBBox(r.bbox)}`);
      const look = lookHint(slug, opts.tag, r.bbox);
      if (look) console.log(chalk.dim(look));
    }));

  registerPlaceAndRender(wb);
}
