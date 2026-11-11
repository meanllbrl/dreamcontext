/**
 * The browser-safe half of the card records (plan I1): what a client is told about a chat's run
 * and secret cards, and the canonical spec form a client matches a drawn card by. No Node
 * imports: the dashboard imports this file (src/lib/cards/records.ts holds the server side).
 */
import type { ChecklistViewSpec, McpViewSpec, RunViewSpec, SecretViewSpec } from '../chat-view-spec.js';

/** Every owner-only card is a record (sahip-karti-yerinde K1): a checklist and an MCP card open,
 *  close and rebuild like a run and a secret. The same list as owner-wait.ts `OWNER_CARD_KINDS`. */
export type CardKind = 'run' | 'secret' | 'checklist' | 'mcp';
export const CARD_KINDS: readonly CardKind[] = ['run', 'secret', 'checklist', 'mcp'];
export type CardSpec = RunViewSpec | SecretViewSpec | ChecklistViewSpec | McpViewSpec;

/**
 * Why a record closed. Only `done` means the card's own end happened (the run exited, the secret
 * was written); a card may say "finished" or "saved" for that one and no other.
 *  - `interrupted`: a run started and the server stopped before it ended (it may have run partly).
 *  - `superseded`: the agent posted the same card again; the newer copy is the live one.
 *  - `dropped`: the Super closed the owner item another way.
 *  - `answered`: a card from before records were kept, closed by the old owner-line rule.
 */
export type CardCloseReason = 'done' | 'interrupted' | 'superseded' | 'dropped' | 'answered';

export interface CardRunInfo {
  runId: string;
  owner: 'mac' | 'phone' | 'telegram';
}

/** What a client is told (the `cards` frame, `GET /api/agent/cards`). Never more than the agent wrote. */
export interface PublicCard {
  id: string;
  cardRef: string;
  kind: CardKind;
  spec: CardSpec;
  state: 'open' | 'closed';
  /** Set when closed; absent on an entry written before reasons were kept. */
  closedBy?: CardCloseReason;
  run: CardRunInfo | null;
  exit?: number | null;
}

/** Canonical JSON: keys sorted at every level, so two spellings of one spec compare alike. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
