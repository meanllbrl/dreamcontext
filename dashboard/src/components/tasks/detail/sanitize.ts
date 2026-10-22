import DOMPurify, { type DOMPurify as DOMPurifyInstance } from 'dompurify';

/**
 * The ONE sanitizer every marked output in the task drawer goes through. A task body is
 * teammate-writable (brain sync) and agent-written, so its HTML is untrusted.
 *
 * DOMPurify's defaults (as MarkdownPreview uses them) strip scripts, `on*` handlers and
 * `javascript:` URLs. On top of that: no style/iframe/object/embed/form at all, and no image or
 * link that points at this server's own `/api/` (a body must not make the drawer fire API reads
 * on open, or carry a link that does it on click). Links open in a new tab, never as the opener.
 *
 * A dedicated instance, so these hooks never leak into the app's other DOMPurify callers.
 */
export const TASK_FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form'] as const;

/** True for a URL the drawer must not load or link: this server's API (however spelled), or a script URL. */
export function isBlockedUrl(raw: string | null | undefined, base?: string): boolean {
  // Control characters and spaces are dropped first: browsers ignore them inside a scheme.
  const v = (raw ?? '').replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (!v) return false;
  if (v.startsWith('javascript:') || v.startsWith('/api/')) return true;
  const origin = base ?? (typeof window !== 'undefined' ? window.location.href : undefined);
  if (!origin) return false;
  try {
    const u = new URL(v, origin);
    return u.origin === new URL(origin).origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Every attribute that can make the browser load or link a URL. */
const URL_ATTRS = ['src', 'href', 'srcset', 'poster', 'background', 'xlink:href', 'action', 'formaction', 'data'] as const;

/** True when any URL an attribute carries is blocked; `srcset` is a comma list of candidates. */
export function attrHasBlockedUrl(attr: string, value: string | null, base?: string): boolean {
  if (value == null) return false;
  const urls = attr === 'srcset' ? value.split(',').map((c) => c.trim().split(/\s+/)[0]) : [value];
  return urls.some((u) => isBlockedUrl(u, base));
}

/** Remove blocked URL attributes from an already-rendered subtree (mermaid's own SVG output). */
export function stripBlockedUrls(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attr of URL_ATTRS) if (attrHasBlockedUrl(attr, el.getAttribute(attr))) el.removeAttribute(attr);
    if (el.hasAttribute('style') && /url\s*\(/i.test(el.getAttribute('style') ?? '')) el.removeAttribute('style');
  }
}

let instance: DOMPurifyInstance | null = null;

function purifier(): DOMPurifyInstance {
  if (instance) return instance;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.getAttribute) return;
    for (const attr of URL_ATTRS) {
      if (el.hasAttribute(attr) && attrHasBlockedUrl(attr, el.getAttribute(attr))) el.removeAttribute(attr);
    }
    if (el.tagName === 'A' && el.hasAttribute('href')) {
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
  });
  instance = p;
  return p;
}

/** Sanitize marked's HTML for the task drawer. */
export function sanitizeTaskHtml(html: string): string {
  return purifier().sanitize(html, {
    FORBID_TAGS: [...TASK_FORBID_TAGS],
    // `style` can load a url() and can lay a fake full-window panel over the app; `background`
    // is a legacy URL attribute. Neither has a place in a task body.
    FORBID_ATTR: ['style', 'background'],
    ADD_ATTR: ['target'],
  }) as string;
}
