import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateId, slugify, today } from './id.js';
import { safeResolveInside } from './safe-resolve.js';
import { appendDeclined } from './task-declined.js';
import { redactEvidenceTail } from './task-evidence.js';
import {
  appendFeedback,
  CorruptStoreError,
  newFeedbackId,
  readFeedback,
  readFeedbackStrict,
  reasonLabel,
  type FeedbackBasis,
  type FeedbackReason,
} from './task-feedback.js';
import type { TaskBackend } from './task-backend/types.js';
import { TaskFileBusyError, withTaskFileLock } from './task-file-lock.js';
import { checkParentLink, loadFamily } from './task-parent.js';
import { isCancelled, normalizeStatusKey, type StatusDef } from './task-status.js';
import { readFrontmatter } from './frontmatter.js';

/**
 * task-proposals — what sleep wants on the board but may not put there itself.
 *
 * Owner decision 8: sleep files a new top-level task only at high confidence
 * (basis `ask` or `defect`, see ask-basis.ts). Everything else it would have
 * filed becomes a PROPOSAL here, and lives on the Tasks screen — not in a chat
 * or the snapshot, because sleep often runs in the background with nobody in a
 * session. The owner accepts (the task lands in the Next queue) or rejects with
 * a one-tap reason (feedback for the task-filing rules, plus the declined store
 * so no later cycle re-proposes it).
 *
 * The same file keeps the ledger of tasks sleep DID file (`filed`): they show in
 * the same section labelled "opened by sleep" until the owner keeps or rejects
 * them, and their outcomes feed the brake — when more than 30% of sleep's last
 * 20 judged items were rejected, direct filing turns off and everything goes to
 * proposals until enough accepted proposals bring the rate back down.
 *
 * `created_by` on the card is NOT the record of "sleep filed this": it is a
 * remote-mapped field a GitHub/ClickUp pull overwrites with the author. This
 * ledger (machine state, synced like `.task-declined.json` where the brain repo
 * syncs `state/`) is.
 */

export const PROPOSALS_REL_PATH = 'state/.task-proposals.json';
/** The lock key for every read-modify-write of this store (and its feedback). */
const LOCK_KEY = '.task-proposals';
/** Resolved entries kept for the brake and the history; pending ones are never dropped. */
const MAX_RESOLVED = 300;
/**
 * How long an owner action holds its claim on an item. Long enough for a slow
 * remote backend; past it, a claim is what a crashed accept or reject left behind.
 */
const CLAIM_TTL_MS = 5 * 60_000;
/** Longest quote kept. A session line is a sentence or two, never a log. */
export const MAX_QUOTE_CHARS = 500;

/**
 * A quote or defect excerpt as it may be stored and synced: secrets redacted (the
 * scrub rules and this project's known secret values), one line (a newline in a
 * synced journal entry could open a forged heading), at most {@link MAX_QUOTE_CHARS}.
 */
