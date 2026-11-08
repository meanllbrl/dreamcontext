/**
 * Card records (plan H1, I1, J1, K1, K3): the server's own copy of every `run` and `secret`
 * card a chat drew, keyed by an unforgeable `cardRef`.
 *
 * WHY THE SERVER KEEPS THEM. A run card can now be started from three places (the Mac card, the
 * hands-free phone page, a Telegram button) and a secret card can be filled on the phone. None of
 * those may send the command or the file: the client names the card, the server runs what the
 * AGENT wrote. So every card is parsed here, with the very rules the chat draws with
 * (`parseViewBlock`, src/lib/chat-view-spec.ts: one module, no mirror to drift), and given
 *
 *     cardRef = sha256(sessionId, assistant message uuid, fence index, canonical spec JSON)
 *
 * Every lookup is `(sessionId, cardRef)`; nothing is looked up by the card's `id` across chats.
 * A card posted again (same id, new message) is a NEW record with a new cardRef, and the old one
 * closes. A cardRef is a lookup key, not a secret: authority is the device session, the paired
 * chat or the desktop gate, plus a live open record.
 *
 * CLOSURE IS DURABLE (J1, K1). A record closes by its own end (the run registry, the moment the
 * run ends; a secret receipt), by the Super's `dropOwnerWait`, or by a re-post, and every closure
 * is appended to `~/.dreamcontext/cards/<sessionId>.json` (0700 dir, 0600 file, atomic, newest
 * 500). After a server restart the records are rebuilt from the transcript and a card whose
 * cardRef is in that file comes back CLOSED, never open; closure is never inferred from text,
 * except for cards older than the file's "records since" marker (written the first time a
 * session is tracked, outside the cap): those use the old owner-wait rule (`answeredBy`).
 *
 * Closed records stay (K1) so a reload shows the finished card; the 16-per-chat cap evicts closed
 * records before open ones (K3).
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseViewBlock, type RunViewSpec, type SecretViewSpec } from '../chat-view-spec.js';
import { answeredBy, type OwnerWait } from '../super/owner-wait.js';
import { parseTelegramPrefix, CARD_RECORD_CAP, CLOSED_CARDS_CAP } from '../telegram/contract.js';

export type CardKind = 'run' | 'secret';
export type CardSpec = RunViewSpec | SecretViewSpec;

export interface CardRunInfo {
  runId: string;
  owner: 'mac' | 'phone' | 'telegram';
}

/** One record. `spec` is the FULL validated spec the chat drew. */
export interface CardRecordEntry {
  sessionId: string;
  id: string;
  cardRef: string;
  kind: CardKind;
  spec: CardSpec;
  state: 'open' | 'closed';
  /** The chat's project (registered vault name): a phone or Telegram request must match it. */
  vault: string;
  /** Insertion order, for eviction and "newest copy". */
  seq: number;
  /** A run is going for this card right now (the run registry sets and clears it). */
  run: CardRunInfo | null;
  /** The last run's exit code in this process (null = ended without one). */
  exit?: number | null;
  /** Rebuilt from the transcript after a restart: never announced again (Telegram, J1). */
  rebuilt?: true;
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

const FENCE = /```dream-view[^\S\r\n]*\r?\n([\s\S]*?)```/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CARD_REF_RE = /^[0-9a-f]{32}$/;

export function isSessionUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Canonical JSON: keys sorted at every level, so two spellings of one spec hash alike. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function cardRefOf(sessionId: string, messageUuid: string, fenceIndex: number, spec: CardSpec): string {
  return createHash('sha256').update(JSON.stringify([sessionId, messageUuid, fenceIndex, canonicalJson(spec)])).digest('hex').slice(0, 32);
}

/** The run and secret cards in one assistant text, with their fence index (every dream-view
 *  fence counts, a skipped one included, so the index is the fence's position). */
export function cardsInText(text: string): Array<{ index: number; spec: CardSpec }> {
  const out: Array<{ index: number; spec: CardSpec }> = [];
  if (!text.includes('dream-view')) return out;
  let i = 0;
  for (const m of text.matchAll(FENCE)) {
    const index = i++;
    const { view } = parseViewBlock(m[1]);
    if (view && (view.type === 'run' || view.type === 'secret')) out.push({ index, spec: view });
  }
  return out;
}

// ─── The closed-cards file ──────────────────────────────────────────────────

interface ClosedFile { v: 1; since?: string; closed: string[] }

let cardsHome: string | null = null;
/** Tests: where `~` is. */
export function setCardsHomeForTests(home: string | null): void { cardsHome = home; }
function cardsDir(): string { return join(cardsHome ?? homedir(), '.dreamcontext', 'cards'); }

function ensureDir(): string | null {
  const dir = cardsDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    return dir;
  } catch { return null; }
}

