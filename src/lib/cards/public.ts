/**
 * The browser-safe half of the card records (plan I1): what a client is told about a chat's run
 * and secret cards, and the canonical spec form a client matches a drawn card by. No Node
 * imports: the dashboard imports this file (src/lib/cards/records.ts holds the server side).
 */
import type { RunViewSpec, SecretViewSpec } from '../chat-view-spec.js';

export type CardKind = 'run' | 'secret';
export type CardSpec = RunViewSpec | SecretViewSpec;

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
