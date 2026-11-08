import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { sendError, sendJson } from '../middleware.js';
import { isPhoneSocket } from '../phone-origin.js';
import { readSetupConfig, resolveContextHandoff } from '../../lib/setup-config.js';
import { ecoModeDefault } from '../../lib/context-watch.js';

/**
 * Settings → Chat → Eco mode's read (owner 2026-11-08: one machine-wide setting, ON by
 * default). The switch itself is this Mac's `~/.dreamcontext/agent-ui.json` `ecoMode`, read
 * by {@link ecoModeDefault} and written by the Settings row through the agent-settings route
 * like every other machine-wide chat setting; this route only adds the thresholds the nudges
 * fire at, so the row can say them in plain words. They come from the open project's
 * `.config.json` (the team's ladder). The route is vault-scoped (the request gate answers
 * `no_vault` first), so the shipped-ladder fallback below only guards a direct call.
 * Refused on the phone like `PATCH /api/config`.
 */
function state(contextRoot: string | null | undefined): { enabled: boolean; nudgeAt: number; hardAt: number } {
  const team = contextRoot ? readSetupConfig(dirname(contextRoot))?.contextHandoff : undefined;
  const ladder = resolveContextHandoff(team);
  return { enabled: ecoModeDefault(), nudgeAt: ladder.nudgeAt, hardAt: ladder.hardAt };
}

export async function handleContextHandoffDefaultGet(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (isPhoneSocket(req)) { sendError(res, 403, 'phone_unavailable', 'Not available on the phone.'); return; }
  sendJson(res, 200, state(contextRoot));
}
