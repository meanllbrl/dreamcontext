import type { HubResult, RenderCardFrame, RenderCardResult, RenderCardRoot } from '../../../src/lib/telegram/contract.js';

/**
 * The window's side of `render_card` (plan R5, S1, S2, T4): an INSIGHT card on the Super stage,
 * cloned for a picture the server seals and renders. The window only supplies parts:
 *  - `body`: the card's DOM as `outerHTML`, with every html/v1 insight frame replaced by the exact
 *    placeholder `<iframe data-dc-frame="N"></iframe>` (the frame's bytes never travel: the server
 *    rebuilds its srcdoc from its own lab cache by `slug`), `<script>` elements and `on*`
 *    attributes removed, `data-cue` dropped;
 *  - `frames[]`: `{id, slug, w, h, scale, scheme}` per placeholder (structured geometry, no style
 *    string);
 *  - `root`: the theme, the class tokens and the zoom of `<html>` (no raw style string);
 *  - `size`: the card's on-screen rectangle.
 * Anything else answers `unsupported` (another card kind, an app/v1 body, any frame that is not an
 * insight frame), `not_mounted`, `hidden` (zero size) or `too_large` (over 4 MB). The server's
 * scanner refuses whatever it does not allow, so a card the clone cannot prove goes as text.
 */

const MAX_BODY = 4 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

function fail(reason: Extract<RenderCardResult, { ok: false }>['reason']): HubResult {
  return { ok: false, error: reason, reason };
}

/** `scope` = the asking project's own surface (never the whole document: one window holds every
 *  open project, and container ids repeat across them). */
export function renderCardFromDom(args: unknown, scope: ParentNode | null): HubResult {
  const target = (args as { target?: unknown } | null)?.target as { kind?: unknown; id?: unknown } | undefined;
  if (!target || target.kind !== 'container' || typeof target.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(target.id)) return fail('unsupported');
  if (!scope) return fail('not_mounted');
  const el = scope.querySelector<HTMLElement>(`.super-card-frame[data-container-id="${target.id}"]`);
  if (!el) return fail('not_mounted');
  if (el.dataset.kind !== 'insight') return fail('unsupported');
  const doc = el.ownerDocument;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return fail('hidden');
  // A card still landing (opacity 0), parked in a strip or not visible draws nothing true.
  const cs = getComputedStyle(el);
  if (el.classList.contains('super-card-frame--pending') || el.closest('[data-strip-hidden]') || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return fail('hidden');
  const html = doc.documentElement;
  const theme = html.dataset.theme === 'dark' ? 'dark' : 'light';

  const liveFrames = Array.from(el.querySelectorAll('iframe'));
  // Only html/v1 insight frames are kept (as placeholders); any other frame (an app/v1 body
  // needs the live host bridge) means the card goes as text.
  if (liveFrames.some((f) => !f.dataset.dcInsight)) return fail('unsupported');
  const frames: RenderCardFrame[] = [];
  const clone = el.cloneNode(true) as HTMLElement;
  const cloned = Array.from(clone.querySelectorAll('iframe'));
  liveFrames.forEach((f, i) => {
    const slug = f.dataset.dcInsight ?? '';
    const r = f.getBoundingClientRect();
    if (!SLUG_RE.test(slug)) return;
    const id = frames.length;
    frames.push({ id, slug, w: Math.round(r.width), h: Math.round(r.height), scale: 1, scheme: theme });
    const ph = doc.createElement('iframe');
    ph.setAttribute('data-dc-frame', String(id));
    cloned[i]?.replaceWith(ph);
  });
  if (frames.length !== liveFrames.length) return fail('unsupported');
  for (const s of Array.from(clone.querySelectorAll('script'))) s.remove();
  // The card at the picture's origin: no stage position, no transient motion state.
  clone.style.left = '0px';
  clone.style.top = '0px';
  clone.style.removeProperty('transform');
  clone.classList.remove('super-card-frame--pending');
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    for (const a of Array.from(node.attributes)) {
      if (/^on/i.test(a.name) || a.name === 'data-cue') node.removeAttribute(a.name);
    }
  }
  // Placeholders exactly as the server expects them (no attribute other than data-dc-frame).
  let body = clone.outerHTML;
  if (body.length > MAX_BODY) return fail('too_large');
  const zoomRaw = Number.parseFloat(getComputedStyle(html).getPropertyValue('--zoom'));
  const root: RenderCardRoot = {
    theme,
    cls: Array.from(html.classList).filter((c) => /^[A-Za-z0-9_-]+$/.test(c)),
    zoom: Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1,
    scheme: theme,
    tokens: {},
  };
  body = body.trim();
  return { ok: true, body, frames, root, size: { w: Math.round(rect.width), h: Math.round(rect.height) } };
}
