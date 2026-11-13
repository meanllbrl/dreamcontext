/**
 * The learned-rule card's routes (learning loop C9). The chat's `learned` view names a rule id; the
 * card reads the record here and draws its headline, scope, his quote and one action row: Undo for
 * an active rule, Keep and Drop for one waiting for his word. No list route and no page (D12): a
 * rule is otherwise a line of `knowledge/patterns/learned-rules.md` or his preferences file.
 *
 *   GET  /api/learned/:id                      the card's facts
 *   POST /api/learned/:id/undo|keep|drop       the owner's tap (his page only)
 *
 * The mutating routes take the owner's page only (`refuseUnlessOwnerPage`), like an automation's
 * approval card: an agent's `curl` cannot keep a rule it proposed. The store's own status rules
 * (`applyStatusOp`) decide what each tap may do; a refusal comes back with its reason.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, parseJsonBody } from '../middleware.js';
import { refuseUnlessOwnerPage } from '../owner-page.js';
import {
  RULE_ID_RE, RulesStoreError, deriveRule, dropRule, findRecord, keepRule, personalRulesVisible, personalStoreRef,
  projectStoreRef, readStore, undoRule, type RuleView, type StatusChange, type StoreRef,
} from '../../lib/rules-store.js';

/** What the card shows: read from the record, never from the block the agent wrote. */
export interface LearnedCardFacts {
  id: string;
  scope: 'me' | 'project';
  status: RuleView['status'];
  headline: string;
  text: string;
  /** His newest quote and when he said it. */
  quote: { text: string; at: string } | null;
  /** The headline of the rule this one replaced ("eskisi saklandı"). */
  replaced: string | null;
  /** The rule a just-undone rule brought back. */
  restored: string | null;
  /** Who wrote the rule. */
  by: string;
  hot: boolean;
}

/** Which store holds `id`: the personal one (when this vault shows it) or the project's. */
export function locateRule(contextRoot: string, id: string, home?: string): { ref: StoreRef; view: RuleView; replacedHeadline: string | null } | null {
  const refs: StoreRef[] = [];
  if (personalRulesVisible(contextRoot, home).visible) refs.push(personalStoreRef(home));
  refs.push(projectStoreRef(contextRoot, home));
  for (const ref of refs) {
    const store = readStore(ref);
    const rec = findRecord(store, id);
    if (!rec) continue;
    const view = deriveRule(rec);
    const old = view.replaces ? findRecord(store, view.replaces) : undefined;
    return { ref, view, replacedHeadline: old ? deriveRule(old).headline : null };
  }
  return null;
}

export function learnedCardFacts(view: RuleView, replaced: string | null, restored: RuleView | null = null): LearnedCardFacts {
  const last = [...view.sayings].reverse().find((s) => s.text);
  return {
    id: view.id,
    scope: view.scope,
    status: view.status,
    headline: view.headline,
    text: view.text,
    quote: last ? { text: last.text, at: last.at } : null,
    replaced,
    restored: restored ? restored.headline : null,
    by: view.created.by,
    hot: view.hot,
  };
}

function badId(res: ServerResponse, id: string | undefined): boolean {
  if (id && RULE_ID_RE.test(id)) return false;
  sendError(res, 400, 'bad_id', 'Not a rule id.');
  return true;
}

function storeError(res: ServerResponse, err: unknown): void {
  if (err instanceof RulesStoreError) {
    sendError(res, err.code === 'unsafe' ? 403 : 409, `store_${err.code}`, err.message);
    return;
  }
  sendError(res, 500, 'learned_failed', 'Failed to read the rule.');
}

export async function handleLearnedGet(
  _req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (badId(res, params.id)) return;
  try {
    const found = locateRule(contextRoot, params.id!);
    if (!found) { sendError(res, 404, 'not_found', `No rule ${params.id} here.`); return; }
    sendJson(res, 200, { card: learnedCardFacts(found.view, found.replacedHeadline) });
  } catch (err) { storeError(res, err); }
}

type Tap = 'undo' | 'keep' | 'drop';
const TAPS: Record<Tap, (ref: StoreRef, id: string, actor: { by: 'owner'; conversation: string }) => StatusChange> = {
  undo: undoRule, keep: keepRule, drop: dropRule,
};

function tapHandler(op: Tap) {
  return async (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, contextRoot: string): Promise<void> => {
    if (refuseUnlessOwnerPage(req, res, op === 'undo' ? 'undoes a learned rule' : op === 'keep' ? 'keeps a learned rule' : 'drops a learned rule')) return;
    if (badId(res, params.id)) return;
    try {
      const body = (await parseJsonBody(req).catch(() => null)) as { sessionId?: unknown } | null;
      const conversation = typeof body?.sessionId === 'string' ? body.sessionId.slice(0, 128) : 'card';
      const found = locateRule(contextRoot, params.id!);
      if (!found) { sendError(res, 404, 'not_found', `No rule ${params.id} here.`); return; }
      const change = TAPS[op](found.ref, params.id!, { by: 'owner', conversation });
      if (!change.ok) { sendError(res, 409, 'refused', change.reason); return; }
      sendJson(res, 200, { card: learnedCardFacts(change.rule, found.replacedHeadline, change.restored ?? null) });
    } catch (err) { storeError(res, err); }
  };
}

export const handleLearnedUndo = tapHandler('undo');
export const handleLearnedKeep = tapHandler('keep');
export const handleLearnedDrop = tapHandler('drop');
