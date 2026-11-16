import matter from 'gray-matter';
import { join } from 'node:path';
import { readTaskHead } from '../agents/task-jobs.js';
import { htmlToText } from '../lab/htmlText.js';
import { getInsight, readCache } from '../lab/store.js';
import { readVaultFileSafe } from '../vault-read.js';
import { pageRefKind, widgetPayloadOf, type WhiteboardElement } from './widgets.js';

/**
 * What a widget SHOWS, for `whiteboard export`: its title and the content the dashboard draws,
 * from what is already on disk (the note's own text, a todo's items, an insight's last cached
 * value). Never a fetch, never a sync: an export draws the board as it was last seen, and says
 * "as of" for a cached number.
 *
 * Every file is read through the vault's safe reader (no symlink on the way, inside the
 * brain), so a widget's ref can never make the export read a file outside the project.
 */

export interface WidgetFace {
  title: string;
  /** The small grey line under the title: the kind, a status, "as of". */
  sub: string;
  /** A big number (an insight's cached value). */
  value?: string;
  /** The insight's first series, oldest first, for a sparkline. */
  spark?: number[];
  /** Body lines, already plain text. */
  lines: string[];
}

const MAX_LINES = 400;

/** Markdown to the lines a card shows: markers off, blank runs collapsed. */
export function markdownLines(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    let l = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_m, sp: string, c: string) => `${sp}${c === ' ' ? '[ ]' : '[x]'} `)
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, '$1$2')
      .trimEnd();
    if (/^\s*(\|?\s*:?-{3,}:?\s*)+\|?\s*$/.test(l) || /^\s*([-*_]\s*){3,}$/.test(l)) l = '';
    if (!l && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
    if (out.length >= MAX_LINES) break;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

function compact(n: number): string {
  const abs = Math.abs(n);
  const fmt = (v: number, s: string) => `${(Math.round(v * 10) / 10).toLocaleString('en-US')}${s}`;
  if (abs >= 1e9) return fmt(n / 1e9, 'B');
  if (abs >= 1e6) return fmt(n / 1e6, 'M');
  if (abs >= 1e4) return fmt(n / 1e3, 'K');
  return (Math.round(n * 100) / 100).toLocaleString('en-US');
}

function frontmatterOf(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try { return (matter(raw).data ?? {}) as Record<string, unknown>; } catch { return {}; }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** The face of one widget (or embed) element; null for an element that is not one, or one
 *  whose files cannot be read as expected (it is then drawn as its titled card). */
export function widgetFace(root: string | null, el: WhiteboardElement): WidgetFace | null {
  try {
    return faceOf(root, el);
  } catch {
    return null;
  }
}

function faceOf(root: string | null, el: WhiteboardElement): WidgetFace | null {
  const dc = widgetPayloadOf(el);
  if (!dc) return null;
  const title = str(dc.title);
  switch (dc.kind) {
    case 'note': {
      const lines = markdownLines(dc.markdown ?? '');
      return { title: title ?? '', sub: '', lines };
    }
    case 'todo': {
      const items = dc.items ?? [];
      const done = items.filter((i) => i.done).length;
      return { title: title ?? 'To-do', sub: `${done}/${items.length} done`, lines: items.map((i) => `${i.done ? '[x]' : '[ ]'} ${i.text}`) };
    }
    case 'html': {
      const text = htmlToText(dc.html ?? '', { maxChars: 20_000 });
      return { title: title ?? 'HTML', sub: 'html', lines: markdownLines(text) };
    }
    case 'web':
      return { title: title ?? (dc.url ?? 'Web page'), sub: 'web', lines: dc.url ? [dc.url] : [] };
    case 'wiki': {
      const lines: string[] = [];
      for (const s of dc.sections ?? []) {
        lines.push(s.title);
        for (const p of s.pages ?? []) lines.push(`  • ${p.label ?? p.ref}`);
      }
      return { title: title ?? 'Wiki', sub: 'wiki', lines };
    }
    case 'insight': {
      const ref = dc.ref ?? '';
      const manifest = root && ref ? getInsight(root, ref) : null;
      const cache = root && ref ? readCache(root, ref) : null;
      const name = title ?? manifest?.title ?? ref;
      if (!cache) return { title: name, sub: 'insight · no cached value yet', lines: [] };
      const asOf = typeof cache.fetchedAt === 'string' && cache.fetchedAt ? ` · as of ${cache.fetchedAt.slice(0, 10)}` : '';
      const unit = cache.unit ?? manifest?.unit ?? '';
      const face: WidgetFace = { title: name, sub: `insight${asOf}`, lines: [] };
      if (typeof cache.latest === 'number' && Number.isFinite(cache.latest)) face.value = `${compact(cache.latest)}${unit ? ` ${unit}` : ''}`;
      const points = Array.isArray(cache.series) && Array.isArray(cache.series[0]?.points) ? cache.series[0].points : [];
      const series = points.map((p) => p?.v).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (series.length >= 2) face.spark = series;
      if (!face.value && cache.html) face.lines = markdownLines(htmlToText(cache.html, { maxChars: 4000 }));
      if (cache.error) face.lines.push(`last sync failed: ${cache.error}`.slice(0, 200));
      return face;
    }
    case 'task': {
      const ref = dc.ref ?? '';
      const head = root && ref ? readTaskHead(root, ref) : null;
      if (!head) return { title: title ?? ref, sub: 'task · not found', lines: [] };
      const status = str(head.data.status) ?? '';
      const prio = str(head.data.priority);
      return { title: title ?? head.name, sub: `task · ${status}${prio ? ` · ${prio}` : ''}`, lines: [] };
    }
    case 'knowledge': {
      const ref = dc.ref ?? '';
      const kind = pageRefKind(ref);
      if (kind === 'knowledge' && root) {
        const fm = frontmatterOf(readVaultFileSafe(root, join('knowledge', `${ref}.md`)));
        return { title: title ?? str(fm.name) ?? ref, sub: 'page', lines: str(fm.description) ? [str(fm.description)!] : [] };
      }
      return { title: title ?? ref.split('/').pop() ?? 'Page', sub: kind ? `page · ${kind}` : 'page', lines: [] };
    }
    default:
      return { title: title ?? dc.ref ?? dc.kind, sub: `${dc.kind}${dc.ref && dc.ref !== title ? ` · ${dc.ref}` : ''}`, lines: [] };
  }
}
