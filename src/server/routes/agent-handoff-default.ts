import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isPhoneSocket } from '../phone-origin.js';
import { readBrainLocal, readSetupConfig, resolveContextHandoff, writeBrainLocal } from '../../lib/setup-config.js';

/**
 * Settings → Eco mode (task codex-tarzi-yeni-kabuk W2-C, flagged F4): this machine's default
 * for the context hand-off nudge in THIS project, `BrainLocalState.contextHandoffDefault`, the
 * value every NEW chat pane seeds its own switch from. Until now only a pane's websocket wrote
 * it (`setContextHandoff`). Vault-scoped (the project root is `dirname(contextRoot)`), boolean
 * only, and refused on the phone like `PATCH /api/config`.
 *
 * The answer carries the thresholds the nudges fire at, read from `.config.json` (the team's
 * ladder), so the row can say them in plain words.
 */
function state(projectRoot: string): { enabled: boolean; nudgeAt: number; hardAt: number } {
  const team = readSetupConfig(projectRoot)?.contextHandoff;
  const ladder = resolveContextHandoff(team);
  const local = readBrainLocal(projectRoot).contextHandoffDefault;
  return { enabled: typeof local === 'boolean' ? local : ladder.enabled, nudgeAt: ladder.nudgeAt, hardAt: ladder.hardAt };
}

export async function handleContextHandoffDefaultGet(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (isPhoneSocket(req)) { sendError(res, 403, 'phone_unavailable', 'Not available on the phone.'); return; }
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No project selected.'); return; }
  sendJson(res, 200, state(dirname(contextRoot)));
}

export async function handleContextHandoffDefaultPost(
  req: IncomingMessage, res: ServerResponse, _params: Record<string, string>, contextRoot: string,
): Promise<void> {
  if (isPhoneSocket(req)) { sendError(res, 403, 'phone_unavailable', 'Not available on the phone.'); return; }
  if (!contextRoot) { sendError(res, 400, 'no_vault', 'No project selected.'); return; }
  const body = await parseJsonBody(req);
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') {
    sendError(res, 400, 'invalid_body', 'Send {"enabled": true|false}.');
    return;
  }
  const projectRoot = dirname(contextRoot);
  try {
    writeBrainLocal(projectRoot, { contextHandoffDefault: enabled });
  } catch (err) {
    sendError(res, 500, 'write_failed', err instanceof Error ? err.message : String(err));
    return;
  }
  sendJson(res, 200, state(projectRoot));
}
