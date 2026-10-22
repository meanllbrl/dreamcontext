/**
 * A card's readable name (owner 2026-10-22: a group tile listed "_dream_context/tm…" paths and
 * task slugs: "başlıkları yok, bu da bir problem"). Wherever the stage names a card (its tile,
 * a group's list, a panel, Others) it is this:
 *
 * - the label the agent gave (`--title`, `--titles`), wrapper tags taken off;
 * - a chat: its brief (else the tab's title);
 * - a task: the task's own title;
 * - a picture or a local page: its file name made readable ("A-agac-listede.png" → "A agac
 *   listede"); an https page: its host and path;
 * - anything else named by a slug: the slug made readable.
 */
import type { SuperContainer } from '../../../lib/superTypes';

/** The `<untrusted-…>` fence (and any other tag) is never part of a name. */
export function stripTags(text: string): string {
  return text.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi, '').replace(/\s+/g, ' ').trim();
}

/** "my-file_name" → "My file name". */
export function humanizeWords(raw: string): string {
  const words = raw.replace(/[-_.+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toLocaleUpperCase() + words.slice(1) : '';
}

/** A file path's name without its folder, extension or a leading timestamp ("1792…-"). */
export function humanizeFile(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/^\d{8,}[-_]/, '');
  return humanizeWords(stem) || base;
}

/** An https page: its host and path ("example.com/pricing"); a local file: its name. */
export function pageName(ref: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return humanizeFile(ref);
  try {
    const u = new URL(ref);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.host}${path}`;
  } catch {
    return ref;
  }
}

export interface TitleSources {
  /** A chat card's name: its brief, else its tab title. */
  chat: (ref: string) => string;
  /** A team card's member. */
  team: (ref: string) => string | undefined;
  /** A task's own title, once the task list is read. */
  task: (slug: string) => string | undefined;
}

export function cardTitle(c: Pick<SuperContainer, 'kind' | 'ref' | 'title'>, from: TitleSources): string {
  const given = c.title ? stripTags(c.title) : '';
  if (c.kind === 'chat') return stripTags(from.chat(c.ref)) || given || c.ref.slice(0, 8);
  if (given) return given;
  switch (c.kind) {
    case 'team': return from.team(c.ref) ?? c.ref;
    case 'task': return from.task(c.ref) || humanizeWords(c.ref);
    case 'image': return humanizeFile(c.ref);
    case 'web': return pageName(c.ref);
    case 'browser': return c.ref.slice(0, 8);
    default: return humanizeWords(c.ref);
  }
}
