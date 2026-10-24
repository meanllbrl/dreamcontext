/**
 * The web card's channel to its page, as the window reads it (owner 2026-10-22: "when I click a
 * component in Inspect, the selected component should reach the composer").
 *
 * The page's bridge (`src/lib/super/web-bridge.ts`, injected by the session proxy) posts three
 * things under `WEB_CARD_KEY`: where it is (`hello`), that the owner left Inspect with Esc, and a
 * pick. Everything in a message is the PAGE's word, so `readWebCardMessage` takes only the
 * shapes below, bounded; the card further accepts a message only from its own frame's window at
 * the proxy's origin (webFrameControl.ts).
 *
 * `WEB_CARD_KEY` and `CLEAR_PATH` mirror the server's constants (separate bundle; drift test
 * tests/unit/web-pick.test.ts).
 */

export const WEB_CARD_KEY = '__dreamWebCard';
export const CLEAR_PATH = '/__dreamcontext/clear';

export interface WebPick {
  href: string;
  title: string;
  selector: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  /** The nearest React components, innermost first, when the page is a React app. */
  component: string[] | null;
  box: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** The element drawn as a picture (`data:image/png|jpeg;base64,…`), or null. */
  crop: string | null;
}

export type WebCardMessage =
  | { kind: 'hello'; href: string; title: string }
  | { kind: 'inspect'; on: boolean }
  | { kind: 'pick'; pick: WebPick };

export const MAX_CROP_CHARS = 1_600_000;
const CROP_RE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;
const TAG_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ATTR_RE = /^[a-z][a-z0-9:_-]{0,40}$/;
const NAME_RE = /^[A-Za-z_$][\w$.]{0,80}$/;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // One line each: a newline in a page's attribute must never start a line of the block.
  // eslint-disable-next-line no-control-regex
  const clean = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(-1e6, Math.min(1e6, v))) : null);

function readPick(r: Record<string, unknown>): WebPick | null {
  const href = str(r.href, 2048);
  const selector = str(r.selector, 1000);
  const tag = typeof r.tag === 'string' && TAG_RE.test(r.tag) ? r.tag : null;
  if (!href || !/^https?:\/\//i.test(href) || !selector || !tag) return null;
  const attrs: Record<string, string> = {};
  if (r.attrs && typeof r.attrs === 'object' && !Array.isArray(r.attrs)) {
    for (const [k, v] of Object.entries(r.attrs as Record<string, unknown>).slice(0, 20)) {
      const val = str(v, 200);
      if (ATTR_RE.test(k) && val !== null) attrs[k] = val;
    }
  }
  const component = Array.isArray(r.component)
    ? r.component.filter((n): n is string => typeof n === 'string' && NAME_RE.test(n)).slice(0, 3)
    : [];
  const b = (r.box && typeof r.box === 'object' ? r.box : {}) as Record<string, unknown>;
  const v = (r.viewport && typeof r.viewport === 'object' ? r.viewport : {}) as Record<string, unknown>;
  const crop = typeof r.crop === 'string' && r.crop.length <= MAX_CROP_CHARS && CROP_RE.test(r.crop) ? r.crop : null;
  return {
    href,
    title: str(r.title, 200) ?? '',
    selector,
    tag,
    attrs,
    text: (str(r.text, 300) ?? '').replace(/\s+/g, ' ').trim(),
    component: component.length ? component : null,
    box: { x: num(b.x) ?? 0, y: num(b.y) ?? 0, width: Math.max(0, num(b.width) ?? 0), height: Math.max(0, num(b.height) ?? 0) },
    viewport: { width: Math.max(0, num(v.width) ?? 0), height: Math.max(0, num(v.height) ?? 0) },
    crop,
  };
}

/** A bridge message, or null for anything else. */
export function readWebCardMessage(data: unknown): WebCardMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = (data as Record<string, unknown>)[WEB_CARD_KEY];
  if (!m || typeof m !== 'object') return null;
  const r = m as Record<string, unknown>;
  if (r.kind === 'hello') {
    const href = str(r.href, 2048);
    return href && /^https?:\/\//i.test(href) ? { kind: 'hello', href, title: str(r.title, 200) ?? '' } : null;
  }
  if (r.kind === 'inspect' && typeof r.on === 'boolean') return { kind: 'inspect', on: r.on };
  if (r.kind === 'pick') { const pick = readPick(r); return pick ? { kind: 'pick', pick } : null; }
  return null;
}