function filePath(sessionId: string): string | null {
  if (!isSessionUuid(sessionId)) return null;
  return join(cardsDir(), `${sessionId.toLowerCase()}.json`);
}

export function readClosedFile(sessionId: string): ClosedFile | null {
  const p = filePath(sessionId);
  if (!p || !existsSync(p)) return null;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<ClosedFile>;
    const closed = Array.isArray(raw.closed) ? raw.closed.filter((x): x is string => typeof x === 'string' && CARD_REF_RE.test(x)) : [];
    return { v: 1, ...(typeof raw.since === 'string' && raw.since.length <= 128 ? { since: raw.since } : {}), closed };
  } catch { return null; }
}

function writeClosedFile(sessionId: string, next: ClosedFile): void {
  const p = filePath(sessionId);
  if (!p || !ensureDir()) return;
  try {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) return;
    const tmp = `${p}.${process.pid}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeSync(fd, JSON.stringify({ v: 1, ...(next.since ? { since: next.since } : {}), closed: next.closed.slice(-CLOSED_CARDS_CAP) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch { /* a closure that could not be written still holds in memory */ }
}

function persistClosed(sessionId: string, cardRef: string): void {
  const cur = readClosedFile(sessionId) ?? { v: 1 as const, closed: [] };
  if (cur.closed.includes(cardRef)) return; // K3: no duplicate entry
  writeClosedFile(sessionId, { ...cur, closed: [...cur.closed, cardRef] });
}

function ensureMarker(sessionId: string, since: string): void {
  const cur = readClosedFile(sessionId);
  if (cur?.since) return;
  writeClosedFile(sessionId, { v: 1, since, closed: cur?.closed ?? [] });
}

// ─── The in-memory records ──────────────────────────────────────────────────

const bySession = new Map<string, CardRecordEntry[]>();
const listeners = new Set<(sessionId: string) => void>();
let seq = 0;

/** Be told when a session's records change (open, close, run state). */
export function onCardsChange(fn: (sessionId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function emit(sessionId: string): void {
  for (const fn of [...listeners]) { try { fn(sessionId); } catch { /* its own */ } }
}

function capRecords(list: CardRecordEntry[]): CardRecordEntry[] {
  let out = list;
  while (out.length > CARD_RECORD_CAP) {
    const closed = out.find((r) => r.state === 'closed' && !r.run);
    const victim = closed ?? out.find((r) => !r.run) ?? out[0];
    out = out.filter((r) => r !== victim);
  }
  return out;
}

/** The chat registry calls this with every top-level assistant text (chat-registry.ts). */
export function noteAssistantCards(sessionId: string, vault: string, messageUuid: string, text: string): void {
  if (!isSessionUuid(sessionId) || !messageUuid) return;
  const found = cardsInText(text);
  if (!found.length) return;
  ensureMarker(sessionId, messageUuid);
  const closedFile = readClosedFile(sessionId);
  let list = bySession.get(sessionId) ?? [];
  let changed = false;
  for (const { index, spec } of found) {
    const cardRef = cardRefOf(sessionId, messageUuid, index, spec);
    if (list.some((r) => r.cardRef === cardRef)) continue;
    // A re-post of the same id is a new ask: the older open copy closes (H1).
    for (const old of list) {
      if (old.id === spec.id && old.kind === spec.type && old.state === 'open' && !old.run) {
        old.state = 'closed';
        persistClosed(sessionId, old.cardRef);
      }
    }
    const state = closedFile?.closed.includes(cardRef) ? 'closed' : 'open';
    list = [...list, { sessionId, id: spec.id, cardRef, kind: spec.type, spec, state, vault, seq: ++seq, run: null }];
    changed = true;
  }
  if (!changed) return;
  bySession.set(sessionId, capRecords(list));
  emit(sessionId);
}

export function getCard(sessionId: string, cardRef: string): CardRecordEntry | null {
  return bySession.get(sessionId)?.find((r) => r.cardRef === cardRef) ?? null;
}

/** The newest record of a card id in a chat (a re-post supersedes; a tap checks it is still this one). */
export function newestCard(sessionId: string, kind: CardKind, id: string): CardRecordEntry | null {
  const list = (bySession.get(sessionId) ?? []).filter((r) => r.kind === kind && r.id === id);
  return list.length ? list.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
}

/** Whether the session is tracked in this process (rebuild needed when not). */
export function hasCards(sessionId: string): boolean {
  return bySession.has(sessionId);
}

export function listCards(sessionId: string): PublicCard[] {
  return (bySession.get(sessionId) ?? []).map(({ id, cardRef, kind, spec, state, run, exit }) => ({ id, cardRef, kind, spec, state, run: run ? { ...run } : null, ...(exit !== undefined ? { exit } : {}) }));
}

/** Open records of a kind in a session (Telegram: what is still waiting on the owner). */
export function openCards(sessionId: string, kind?: CardKind): CardRecordEntry[] {
  return (bySession.get(sessionId) ?? []).filter((r) => r.state === 'open' && (!kind || r.kind === kind));
}

/** Close one record, durably. Re-closing writes nothing new (K3). */
export function closeCard(sessionId: string, cardRef: string): boolean {
  const r = getCard(sessionId, cardRef);
  persistClosed(sessionId, cardRef);
  if (!r || r.state === 'closed') return false;
  r.state = 'closed';
  emit(sessionId);
  return true;
}

/** The Super closed an owner item another way (`dropOwnerWait`): its open records close. */
export function closeCardsById(sessionId: string, kind: CardKind, id: string): void {
  for (const r of bySession.get(sessionId) ?? []) {
    if (r.kind === kind && r.id === id && r.state === 'open' && !r.run) closeCard(sessionId, r.cardRef);
  }
}

export function setCardRun(sessionId: string, cardRef: string, run: CardRunInfo | null, exit?: number | null): void {
  const r = getCard(sessionId, cardRef);
  if (!r) return;
  r.run = run;
  if (run) delete r.exit; else if (exit !== undefined) r.exit = exit;
  emit(sessionId);
}

// ─── Rebuild after a restart (I1, J1, K1) ───────────────────────────────────

const REBUILD_ROWS = 4000;

function rowText(row: Record<string, unknown>): string {
  const msg = row.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
}

/**
 * Rebuild a session's records from its transcript (JSONL rows), once per process. Opens ONLY
 * cards whose cardRef is not in the closed-cards file; cards before the "records since" marker
 * (or every card, when the session was never tracked) use the old owner-wait rule: closed when a
 * LATER owner line answers it, a Telegram owner block excluded. Only the newest 16 come back.
 */
export function rebuildCards(sessionId: string, vault: string, jsonl: string): void {
  if (!isSessionUuid(sessionId) || bySession.has(sessionId)) return;
  const closedFile = readClosedFile(sessionId);
  const rows = jsonl.split('\n').slice(-REBUILD_ROWS);
  const found: Array<{ uuid: string; index: number; spec: CardSpec; legacy: boolean; at: number }> = [];
  const ownerLines: Array<{ at: number; text: string }> = [];
  // Legacy until the marker row is passed. No file, or no marker: every card is legacy, and the
  // legacy rule can only ever close a card, never open one the file closed.
  let afterMarker = false;
  rows.forEach((line, at) => {
    if (!line.trim()) return;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const uuid = typeof row.uuid === 'string' ? row.uuid : '';
    if (closedFile?.since && uuid === closedFile.since) afterMarker = true;
    if (row.type === 'assistant' && uuid) {
      for (const c of cardsInText(rowText(row))) found.push({ uuid, ...c, legacy: !afterMarker, at });
    } else if (row.type === 'user') {
      const text = rowText(row);
      if (text && !parseTelegramPrefix(text).ref) ownerLines.push({ at, text });
    }
  });
  // The legacy rule, as the live registry applies it: each owner line answers from the SET of
  // legacy cards still open before it (with two run cards open, only the one whose command ran).
  const legacyClosed = new Set<(typeof found)[number]>();
  const waitOf = (f: (typeof found)[number]): OwnerWait => (f.spec.type === 'run'
    ? { kind: 'run', id: f.spec.id, line: f.spec.command, key: f.spec.command }
    : { kind: 'secret', id: f.spec.id, line: f.spec.title, key: f.spec.title });
  for (const l of ownerLines) {
    const open = found.filter((f) => f.legacy && f.at < l.at && !legacyClosed.has(f));
    const waits = open.map(waitOf);
    const hit = answeredBy(l.text, waits);
    open.forEach((f, i) => { if (hit.includes(waits[i])) legacyClosed.add(f); });
  }
  let list: CardRecordEntry[] = [];
  for (const f of found.slice(-CARD_RECORD_CAP)) {
    const cardRef = cardRefOf(sessionId, f.uuid, f.index, f.spec);
    let state: 'open' | 'closed' = closedFile?.closed.includes(cardRef) ? 'closed' : 'open';
    if (state === 'open' && f.legacy && legacyClosed.has(f)) state = 'closed';
    // A later copy of the same id supersedes an earlier open one.
    for (const old of list) if (old.id === f.spec.id && old.kind === f.spec.type) old.state = 'closed';
    list.push({ sessionId, id: f.spec.id, cardRef, kind: f.spec.type, spec: f.spec, state, vault, seq: ++seq, run: null, rebuilt: true });
  }
  list = capRecords(list);
  bySession.set(sessionId, list);
  if (list.length) emit(sessionId);
}

/** Tests only. */
export function _resetCardsForTests(): void {
  bySession.clear();
  listeners.clear();
  seq = 0;
}
