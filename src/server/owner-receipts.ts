/**
 * The result of an owner's action on a CREW child's card, held by the server until that child
 * has taken it (sahip-karti-yerinde K6). A crew child is a child of main or of a member Super;
 * every other host keeps today's path (src/server/runs/delivery.ts, by session, window delivery).
 *
 * ONE RULE: a result is held BEFORE anything that can lose it (the record closing, the process
 * exiting, the first await), and it leaves the store only once delivered, or when its item
 * leaves without delivery (Not needed, `super queue done`, the child ended).
 *
 *  - Where: `~/.dreamcontext/cards/receipts/<child record>__<child id>.json`, keyed by the item's
 *    `deliverTo` (the posting child, then its successor). Both name parts are checked against
 *    fixed patterns first. Dir 0700, file 0600, written atomically; a symlinked dir or file is
 *    refused (lstat + realpath containment).
 *  - One entry per ACTION (`id` = the runId of a run, a fresh submit id of a secret or a
 *    checklist): a newer action never overwrites an older undelivered one, a send removes only
 *    the entry it sent (same id, same text), and an undelivered entry is NEVER cut.
 *  - A FILE IS NEVER PROOF that the owner acted. Each entry carries an HMAC under a random key
 *    made at boot and kept in memory only, over (child record, child, entry id, cardRef, kind,
 *    kept text, pending). The deliverer, the wake and the Super's `owner-result` event act on an
 *    entry ONLY when it verifies under THIS boot's key; one held across a restart, written by
 *    hand or edited is drawn read-only (`kept`) and proves nothing.
 *  - TWO FORMS: `text` on disk is the KEPT form (a typed secret replaced by
 *    `[secret, N chars, sha256:…]`). The FULL form lives in this process's memory only, keyed by
 *    (target, entry id), is handed only to the deliverer that writes it into the child's own
 *    stream, and is dropped the moment its entry leaves.
 *
 * The deliverer and the wake are lane A's (agent-chat.ts registers them); until one is
 * registered the receipt simply stays held.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { CARD_REF_RE } from '../lib/cards/records.js';
import { buildInterruptedReport } from '../lib/run-report.js';
import { checklistReceiptForms, type ChecklistSubmitState } from '../lib/checklist-markdown.js';
import type { ChecklistViewSpec } from '../lib/chat-view-spec.js';
import { isOwnerCardKind, type OwnerCardKind } from '../lib/super/owner-wait.js';
import {
  OWNER_RECEIPT_CHILD_RE, OWNER_RECEIPT_RECORD_RE,
  type OwnerCardHandle, type OwnerDeliverOutcome, type OwnerReceiptEntry, type OwnerReceiptView, type OwnerWakeOutcome,
} from '../lib/super/types.js';

export type { OwnerReceiptEntry, OwnerReceiptView, OwnerWakeOutcome, OwnerDeliverOutcome };

/** Whose result it is: the Super record that owns the child, and the child. */
export interface OwnerReceiptTarget { childRecordId: string; childId: string }

/** The item's delivery target (`deliverTo`, K1/K2). */
export function receiptTargetOf(h: Pick<OwnerCardHandle, 'childRecordId' | 'deliverTo'>): OwnerReceiptTarget {
  return { childRecordId: h.childRecordId, childId: h.deliverTo };
}

/** What a caller holds: the kept form (`text`), and the full form only when it differs (a
 *  checklist with a typed `wants:'secret'` value). */
export interface OwnerReceiptInput {
  id: string;
  cardRef: string;
  kind: OwnerCardKind;
  text: string;
  full?: string;
  pending?: true;
}

const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A file this large is not ours: refused, never parsed. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// ─── The per-boot key ───────────────────────────────────────────────────────

let bootKey: Buffer = randomBytes(32);
/** Full forms, by `<file key>\n<entry id>`: this process's memory only. */
const fullForms = new Map<string, string>();
/** Cut-off notices already given in this boot, by `<file key>\n<entry id>`. */
const noticed = new Set<string>();

function macOf(t: OwnerReceiptTarget, e: Pick<OwnerReceiptEntry, 'id' | 'cardRef' | 'kind' | 'text' | 'pending'>): string {
  return createHmac('sha256', bootKey)
    .update(JSON.stringify(['owner-receipt/v1', t.childRecordId, t.childId, e.id, e.cardRef, e.kind, e.text, e.pending === true]))
    .digest('hex');
}

