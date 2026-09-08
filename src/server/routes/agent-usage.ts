import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import { resolveConfigDir } from '../../lib/claude-accounts.js';
import { EMPTY_USAGE_LIMITS, readUsageLimits } from '../../lib/claude-usage.js';

/**
 * GET /api/agent/usage-limits[?account=<id>] — the ACCOUNT's 5-hour and weekly caps, from
 * Claude Code's own cache (`<configDir>/.claude.json` → `cachedUsageUtilization`; see
 * src/lib/claude-usage.ts).
 *
 * VAULT-AGNOSTIC, like `/api/agent/model-config` beside it: this reads the user's Claude
 * install, not any project's brain. Registered in `VAULT_AGNOSTIC_PREFIXES` for that reason.
 *
 * ── WHICH account, and why the parameter is safe ──────────────────────────────────────
 * This route read the real HOME unconditionally until 2026-09-07, which was correct only
 * while a machine had ONE account. With multi-account, a pane running on a sandbox account
 * was shown the PRIMARY account's bars — measured on the owner's machine, 98% session on the
 * popover for a pane whose actual account was at 3%. The number was real; it just belonged to
 * a different account.
 *
 * So the pane says which account it is on, and the id goes through `resolveConfigDir` — the
 * single gate that refuses a non-slug id and an unregistered one, and asserts the resolved
 * path is either `homedir()` or inside `~/.dreamcontext/claude-accounts/`. That is exactly
 * the distinction `claude-usage.ts` documents: a request-derived ACCOUNT ID may choose which
 * account is read; a request-derived PATH may not, and cannot get in here. An unusable id
 * answers with an EMPTY reading rather than an error, for the same reason as the off-desktop
 * case below — this is a bar, not an action.
 *
 * Omitting the parameter resolves the default the same way a spawn does
 * (`resolveConfigDir(null)` — the preferred account, else account #0), so the popover and the
 * CLI child can never disagree about whose quota is being shown.
 *
 * WHY ITS OWN ROUTE rather than three more fields on `/api/agent/session-stats`:
 *   • session-stats is keyed by `claudeId` and polled every 5s PER PANE. These numbers are
 *     account-level and move on the CLI's own refresh cadence — bolting them on would
 *     re-read the same file N times a tick for N split panes, to no purpose.
 *   • session-stats has a tested contract (`computeSessionStats`) whose every failure path
 *     returns the same `EMPTY_STATS` shape. Three unrelated fields would muddy it.
 * This route is polled once per account per 60s and deduped when concurrent.
 *
 * OFF-DESKTOP it answers 200 with an EMPTY list rather than 403. The popover's rule is
 * "show what's found, hide what isn't" — an empty list renders nothing, which is exactly
 * right, whereas a 403 would surface an error the user cannot act on for a bar that is
 * simply unavailable outside the app.
 */
export async function handleAgentUsageLimits(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isDesktop()) { sendJson(res, 200, EMPTY_USAGE_LIMITS); return; }

  let configDir: string;
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    configDir = resolveConfigDir(url.searchParams.get('account'));
  } catch {
    sendJson(res, 200, EMPTY_USAGE_LIMITS);
    return;
  }
  sendJson(res, 200, readUsageLimits(configDir));
}