export function storableQuote(text: string, contextRoot: string): string {
  const flat = redactEvidenceTail(text, dirname(contextRoot)).replace(/\s*[\r\n]+\s*/g, ' ⏎ ').trim();
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS - 1)}…` : flat;
}

export interface TaskProposal {
  id: string;
  name: string;
  why: string;
  /** alıntı — the session line it came from. */
  quote: string;
  basis: FeedbackBasis;
  /** önerilen ana görev — the parent sleep suggests it belongs under. */
  parent: string | null;
  session: string | null;
  proposedAt: string;
  by: 'sleep' | 'agent';
  status: 'pending' | 'accepted' | 'rejected';
  resolvedAt?: string;
  /** The task an accepted proposal became. */
  slug?: string;
  /** An accept in flight: the task it is creating, and since when. */
  claim?: { slug: string; at: string };
}

export interface FiledRecord {
  slug: string;
  name: string;
  why: string;
  quote: string;
  basis: FeedbackBasis;
  /** Set when sleep filed it as a sub-task of an existing parent. */
  parent: string | null;
  filedAt: string;
  outcome: 'open' | 'kept' | 'rejected';
  resolvedAt?: string;
  /** A reject in flight, since when. */
  claim?: { at: string };
}

export interface ProposalStore {
  proposals: TaskProposal[];
  filed: FiledRecord[];
}

export class ProposalError extends Error {
  constructor(
    public readonly code: 'not_found' | 'resolved' | 'invalid' | 'exists' | 'no_cancel_status' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'ProposalError';
  }
}

function storePath(contextRoot: string): string {
  return safeResolveInside(contextRoot, PROPOSALS_REL_PATH);
}

function isProposal(v: unknown): v is TaskProposal {
  const p = v as Record<string, unknown> | null;
  return !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.why === 'string'
    && (p.status === 'pending' || p.status === 'accepted' || p.status === 'rejected');
}

function isFiled(v: unknown): v is FiledRecord {
  const f = v as Record<string, unknown> | null;
  return !!f && typeof f.slug === 'string' && typeof f.filedAt === 'string'
    && (f.outcome === 'open' || f.outcome === 'kept' || f.outcome === 'rejected');
}

/**
 * Missing = an empty store; a file that exists but cannot be read throws
 * {@link CorruptStoreError}. What every write and every gate reads: a write must
 * never replace a store it could not read (its history feeds the brake).
 */
export function readProposalsStrict(contextRoot: string): ProposalStore {
  const path = storePath(contextRoot);
  if (!existsSync(path)) return { proposals: [], filed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new CorruptStoreError(PROPOSALS_REL_PATH);
  }
  const store = parsed as Partial<ProposalStore> | null;
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || (store.proposals !== undefined && !Array.isArray(store.proposals))
    || (store.filed !== undefined && !Array.isArray(store.filed))) {
    throw new CorruptStoreError(PROPOSALS_REL_PATH);
  }
  return {
    proposals: (store.proposals ?? []).filter(isProposal),
    filed: (store.filed ?? []).filter(isFiled),
  };
}

/** For display. Never throws: an unreadable or unsafe file reads as an empty store. */
export function readProposals(contextRoot: string): ProposalStore {
  try {
    return readProposalsStrict(contextRoot);
  } catch {
    return { proposals: [], filed: [] };
  }
}

function trimResolved<T>(items: T[], open: (t: T) => boolean): T[] {
  const live = items.filter(open);
  const done = items.filter((t) => !open(t)).slice(0, MAX_RESOLVED);
  return [...live, ...done];
}

export function writeProposals(contextRoot: string, store: ProposalStore): void {
  const path = storePath(contextRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const out: ProposalStore = {
    proposals: trimResolved(store.proposals, (p) => p.status === 'pending'),
    filed: trimResolved(store.filed, (f) => f.outcome === 'open'),
  };
  writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** An unreadable store, as the error every owner action and CLI verb already handles. */
function asProposalError(err: unknown): unknown {
  return err instanceof CorruptStoreError ? new ProposalError('corrupt', err.message) : err;
}

/** The store an owner action starts from (an unreadable one refuses the action). */
function storeForAction(contextRoot: string): ProposalStore {
  try {
    return readProposalsStrict(contextRoot);
  } catch (err) {
    throw asProposalError(err);
  }
}

/**
 * Read-modify-write under the store's lock. Refuses with `ProposalError('corrupt')`
 * when this store or the feedback store cannot be read, leaving both as they are.
 * Both are read BEFORE `fn` runs: an owner action claims its item through here
 * before it creates or cancels a task, so an unreadable verdict store refuses the
 * action while nothing has happened yet, never after the task changed.
 */
export function mutateProposals<T>(contextRoot: string, fn: (store: ProposalStore) => T): T {
  try {
    return withTaskFileLock(contextRoot, LOCK_KEY, () => {
      readFeedbackStrict(contextRoot);
      const store = readProposalsStrict(contextRoot);
      const result = fn(store);
      writeProposals(contextRoot, store);
      return result;
    });
  } catch (err) {
    throw asProposalError(err);
  }
}

export function pendingProposals(store: ProposalStore): TaskProposal[] {
  return store.proposals.filter((p) => p.status === 'pending');
}

export function openFiled(store: ProposalStore): FiledRecord[] {
  return store.filed.filter((f) => f.outcome === 'open');
}

/** Is this task still on the board (`state/<slug>.md`)? */
export function taskOnBoard(contextRoot: string): (slug: string) => boolean {
  return (slug) => {
    try {
      return existsSync(safeResolveInside(contextRoot, `state/${slug}.md`));
    } catch {
      return false;
    }
  };
}

/**
 * Sleep-filed tasks waiting for the owner: not yet judged AND still on the board.
 * A task that left some other way (deleted, renamed away) waits for nothing, so
 * the section never shows it and the badge never counts it.
 */
export function waitingFiled(store: ProposalStore, onBoard: (slug: string) => boolean): FiledRecord[] {
  return openFiled(store).filter((f) => onBoard(f.slug));
}

/** What the sidebar badge counts: exactly what the section lists. */
export function waitingCount(store: ProposalStore, onBoard: (slug: string) => boolean): number {
  return pendingProposals(store).length + waitingFiled(store, onBoard).length;
}

/** The record for this slug: the one still waiting, else the newest. */
function filedRecord(store: ProposalStore, slug: string): FiledRecord | undefined {
  return store.filed.find((f) => f.slug === slug && f.outcome === 'open') ?? store.filed.find((f) => f.slug === slug);
}

function claimFresh(claim: { at: string } | undefined): boolean {
  return !!claim && Date.now() - Date.parse(claim.at) < CLAIM_TTL_MS;
}

/**
 * The proposal a card says it was accepted from (`from_proposal`, written in the card's first
 * write), read from disk; null when the card is missing or carries none.
 */
function provenanceOf(contextRoot: string, slug: string): string | null {
  try {
    const path = safeResolveInside(contextRoot, `state/${slug}.md`);
    if (!existsSync(path)) return null;
    const v = readFrontmatter<Record<string, unknown>>(path).data.from_proposal;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Drop a claim nothing is working on any more (past CLAIM_TTL_MS), if it is still the same one. */
function clearStaleClaim(contextRoot: string, id: string, claimAt: string): void {
  mutateProposals(contextRoot, (store) => {
    const live = store.proposals.find((x) => x.id === id);
    if (live?.claim && live.claim.at === claimAt && !claimFresh(live.claim)) delete live.claim;
  });
}

/** A proposal the owner can still act on: pending, and no accept in flight. */
function assertProposalOpen(p: TaskProposal | undefined, id: string): TaskProposal {
  if (!p) throw new ProposalError('not_found', `No proposal ${id}.`);
  if (p.status !== 'pending') throw new ProposalError('resolved', `Proposal ${id} was already ${p.status}.`);
  if (claimFresh(p.claim)) throw new ProposalError('resolved', `Proposal ${id} is being accepted right now; try again shortly.`);
  return p;
}

/** A sleep-filed task the owner can still judge: open, and no reject in flight. */
function assertFiledOpen(f: FiledRecord | undefined, slug: string): FiledRecord {
  if (!f) throw new ProposalError('not_found', `"${slug}" is not a task sleep filed.`);
  if (f.outcome !== 'open') throw new ProposalError('resolved', `"${slug}" was already ${f.outcome}.`);
  if (claimFresh(f.claim)) throw new ProposalError('resolved', `"${slug}" is being rejected right now.`);
  return f;
}

export interface NewProposal {
  name: string;
  why: string;
  quote: string;
  basis: FeedbackBasis;
  parent?: string | null;
  session?: string | null;
  by?: 'sleep' | 'agent';
}

/** Add a proposal. Refuses a second pending proposal with the same name. */
export function addProposal(contextRoot: string, input: NewProposal): TaskProposal {
  return mutateProposals(contextRoot, (store) => {
    const key = slugify(input.name);
    const twin = pendingProposals(store).find((p) => slugify(p.name) === key);
    if (twin) throw new ProposalError('exists', `Already proposed and waiting: ${twin.id} "${twin.name}".`);
    const proposal: TaskProposal = {
      id: generateId('tp'),
      name: input.name.trim(),
      why: input.why.trim(),
      quote: storableQuote(input.quote, contextRoot),
      basis: input.basis,
      parent: input.parent ?? null,
      session: input.session ?? null,
      proposedAt: new Date().toISOString(),
      by: input.by ?? 'sleep',
      status: 'pending',
    };
    store.proposals.unshift(proposal);
    return proposal;
  });
}

/**
 * Record a task sleep is filing, so it shows as "opened by sleep" and counts for
 * the brake. Called BEFORE the task is created: a task sleep filed is never on the
 * board without its record (the section only shows records whose task exists).
 * Returns the record's `filedAt`, which {@link dropFiled} takes back on a failed create.
 */
export function recordFiled(contextRoot: string, rec: Omit<FiledRecord, 'filedAt' | 'outcome'>): string {
  return mutateProposals(contextRoot, (store) => {
    const filedAt = new Date().toISOString();
    // A judged record of the same slug stays: it is a verdict the brake counts.
    store.filed = store.filed.filter((f) => f.slug !== rec.slug || f.outcome !== 'open');
    store.filed.unshift({ ...rec, quote: storableQuote(rec.quote, contextRoot), filedAt, outcome: 'open' });
    return filedAt;
  });
}

/** Take back the record {@link recordFiled} wrote, when the task was not created after all. */
export function dropFiled(contextRoot: string, slug: string, filedAt: string): void {
  mutateProposals(contextRoot, (store) => {
    store.filed = store.filed.filter((f) => !(f.slug === slug && f.filedAt === filedAt));
  });
}

// ─── The brake ───────────────────────────────────────────────────────────────

export const BRAKE_WINDOW = 20;
export const BRAKE_MAX_REJECT_RATE = 0.3;

export interface FilingBrake {
  /** Judged items in the window (≤ {@link BRAKE_WINDOW}). */
  window: number;
  rejected: number;
  /** rejected / window, or null before anything was judged. */
  rate: number | null;
  /** True while sleep may file directly. */
  open: boolean;
}

/**
 * Sleep's last {@link BRAKE_WINDOW} JUDGED items, by when the owner judged them:
 * the tasks it filed that the owner kept or rejected, and the proposals the owner
 * decided. A task still waiting is not a verdict, so filing more cannot dilute
 * the window. Counting accepted proposals is what lets a closed brake RECOVER:
 * with direct filing off, no new filed task could ever bring the rate down.
 */
export function filingBrake(store: ProposalStore): FilingBrake {
  const items = [
    ...store.filed
      .filter((f) => f.outcome !== 'open')
      .map((f) => ({ at: f.resolvedAt ?? f.filedAt, rejected: f.outcome === 'rejected' })),
    ...store.proposals
      .filter((p) => p.status !== 'pending')
      .map((p) => ({ at: p.resolvedAt ?? p.proposedAt, rejected: p.status === 'rejected' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, BRAKE_WINDOW);
  const rejected = items.filter((i) => i.rejected).length;
  const rate = items.length > 0 ? rejected / items.length : null;
  return { window: items.length, rejected, rate, open: rate === null || rate <= BRAKE_MAX_REJECT_RATE };
}

// ─── Owner actions (CLI and dashboard share these) ───────────────────────────

export interface AcceptEdits {
  name?: string;
  why?: string;
  /** Parent override: a slug, or null to file it top-level. Undefined = the suggestion. */
  parent?: string | null;
}

export interface AcceptResult {
  slug: string;
  parent: string | null;
  /** The suggested parent could not be used (closed, gone, a sub-task itself). */
  parentDropped?: string;
  /** The task was created but a later write failed (the proposal is accepted all the same). */
  warning?: string;
}

/**
 * Accept a proposal: it becomes a task in the Next queue (owner decision 8 — the
 * owner, not sleep, decides when it enters a cycle), `created_by: human`, no
 * filing basis. An edited name or Why is recorded as the feedback diff.
 *
 * The caller decides who may accept: the CLI refuses an agent environment
 * (`refuseSelfApproval`); the dashboard route is the owner's path.
 */
export async function acceptProposal(
  contextRoot: string,
  backend: TaskBackend,
  defs: readonly StatusDef[],
  id: string,
  edits: AcceptEdits,
  variant: 'cli' | 'dashboard',
): Promise<AcceptResult> {
  let stored = storeForAction(contextRoot).proposals.find((x) => x.id === id);
  // A claim left behind by an earlier accept (its store was busy, or the process died). It is
  // finished here ONLY when it is stale and the card on its slug says it came from THIS proposal
  // (`from_proposal`, written with the card): a fresh claim is an accept still in flight, and a
  // card without the marker is someone else's task. Any other stale claim is dropped, and this
  // accept runs as new (a same-slug task then refuses as `exists`).
  if (stored?.status === 'pending' && stored.claim && !claimFresh(stored.claim)) {
    if (provenanceOf(contextRoot, stored.claim.slug) === id) {
      return finishLeftoverAccept(contextRoot, backend, id, stored.claim.slug);
    }
    clearStaleClaim(contextRoot, id, stored.claim.at);
    stored = storeForAction(contextRoot).proposals.find((x) => x.id === id);
  }
  const seen = assertProposalOpen(stored, id);

  const name = (edits.name ?? seen.name).trim();
  const why = (edits.why ?? seen.why).trim();
  if (!name) throw new ProposalError('invalid', 'A task needs a name.');
  if (!why) throw new ProposalError('invalid', 'A task needs a Why.');
  const slug = slugify(name);
  if (!slug) throw new ProposalError('invalid', `"${name}" has no usable slug.`);
  if ((await backend.get(slug)) !== null) throw new ProposalError('exists', `A task "${slug}" already exists.`);

  const wanted = edits.parent === undefined ? seen.parent : edits.parent;
  let parent: string | null = null;
  let parentDropped: string | undefined;
  if (wanted) {
    const check = checkParentLink(loadFamily(safeResolveInside(contextRoot, 'state')), defs, slug, wanted);
    if (check.ok) parent = check.parent;
    else parentDropped = check.reason;
  }

  // Claim it under the lock, checking again there: a second accept (a double tap,
  // the CLI and the dashboard at once) or a reject racing this one stops here.
  const p = mutateProposals(contextRoot, (store) => {
    const live = assertProposalOpen(store.proposals.find((x) => x.id === id), id);
    live.claim = { slug, at: new Date().toISOString() };
    return { ...live };
  });

  try {
    await backend.create({
      name,
      description: name,
      status: 'todo',
      tags: [],
      why,
      queue: 'next',
      ...(parent ? { parent_task: parent } : {}),
      // Provenance, in the card's first write: a crash after the create still leaves it.
      from_proposal: p.id,
      variant,
    });
  } catch (err) {
    // The create threw AFTER the card was written (a remote backend's push, a field layered
    // after the first write): the card with this proposal's marker is on disk, so the task
    // exists. Keep the claim (it goes stale, and the next accept finishes it through the
    // leftover path) and answer as an accept that happened, with a warning.
    if (provenanceOf(contextRoot, slug) === p.id) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[task-proposals] ${id}: "${slug}" was created, but the create did not finish (${why}).`);
      return {
        slug,
        parent,
        ...(parentDropped ? { parentDropped } : {}),
        warning: `The task "${slug}" was created, but the create did not finish (${why}); accept it again in a few minutes to finish.`,
      };
    }
    // Nothing on disk: release the claim. A release that fails (a busy store) must not hide WHY
    // the create failed: the claim then expires on its own (CLAIM_TTL_MS), and the error surfaces.
    try {
      mutateProposals(contextRoot, (store) => {
        const live = store.proposals.find((x) => x.id === id);
        if (live?.claim?.slug === slug) delete live.claim;
      });
    } catch (releaseErr) {
      console.error(`[task-proposals] ${id}: the claim was not released (${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}); it expires on its own.`);
    }
    throw err;
  }

  // The task exists from here, so the proposal IS accepted whatever follows: a
  // failed field or journal write is reported, never left as a pending proposal
  // whose task is already on the board.
  let warning: string | undefined;
  try {
    // `queue` again here: the dashboard create skeleton does not layer it.
    await backend.updateFields(slug, { created_by: 'human', filing_basis: null, queue: 'next' });
    await backend.addJournal(slug, {
      kind: 'approval',
      label: 'accepted from a sleep proposal',
      body: `- proposal ${p.id} (${p.basis}): "${storableQuote(p.quote, contextRoot)}"`,
    });
  } catch (err) {
    warning = `The task was created, but its fields or journal note were not written: ${err instanceof Error ? err.message : String(err)}`;
  }

  const diff: { name?: { from: string; to: string }; why?: { from: string; to: string } } = {};
  if (name !== p.name) diff.name = { from: p.name, to: name };
  if (why !== p.why) diff.why = { from: p.why, to: why };

  // After the create, nothing here refuses: the task exists, so a busy store or a proposal that
  // changed meanwhile is the result's warning (the route still records the change and the
  // audit), never an error that says "nothing was changed" over a task on the board.
  const add = (text: string) => { warning = `${warning ? `${warning} ` : ''}${text}`; };
  try {
    const outcome = mutateProposals(contextRoot, (s) => {
      const live = s.proposals.find((x) => x.id === id);
      if (live?.status === 'accepted' && live.slug === slug) return 'done';
      if (!live || live.status !== 'pending' || live.claim?.slug !== slug) return live ? live.status : 'gone';
      markAccepted(contextRoot, live, slug, Object.keys(diff).length > 0 ? diff : null);
      return 'done';
    });
    if (outcome !== 'done') {
      add(`The task "${slug}" was created, but proposal ${id} changed while it was being accepted (it is now ${outcome}).`);
    }
  } catch (err) {
    // ANY failure here (a busy store, an unwritable file, a feedback store that cannot be read):
    // the task exists, so it is a warning on the result, logged, never a refusal.
    const why = err instanceof TaskFileBusyError ? 'its store is busy' : err instanceof Error ? err.message : String(err);
    console.error(`[task-proposals] ${id}: "${slug}" was created, but the proposal was not marked accepted (${why}).`);
    add(`The task "${slug}" was created, but the proposal could not be marked accepted (${why}); accept it again in a few minutes to finish.`);
  }
  return { slug, parent, ...(parentDropped ? { parentDropped } : {}), ...(warning ? { warning } : {}) };
}

