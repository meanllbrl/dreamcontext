import { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { sendJson } from '../middleware.js';

// ─── The Chat `dream-html` kit's BRAND OVERRIDE ─────────────────────────────────
//
// An agent's `dream-html` block is drawn inside a sandboxed iframe wearing
// dreamcontext's own class kit (`dashboard/src/components/sleepy/chat/chat-html-kit.css`),
// so a written-once answer looks native in both themes without the agent choosing a
// single color. That kit ships with the app — but a vault may not want the app's look.
//
// `_dream_context/overrides/chat-html-kit.css` is that escape hatch: plain CSS, appended
// AFTER the base kit inside the srcdoc, so "later wins" is the entire override mechanism.
// A brand redefines the tokens it cares about (`:root { --color-accent: … }`) or restyles
// individual `dc-` classes, and every HTML answer in that project follows — with no fork of
// the app and no instruction to the agent, which keeps writing the same kit classes.
//
// It lives under `overrides/` for the reason `board.json` does: that folder is
// git-tracked and survives `dreamcontext update`, so a team's brand is shared and
// permanent rather than per-machine.
//
// READ-ONLY, and deliberately so. There is no write route: this is a file a human edits,
// not state the app manages, and an endpoint that let a chat answer rewrite the CSS every
// chat answer is drawn in would be a self-modifying surface.

const OVERRIDE_REL_PATH = 'overrides/chat-html-kit.css';

/**
 * Hard cap. Generous for a brand sheet, bounded because this string is embedded into the
 * srcdoc of EVERY html block in the transcript — a runaway file would be re-inlined per
 * block, per theme flip.
 */
const MAX_BYTES = 128 * 1024;

/**
 * GET /api/chat/html-kit — the vault's brand override for the Chat HTML kit.
 *
 * Always 200. `{ css: null }` is the ordinary answer for a vault that has no override, not
 * an error: the base kit is a complete stylesheet on its own, and a 404 here would make
 * every client have to tell "no override" apart from "the server is unwell".
 *
 * Never throws — an unreadable or oversized file degrades to `null` plus a `notice` the
 * client can surface, because a silently ignored brand sheet is a user editing a file and
 * watching nothing happen.
 */
export async function handleChatHtmlKitGet(
  _req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const path = join(contextRoot, OVERRIDE_REL_PATH);
  if (!existsSync(path)) {
    sendJson(res, 200, { css: null, path: OVERRIDE_REL_PATH, notice: null });
    return;
  }

  try {
    const bytes = statSync(path).size;
    if (bytes > MAX_BYTES) {
      sendJson(res, 200, {
        css: null,
        path: OVERRIDE_REL_PATH,
        notice: `${OVERRIDE_REL_PATH} is ${Math.round(bytes / 1024)}KB, over the ${MAX_BYTES / 1024}KB limit — it was not applied.`,
      });
      return;
    }
    sendJson(res, 200, { css: readFileSync(path, 'utf-8'), path: OVERRIDE_REL_PATH, notice: null });
  } catch (err) {
    sendJson(res, 200, {
      css: null,
      path: OVERRIDE_REL_PATH,
      notice: `${OVERRIDE_REL_PATH} could not be read — it was not applied. (${(err as Error).message})`,
    });
  }
}
