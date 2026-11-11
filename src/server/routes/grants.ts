/**
 * A member's Permissions (uye-bildirim K3, G2 for rules): what the profile lists and what the
 * owner removes. The "Always allowed" rules of an AI Team member live in the machine-local grant
 * store (`~/.dreamcontext/grants/`), never in the brain.
 *
 * Nothing here CREATES a grant: a grant is born only from an answered owner item (super.ts
 * `/api/super/owner-answer`, and Telegram's callback), built from the stored item. Removing one
 * is a decision in his name, so it takes the same proof as giving one: the shell's owner key.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { sendError, sendJson, parseJsonBody } from '../middleware.js';
import { fromOwnerPage, ownerRefusalMessage } from './assistant.js';
import { getAgent } from '../../lib/agents/store.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import { listGrants, removeGrant, type StoreOpts } from '../../lib/grants/store.js';
import type { Grant } from '../../lib/grants/types.js';
import { redactSecrets } from '../../lib/telegram/format.js';
import type { PermissionRuleView } from '../../lib/super/types.js';

/** Tests only: the home the store is read under. */
let storeHome: string | null = null;
export function _setGrantsRouteHome(home: string | null): void { storeHome = home; }
const store = (): StoreOpts => (storeHome ? { home: storeHome } : {});

/** The project as grants name it: the real path of the project root. */
function projectOf(contextRoot: string): string {
  const root = dirname(contextRoot);
  try { return realpathSync.native(root); } catch { return root; }
}

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** A rule as the profile draws it: secrets redacted, and every hidden or direction-changing
 *  character drawn as a visible escape, so what he reads is what is stored. */
export function ruleText(input: string): string {
  return redactSecrets(input).replace(HIDDEN, (c) => `\\u{${c.codePointAt(0)!.toString(16).padStart(4, '0')}}`)
    .replace(/\r?\n/g, '\\n');
}

/** This project's saved rules of one member, newest first. */
export function memberRules(contextRoot: string, member: string, opts: StoreOpts = store()): PermissionRuleView[] {
  const project = projectOf(contextRoot);
  return listGrants(project, opts)
    .filter((g: Grant) => g.scope === 'member' && g.member === member && g.form === 'script')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((g) => ({ id: g.id, member, form: 'script' as const, rule: ruleText(g.input), createdAt: g.createdAt }));
}

/** GET /api/agents/:slug/permissions → { level, rules, applies } */
export async function handleAgentPermissions(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  const agent = isSafeAutomationSlug(params.slug) ? getAgent(contextRoot, params.slug) : null;
  if (!agent) {
    sendError(res, 404, 'not_found', `Agent not found: ${params.slug}`);
    return;
  }
  sendJson(res, 200, {
    level: agent.autonomy,
    rules: memberRules(contextRoot, params.slug),
    // A narrower level reaches a running member at once (the live mode switch); a wider one waits
    // for its next session start (agents.ts `levelApplies`).
    applies: { narrowing: 'now', widening: 'next_session' },
  });
}

/** POST /api/agents/:slug/permissions/remove {id} → { ok: true }. Owner proof only. */
export async function handleAgentPermissionRemove(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!fromOwnerPage(req)) {
    sendError(res, 403, 'owner_page_only', ownerRefusalMessage(req, 'Only the owner, in the app, removes a permission he gave. An agent or a script cannot.'));
    return;
  }
  const body = await parseJsonBody(req);
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!id || !isSafeAutomationSlug(params.slug)) {
    sendError(res, 400, 'bad_body', 'Expected the id of a rule.');
    return;
  }
  // Only a rule of THIS member in THIS project: an id from another page removes nothing here.
  const owned = listGrants(projectOf(contextRoot), store()).some((g) => g.id === id && g.scope === 'member' && g.member === params.slug);
  if (!owned) {
    sendError(res, 404, 'not_found', 'That rule is not one of this member\'s.');
    return;
  }
  removeGrant(id, store());
  sendJson(res, 200, { ok: true });
}