/** Mark a claimed proposal accepted as `slug` and record the keep. The caller holds the store lock. */
function markAccepted(
  contextRoot: string,
  live: TaskProposal,
  slug: string,
  diff: { name?: { from: string; to: string }; why?: { from: string; to: string } } | null,
): void {
  delete live.claim;
  Object.assign(live, { status: 'accepted', resolvedAt: new Date().toISOString(), slug });
  // One keep per proposal: an earlier write that recorded it and then failed is not counted twice.
  if (readFeedbackStrict(contextRoot).some((e) => e.id === live.id && e.source === 'proposal' && e.verdict === 'keep')) return;
  appendFeedback(contextRoot, {
    id: live.id,
    source: 'proposal',
    verdict: 'keep',
    outcome: 'new-task',
    proposal: { name: live.name, why: live.why, parent: live.parent },
    basis: live.basis,
    quote: storableQuote(live.quote, contextRoot),
    diff,
  });
}

/**
 * Finish an accept that created its task but never marked the proposal: accepted, with the keep
 * feedback, and a warning that says so. A busy store refuses (nothing was written by this call).
 */
async function finishLeftoverAccept(contextRoot: string, backend: TaskBackend, id: string, slug: string): Promise<AcceptResult> {
  const task = await backend.get(slug);
  mutateProposals(contextRoot, (store) => {
    const live = store.proposals.find((x) => x.id === id);
    if (live?.status === 'accepted' && live.slug === slug) return;
    if (!live || live.status !== 'pending' || live.claim?.slug !== slug) {
      throw new ProposalError('resolved', `Proposal ${id} changed while its accept was being finished.`);
    }
    // The owner's edits at that first accept live on the card: the keep records them as its diff.
    const diff: { name?: { from: string; to: string }; why?: { from: string; to: string } } = {};
    const cardName = (task?.name ?? '').trim();
    const cardWhy = (task?.why ?? '').trim();
    if (cardName && cardName !== live.name.trim()) diff.name = { from: live.name, to: cardName };
    if (cardWhy && cardWhy !== live.why.trim()) diff.why = { from: live.why, to: cardWhy };
    markAccepted(contextRoot, live, slug, Object.keys(diff).length > 0 ? diff : null);
  });
  return {
    slug,
    parent: task?.parent_task ?? null,
    warning: `The task "${slug}" was already created by an earlier accept that did not finish; the proposal is now marked accepted.`,
  };
}