/** Does this entry verify under THIS boot's key, for THIS target? */
export function verifyOwnerReceipt(t: OwnerReceiptTarget, e: OwnerReceiptEntry): boolean {
  if (typeof e.mac !== 'string' || !/^[0-9a-f]{64}$/.test(e.mac)) return false;
  const want = Buffer.from(macOf(t, e), 'hex');
  const got = Buffer.from(e.mac, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}

// ─── The store on disk ──────────────────────────────────────────────────────

let receiptsHome: string | null = null;
/** Tests: where `~` is. */
export function setOwnerReceiptsHomeForTests(home: string | null): void { receiptsHome = home; }
function cardsDir(): string { return join(receiptsHome ?? homedir(), '.dreamcontext', 'cards'); }
function receiptsDir(): string { return join(cardsDir(), 'receipts'); }

export function isReceiptTarget(t: unknown): t is OwnerReceiptTarget {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  return typeof o.childRecordId === 'string' && OWNER_RECEIPT_RECORD_RE.test(o.childRecordId)
    && typeof o.childId === 'string' && OWNER_RECEIPT_CHILD_RE.test(o.childId);
}

/** `main` / `m:<slug>` → a file-name part with no colon. */
function fileKey(t: OwnerReceiptTarget): string | null {
  if (!isReceiptTarget(t)) return null;
  return `${t.childRecordId.replace(':', '~')}__${t.childId}`;
}

/** The receipts dir, made 0700 if missing; null when it (or `cards/`) is a symlink or resolves
 *  outside `~/.dreamcontext/cards`. */
function ensureReceiptsDir(create: boolean): string | null {
  const parent = cardsDir();
  const dir = receiptsDir();
  try {
    if (!existsSync(dir)) {
      if (!create) return null;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    for (const d of [parent, dir]) {
      const st = lstatSync(d);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    const realParent = realpathSync.native(parent);
    const realDir = realpathSync.native(dir);
    if (realDir !== join(realParent, 'receipts') || !realDir.startsWith(realParent + sep)) return null;
    if ((lstatSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    return dir;
  } catch { return null; }
}

function filePath(t: OwnerReceiptTarget, create: boolean): string | null {
  const key = fileKey(t);
  if (!key) return null;
  const dir = ensureReceiptsDir(create);
  return dir ? join(dir, `${key}.json`) : null;
}

function cleanEntry(raw: unknown): OwnerReceiptEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ENTRY_ID_RE.test(o.id)) return null;
  if (typeof o.cardRef !== 'string' || !CARD_REF_RE.test(o.cardRef)) return null;
  if (!isOwnerCardKind(o.kind) || typeof o.text !== 'string') return null;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  // An entry with no MAC is still read (drawn `kept`, read-only); it never verifies.
  const mac = typeof o.mac === 'string' ? o.mac : '';
  return { id: o.id, cardRef: o.cardRef, kind: o.kind, text: o.text, at, ...(o.pending === true ? { pending: true as const } : {}), mac };
}

/** Every entry held for a target, as on disk (verified or not). */
export function readOwnerReceipts(t: OwnerReceiptTarget): OwnerReceiptEntry[] {
  const p = filePath(t, false);
  if (!p || !existsSync(p)) return [];
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return [];
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : []);
    return list.map(cleanEntry).filter((e): e is OwnerReceiptEntry => !!e);
  } catch { return []; }
}

/** Write the whole list (synchronously, atomically, 0600); an empty list removes the file
 *  (every store key needs a death). False when it could not be written. */
function writeAll(t: OwnerReceiptTarget, list: OwnerReceiptEntry[]): boolean {
  const p = filePath(t, list.length > 0);
  if (!p) return list.length === 0;
  try {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) return false;
    if (!list.length) { if (existsSync(p)) rmSync(p); return true; }
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ v: 1, entries: list })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    return true;
  } catch { return false; }
}

const memKey = (t: OwnerReceiptTarget, id: string): string => `${fileKey(t) ?? ''}\n${id}`;

/**
 * HOLD one action's result (K6). SYNCHRONOUS, before any await: call it in the same block that
 * closes the record (run start's `pending` placeholder before `markCardStarted`, the finished
 * report, a secret before `closeCard(..., 'done')`, a checklist before its record closes).
 * Replaces only an entry with the same id (a run's placeholder by its finished report); never
 * cuts another. Returns the entry as stored (with its MAC), or null when it could not be
 * written (bad target or id, a symlinked store).
 */
export function holdOwnerReceipt(t: OwnerReceiptTarget, input: OwnerReceiptInput): OwnerReceiptEntry | null {
  if (!isReceiptTarget(t) || !ENTRY_ID_RE.test(input.id) || !CARD_REF_RE.test(input.cardRef) || !isOwnerCardKind(input.kind)) return null;
  const base = { id: input.id, cardRef: input.cardRef, kind: input.kind, text: input.text, ...(input.pending ? { pending: true as const } : {}) };
  const entry: OwnerReceiptEntry = { ...base, at: Date.now(), mac: macOf(t, base) };
  const next = [...readOwnerReceipts(t).filter((e) => e.id !== input.id), entry];
  if (!writeAll(t, next)) return null;
  const k = memKey(t, input.id);
  if (input.full !== undefined && input.full !== input.text) fullForms.set(k, input.full); else fullForms.delete(k);
  return entry;
}

