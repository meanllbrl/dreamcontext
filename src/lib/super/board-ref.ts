/**
 * What a `super open board <ref>` really names (2026-10-29). A `board` card draws a project
 * file (`/agent/file?path=<ref>`); a dreamcontext whiteboard is a `whiteboard` card, by slug.
 * The Super Agent opened `board ana-sayfa-tasarimlari` and got a card that said "not in this
 * project yet" forever, then had the whiteboard's own path refused. A whiteboard named through
 * `board` (its slug, its folder or its file) is read as the whiteboard it is.
 */

/** A whiteboard slug, as the window reads it (`whiteboardPath` in SuperContainer.tsx). */
export const WHITEBOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** A board file's extensions (what `/agent/file` gives the board cap, `agentFileTextCap`). */
export const BOARD_EXT_RE = /\.excalidraw(\.md)?$/i;

/**
 * The whiteboard slug a `board` ref names, or null for a plain project file. A bare slug, the
 * whiteboard's folder, or its own `<slug>/<slug>.excalidraw.md`, written project-relative
 * (`<contextDir>/whiteboards/…`) or brain-relative (`whiteboards/…`).
 */
export function whiteboardSlugOfBoardRef(raw: string, contextDir = '_dream_context'): string | null {
  const ref = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (WHITEBOARD_SLUG_RE.test(ref)) return ref;
  const ctx = `${contextDir}/whiteboards/`;
  const rest = ref.startsWith(ctx) ? ref.slice(ctx.length) : ref.startsWith('whiteboards/') ? ref.slice('whiteboards/'.length) : null;
  if (rest === null) return null;
  const parts = rest.split('/');
  const slug = parts[0];
  if (!WHITEBOARD_SLUG_RE.test(slug)) return null;
  if (parts.length === 1) return slug;
  if (parts.length === 2 && parts[1] === `${slug}.excalidraw.md`) return slug;
  return null;
}

/** The note an open rerouted from `board` to `whiteboard` carries, so the agent learns the verb. */
export function boardRerouteNote(slugs: readonly string[]): string {
  return `opened as a whiteboard: a dreamcontext whiteboard opens with \`super open whiteboard ${slugs[0]}\`, never \`board\` `
    + '(board is a project .excalidraw.md file outside the whiteboards folder)';
}
