/**
 * A child that waits on the OWNER (task a-super-child-waiting-on-the-owner-or-still-running-…).
 *
 * Some things only the owner can do: run a command that opens a browser sign-in (a `run` card),
 * type a credential (a `secret` card), work through a procedure in another app (a `checklist`),
 * connect an MCP server only he can sign into (an `mcp` card, task mcp-management).
 * A child that leaves one of those open is not done:
 * nothing will move until he acts (Tilki 2026-10-22: a `gcloud auth login` run card sat under a
 * "done" row for hours while the agenda said nothing waits on him). CARDS ONLY (owner 2026-10-22):
 * a sign-in asked in plain prose is not read, it is guessed, and the guess was wrong both ways in
 * review; a child asks for what only he can do with a card (the chat surface tells it to).
 *
 * This module reads that from the child's OWN stream, the same fences the chat draws (the
 * registry calls it on every assistant frame, chat-registry.ts), and recognises the owner's
 * answer when it is written back into the chat (the run card's exit report, the secret
 * receipt, the checklist's submit). Who wrote a message matters: the Super Agent steering the
 * child is not the owner doing it, so the server notes what it sends for the Super
 * (`noteSuperSend`) and the registry asks (`takeSuperSend`) before it lets a message answer a
 * wait. Everything else here is pure.
 */

import { createHash } from 'node:crypto';
import { MAX_REFUSAL_REASON, REFUSAL_WORD_RE, type RefusalFact } from './types.js';

/**
 * `refusal` and `stalled` are no cards (uye-bildirim K2, K6): a refusal is read from the stream's
 * permission metadata by the registry, a stall is decided by the server. Neither is ever produced
 * by `ownerCardsIn` or answered by a receipt; a refusal closes when the same call is accepted
 * later or the owner writes into that session himself (the registry), a stall when the server
 * says so.
 */
export const OWNER_WAIT_KINDS = ['run', 'secret', 'checklist', 'mcp', 'refusal', 'stalled'] as const;
export type OwnerWaitKind = typeof OWNER_WAIT_KINDS[number];
/** The kinds a card in the chat's own text can be (what `ownerCardsIn` and `answeredBy` know). */
export type OwnerCardKind = Exclude<OwnerWaitKind, 'refusal' | 'stalled'>;
/** The owner-only CARD kinds, in order (sahip-karti-yerinde K1): each one is a card record the
 *  server holds (src/lib/cards/records.ts `CardKind` is the same list). MIRRORED in
 *  dashboard/src/lib/superTypes.ts, pinned by owner-card-types.test.ts. */
export const OWNER_CARD_KINDS = ['run', 'secret', 'checklist', 'mcp'] as const satisfies readonly OwnerCardKind[];
export function isOwnerCardKind(v: unknown): v is OwnerCardKind {
  return typeof v === 'string' && (OWNER_CARD_KINDS as readonly string[]).includes(v);
}

export interface OwnerWait {
  kind: OwnerWaitKind;
  /** The card's own id; a refusal's `rf-<hash of tool and whole input>`; a stall's `st-<request>`. */
  id: string;
  /** What he is asked to do, one plain line (the card's title, `why` or command). */
  line: string;
  /** What his answer names (the run card's command, the secret's or checklist's title; a
   *  refusal's tool). */
  key?: string;
  /** Only on kind `refusal`: the call that was refused. */
  refusal?: RefusalFact;
}

/** Owner waits one child may hold at once (a fence-happy reply cannot grow the record). */
export const MAX_OWNER_WAITS = 4;
const LINE_MAX = 160;
const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** The same fence the chat (chatViewSpec.ts) and the checkout directive read: an unterminated
 *  one is not a card yet. */
