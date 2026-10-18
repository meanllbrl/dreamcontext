import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateId } from './id.js';
import { matchForm, ownerTurns, sessionsFromSleepState } from './ask-basis.js';
import { redactEvidenceTail } from './task-evidence.js';
import { candidateSimilarity } from './task-feedback.js';
import { ensureLocalStateIgnored, writeLocalStateJson } from './task-audit.js';
import { safeResolveInside } from './safe-resolve.js';
import { withTaskFileLock } from './task-file-lock.js';
import { findTranscriptBySessionId, isSafeSessionId } from './transcript-locate.js';
import { findRegisteredActor } from './goal-live.js';
import { isAutomationBoundSession } from './automations/session-registry.js';

/**
 * The owner's corrections, kept across sleeps (C7: sleep learns patterns from
 * the owner's repeated corrections).
 *
 * A correction lives one sleep as a bookmark and is then gone, so "the owner
 * said this again" had nowhere to be seen. This ledger keeps the owner's own
 * directive and correction sentences, read through the same classifier C4's
 * quote check uses (`ownerTurns`: never a tool result, hook context, sub-agent
 * notice or skill-loader text), redacted before they are stored, with their
 * date and session. A sentence said in two or more sessions by one person
 * forms a group; sleep-product decides whether a group states a rule and
 * writes it through `patterns learn` (learned-patterns.ts).
 *
 * Machine-local, ignored before the first write (`ensureLocalStateIgnored`),
 * temps under `_dream_context/tmp/`.
 */

/** The ledger, relative to the context root. Referenced only in this module. */
const OWNER_CORRECTIONS_REL = 'state/.owner-corrections.json';
const LOCK_KEY = '.owner-corrections';

export const MAX_ITEMS = 1000;
export const TTL_DAYS = 90;
export const QUOTE_MAX = 200;
/** A whole turn at least this long, identical across sessions, is a program's brief: counted once. */
export const LONG_TURN_CHARS = 400;
/** Stem overlap at which two corrections are the same one, said again. */
export const GROUP_SIMILARITY = 0.45;

export type CorrectionSource = 'epoch' | 'backfill';

export interface OwnerCorrection {
  /** `oc_<nanoid8>` */
  id: string;
  /** sha1(session + record uuid or ordinal + quote): ingest is idempotent on it. */
  key: string;
  at: string;
  session: string;
  person: string | null;
  quote: string;
  source: CorrectionSource;
  /** `unknown` for backfilled turns: the session's origin was not recorded at the time. */
  origin: 'recorded' | 'unknown';
  /** Set when the quote came from a long turn: sha1 of the turn's match form. */
  turnHash?: string;
}

export interface CorrectionGroup {
  /** `cg_<hash of the sorted ids>` */
  groupId: string;
  ids: string[];
  sessions: number;
  person: string | null;
  originUnknown: boolean;
  quotes: Array<{ text: string; date: string }>;
}

export interface SessionRef {
  id: string;
  path: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

// ─── Detection ───────────────────────────────────────────────────────────────

/**
 * A correction or a standing style instruction, matched on the ASCII-folded
 * match form (so `yanlış` is `yanlis`, `don't` is `don t`). The correction half
 * mirrors `CORRECTION_RE` (salience.ts); the rest are the words a person uses
 * when they set a rule. Recall over precision: sleep-product judges each group.
 */
const DIRECTIVE_RE = new RegExp([
  '^(no|nope|hayir)\\b', '\\bactually\\b', '\\binstead of\\b', '\\b(wrong|incorrect)\\b', '\\byanlis\\b', '\\boyle degil\\b',
  '\\balways\\b', '\\bnever\\b', '\\bdon t\\b', '\\bdont\\b', '\\bdo not\\b', '\\bstop\\b', '\\bfrom now on\\b',
  '\\binstead\\b', '\\bi (already )?told you\\b', '\\bagain\\b',
  '\\bher zaman\\b', '\\basla\\b', '\\bhicbir zaman\\b', '\\b(yapma|kullanma|yazma)(yin|yiniz)?\\b',
  '\\bbundan sonra\\b', '\\byerine\\b', '\\bkac kere\\b', '\\byine\\b', '\\btekrar soyluyorum\\b',
].join('|'));

/** The sentences of one owner turn that set a rule or correct the agent. */
export function directiveSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.trim();
    if (!s) continue;
    const form = matchForm(s);
    if (!form) continue;
    if (DIRECTIVE_RE.test(form)) out.push(s);
  }
  return out;
}

