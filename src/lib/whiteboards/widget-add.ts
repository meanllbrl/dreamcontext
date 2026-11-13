/**
 * The ONE engine that turns "add a widget of this kind" into a payload and a box: the CLI's
 * `whiteboard add` and the quick edit (quick-edit.ts) both go through it, so a widget the quick
 * edit adds passes exactly the checks a `whiteboard add` does (ref shape, a todo's items, an html
 * body, a web target, a wiki title, an agent that exists). Callers add their own policy on top
 * (the quick edit narrows web targets and requires every ref to exist), never a second builder.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getBoard } from '../lab/boards.js';
import { getAgent } from '../agents/store.js';
import { WhiteboardValidationError } from './errors.js';
import { newTodoItem } from './ops.js';
import { checkWebUrl, isValidWidgetRef } from './validate.js';
import {
  DEFAULT_WIDGET_BOXES, DEFAULT_WIDGET_SIZES, WIDGET_SIZES, makeWidgetElement, pageRefKind, splitLabCardRef,
  type CardColor, type WhiteboardElement, type WidgetKind, type WidgetPayload, type WidgetSize,
} from './widgets.js';

/** What kind of problem a widget's input has: the quick edit words each one for the owner. */
export type WidgetInputProblem = 'missing' | 'invalid' | 'not_found' | 'web';

export class WidgetInputError extends WhiteboardValidationError {
  constructor(readonly problem: WidgetInputProblem, message: string) { super(message); }
}

export interface WidgetInput {
  ref?: string;
  title?: string;
  /** A note's markdown, an html block's content. */
  text?: string;
  url?: string;
  items?: readonly string[];
  size?: WidgetSize;
  tag?: string;
  color?: CardColor;
}

/** Where a page ref points: a knowledge slug in the brain, or a file relative to the project. */
export function pageExists(root: string, ref: string): boolean {
  if (pageRefKind(ref) === 'knowledge') return existsSync(join(root, 'knowledge', `${ref}.md`));
  return existsSync(join(dirname(root), ref));
}

/** Whether the thing a ref names is in this brain (an insight, a page, a task, a lab card). */
export function widgetRefExists(root: string, kind: WidgetKind, ref: string): boolean {
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
  if (kind === 'agent') {
    try { return !!getAgent(root, ref); } catch { return false; }
  }
  return true;
}

/**
 * A widget's payload from its input, checked the way `whiteboard add` checks it. Throws
 * {@link WidgetInputError}. An agent card for an unknown slug is refused (a typo, never "later").
 */
export function widgetPayloadFor(
  root: string,
  kind: WidgetKind,
  input: WidgetInput,
  opts: { selfOrigin?: string } = {},
): Omit<WidgetPayload, 'v' | 'kind'> {
  const payload: Omit<WidgetPayload, 'v' | 'kind'> = {
    title: input.title,
    tag: input.tag,
    size: input.size,
    color: input.color,
  };
  if (kind === 'insight' || kind === 'knowledge' || kind === 'task' || kind === 'lab-card') {
    if (!input.ref) throw new WidgetInputError('missing', `${kind} widget needs --ref ${kind === 'lab-card' ? '<board>/<card-id>' : '<slug>'}`);
    if (!isValidWidgetRef(kind, input.ref)) {
      throw new WidgetInputError('invalid', kind === 'knowledge'
        ? `invalid page ref '${input.ref}' (a knowledge slug, or a project-relative .md/.pdf/.html path with no '..')`
        : kind === 'lab-card'
          ? `invalid lab card ref '${input.ref}' (expected <board>/<card-id>, e.g. growth/c-signups; \`dreamcontext lab board show <board>\` lists card ids)`
          : `invalid ref '${input.ref}'`);
    }
    payload.ref = input.ref;
  } else if (kind === 'todo') {
    payload.items = (input.items ?? []).map(newTodoItem);
  } else if (kind === 'note') {
    payload.markdown = input.text ?? '';
  } else if (kind === 'html') {
    if (input.text === undefined) throw new WidgetInputError('missing', 'html widget needs --text or --file');
    payload.html = input.text;
  } else if (kind === 'web') {
    try {
      payload.url = checkWebUrl(input.url, opts.selfOrigin);
    } catch (err) {
      throw new WidgetInputError('web', (err as Error).message);
    }
  } else if (kind === 'wiki') {
    if (!input.title?.trim()) throw new WidgetInputError('missing', 'wiki widget needs --title "<title>"');
    payload.sections = [];
  }
  if (kind === 'agent') {
    if (!input.ref) throw new WidgetInputError('missing', 'agent widget needs --ref <agent-slug> (`dreamcontext agents list` lists them)');
    if (!isValidWidgetRef(kind, input.ref)) throw new WidgetInputError('invalid', `invalid agent slug '${input.ref}'`);
    if (!getAgent(root, input.ref)) {
      throw new WidgetInputError('not_found', `no agent '${input.ref}' in this project (\`dreamcontext agents list\` lists them)`);
    }
    payload.ref = input.ref;
  }
  return payload;
}

/** The box a new widget takes: a free-form size, its preset, or the kind's own default. */
export function widgetBox(kind: WidgetKind, payload: Pick<WidgetPayload, 'size'>, free?: { w: number; h: number }): [number, number] {
  if (free) return [free.w, free.h];
  const own = payload.size ? undefined : DEFAULT_WIDGET_BOXES[kind];
  const [w, h] = own ?? WIDGET_SIZES[payload.size ?? DEFAULT_WIDGET_SIZES[kind]];
  return [w, h];
}

/** The widget element at a position (the caller found the spot and the index under its lock). */
export function widgetElementAt(
  kind: WidgetKind,
  payload: Omit<WidgetPayload, 'v' | 'kind'>,
  pos: { x: number; y: number },
  index: string,
  free?: { w: number; h: number },
  now?: number,
): WhiteboardElement {
  return makeWidgetElement(kind, payload, { x: pos.x, y: pos.y, w: free?.w, h: free?.h }, index, now);
}
