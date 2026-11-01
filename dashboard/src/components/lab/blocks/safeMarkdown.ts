import DOMPurify from 'dompurify';
/**
 * `text` and `callout` blocks render markdown in the APP document (not a
 * sandbox), through MarkdownPreview (DOMPurify). DOMPurify strips scripts and
 * handlers but keeps `<img src="https://...">`, and an image loads the moment
 * the element exists: a board anyone on the team can edit would become a
 * beacon that pings a third party whenever a teammate opens it. So every
 * remote image (and every other element that fetches on creation) is removed
 * from the SOURCE before it is parsed; `data:` images, which contact no
 * host, stay. An image's alt text is kept in its place.
 */

const FETCHING_TAGS = ['img', 'image', 'picture', 'source', 'video', 'audio', 'iframe', 'frame', 'object', 'embed', 'link', 'track', 'input'];

function isDataUrl(url: string): boolean {
  return /^\s*<?\s*data:/i.test(url);
}

export function stripRemoteMedia(markdown: string): string {
  let out = markdown;
  // Inline markdown images: ![alt](url "title").
  out = out.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (whole, alt: string, url: string) => (isDataUrl(url) ? whole : alt));
  // Reference images: ![alt][ref] and ![alt][] / ![alt] resolve to a definition elsewhere.
  out = out.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
  // Raw HTML elements that fetch on creation, unless every URL they carry is data:.
  const tagRe = new RegExp(`<\\s*(${FETCHING_TAGS.join('|')})\\b[^>]*>`, 'gi');
  out = out.replace(tagRe, (tag) => {
    const urls = [...tag.matchAll(/\b(?:src|srcset|href|poster|data|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1].replace(/^["']|["']$/g, ''));
    return urls.length > 0 && urls.every(isDataUrl) && !/^<\s*(iframe|frame|object|embed|link)\b/i.test(tag) ? tag : '';
  });
  // Closing tags of stripped media elements (harmless alone, but keep the output clean).
  out = out.replace(new RegExp(`<\\s*/\\s*(${FETCHING_TAGS.join('|')})\\s*>`, 'gi'), '');
  // CSS that fetches: url(...) inside a style attribute or a <style> block, unless data:.
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (whole, _q: string, url: string) => (isDataUrl(url) ? whole : 'none'));
  out = out.replace(/@import[^;]*;?/gi, '');
  return out;
}

/** A picture or clip of this page's own origin, or inline. Judged by the browser's own URL parser,
 *  so no spelling (a tab, a backslash, a control character) reads as local and fetches remotely. */
function localMedia(url: string | null): boolean {
  if (!url) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true; // a Windows path: the chat's media hook rewrites it
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * For text that came from a model: an ALLOWLIST, because a list of what fetches is never finished
 * (SVG `image`, `<style>@import`, `mask="url()"`, `ht\ttps:`). Plain HTML only, no style of any
 * kind, and media kept only when it is local. Links stay: they fetch on a click, not on a draw.
 * Local paths stay too: the chat's media hook rewrites them.
 */
export function dropRemoteMedia(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'link', 'base', 'meta', 'iframe', 'object', 'embed', 'form', 'input', 'picture'],
    FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'action', 'formaction'],
  });
  const box = document.createElement('template');
  box.innerHTML = clean;
  for (const el of box.content.querySelectorAll('img, video, audio, source, track')) {
    if (el.hasAttribute('src') ? !localMedia(el.getAttribute('src')) : el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO') el.remove();
  }
  return box.innerHTML;
}