/** The stored form of a quote: secrets redacted (A8), one line, capped. */
function storedQuote(sentence: string, contextRoot: string): string {
  const redacted = redactEvidenceTail(sentence, dirname(contextRoot)).replace(/\s+/g, ' ').trim();
  return redacted.length <= QUOTE_MAX ? redacted : `${redacted.slice(0, QUOTE_MAX - 1)}…`;
}

// ─── The ledger ──────────────────────────────────────────────────────────────

function isItem(x: unknown): x is OwnerCorrection {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.key === 'string' && typeof o.at === 'string'
    && typeof o.session === 'string' && typeof o.quote === 'string'
    && (o.source === 'epoch' || o.source === 'backfill')
    && (o.origin === 'recorded' || o.origin === 'unknown');
}

/** Every stored correction, oldest first. Missing or unreadable reads as none. */
export function readCorrections(contextRoot: string): OwnerCorrection[] {
  let p: string;
  try {
    p = safeResolveInside(contextRoot, OWNER_CORRECTIONS_REL);
  } catch {
    return [];
  }
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { items?: unknown };
    return Array.isArray(parsed?.items) ? parsed.items.filter(isItem) : [];
  } catch {
    return [];
  }
}

/**
 * Drop what is past the TTL, then keep the newest {@link MAX_ITEMS} by `at` — not by insertion
 * order: a backfill appends sessions in registry order, so the ledger's tail is not its newest
 * end. At an equal `at`, an item this ingest brought (`fresh`) goes first, so a re-run never
 * swaps a stored item out for its own copy. An unparseable `at` counts as now.
 */
function prune(items: OwnerCorrection[], now: Date, fresh: ReadonlySet<string> = new Set()): OwnerCorrection[] {
  const cutoff = now.getTime() - TTL_DAYS * 86_400_000;
  const time = (i: OwnerCorrection) => {
    const t = Date.parse(i.at);
    return Number.isNaN(t) ? now.getTime() : t;
  };
  // Stored oldest first by `at`, which is also what `readCorrections` promises.
  const ranked = items
    .filter((i) => time(i) >= cutoff)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => time(a.item) - time(b.item)
      || Number(fresh.has(b.item.key)) - Number(fresh.has(a.item.key))
      || a.index - b.index)
    .map((r) => r.item);
  return ranked.length > MAX_ITEMS ? ranked.slice(ranked.length - MAX_ITEMS) : ranked;
}

/**
 * Read the owner's turns of these sessions into the ledger. The ignore entries
 * are ensured FIRST (throws when they cannot be: nothing is written then).
 * Idempotent on each quote's key. A whole turn of {@link LONG_TURN_CHARS}+ that
 * is identical across sessions (a dispatch brief pasted into several builders)
 * counts once; a short correction typed verbatim in two sessions counts twice,
 * because that is exactly the owner repeating themself.
 */