export interface RejectInput {
  reason: FeedbackReason;
  note?: string;
}

/** Every reject also lands in the declined store, so no later cycle re-files it. */
function declineFor(contextRoot: string, name: string, input: RejectInput, session?: string | null): void {
  const why = `Rejected by the owner: ${reasonLabel(input.reason)}${input.note?.trim() ? ` — ${input.note.trim()}` : ''}`;
  appendDeclined(contextRoot, {
    key: slugify(name),
    topic: name,
    declinedAt: new Date().toISOString(),
    reason: why,
    ...(session ? { session } : {}),
  });
}

/** Reject a pending proposal: feedback + declined, the proposal is kept as rejected. */
export function rejectProposal(contextRoot: string, id: string, input: RejectInput): TaskProposal {
  return mutateProposals(contextRoot, (store) => {
    const p = assertProposalOpen(store.proposals.find((x) => x.id === id), id);
    if (p.claim) {
      // A stale accept claim whose card says it came from THIS proposal: the owner already kept
      // it, and a reject would record a "no" (and a declined entry) for a task they have.
      if (provenanceOf(contextRoot, p.claim.slug) === id) {
        throw new ProposalError('exists', `The task "${p.claim.slug}" was already created from proposal ${id}; accept it to finish, or delete the task.`);
      }
      // Any other stale claim (no card, or someone else's card on that slug) is dropped.
      delete p.claim;
    }
    p.status = 'rejected';
    p.resolvedAt = new Date().toISOString();
    appendFeedback(contextRoot, {
      id: p.id,
      source: 'proposal',
      verdict: 'reject',
      outcome: input.reason === 'too-small' || input.reason === 'already-exists' ? 'add-to-task' : 'nothing',
      proposal: { name: p.name, why: p.why, parent: p.parent },
      basis: p.basis,
      quote: storableQuote(p.quote, contextRoot),
      reason: input.reason,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    });
    declineFor(contextRoot, p.name, input, p.session);
    return p;
  });
}

