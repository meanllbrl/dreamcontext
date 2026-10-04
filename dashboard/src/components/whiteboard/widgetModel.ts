/**
 * Pure helpers over the widget contract (`lib/whiteboardWidgets.ts`): reading a payload off an
 * element, the link a widget carries, the ref check, and the todo toggle.
 *
 * No React, no CSS, no Excalidraw import: root vitest imports this file.
 */
import {
  WIDGET_KINDS, WIDGET_LINK_PREFIX, isLabCardRef, isValidPageRef, pageRefKind, type PageKind, type WidgetPayload,
} from '../../lib/whiteboardWidgets';

export type WidgetKind = WidgetPayload['kind'];
export type TodoItem = NonNullable<WidgetPayload['items']>[number];

/** The kinds whose payload points at a dreamcontext entity by slug. */
export const REF_KINDS: readonly WidgetKind[] = ['insight', 'knowledge', 'task', 'lab-card'];

/** The server's ref rule (security invariants), re-checked here before a ref reaches a fetch. */
const REF_RE = /^[a-z0-9][a-z0-9\-/]{0,200}$/;

export function isWidgetKind(v: unknown): v is WidgetKind {
  return typeof v === 'string' && (WIDGET_KINDS as readonly string[]).includes(v);
}

export function isValidWidgetRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.split('/').includes('..');
}

/**
 * The ref check for one kind, the server's rule (src/lib/whiteboards/validate.ts): a knowledge
 * widget is a PAGE, whose ref is a knowledge slug OR a project-relative .md/.pdf/.html path;
 * a lab-card's is `<board>/<card-id>`; every other kind takes a slug.
 */
export function isValidRefFor(kind: WidgetKind, ref: unknown): ref is string {
  if (kind === 'lab-card') return isLabCardRef(ref);
  return kind === 'knowledge' ? isValidPageRef(ref) : isValidWidgetRef(ref);
}

/** `validateEmbeddable`: only our own scheme. Every other link is rejected, so Excalidraw's
 *  native iframe embed never runs. */
export function isWidgetLink(link: unknown): boolean {
  return typeof link === 'string' && link.startsWith(WIDGET_LINK_PREFIX);
}

/** The link a widget carries, the same shape the CLI writes (`<kind>/<ref ?? id>`). */
export function widgetLink(kind: WidgetKind, refOrId: string): string {
  return `${WIDGET_LINK_PREFIX}${kind}/${refOrId}`;
}

/** Split a `dreamcontext://<kind>/<rest>` link, or null when it is not one. */
export function parseWidgetLink(link: string): { kind: string; id: string } | null {
  if (!link.startsWith(WIDGET_LINK_PREFIX)) return null;
  const rest = link.slice(WIDGET_LINK_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const kind = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  return id ? { kind, id } : null;
}

/** The widget payload of an element, or null when it is not a widget. */
export function readWidgetPayload(el: { customData?: unknown } | null | undefined): WidgetPayload | null {
  const cd = el?.customData;
  if (!cd || typeof cd !== 'object') return null;
  const dc = (cd as Record<string, unknown>).dc;
  if (!dc || typeof dc !== 'object') return null;
  if (!isWidgetKind((dc as Record<string, unknown>).kind)) return null;
  return dc as WidgetPayload;
}

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';

/** A 21-char element id in Excalidraw's own shape. `getRandomValues`, not `randomUUID`: the
 *  latter is missing outside a secure context (a plain-http tailnet host). */
export function newElementId(): string {
  const bytes = new Uint8Array(21);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b & 63];
  return id;
}

export function newTodoItemId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A copy of `payload` with item `id` flipped. Never mutates: the element it came from is
 *  Excalidraw's, and a new version is built with `newElementWith`. */
export function toggleTodoItem(payload: WidgetPayload, id: string): WidgetPayload {
  const items = (payload.items ?? []).map((it) => (it.id === id ? { ...it, done: !it.done } : it));
  return { ...payload, items };
}

export function addTodoItem(payload: WidgetPayload, text: string): WidgetPayload {
  const clean = text.trim();
  if (!clean) return payload;
  return { ...payload, items: [...(payload.items ?? []), { id: newTodoItemId(), text: clean, done: false }] };
}

export function removeTodoItem(payload: WidgetPayload, id: string): WidgetPayload {
  return { ...payload, items: (payload.items ?? []).filter((it) => it.id !== id) };
}

/**
 * A widget draws no Excalidraw stroke (A18): the card is the frame. Excalidraw paints an
 * element's stroke on the canvas UNDER the widget's DOM, centred on the box edge, so half of it
 * shows outside the card whatever the card's CSS does; the only robust fix is the element's own
 * `strokeColor`. With a transparent stroke AND background Excalidraw would paint its grey
 * "unvalidated embed" placeholder, but only for a link `validateEmbeddable` rejected, which a
 * widget link never is.
 */
export const WIDGET_STROKE = 'transparent';

/** True for a live widget element that still carries a visible stroke (a Phase-1 or CLI-made
 *  widget, or one the user gave a stroke colour): the canvas normalises it once. */
export function hasWidgetStroke(el: { type?: unknown; isDeleted?: unknown; strokeColor?: unknown; customData?: unknown }): boolean {
  return el.type === 'embeddable' && !el.isDeleted && el.strokeColor !== WIDGET_STROKE && readWidgetPayload(el) !== null;
}

/**
 * True when something is selected and every selected element is a widget (A18). The canvas then
 * hides Excalidraw's properties panel (stroke, sloppiness, opacity: meaningless for a card with
 * no frame) and its link popup (the raw `dreamcontext://` URL with edit/embed buttons). A mixed
 * selection, or free drawing alone, keeps both.
 */