export function ingestSessions(
  contextRoot: string,
  sessions: readonly SessionRef[],
  person: string | null,
  source: CorrectionSource,
  now: Date = new Date(),
): { added: number } {
  ensureLocalStateIgnored(contextRoot);
  return withTaskFileLock(contextRoot, LOCK_KEY, () => {
    const items = readCorrections(contextRoot);
    const keys = new Set(items.map((i) => i.key));
    const longTurnSession = new Map<string, string>();
    for (const i of items) if (i.turnHash && !longTurnSession.has(i.turnHash)) longTurnSession.set(i.turnHash, i.session);
    const fresh = new Set<string>();
    for (const s of sessions) {
      if (!isSafeSessionId(s.id)) continue;
      const turns = ownerTurns(s.path);
      turns.forEach((turn, ordinal) => {
        let turnHash: string | undefined;
        if (turn.text.length >= LONG_TURN_CHARS) {
          turnHash = sha1(matchForm(turn.text));
          const seenIn = longTurnSession.get(turnHash);
          if (seenIn && seenIn !== s.id) return;
          longTurnSession.set(turnHash, s.id);
        }
        for (const sentence of directiveSentences(turn.text)) {
          const quote = storedQuote(sentence, contextRoot);
          if (!quote) continue;
          const key = sha1(`${s.id}\0${turn.uuid ?? `#${ordinal}`}\0${quote}`);
          if (keys.has(key)) continue;
          keys.add(key);
          items.push({
            id: generateId('oc'),
            key,
            at: turn.at ?? now.toISOString(),
            session: s.id,
            person,
            quote,
            source,
            origin: source === 'backfill' ? 'unknown' : 'recorded',
            ...(turnHash ? { turnHash } : {}),
          });
          fresh.add(key);
        }
      });
    }
    const kept = prune(items, now, fresh);
    writeLocalStateJson(contextRoot, OWNER_CORRECTIONS_REL, { version: 1, items: kept });
    // Only what survived the prune was added: a turn past the TTL, or older than the newest
    // MAX_ITEMS, is read and dropped again on every run and must not count as new each time.
    return { added: kept.filter((i) => fresh.has(i.key)).length };
  });
}

// ─── Backfill ────────────────────────────────────────────────────────────────

export interface BackfillExclusions {
  spawnRecord: number;
  goalLive: number;
  goalSid: number;
  builder: number;
  automation: number;
}

/** Every string under a `sid` key, at any depth (the Develop builder registry). */
function collectSids(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { for (const v of value) collectSids(v, out); return; }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'sid' && typeof v === 'string' && isSafeSessionId(v)) out.add(v);
    else collectSids(v, out);
  }
}

function safeDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function filesUnder(dir: string, test: (name: string) => boolean, depth = 4): string[] {
  if (depth < 0 || !safeDir(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st: Stats;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...filesUnder(p, test, depth - 1));
    else if (st.isFile() && test(name)) out.push(p);
  }
  return out;
}

/** Session ids the goal-skill wrote as `.sid` files, and the Develop builders' registries. */
function registeredSpawnIds(contextRoot: string): { goalSid: Set<string>; builder: Set<string> } {
  const goalSid = new Set<string>();
  for (const f of filesUnder(join(contextRoot, 'tmp', 'goal'), (n) => n.endsWith('.sid'))) {
    try {
      const id = readFileSync(f, 'utf-8').trim();
      if (isSafeSessionId(id)) goalSid.add(id);
    } catch { /* vanished */ }
  }
  const builder = new Set<string>();
  for (const f of filesUnder(join(contextRoot, 'tmp', 'develop'), (n) => n === 'builders.json', 1)) {
    try { collectSids(JSON.parse(readFileSync(f, 'utf-8')), builder); } catch { /* unreadable registry */ }
  }
  return { goalSid, builder };
}

interface HistoryRow { consolidated_at?: unknown; session_ids?: unknown; spawned_session_ids?: unknown }

