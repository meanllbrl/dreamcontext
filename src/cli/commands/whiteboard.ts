import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import chalk from 'chalk';
import { ensureContextRoot } from '../../lib/context-path.js';
import { success, error, info } from '../../lib/format.js';
import {
  createWhiteboard,
  listWhiteboards,
  mutateWhiteboard,
  nextIndices,
  readWhiteboard,
  boardName,
  DEFAULT_WHITEBOARD,
} from '../../lib/whiteboards/store.js';
import { WhiteboardError, WhiteboardValidationError } from '../../lib/whiteboards/errors.js';
import { checkWebUrl, isValidRef, isValidTag } from '../../lib/whiteboards/validate.js';
import {
  WIDGET_KINDS,
  WIDGET_SIZES,
  DEFAULT_WIDGET_SIZES,
  isWidgetKind,
  isWidgetSize,
  makeWidgetElement,
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
  if (opts.file !== undefined) return readFileSync(opts.file, 'utf-8');
  return opts.text;
}

/** Where a ref of this kind lives in the brain — only used for the does-it-exist warning. */
function refExists(root: string, kind: WidgetKind, ref: string): boolean {
  if (kind === 'insight') return existsSync(join(root, 'lab', 'insights', `${ref}.md`));
  if (kind === 'knowledge') return existsSync(join(root, 'knowledge', `${ref}.md`));
  if (kind === 'task') return existsSync(join(root, 'state', `${ref}.md`));
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
  console.log(`  ${chalk.dim(v.id)}  ${chalk.bold(what)}  ${label.split('\n')[0]}${tag}  ${chalk.dim(`@${formatBBox(v.bbox)}`)}`);
  if (v.items) {
    v.items.forEach((it, i) => console.log(`      ${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}  ${chalk.dim(it.id)}`));
  }
}

export function registerWhiteboardCommand(program: Command): void {
  const wb = program
    .command('whiteboard')
    .description('Read and edit whiteboards: excalidraw boards carrying live widgets (insight, knowledge, task, todo, note, html, web)');

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
      const created = createWhiteboard(ensureContextRoot(), name, opts.description);
      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
        return;
      }
      success(`Created whiteboard ${chalk.bold(name)} → ${created.slug}`);
      console.log(chalk.dim(`  ${created.path}`));
    }));

  // --- show ---
  wb.command('show <slug> [id]')
    .description('Show a board\'s live elements (or one element with --full)')
    .option('--json', 'Machine-readable output')
    .option('--full', 'Do not truncate note markdown / html payloads')
    .action(run((slug: string, id: string | undefined, opts: { json?: boolean; full?: boolean }) => {
      const { board } = readWhiteboard(ensureContextRoot(), slug);
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
      if (opts.json) {
        console.log(JSON.stringify({
          slug,
          name: boardName(board, slug),
          description: typeof board.frontmatter.description === 'string' ? board.frontmatter.description : '',
          elements: views,
        }, null, 2));
        return;
      }
      console.log(chalk.bold(boardName(board, slug)) + chalk.dim(`  (${slug}, ${views.length} element${views.length === 1 ? '' : 's'})`));
      for (const v of views) printView(v);
    }));

  // --- add ---
  wb.command('add <slug> <kind>')
    .description(`Add a widget: ${WIDGET_KINDS.join(' | ')}`)
    .option('--ref <slug>', 'insight / knowledge / task slug')
    .option('--title <text>', 'Widget title')
    .option('--text <text>', 'Note markdown or HTML block content')
    .option('--file <path>', 'Read note markdown / HTML block content from a file')
    .option('--url <https-url>', 'Web embed URL (https only)')
    .option('--item <text>', 'Todo item (repeatable)', collect, [])
    .option('--at <x,y>', 'Top-left position (default: next free grid slot right of / below existing content)')
    .option('--size <s|m|l|xl|w,h>', `Grid size S 180x180, M 376x180, L 376x376, XL 768x376, or free-form w,h (default per kind: ${Object.entries(DEFAULT_WIDGET_SIZES).map(([k, v]) => `${k} ${v}`).join(', ')})`)
    .option('--tag <tag>', 'Group tag, for `remove --tag`')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, kind: string, opts: {
      ref?: string; title?: string; text?: string; file?: string; url?: string; item: string[];
      at?: string; size?: string; tag?: string; json?: boolean;
    }) => {
      if (!isWidgetKind(kind)) throw new WhiteboardValidationError(`unknown widget kind '${kind}' (one of ${WIDGET_KINDS.join(', ')})`);
      const root = ensureContextRoot();
      const at = parseAt(opts.at);
      const size = parseSize(opts.size);
      const body = readTextOpt(opts);
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);

      const payload: Omit<WidgetPayload, 'v' | 'kind'> = {
        title: opts.title,
        tag: opts.tag,
        size: typeof size === 'string' ? size : undefined,
      };
      if (kind === 'insight' || kind === 'knowledge' || kind === 'task') {
        if (!opts.ref) throw new WhiteboardValidationError(`${kind} widget needs --ref <slug>`);
        if (!isValidRef(opts.ref)) throw new WhiteboardValidationError(`invalid ref '${opts.ref}'`);
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
    }));

  // --- update ---
  wb.command('update <slug> <id>')
    .description('Update a widget (or a text element\'s text)')
    .option('--title <text>', 'New title')
    .option('--text <text>', 'New note markdown / HTML / text')
    .option('--file <path>', 'Read the new content from a file')
    .option('--url <https-url>', 'New web URL')
    .option('--ref <slug>', 'New insight / knowledge / task ref')
    .option('--item <text>', 'Append a todo item (repeatable)', collect, [])
    .option('--check <n>', 'Tick todo item n (1-based) or item id (repeatable)', collect, [])
    .option('--uncheck <n>', 'Untick todo item n (1-based) or item id (repeatable)', collect, [])
    .option('--at <x,y>', 'Move to x,y')
    .option('--size <s|m|l|xl|w,h>', 'Resize a widget to a grid size, or any element to w,h')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, id: string, opts: {
      title?: string; text?: string; file?: string; url?: string; ref?: string; item: string[];
      check: string[]; uncheck: string[]; at?: string; size?: string; json?: boolean;
    }) => {
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
      };
      if (update.ref !== undefined && !isValidRef(update.ref)) throw new WhiteboardValidationError(`invalid ref '${update.ref}'`);
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

  // --- draw ---
  wb.command('draw <slug>')
    .description('Import a drawing built by the excalidraw skill (.excalidraw.md or scene .json) onto a board')
    .requiredOption('--file <path>', 'x.excalidraw.md or x.json')
    .option('--at <x,y>', 'Top-left of the imported group (default: right of existing content)')
    .option('--tag <tag>', 'Tag every imported element, for `remove --tag`')
    .option('--json', 'Machine-readable output')
    .action(run(async (slug: string, opts: { file: string; at?: string; tag?: string; json?: boolean }) => {
      if (opts.tag !== undefined && !isValidTag(opts.tag)) throw new WhiteboardValidationError(`invalid tag '${opts.tag}'`);
      const source = readImportSource(readFileSync(opts.file, 'utf-8'), basename(opts.file));
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
