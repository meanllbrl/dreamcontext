/**
 * His words reach the member (plan global-uye-ogrenme D7c, SG1). A `team ask` that answers one of
 * his messages (`--origin <ref>`, or his own turn) carries that message, so the member can learn a
 * correction on HIS words, proven "here" by G1 unchanged:
 *
 *  - the server finds the ledger line with that ref whose `keys` include the ASKING Super's
 *    session ({@link findRelayedTurn}); never text the Super typed, never a line of another chat;
 *  - the member's request turn shows his words verbatim in a server-built `<owner-relay>` block
 *    ({@link ownerRelayBlock}), outside the untrusted fence;
 *  - at delivery ONE ledger line is appended, keyed to the member's conversation
 *    ({@link appendRelayLine}): same `own`, `via` and `at`, `surface: 'relay'`, `relay_of` the
 *    original turn. Its turn id is derived from the request, so a second delivery writes nothing.
 *    Readers that count his turns skip `relay_of` lines (it is the same saying, not a repeat).
 *  - the hand-back to the main Super names every rule the member learned on that relay line
 *    ({@link learnedOnRelay}), added by the server, never left to the member's memory.
 */
import { homedir } from 'node:os';
import { appendOwnerTurn, OWNER_WORDS_MAX_AGE_DAYS, readOwnerTurns, type OwnerTurnLine, type OwnerTurnVia } from '../owner-words.js';
import { deriveAll, memberStoreRefs, readStore } from '../rules-store.js';

/** What a request carries of his message: the ledger line it came from. */
export interface RelayedOwnerWords {
  ref: string;
  /** The original ledger turn id. */
  turn: string;
  via: OwnerTurnVia;
  own: string;
  /** When he said it (kept on the relay line). */
  at: string;
  vault: string;
  /** The original turn's occasion (its session): the relay line keeps it, so it never reads as
   *  another occasion of the same saying. */
  session: string;
}

const REF_RE = /^[0-9a-z]{6}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The relay line's turn id for one request: deterministic, so it is written once. */
export function relayTurnId(requestId: string): string {
  return `relay-${requestId}`;
}

/**
 * His message `ref` as the asking Super's conversation recorded it, or null: the newest ledger
 * line (never itself a relay) carrying that ref (or part ref) whose keys include `superSession`.
 */
export function findRelayedTurn(ref: string, superSession: string, opts: { home?: string; now?: Date } = {}): RelayedOwnerWords | null {
  if (!REF_RE.test(ref) || !superSession) return null;
  try {
    const now = opts.now ?? new Date();
    const since = new Date(now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 86_400_000).toISOString();
    const turns = readOwnerTurns({ home: opts.home ?? homedir(), since });
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]!;
      if (t.relay_of) continue;
      if (t.ref !== ref && !(t.parts ?? []).includes(ref)) continue;
      if (!t.keys.includes(superSession) && t.session !== superSession) continue;
      return { ref, turn: t.turn, via: t.via, own: t.own, at: t.at, vault: t.vault, session: t.session };
    }
  } catch { /* unreadable ledger: nothing relayed */ }
  return null;
}

/** The server's block of his words in the member's request turn. His text cannot close it. */
export function ownerRelayBlock(w: RelayedOwnerWords): string {
  const own = w.own.replace(/<\/?owner-relay/gi, (m) => m.replace('<', '‹'));
  return [
    `<owner-relay ref="${w.ref}" via="${w.via}">`,
    own,
    '</owner-relay>',
    'The block above is the OWNER\'s own message, verbatim, that this request answers (the server read it from his chat, not the Super\'s words). A correction of how YOU work in it is his word to you: `dreamcontext learn "<the rule>" --scope member --quote "<his exact words>"` in this turn (your own Super, never a child).',
  ].join('\n');
}

/** Append the relay ledger line for one delivered request, once. Never throws. */
export function appendRelayLine(w: RelayedOwnerWords, requestId: string, memberKeys: readonly string[], opts: { home?: string } = {}): boolean {
  if (!REQUEST_RE.test(requestId)) return false;
  const keys = [...new Set(memberKeys.filter((k) => typeof k === 'string' && k !== ''))];
  if (keys.length === 0) return false;
  const turn = relayTurnId(requestId);
  try {
    const home = opts.home ?? homedir();
    const since = new Date(Date.parse(w.at) - 1000).toISOString();
    if (readOwnerTurns({ home, since }).some((t) => t.turn === turn)) return false;
    const line: OwnerTurnLine = {
      at: w.at, turn, vault: w.vault, surface: 'relay', via: w.via, keys, session: w.session || keys[0]!, own: w.own, relay_of: w.turn,
    };
    appendOwnerTurn(line, { home });
    return true;
  } catch {
    return false;
  }
}

/** `LEARNED <id> <status> member` for every member rule a quote of which cites this request's relay line. */
export function learnedOnRelay(contextRoot: string | null, member: string, requestId: string, home: string = homedir()): string[] {
  const turn = relayTurnId(requestId);
  const out: string[] = [];
  try {
    for (const ref of memberStoreRefs(contextRoot, home)) {
      if (ref.member.slug !== member) continue;
      for (const v of deriveAll(readStore(ref))) {
        if (v.cited_turns.includes(turn) || v.sayings.some((s) => s.turn === turn)) out.push(`LEARNED ${v.id} ${v.status} member`);
      }
    }
  } catch { /* a receipt line lost, never the hand-back */ }
  return out;
}