function readHistory(contextRoot: string): HistoryRow[] {
  try {
    const parsed = JSON.parse(readFileSync(join(contextRoot, 'state', '.sleep-history.json'), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as HistoryRow[]) : [];
  } catch {
    return [];
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The sessions of the last `days` whose owner turns may be read: the history's
 * consolidated rounds in that window plus this sleep's sessions, minus every
 * session registered as spawned (a `spawn` record, a history
 * `spawned_session_ids` entry, a goal-live actor, a goal-skill `.sid` file, a
 * Develop builder, an automation-bound session). What no registry knows about
 * (a council persona, an ad-hoc nested `claude -p` before markers existed) can
 * still slip through: those items are stored as `origin: unknown`.
 */
export function backfillSessions(
  contextRoot: string,
  days: number,
  now: Date = new Date(),
  home: string = homedir(),
): { sessions: SessionRef[]; excluded: BackfillExclusions } {
  const excluded: BackfillExclusions = { spawnRecord: 0, goalLive: 0, goalSid: 0, builder: 0, automation: 0 };
  const cutoff = now.getTime() - days * 86_400_000;
  const spawned = new Set<string>();
  const candidates = new Map<string, string | null>();

  for (const row of readHistory(contextRoot)) {
    const at = typeof row.consolidated_at === 'string' ? Date.parse(row.consolidated_at) : NaN;
    if (Number.isNaN(at) || at < cutoff) continue;
    for (const id of strings(row.spawned_session_ids)) spawned.add(id);
    for (const id of strings(row.session_ids)) if (!candidates.has(id)) candidates.set(id, null);
  }
  for (const s of sessionsFromSleepState(contextRoot)) {
    if (!s || typeof s.session_id !== 'string') continue;
    if (s.spawn) spawned.add(s.session_id);
    candidates.set(s.session_id, typeof s.transcript_path === 'string' ? s.transcript_path : null);
  }

  const { goalSid, builder } = registeredSpawnIds(contextRoot);
  const sessions: SessionRef[] = [];
  for (const [id, knownPath] of candidates) {
    if (!isSafeSessionId(id)) continue;
    if (spawned.has(id)) { excluded.spawnRecord++; continue; }
    if (goalSid.has(id)) { excluded.goalSid++; continue; }
    if (builder.has(id)) { excluded.builder++; continue; }
    if (findRegisteredActor(contextRoot, id)) { excluded.goalLive++; continue; }
    if (isAutomationBoundSession(id, home)) { excluded.automation++; continue; }
    const path = knownPath && knownPath.endsWith('.jsonl') && existsSync(knownPath)
      ? knownPath
      : findTranscriptBySessionId([id], home);
    if (!path) continue;
    try {
      const mtime = lstatSync(path).mtimeMs;
      if (mtime < cutoff) continue;
    } catch {
      continue;
    }
    sessions.push({ id, path });
  }
  return { sessions, excluded };
}

// ─── Groups ──────────────────────────────────────────────────────────────────

/**
 * Corrections said in two or more sessions by one person, grouped greedily by
 * stem overlap against each group's first item. `exclude` holds the ids already
 * cited by a learned change, active or reverted (a reverted rule is the owner's
 * no: its corrections never regroup). Oldest first inside a group.
 */
export function recurringGroups(contextRoot: string, opts: { exclude?: ReadonlySet<string> } = {}): CorrectionGroup[] {
  const exclude = opts.exclude ?? new Set<string>();
  const items = readCorrections(contextRoot).filter((i) => !exclude.has(i.id));
  const groups: OwnerCorrection[][] = [];
  for (const item of items) {
    const home = groups.find((g) => g[0].person === item.person && candidateSimilarity(g[0].quote, item.quote) >= GROUP_SIMILARITY);
    if (home) home.push(item);
    else groups.push([item]);
  }
  const out: CorrectionGroup[] = [];
  for (const g of groups) {
    const sessions = new Set(g.map((i) => i.session)).size;
    if (sessions < 2) continue;
    const ids = g.map((i) => i.id);
    out.push({
      groupId: `cg_${sha1([...ids].sort().join(',')).slice(0, 10)}`,
      ids,
      sessions,
      person: g[0].person,
      originUnknown: g.some((i) => i.origin === 'unknown'),
      quotes: g.map((i) => ({ text: i.quote, date: i.at.slice(0, 10) })),
    });
  }
  return out;
}