/**
 * Reject a task sleep filed: it moves to the project's cancelled-kind status
 * (refused when none is declared, like `cycle close`), the journal says why, and
 * it is recorded as feedback + declined + a rejected item for the brake.
 *
 * The status write is the commit point (as `applyVerdict`'s): a busy card refuses before it
 * with nothing written; the journal note and the store's record follow it, and a failure
 * there is the result's `warning`, never a refusal of a reject that happened.
 */
export async function rejectFiled(
  contextRoot: string,
  backend: TaskBackend,
  defs: readonly StatusDef[],
  slug: string,
  input: RejectInput,
): Promise<FiledRecord & { warning?: string }> {
  const seenClaim = assertFiledOpen(filedRecord(storeForAction(contextRoot), slug), slug).claim;
  const cancelKey = defs.find((d) => d.kind === 'cancelled')?.key ?? null;
  if (!cancelKey) {
    throw new ProposalError('no_cancel_status',
      'This project declares no cancelled-kind status (overrides/task.md), so a rejected task has nowhere to go. Declare one, then reject.');
  }
  // Claim it under the lock, checking again there: a double tap, or a reject
  // racing a keep, stops here, so one reject is counted once.
  const claimedAt = mutateProposals(contextRoot, (store) => {
    const live = assertFiledOpen(filedRecord(store, slug), slug);
    live.claim = { at: new Date().toISOString() };
    return live.claim.at;
  });
  // A reject that cancelled the card and then stopped before the store's record (it left its
  // claim, now stale): the card already sits at the cancelled status, so only the record is
  // finished, with no second status write and no second journal note.
  const card = await backend.get(slug);
  const leftover = !!card && isCancelled(defs, card.status) && !!seenClaim && !claimFresh(seenClaim);
  let onBoard = false;
  try {
    if (card && !leftover) {
      await backend.updateFields(slug, { status: cancelKey, updated_at: today() });
      onBoard = true;
    }
  } catch (err) {
    // As in an accept: a release that fails never hides the status write's own error.
    try {
      mutateProposals(contextRoot, (store) => {
        const live = filedRecord(store, slug);
        if (live?.claim?.at === claimedAt) delete live.claim;
      });
    } catch (releaseErr) {
      console.error(`[task-proposals] ${slug}: the reject claim was not released (${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}); it expires on its own.`);
    }
    throw err;
  }
  const warnings: string[] = [];
  if (onBoard) {
    try {
      await backend.addJournal(slug, {
        kind: 'status',
        label: cancelKey,
        body: `- rejected by the owner (sleep filed it): ${reasonLabel(input.reason)}${input.note?.trim() ? ` — ${input.note.trim()}` : ''}`,
      });
    } catch (err) {
      console.error(`[task-proposals] ${slug}: rejected, but the journal note was not written (${err instanceof Error ? err.message : String(err)}).`);
      warnings.push(`"${slug}" was cancelled, but its journal note was not written.`);
    }
  }
  let record: FiledRecord | null = null;
  try {
    record = recordFiledReject(contextRoot, slug, claimedAt, input);
  } catch (err) {
    // The card is cancelled already: any failure of the record is a warning, never a refusal.
    // The record stays open with a claim that goes stale; the next reject finishes it.
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[task-proposals] ${slug}: rejected, but not recorded as rejected (${why}).`);
    warnings.push(`"${slug}" was cancelled, but the reject was not recorded for sleep (${why}); reject it again in a few minutes to finish.`);
  }
  const base: FiledRecord = record ?? { ...(filedRecord(readProposals(contextRoot), slug) as FiledRecord), slug, outcome: 'rejected' };
  return { ...base, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) };
}

/** The store half of {@link rejectFiled}: rejected, with the feedback and the declined entry. */
function recordFiledReject(contextRoot: string, slug: string, claimedAt: string, input: RejectInput): FiledRecord {
  return mutateProposals(contextRoot, (store) => {
    const live = filedRecord(store, slug);
    if (!live || live.outcome !== 'open' || live.claim?.at !== claimedAt) {
      throw new ProposalError('resolved', `"${slug}" changed while it was being rejected.`);
    }
    delete live.claim;
    live.outcome = 'rejected';
    live.resolvedAt = new Date().toISOString();
    appendFeedback(contextRoot, {
      id: newFeedbackId(),
      source: 'sleep-filed',
      verdict: 'reject',
      outcome: input.reason === 'too-small' || input.reason === 'already-exists' ? 'add-to-task' : 'nothing',
      proposal: { name: live.name, why: live.why, parent: live.parent },
      basis: live.basis,
      quote: storableQuote(live.quote, contextRoot),
      reason: input.reason,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    });
    declineFor(contextRoot, live.name, input);
    return live;
  });
}

/**
 * Keep a task sleep filed: it leaves the section and counts as a good filing. A card already at
 * a cancelled-kind status is refused: it was rejected (a reject that stopped before its record),
 * and "keep" would count a cancelled task as a good filing.
 */
export function keepFiled(contextRoot: string, slug: string, defs: readonly StatusDef[]): FiledRecord {
  let status: unknown = null;
  try {
    const path = safeResolveInside(contextRoot, `state/${slug}.md`);
    if (existsSync(path)) status = readFrontmatter<Record<string, unknown>>(path).data.status;
  } catch { /* unreadable reads as no card */ }
  if (typeof status === 'string' && isCancelled(defs, normalizeStatusKey(status))) {
    throw new ProposalError('resolved', `"${slug}" is cancelled; reject it to finish, or reopen it first.`);
  }
  return mutateProposals(contextRoot, (store) => {
    const live = assertFiledOpen(filedRecord(store, slug), slug);
    live.outcome = 'kept';
    live.resolvedAt = new Date().toISOString();
    appendFeedback(contextRoot, {
      id: newFeedbackId(),
      source: 'sleep-filed',
      verdict: 'keep',
      outcome: 'new-task',
      proposal: { name: live.name, why: live.why, parent: live.parent },
      basis: live.basis,
      quote: storableQuote(live.quote, contextRoot),
    });
    return live;
  });
}

/** Counts `sleep done` prints: filed and proposed since the epoch, rejected since the last sleep. */
export function cycleCounts(
  contextRoot: string,
  epoch: string | null,
  lastSleep: string | null,
): { filed: number; children: number; proposed: number; rejected: number } {
  const store = readProposals(contextRoot);
  const since = (at: string | undefined, from: string | null): boolean => !!at && (!from || at >= from);
  const filed = store.filed.filter((f) => since(f.filedAt, epoch));
  const rejected = readFeedback(contextRoot).filter((e) =>
    (e.source === 'proposal' || e.source === 'sleep-filed') && e.verdict === 'reject' && since(e.at, lastSleep));
  return {
    filed: filed.filter((f) => !f.parent).length,
    children: filed.filter((f) => !!f.parent).length,
    proposed: store.proposals.filter((p) => since(p.proposedAt, epoch)).length,
    rejected: rejected.length,
  };
}
