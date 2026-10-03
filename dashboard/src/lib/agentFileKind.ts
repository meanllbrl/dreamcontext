/**
 * What a posted path should be DRAWN as. Lives here, not in AgentMessage.tsx, so root vitest can
 * import it without a React tree; AgentMessage re-exports both names.
 *
 * Pure: no React, no DOM.
 */

/**
 * The image types the VAULT route will actually stream back.
 *
 * MIRRORS the raster half of `GRAPH_RAW_CONTENT_TYPE` (src/server/routes/graph.ts)
 * and must not drift from it: an extension listed here that the route does not
 * serve renders a broken image, and one the route serves but this omits shows a
 * chip for a picture we could have drawn.
 *
 * `.svg` IS DELIBERATELY ABSENT, on both sides. An SVG is a script-bearing
 * document, and `/api/graph/content` is generic — the Knowledge page hands its
 * URL to an iframe. It falls through to a chip here, which is the whole point.
 */
const RASTER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
/** Media the same route streams with byte ranges — mirrors its `video/*` and `audio/*` rows. */
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav'];
/** A web page. Listed as a CARD wherever files are listed (like `doc`), and rendered in the
 *  chat's strict sandbox once opened in a reader — never as its raw markup. */
const HTML_EXTENSIONS = ['.html', '.htm'];

export type AgentFileKind = 'board' | 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'doc';

/**
 * Extension-only and total: an unknown type is a `doc`, which is the card — the treatment that
 * works for anything.
 */
export function agentFileKind(path: string): AgentFileKind {
  const lower = path.toLowerCase();
  const has = (list: string[]) => list.some((ext) => lower.endsWith(ext));
  if (lower.endsWith('.excalidraw.md')) return 'board';
  if (has(RASTER_EXTENSIONS)) return 'image';
  if (has(VIDEO_EXTENSIONS)) return 'video';
  if (has(AUDIO_EXTENSIONS)) return 'audio';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (has(HTML_EXTENSIONS)) return 'html';
  return 'doc';
}