/** The page's own address under the proxy (`http://localhost:5173/a?b#c` → `<proxy>/a?b#c`). */
export function proxiedHref(href: string, proxyOrigin: string): string {
  try {
    const u = new URL(href);
    return `${proxyOrigin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return proxyOrigin + '/';
  }
}

/** A proxied address as the dev server knows it (what the owner and the child mean by it). */
export function upstreamHref(href: string, proxyOrigin: string, upstreamOrigin: string): string {
  if (href === proxyOrigin || href.startsWith(`${proxyOrigin}/`) || href.startsWith(`${proxyOrigin}?`) || href.startsWith(`${proxyOrigin}#`)) {
    return upstreamOrigin + href.slice(proxyOrigin.length);
  }
  return href;
}

/** The path (with query and hash) of an address, for Clear's way back. */
export function pathOf(href: string): string {
  try { const u = new URL(href); return `${u.pathname}${u.search}${u.hash}` || '/'; } catch { return '/'; }
}

const ATTR_ORDER = ['id', 'data-testid', 'data-test', 'data-cy', 'name', 'type', 'role', 'aria-label', 'href', 'src', 'alt', 'placeholder', 'title', 'for', 'class'];

/** `<button class="cta" type="submit">`: the tag and its key attributes, quotes neutralised. */
export function elementLine(pick: Pick<WebPick, 'tag' | 'attrs'>): string {
  const parts = ATTR_ORDER.filter((k) => pick.attrs[k] !== undefined)
    .map((k) => `${k}="${pick.attrs[k].replace(/"/g, '\'').replace(/\s+/g, ' ').slice(0, 120)}"`);
  return `<${[pick.tag, ...parts].join(' ')}>`;
}

/** What the chip reads: the component (or the tag) and a clip of the text. */
export function pickChipName(pick: WebPick): string {
  const who = pick.component?.[0] ?? pick.tag;
  const text = pick.text.length > 28 ? `${pick.text.slice(0, 27)}…` : pick.text;
  return text ? `${who} · “${text}”` : `${who} · ${pick.selector.length > 40 ? `${pick.selector.slice(0, 39)}…` : pick.selector}`;
}

/**
 * The block the Super Agent receives for one pick (the chip folds it into the message at send):
 * which card, the page as the dev server knows it, the selector, the element, its text, the
 * React components, the box. The page's words are quoted as JSON strings: they are content to
 * read, never instructions. The picture's path is added once its upload settles.
 */
export function pickBlock(pick: WebPick, card: { id: string; title: string }, page: string): string {
  const title = card.title.replace(/[\u0000-\u001f\u007f“”"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const lines = [
    `[Selected element on card @card:${card.id} “${title}”]`,
    `page: ${page}`,
    `selector: ${pick.selector}`,
    `element: ${elementLine(pick)}`,
  ];
  if (pick.text) lines.push(`text: ${JSON.stringify(pick.text)}`);
  if (pick.component) lines.push(`react: ${pick.component.join(' ← ')}`);
  lines.push(`box: x ${pick.box.x}, y ${pick.box.y}, ${pick.box.width}×${pick.box.height} in a ${pick.viewport.width}×${pick.viewport.height} view`);
  return lines.join('\n');
}

/** A data URL's bytes as a Blob (the picture is uploaded like a pasted image). */
export function dataUrlBlob(dataUrl: string): Blob | null {
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1] });
  } catch {
    return null;
  }
}