export function selectionIsOnlyWidgets(
  elements: readonly { id: string; type?: unknown; isDeleted?: unknown; customData?: unknown }[],
  selectedElementIds: Readonly<Record<string, boolean>>,
): boolean {
  let any = false;
  for (const el of elements) {
    if (!selectedElementIds[el.id] || el.isDeleted) continue;
    if (el.type !== 'embeddable' || readWidgetPayload(el) === null) return false;
    any = true;
  }
  return any;
}

/** A slug read aloud: last path segment, hyphens to spaces, first letter capitalised. */
export function humaniseSlug(slug: string): string {
  const leaf = slug.split('/').filter(Boolean).pop() ?? slug;
  const words = leaf.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

/** A name that is really a slug: the CLI writes the slug into `name:` when no name was given. */
function isSlugLike(name: string, slug: string): boolean {
  return name === slug || name === slug.split('/').pop() || /^[a-z0-9]+(?:[-_/][a-z0-9]+)+$/.test(name);
}

/**
 * The title a knowledge card shows (A19): a frontmatter `title` if the API ever sends one, the
 * `name` when it is a real name, the file's first `# ` heading, else the slug humanised. Never
 * the raw slug.
 */
export function knowledgeTitle(entry: { slug: string; name?: string; content?: string; title?: unknown }): string {
  if (typeof entry.title === 'string' && entry.title.trim()) return entry.title.trim();
  const name = entry.name?.trim() ?? '';
  if (name && !isSlugLike(name, entry.slug)) return name;
  const h1 = /^#[ \t]+(.+?)[ \t#]*$/m.exec(entry.content ?? '')?.[1]?.trim();
  if (h1) return h1;
  return humaniseSlug(entry.slug);
}

/** A task's display name: its `name`, unless that is only its slug, then the slug humanised. */
export function taskTitle(task: { slug: string; name?: string }): string {
  const name = task.name?.trim() ?? '';
  return name && !isSlugLike(name, task.slug) ? name : humaniseSlug(task.slug);
}

// ── page cards: the type label and the title ─────────────────────────────────────────────────

/** The type words every page surface uses: the cards, the wiki card's rows, the picker, the panel. */
export type PageTypeLabel = 'Knowledge' | 'MD' | 'PDF' | 'HTML';

/** The label for what a page ref points at (`pageRefKind`'s answer). */
export function pageKindLabel(kind: PageKind): Exclude<PageTypeLabel, 'Knowledge'>;
export function pageKindLabel(kind: 'knowledge' | PageKind): PageTypeLabel;
export function pageKindLabel(kind: 'knowledge' | PageKind): PageTypeLabel {
  return kind === 'knowledge' ? 'Knowledge' : kind === 'pdf' ? 'PDF' : kind === 'html' ? 'HTML' : 'MD';
}

/**
 * The label a page card's header wears: "Knowledge" for a knowledge slug, the file's type for a
 * project file (MD / PDF / HTML, the page picker's vocabulary), null for an invalid ref. A PDF
 * card never says "Knowledge". THE one place a page ref becomes a type word: the panel's
 * `pageTypeChip` and the picker read it from here.
 */
export function pageTypeLabel(ref: unknown): PageTypeLabel | null {
  const kind = pageRefKind(ref);
  return kind === null ? null : pageKindLabel(kind);
}

/** True when a page ref is a project file path rather than a knowledge slug. */
export function isPagePath(ref: unknown): boolean {
  const kind = pageRefKind(ref);
  return kind !== null && kind !== 'knowledge';
}

/**
 * A file path read as a title: the folder and the extension go, `-` and `_` become spaces, runs
 * of spaces collapse, the first letter is upper-cased and the rest kept as written
 * ("docs/Q3_report-final.html" → "Q3 report final", "README.md" → "README"). A leading dot is
 * not part of the name (".hidden.md" → "Hidden"). A name with nothing left once stripped
 * (".md", ".gitignore", "---.pdf") falls back to the file name.
 *
 * THE one place a file name becomes a title: the cards, the wiki card's rows and the panel's
 * heading (`pageTitleFromPath`) all read it from here.
 */
export function humanizeFileName(path: string): string {
  const leaf = path.split('/').filter(Boolean).pop() ?? path;
  const dot = leaf.lastIndexOf('.');
  const base = dot >= 0 ? leaf.slice(0, dot) : leaf;
  const words = base.replace(/[-_]+/g, ' ').replace(/^[\s.]+/, '').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : leaf;
}

/**
 * A title stamped in a widget payload, unless it is only the ref again: the bare ref, or the
 * raw file name of a path ref (older pickers stamped both). Empty when there is no real stamp.
 */
export function stampedTitle(stamp: unknown, ref: string | null): string {
  const clean = typeof stamp === 'string' ? stamp.trim() : '';
  if (!clean || !ref) return clean;
  const leaf = ref.split('/').filter(Boolean).pop() ?? ref;
  return clean === ref || clean === leaf ? '' : clean;
}

/**
 * The title a page card shows: a real stamped title first; then, for a file path, the file name
 * humanised; for a knowledge slug, the entry's own title (`knowledgeTitle`) when it is loaded,
 * else the slug humanised. Never the raw ref.
 */
export function pageCardTitle(ref: string, stamp?: unknown, entryTitle?: string): string {
  const stamped = stampedTitle(stamp, ref);
  if (stamped) return stamped;
  if (isPagePath(ref)) return humanizeFileName(ref);
  return entryTitle?.trim() || humaniseSlug(ref);
}