const FENCE = /```dream-view[^\S\r\n]*\r?\n([\s\S]*?)```/g;

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1).trimEnd()}…` : flat;
};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The owner-only cards in one assistant text, in order (at most MAX_OWNER_WAITS). */
export function ownerCardsIn(text: string): OwnerWait[] {
  const out: OwnerWait[] = [];
  if (!text.includes('dream-view')) return out;
  for (const m of text.matchAll(FENCE)) {
    let obj: unknown;
    try { obj = JSON.parse(m[1]); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    const id = str(o.id);
    if (!ID_RE.test(id)) continue;
    let w: OwnerWait | null = null;
    if (o.type === 'run') {
      const command = str(o.command);
      if (!command || /[\r\n]/.test(command)) continue;
      w = { kind: 'run', id, line: oneLine(str(o.why) || `run ${command}`), key: command };
    } else if (o.type === 'secret') {
      const title = str(o.title);
      if (!title) continue;
      w = { kind: 'secret', id, line: oneLine(title), key: title };
    } else if (o.type === 'mcp') {
      const servers = Array.isArray(o.servers) ? o.servers.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
      if (!servers.length || servers.length > 8) continue;
      const names = servers.join(', ');
      w = { kind: 'mcp', id, line: oneLine(str(o.why) || `Connect: ${names}`), key: names };
    } else if (o.type === 'checklist') {
      const title = str(o.title);
      if (!title || !Array.isArray(o.items) || !o.items.length) continue;
      w = { kind: 'checklist', id, line: oneLine(title), key: title };
    }
    if (w && !out.some((x) => x.kind === w!.kind && x.id === w!.id)) out.push(w);
    if (out.length >= MAX_OWNER_WAITS) break;
  }
  return out;
}

/**
 * The owner's answer to an open wait, as the chat writes it back into the child (an owner user
 * frame, chat/postToSession.ts):
 *  - a run card:    `[ran in chat]` then `$ <command>` (chat/runReport.ts `buildRunReport`);
 *  - a secret card: `[secret submitted · <title>]` (env-secrets.ts `secretReceipt`);
 *  - a checklist:   `Checklist: <title> — n of m done.` (checklistMarkdown.ts `buildSubmitMarkdown`).
 *  - an mcp card:   `MCP connected: <names>` or `MCP skipped: <names>` (chat/mcpRows.ts `mcpReport`).
 * Returns the waits it answers: a card's own receipt (matched by its command or title; with one
 * card of that kind open, any receipt of the kind). Any other message HE writes to the child
 * answers every wait: he dealt with it his own way ("done, I signed in in my terminal", "use the
 * service account"). The caller never passes the Super Agent's own messages here.
 */
export function answeredBy(text: string, open: readonly OwnerWait[]): OwnerWait[] {
  const head = text.trimStart().slice(0, 4000);
  const lines = head.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const kind: OwnerWaitKind | null = /^\[ran in chat\]/i.test(first) ? 'run'
    : /^\[secret submitted\b/i.test(first) ? 'secret'
      : /^Checklist:\s/.test(first) ? 'checklist'
        : /^MCP (connected|skipped):\s/.test(first) ? 'mcp' : null;
  const subject = kind === 'run' ? (lines.find((l) => l.startsWith('$ '))?.slice(2).trim() ?? '')
    : kind === 'secret' ? (/·\s*(.*?)\]\s*$/.exec(first)?.[1]?.trim() ?? '')
      : kind === 'checklist' ? first.replace(/^Checklist:\s*/, '').replace(/\s+—\s+\d+\s+of\s+\d+\s+done\.?\s*$/, '').trim()
        : kind === 'mcp' ? first.replace(/^MCP (connected|skipped):\s*/, '').trim() : '';
  // Not a receipt: his own words to the child answer everything it waited on him for.
  if (!kind) return [...open];
  return open.filter((w) => {
    if (w.kind !== kind) return false;
    if (subject && w.key === subject) return true;
    return open.filter((x) => x.kind === w.kind).length === 1;
  });
}

// ─── Waits the server reads, not cards (uye-bildirim K2, K6) ───────────────────────────────────

/** A refusal wait's id: the same call (tool and WHOLE canonical input) is one wait however often
 *  it is refused, and it never collides with a card id (`ID_RE` still holds). */
export function refusalWaitId(tool: string, wholeInput: string): string {
  return `rf-${createHash('sha256').update(`${tool}\n${wholeInput}`).digest('hex').slice(0, 16)}`;
}

/** The owner wait for one refused call. `wholeInput` is the canonical input before any cut;
 *  the fact keeps at most `cap` of it and says so (`whole: false`). */
export function refusalWait(
  tool: string, wholeInput: string, cap: number,
  how: { source: RefusalFact['source']; category?: string; reason?: string },
): OwnerWait {
  const whole = wholeInput.length <= cap;
  const reason = how.reason ? how.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REFUSAL_REASON) : '';
  const category = how.category && REFUSAL_WORD_RE.test(how.category) ? how.category : '';
  return {
    kind: 'refusal',
    id: refusalWaitId(tool, wholeInput),
    line: oneLine(wholeInput ? `${tool}: ${wholeInput}` : tool),
    key: tool,
    refusal: {
      tool, input: whole ? wholeInput : wholeInput.slice(0, cap), whole, source: how.source,
      ...(category ? { category } : {}),
      ...(reason ? { reason } : {}),
    },
  };
}

/** The owner wait for a member that stopped without closing request `requestId` or asking (K6);
 *  `lastSentence` is its own last words (untrusted, shown as a line). Null for a request id a
 *  card id could not hold. */
export function stalledWait(requestId: string, lastSentence: string): OwnerWait | null {
  const id = `st-${requestId}`;
  if (!ID_RE.test(id)) return null;
  return { kind: 'stalled', id, line: oneLine(lastSentence) || 'Stopped without finishing or asking' };
}

// ─── Who wrote it: the Super Agent's own sends ────────────────────────────────────────────────

/** How long a noted send waits for its frame (a parked child is woken first: seconds). */
const SUPER_SEND_TTL_MS = 2 * 60_000;
const MAX_SUPER_SENDS = 32;
const superSends = new Map<string, Array<{ text: string; at: number }>>();

/** The server is about to send `text` into child `sid` for the Super Agent (`super send`, the
 *  outbox, a successor's stop): its frame is the Super's, never the owner's answer. */
export function noteSuperSend(sid: string, text: string, now = Date.now()): void {
  const t = text.trim();
  if (!t) return;
  const list = (superSends.get(sid) ?? []).filter((x) => now - x.at < SUPER_SEND_TTL_MS);
  list.push({ text: t, at: now });
  superSends.set(sid, list.slice(-8));
  while (superSends.size > MAX_SUPER_SENDS) superSends.delete(superSends.keys().next().value as string);
}

/** Was this user frame one the server sent for the Super Agent? Consumes the note. The window
 *  may add its own block around the text (a hand-over note), so the note is looked for inside. */
export function takeSuperSend(sid: string, frameText: string, now = Date.now()): boolean {
  const list = superSends.get(sid);
  if (!list) return false;
  const live = list.filter((x) => now - x.at < SUPER_SEND_TTL_MS);
  const i = live.findIndex((x) => frameText.includes(x.text));
  if (i >= 0) live.splice(i, 1);
  if (live.length) superSends.set(sid, live); else superSends.delete(sid);
  return i >= 0;
}

/** Tests only. */
export function _resetSuperSends(): void {
  superSends.clear();
}
