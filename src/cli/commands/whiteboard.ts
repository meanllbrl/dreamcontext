import { Command } from 'commander';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
import { getAutomation } from '../../lib/automations/store.js';
import { AGENT_BOARD_ENV, AGENT_SCRATCH_ENV, AGENT_SELF_ENV } from '../../lib/automations/types.js';
import { agentsOnElements } from '../../lib/whiteboards/agents.js';
import { checkWebUrl, isValidRef, isValidTag, isValidWidgetRef } from '../../lib/whiteboards/validate.js';
import {
  WIDGET_KINDS,
  WIDGET_SIZES,
  DEFAULT_WIDGET_SIZES,
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
  gridPlace,
  formatBBox,
  liveElements,
  newTodoItem,
  prepareImport,
  readImportSource,
  removeElements,
  type ElementView,
} from '../../lib/whiteboards/ops.js';
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
  await mutateWhiteboard(root, slug, (board) => {
    const card = resolveWikiCard(board.elements, slug, cardId);
    const i = board.elements.indexOf(card);
    board.elements[i] = applyWikiEdit(card, fn);
    out = wikiCardView(board.elements[i]);
  });
  return out as unknown as WikiCardView;
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
    .description('Show a board\'s live elements (or one element with --full)')
    .option('--json', 'Machine-readable output')
    .option('--full', 'Do not truncate note markdown / html payloads')
    .action(run((slug: string, id: string | undefined, opts: { json?: boolean; full?: boolean }) => {
      const root = ensureContextRoot();
      const { board } = readWhiteboard(root, slug);
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
      if (opts.json) {
        console.log(JSON.stringify({
          slug,
          name: boardName(board, slug),
          description: typeof board.frontmatter.description === 'string' ? board.frontmatter.description : '',
          elements: views,
          wikis,
          // Who is on this board: `home` agents act only here, the rest are attached.
          agents: agentsOnElements(root, slug, live),
        }, null, 2));
        return;
      }
      console.log(chalk.bold(boardName(board, slug)) + chalk.dim(`  (${slug}, ${views.length} element${views.length === 1 ? '' : 's'})`));
      for (const v of views) printView(v);
      for (const w of wikis) {
        if (w.sections.length === 0) continue;
        console.log(chalk.bold(cardName(w)) + chalk.dim(`  ${w.id}`));
        printNav(w);
      }
    }));

  // --- add ---
  wb.command('add <slug> <kind>')
    .description(`Add a widget: ${WIDGET_KINDS.join(' | ')}`)
    .option('--ref <ref>', 'insight / task slug; for knowledge (a page): a knowledge slug or a project-relative .md/.pdf/.html path; for lab-card: <board>/<card-id>')
    .option('--title <text>', 'Widget title (a wiki card needs one)')
    .option('--text <text>', 'Note markdown or HTML block content')
    .option('--file <path>', 'Read note markdown / HTML block content from a file')
    .option('--url <https-url>', 'Web embed URL (https only)')
    .option('--item <text>', 'Todo item (repeatable)', collect, [])
    .option('--at <x,y>', 'Top-left position (default: next free grid slot right of / below existing content)')
    .option('--size <s|m|l|xl|w,h>', `Grid size S 180x180, M 376x180, L 376x376, XL 768x376, or free-form w,h (default per kind: ${Object.entries(DEFAULT_WIDGET_SIZES).map(([k, v]) => `${k} ${v}`).join(', ')})`)
    .option('--tag <tag>', 'Group tag, for `remove --tag`')
    .option('--color <color>', `Card tint: ${CARD_COLORS.join(' | ')}`)
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, kind: string, opts: {
      ref?: string; title?: string; text?: string; file?: string; url?: string; item: string[];
      at?: string; size?: string; tag?: string; color?: string; json?: boolean;
    }) => {
      if (!isWidgetKind(kind)) throw new WhiteboardValidationError(`unknown widget kind '${kind}' (one of ${WIDGET_KINDS.join(', ')})`);
      assertBoardInScope(slug);
      const root = ensureContextRoot();
      const at = parseAt(opts.at);
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
        if (!opts.ref) throw new WhiteboardValidationError('agent widget needs --ref <agent-slug> (`dreamcontext automations list` lists them)');
        if (!isValidWidgetRef(kind, opts.ref)) throw new WhiteboardValidationError(`invalid agent slug '${opts.ref}'`);
        if (!getAutomation(root, opts.ref)) {
          throw new WhiteboardValidationError(`no agent '${opts.ref}' in this project (\`dreamcontext automations list\` lists them)`);
        }
        payload.ref = opts.ref;
      }

      let id = '';
      await mutateWhiteboard(root, slug, (board) => {
        const free = typeof size === 'object' ? size : undefined;
        const [w, h] = free ? [free.w, free.h] : WIDGET_SIZES[payload.size ?? DEFAULT_WIDGET_SIZES[kind]];
        const pos = at ?? gridPlace(board.elements, { w, h });
        const [index] = nextIndices(board.elements, 1);
        const el = makeWidgetElement(kind, payload, { x: pos.x, y: pos.y, w: free?.w, h: free?.h }, index);
        id = el.id;
        board.elements.push(el);
      });

      // A dangling ref renders "not found" on the board; warn, never fail (the entity may come later).
      const dangling = payload.ref && !refExists(root, kind, payload.ref);
      const warning = dangling ? `no ${kind} '${payload.ref}' exists yet; the widget will show "not found" until it does` : null;
      if (opts.json) {
        if (warning) console.error(`⚠ ${warning}`);
        console.log(JSON.stringify({ id, slug, kind }, null, 2));
        return;
      }
      if (warning) console.log(chalk.yellow('⚠') + ' ' + warning);
      success(`Added ${kind} widget ${chalk.bold(id)} to ${slug}`);
      if (kind === 'wiki') {
        console.log(chalk.dim(`  Fill it: dreamcontext whiteboard nav add ${slug} --card ${id} --section "<title>" --page <ref>`));
      }
    }));

  // --- update ---
  wb.command('update <slug> <id>')
    .description('Update a widget (or a text element\'s text)')
    .option('--title <text>', 'New title')
    .option('--text <text>', 'New note markdown / HTML / text')
    .option('--file <path>', 'Read the new content from a file')
    .option('--url <https-url>', 'New web URL')
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
      await mutateWhiteboard(ensureContextRoot(), slug, (board) => {
        const i = board.elements.findIndex((e) => e.id === id && e.isDeleted !== true);
        if (i < 0) throw new WhiteboardValidationError(`no live element '${id}' on ${slug}`);
        board.elements[i] = applyUpdate(board.elements[i], update);
        view = describeElement(board.elements[i]);
      });
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
      await mutateWhiteboard(ensureContextRoot(), slug, (board) => {
        result = removeElements(board.elements, { ids, tag: opts.tag });
        board.elements = result.elements;
      });
      const r = result as unknown as ReturnType<typeof removeElements>;
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
    .description('Import a drawing built by the excalidraw skill (.excalidraw.md or scene .json) onto a board')
    .requiredOption('--file <path>', 'x.excalidraw.md or x.json')
    .option('--at <x,y>', 'Top-left of the imported group (default: right of existing content)')
    .option('--tag <tag>', 'Tag every imported element, for `remove --tag`')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: { file: string; at?: string; tag?: string; json?: boolean }) => {
      assertBoardInScope(slug);
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
      const source = readImportSource(readFileSync(assertFileInScope(opts.file), 'utf-8'), basename(opts.file));
      const at = parseAt(opts.at);
      let imported: ReturnType<typeof prepareImport> | null = null;
      await mutateWhiteboard(ensureContextRoot(), slug, (board) => {
        imported = prepareImport(source, board.elements, { at, tag: opts.tag });
        board.elements.push(...imported.elements);
      });
      const r = imported as unknown as ReturnType<typeof prepareImport>;
      if (opts.json) {
        console.log(JSON.stringify({ ids: r.elements.map((e) => e.id), bbox: r.bbox }, null, 2));
        return;
      }
      success(`Imported ${r.elements.length} element${r.elements.length === 1 ? '' : 's'} onto ${slug}`);
      if (r.bbox) console.log(`bbox ${formatBBox(r.bbox)}`);
    }));
}
