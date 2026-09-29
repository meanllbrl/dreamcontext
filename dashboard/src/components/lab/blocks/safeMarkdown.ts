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
