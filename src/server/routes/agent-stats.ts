import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { parseJsonBody, sendError, sendJson } from '../middleware.js';
import { isAgentHost, isAgentRequest, isDesktop } from '../desktop.js';
import { freshenLedger } from '../../lib/usage-ledger.js';
import { setPrice } from '../../lib/usage-pricing.js';
import { buildStats, type StatsRange } from '../../lib/usage-report.js';

/**
 * The Stats screen. Vault-agnostic: usage belongs to the machine's accounts, not one project.
 *
 * GET answers from the ledger as it stands and starts a scan in the background: the first scan of
 * a full Mac takes a while and no request waits for it. The reply says how far it is, the screen
 * asks again. A model name in POST only keys a local price; it never reaches a path.
 */
const RANGES: readonly StatsRange[] = ['24h', '7d', '30d', '90d'];

function allowed(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAgentHost() && (isDesktop() || isAgentRequest(req))) return true;
  sendError(res, 403, 'desktop_only', 'Stats are desktop-only.');
  return false;
}

export async function handleAgentStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!allowed(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const raw = url.searchParams.get('range') as StatsRange | null;
  const range = raw && RANGES.includes(raw) ? raw : '7d';
  const project = url.searchParams.get('project') || null;
  const off = new Set((url.searchParams.get('off') ?? '').split(',').filter(Boolean));
  const home = homedir();
  freshenLedger(home);
  sendJson(res, 200, buildStats({ range, project, off }, home));
}

export async function handleAgentStatsPrice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!allowed(req, res)) return;
  const body = await parseJsonBody(req);
  const model = typeof body?.model === 'string' ? body.model.slice(0, 200) : '';
  if (!model) { sendError(res, 400, 'invalid_model', 'A model name is required.'); return; }
  setPrice(model, { price: body?.price, alias: body?.alias }, homedir());
  sendJson(res, 200, { ok: true });
}