/** The entries a deliverer may send now: verified, not a run still pending, with the text it
 *  writes into the child (the FULL form when this process has one, else the kept form). */
export function deliverableOwnerReceipts(t: OwnerReceiptTarget): Array<{ entry: OwnerReceiptEntry; text: string }> {
  return readOwnerReceipts(t)
    .filter((e) => !e.pending && verifyOwnerReceipt(t, e))
    .map((entry) => ({ entry, text: fullForms.get(memKey(t, entry.id)) ?? entry.text }));
}

/**
 * The deliverer wrote `sent` into the child (an `ownerReceipt` frame): remove it (same id, same
 * kept text; a placeholder replaced meanwhile stays), and with it every OTHER entry for the same
 * cardRef that does not verify (kept from before a restart, a stale cut-off placeholder), so the
 * slot never draws "Kept from before a restart" beside "Sent to <child>". Its full form goes.
 * Returns how many entries left.
 */
export function markOwnerReceiptDelivered(t: OwnerReceiptTarget, sent: Pick<OwnerReceiptEntry, 'id' | 'text'>): number {
  const all = readOwnerReceipts(t);
  const hit = all.find((e) => e.id === sent.id && e.text === sent.text && verifyOwnerReceipt(t, e));
  if (!hit) return 0;
  const gone = all.filter((e) => e === hit || (e.cardRef === hit.cardRef && !verifyOwnerReceipt(t, e)));
  if (!writeAll(t, all.filter((e) => !gone.includes(e)))) return 0;
  for (const e of gone) fullForms.delete(memKey(t, e.id));
  return gone.length;
}

/**
 * Entries leave WITHOUT delivery (Not needed, `super queue done`, the child ended, the item
 * closed, the child's record deleted): by cardRef, or all of the target's. Their full forms are
 * dropped with them, so a typed secret never outlives the item it was typed for. Returns what
 * left (an ended child's `owner-result` event carries their kept form).
 */
export function dropOwnerReceipts(t: OwnerReceiptTarget, filter: { cardRef?: string } = {}): OwnerReceiptEntry[] {
  const all = readOwnerReceipts(t);
  const gone = all.filter((e) => !filter.cardRef || e.cardRef === filter.cardRef);
  if (!gone.length) return [];
  if (!writeAll(t, all.filter((e) => !gone.includes(e)))) return [];
  for (const e of gone) fullForms.delete(memKey(t, e.id));
  return gone;
}

/** What the slot draws for a target's held entries (K6/K7), never a MAC. */
export function ownerReceiptViews(t: OwnerReceiptTarget): OwnerReceiptView[] {
  return readOwnerReceipts(t).map((e): OwnerReceiptView => {
    const ok = verifyOwnerReceipt(t, e);
    const state: OwnerReceiptView['state'] = e.pending ? (ok ? 'running' : 'cut_off') : (ok ? 'held' : 'kept');
    return { id: e.id, cardRef: e.cardRef, kind: e.kind, at: e.at, state, text: e.text };
  });
}

/**
 * The secret re-entry (K1): true only while the owner item is still OPEN and the store holds an
 * entry for this secret card that does NOT verify under this boot's key, and none that does.
 * It stays true while the re-entry is in flight and turns false once a verified entry exists or
 * the item closes. Never true for any other kind.
 */
export function owedUnverified(h: OwnerCardHandle, opts: { itemOpen?: boolean } = {}): boolean {
  if (opts.itemOpen === false || h.spec.type !== 'secret') return false;
  const targets: OwnerReceiptTarget[] = [{ childRecordId: h.childRecordId, childId: h.deliverTo }];
  if (h.childId !== h.deliverTo) targets.push({ childRecordId: h.childRecordId, childId: h.childId });
  let unverified = false;
  for (const t of targets) {
    for (const e of readOwnerReceipts(t)) {
      if (e.cardRef !== h.cardRef || e.kind !== 'secret') continue;
      if (verifyOwnerReceipt(t, e)) return false;
      unverified = true;
    }
  }
  return unverified;
}

/** The line a cut-off run notice ends with. */
export const CUT_OFF_NOTICE_TAIL = 'The owner can run it again from the card.';

/**
 * The cut-off notices owed to a child at its live edge (K1, K6): one per UNVERIFIED `pending`
 * entry of the target (an unverified placeholder was never written in this boot, so its run is
 * not live in this boot), once per (entry, boot). The text is NEVER taken from the file: it is
 * built from the record's command, which `commandOf` returns for a cardRef the child has (from
 * its items' card handles, or `ensureCardsFor`); a cardRef it does not know (a hand-written
 * entry) gives nothing. Written on the `server` channel by the caller: closes nothing, wakes
 * nothing.
 */
