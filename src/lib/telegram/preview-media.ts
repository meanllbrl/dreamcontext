/**
 * An AskUserQuestion option `preview` that is NOTHING BUT one project picture or clip
 * (`<img src="docs/a.png">`, `<video src="tmp/a.mp4"></video>`): the server twin of the chat
 * card's `loneMedia` (dashboard/src/components/sleepy/chat/previewImages.ts), which draws such a
 * preview natively. On Telegram it goes as that file itself, never as a drawing of a page that
 * cannot load it (owner 2026-11-17, "fotoğraflar gözükmüyor": two option pictures reached the
 * phone as white boxes with a broken-image icon). Same regex and the same local-ref rule as the
 * card; pinned by tests/unit/telegram-preview-media.test.ts.
 */

export function isLocalImageRef(src: string): boolean {
  const s = src.trim();
  return !!s && !/^(https?:|data:|blob:|mailto:|#|\/\/)/i.test(s) && !s.startsWith('/api/');
}

export function loneMedia(html: string | undefined): { kind: 'image' | 'video'; src: string } | null {
  if (!html) return null;
  const m = /^\s*<(img|video)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\2[^>]*>\s*(?:<\/video>)?\s*$/i.exec(html);
  if (!m || !isLocalImageRef(m[3])) return null;
  return { kind: m[1].toLowerCase() === 'video' ? 'video' : 'image', src: m[3].trim() };
}
