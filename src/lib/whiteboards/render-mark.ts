/**
 * Which kind of board picture a PNG is, written into the PNG itself (a `tEXt` chunk), so any
 * later step can tell from the BYTES, never from a file name an agent chose:
 *
 *  - `layout`: `whiteboard render`, a layout check. Pictures are empty crossed boxes and widgets
 *    only their titles. It shows where things sit, never what the board looks like.
 *  - `export`: `whiteboard export`, the board as it looks: its own pictures, widgets with their
 *    last cached content.
 *
 * Sending a `layout` picture to the owner as a result (a Telegram picture, `super open image`)
 * is warned about and pointed to `whiteboard export`; it is never blocked.
 */

export const RENDER_KIND_KEY = 'dreamcontext-render';
export type RenderKind = 'layout' | 'export';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The `tEXt` chunks before the image data of a PNG (keyword → text); {} for anything else. */
export function pngTextChunks(buf: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (buf.length < 16 || PNG_SIGNATURE.some((b, i) => buf[i] !== b)) return out;
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 8;
  // Text chunks sit before IDAT in what `render`/`export` write; stop at the image data.
  while (at + 8 <= view.length) {
    const len = view.readUInt32BE(at);
    const type = view.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT' || type === 'IEND' || at + 12 + len > view.length) break;
    if (type === 'tEXt') {
      const body = view.subarray(at + 8, at + 8 + len);
      const nul = body.indexOf(0);
      if (nul > 0) out[body.toString('latin1', 0, nul)] = body.toString('latin1', nul + 1);
    }
    at += 12 + len;
  }
  return out;
}

/** Is this PNG a `whiteboard render` layout check? */
export function isLayoutRender(buf: Uint8Array): boolean {
  return pngTextChunks(buf)[RENDER_KIND_KEY] === 'layout';
}

/** The one sentence an agent reads when it is about to show a layout check as a result. */
export function layoutRenderWarning(name: string): string {
  return `${name} is a whiteboard layout check (\`whiteboard render\`): its pictures are empty crossed boxes and its widgets only titles. To show the owner the board as it looks, use \`dreamcontext whiteboard export <slug> --split tags --out <folder>\` and send those pictures.`;
}