export function takeInterruptedNotices(
  t: OwnerReceiptTarget,
  commandOf: (cardRef: string) => string | null,
): Array<{ entryId: string; cardRef: string; text: string }> {
  const out: Array<{ entryId: string; cardRef: string; text: string }> = [];
  for (const e of readOwnerReceipts(t)) {
    if (!e.pending || e.kind !== 'run' || verifyOwnerReceipt(t, e)) continue;
    const k = memKey(t, e.id);
    if (noticed.has(k)) continue;
    const command = commandOf(e.cardRef);
    if (!command) continue;
    noticed.add(k);
    out.push({ entryId: e.id, cardRef: e.cardRef, text: `${buildInterruptedReport(command)}\n${CUT_OFF_NOTICE_TAIL}` });
  }
  return out;
}

/** A command from a child's card handles, for {@link takeInterruptedNotices}. */
export function commandFromHandles(handles: ReadonlyArray<Pick<OwnerCardHandle, 'cardRef' | 'spec'>>): (cardRef: string) => string | null {
  return (cardRef) => {
    const h = handles.find((x) => x.cardRef === cardRef);
    return h && h.spec.type === 'run' ? h.spec.command : null;
  };
}

/** Every target with a receipts file (for a sweep that removes the files of deleted children). */
export function listReceiptTargets(): OwnerReceiptTarget[] {
  const dir = ensureReceiptsDir(false);
  if (!dir) return [];
  const out: OwnerReceiptTarget[] = [];
  try {
    for (const f of readdirSync(dir)) {
      const m = /^(main|m~[a-z0-9][a-z0-9-]{0,79})__([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.json$/.exec(f);
      if (m) out.push({ childRecordId: m[1].replace('~', ':'), childId: m[2] });
    }
  } catch { /* none */ }
  return out;
}

// ─── Receipts built here (server side) ──────────────────────────────────────

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf-8').digest('hex');

/** A checklist receipt's two forms, built by the SERVER from the structured state (K4, K6). */
export function checklistReceipt(spec: ChecklistViewSpec, state: ChecklistSubmitState, secrets: Record<string, string>): { full: string; kept: string } {
  return checklistReceiptForms(spec, state, secrets, sha256Hex);
}

/** A fresh submit id for a secret or a checklist action. */
export function newSubmitId(): string {
  return `s-${randomBytes(12).toString('hex')}`;
}

// ─── Deliver and wake: registered by lane A ─────────────────────────────────

export type OwnerReceiptDeliverer = (t: OwnerReceiptTarget) => Promise<OwnerDeliverOutcome>;
export type OwnerCardWaker = (t: OwnerReceiptTarget) => Promise<OwnerWakeOutcome>;

let deliverer: OwnerReceiptDeliverer | null = null;
let waker: OwnerCardWaker | null = null;

/** Lane A (agent-chat.ts) registers the deliverer: live process → an `ownerReceipt` frame
 *  through the crew handle; not live → `wakeForOwnerCard`; ended → no delivery. Returns the
 *  unregister. */
export function registerOwnerReceiptDeliverer(fn: OwnerReceiptDeliverer): () => void {
  deliverer = fn;
  return () => { if (deliverer === fn) deliverer = null; };
}

/** Lane A registers the wake: the window `resume` of the owning Super, the live-children cap. */
export function registerOwnerCardWaker(fn: OwnerCardWaker): () => void {
  waker = fn;
  return () => { if (waker === fn) waker = null; };
}

/** Deliver what is held for a target. With no deliverer registered the receipt stays held. */
export async function deliverOwnerReceipt(t: OwnerReceiptTarget): Promise<OwnerDeliverOutcome> {
  if (!deliverer) return 'held';
  try { return await deliverer(t); } catch { return 'held'; }
}

/** Wake a not-live child for its card result (a server primitive acting on the owner's proven
 *  action, never a SuperCaller). With no waker registered: `held:no_window`, receipt kept. */
export async function wakeForOwnerCard(t: OwnerReceiptTarget): Promise<OwnerWakeOutcome> {
  if (!waker) return 'held:no_window';
  try { return await waker(t); } catch { return 'held:no_window'; }
}

/** Tests only: a server restart (a new boot key; full forms and notice memory gone). */
export function _restartOwnerReceiptsForTests(): void {
  bootKey = randomBytes(32);
  fullForms.clear();
  noticed.clear();
}

/** Tests only. */
export function _resetOwnerReceiptsForTests(): void {
  _restartOwnerReceiptsForTests();
  deliverer = null;
  waker = null;
  receiptsHome = null;
}
