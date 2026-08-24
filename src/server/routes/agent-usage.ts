import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { EMPTY_USAGE_LIMITS, readUsageLimits } from '../../lib/claude-usage.js';

/**
 * GET /api/agent/usage-limits — the ACCOUNT's 5-hour and weekly caps, from Claude Code's
 * own cache (`~/.claude.json` → `cachedUsageUtilization`; see src/lib/claude-usage.ts).
 *
 * VAULT-AGNOSTIC, like `/api/agent/model-config` beside it: this reads the user's Claude
 * install, not any project's brain. Registered in `VAULT_AGNOSTIC_PREFIXES` for that reason.
 *
 * WHY ITS OWN ROUTE rather than three more fields on `/api/agent/session-stats`:
 *   • session-stats is keyed by `claudeId` and polled every 5s PER PANE. These numbers are
 *     account-global and move on the CLI's own refresh cadence — bolting them on would
 *     re-read the same file N times a tick for N split panes, to no purpose.
 *   • session-stats has a tested contract (`computeSessionStats`) whose every failure path
 *     returns the same `EMPTY_STATS` shape. Three unrelated fields would muddy it.
 * This route is polled once per pane per 60s and deduped when concurrent.
 *
 * OFF-DESKTOP it answers 200 with an EMPTY list rather than 403. The popover's rule is
 * "show what's found, hide what isn't" — an empty list renders nothing, which is exactly
 * right, whereas a 403 would surface an error the user cannot act on for a bar that is
 * simply unavailable outside the app.
 *
 * `readUsageLimits()` is called with ZERO ARGUMENTS on purpose. Its `home` parameter exists
 * only as a test seam, and the file it selects holds the user's OAuth account and machine
 * id — so no request-derived value may ever reach it. Do not "thread the vault through".
 */
export async function handleAgentUsageLimits(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) { sendJson(res, 200, EMPTY_USAGE_LIMITS); return; }
  sendJson(res, 200, readUsageLimits());
}
