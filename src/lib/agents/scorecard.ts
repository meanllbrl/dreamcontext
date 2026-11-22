import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireFileLock } from '../file-lock.js';
import { localDir, projectKey } from '../local-store.js';
import { AutomationError } from '../automations/types.js';
import { JUDGE_TIMEOUT_MS, UNUSABLE_TRIES } from '../recall-judge.js';
import { assertOwned } from './owner.js';
import { globalAgentHome, globalAgentPath, globalMemoryDir } from './scope.js';
import { isSafeAutomationSlug } from './slot.js';
import { getAgent } from './store.js';
import type { AgentManifest } from './types.js';

/**
 * The member SCORECARD (plan uye-karnesi C1): the owner's ratings of a member's runs, his
 * "what good looks like" lines, the lessons his notes became, the model's checks of each run
 * against those lines, and one optional Lab insight as the member's goal.
 *
 * Machine-local, like amendments (D4): a project member's card lives in
 * `~/.dreamcontext/local/<projectKey>/agent-scorecards.json`, a global member's in
 * `<globalMemoryDir(slug)>/scorecard.json` (its runs in every project share it, each rating names
 * its project, and its run keys carry the `<projectKey>/` prefix). Nothing here syncs, so no
 * synced text ever reaches a prompt.
 *
 * Every key needs a death: `agents delete` drops the card, a rename moves it
 * (`renameScorecardMember`), and a write for a member that is gone is refused, so a detached
 * check that ends after a delete brings nothing back.
 *
 * No count caps (owner rule, D20): ratings, criteria, lessons and checks are kept without a
 * count limit. Sizes are capped per item instead.
 */

export const SCORECARD_LIMITS = {
  criterionChars: 200,
  noteChars: 2_000,
  lessonChars: 300,
  /** Over this the card shows the length line; everything is still injected (D8). */
  blockWarnChars: 4_000,
} as const;

const PROJECT_FILE = 'agent-scorecards.json';
const GLOBAL_FILE = 'scorecard.json';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;

export type ModelStateName = 'running' | 'done' | 'failed';

export interface ModelState {
  state: ModelStateName;
  attempts: number;
  lastError?: string;
  pid?: number;
  pidStart?: string;
  at: string;
}

export interface ProjectRef {
  key: string;
  vault: string;
  name: string;
}

export interface Criterion {
  id: string;
  text: string;
  at: string;
  removedAt?: string;
}

export type RatedBy = 'owner' | 'super' | 'session';

export interface Rating {
  stars: number;
  note?: string;
  noteFold?: string;
  firstAt: string;
  at: string;
  by: RatedBy;
  quote?: string;
  quoteTurn?: string;
  title: string;
  runAt: string;
  status: string;
  project: ProjectRef;
  draft?: ModelState & { noteFold: string };
  /** Where his rating came from (W3 E5); only Telegram is shown. */
  via?: 'mac' | 'telegram' | 'super';
  /** The stars are the Super's reading of his words (E12), never his own number. */
  judged?: true;
  /** A job the main Super handed the member (E9): resolved from this snapshot at any age. */
  viaSuper?: true;
  /** His words an agent recorded on a run that already had his note (E13): kept beside it. */
  corrections?: Correction[];
}

/** E13: his verbatim words, added by an agent beside his own note, with their own lesson slot. */
export interface Correction {
  id: string;
  note: string;
  noteFold: string;
  quoteTurn: string;
  at: string;
  draft?: ModelState & { noteFold: string };
}

/** W3 C10: the one Telegram message that carries a run's stars. */
export interface TgAsk {
  askId: string;
  botId: string;
  chatId: string;
  endedAt: string;
  messageId?: number;
  notePromptIds: number[];
  at: string;
  closedAt?: string;
  sweepTries?: number;
}

export interface Verdict {
  id: string;
  text: string;
  met: boolean | null;
  why?: string;
  by: 'model' | 'owner';
}

export interface Check extends Omit<ModelState, 'state'> {
  state: ModelStateName | 'no_text';
  criteriaHash: string;
  verdicts: Verdict[];
  costUsd: number;
}

export type LessonStatus = 'active' | 'held' | 'undone' | 'replaced';

export interface Lesson {
  id: string;
  text: string;
  run: string;
  noteFold: string;
  at: string;
  status: LessonStatus;
  flags?: string[];
  undoneAt?: string;
  /** Absent: the rating's note; `c:<id>`: a correction's (W3 C17). */
  slot?: string;
}

export interface Goal {
  insight: string;
  project: ProjectRef;
  baseline: number;
  target: number;
  linkedAt: string;
}

export interface MemberCard {
  criteria: Criterion[];
  ratings: Record<string, Rating>;
  checks: Record<string, Check>;
  lessons: Lesson[];
  goal: Goal | null;
  usedQuoteTurns: string[];
  /** W3 C10: run key -> its Telegram request. */
  telegramAsks: Record<string, TgAsk>;
}

interface ScorecardFile {
  v: 1;
  members: Record<string, MemberCard>;
}

export type ScorecardRefusalCode =
  | 'unknown_member' | 'unknown_run' | 'run_not_rateable' | 'rate_needs_owner_words' | 'quote_used'
  | 'check_running' | 'scorecard_unreadable' | 'invalid_args' | 'unknown_lesson' | 'unknown_criterion';

/** A named refusal; nothing was written. */
export class ScorecardRefused extends AutomationError {
  constructor(readonly code: ScorecardRefusalCode, readonly status: number, message: string) {
    super(message);
  }
}

export function emptyCard(): MemberCard {
  return { criteria: [], ratings: {}, checks: {}, lessons: [], goal: null, usedQuoteTurns: [], telegramAsks: {} };
}

// ─── Scope ─────────────────────────────────────────────────────────────────────

export interface ScorecardScope {
  kind: 'project' | 'global';
  member: string;
  projectRoot: string;
  /** The card's file. */
  file: string;
  /** The folder the file sits in. */
  dir: string;
  /** '' for a project member; `<projectKey>/` for a global one (D2: run ids collide across projects). */
  prefix: string;
  home?: string;
}

function contextRootOf(projectRoot: string): string {
  return join(projectRoot, '_dream_context');
}

/** The member and where its card lives, or `unknown_member`. */
export function resolveScorecard(projectRoot: string, member: string, home?: string): { manifest: AgentManifest; scope: ScorecardScope } {
  if (!isSafeAutomationSlug(member)) throw new ScorecardRefused('unknown_member', 404, `No member "${member}".`);
  let manifest: AgentManifest | null = null;
  try { manifest = getAgent(contextRootOf(projectRoot), member, home); } catch { manifest = null; }
  if (!manifest) throw new ScorecardRefused('unknown_member', 404, `No member "${member}" in this project.`);
  return { manifest, scope: scopeFor(projectRoot, member, manifest.scope === 'global' ? 'global' : 'project', home) };
}

export function scopeFor(projectRoot: string, member: string, kind: 'project' | 'global', home?: string): ScorecardScope {
  if (kind === 'global') {
    const dir = globalMemoryDir(member, home);
    return { kind, member, projectRoot, dir, file: join(dir, GLOBAL_FILE), prefix: `${projectKey(projectRoot)}/`, home };
  }
  const dir = localDir(projectRoot, home);
  return { kind, member, projectRoot, dir, file: join(dir, PROJECT_FILE), prefix: '', home };
}

const RUN_KEY_RE = /^([0-9a-f]{16}\/)?[a-z0-9-]+::[0-9A-Za-z:.\-]+$/;

export function isRunKey(key: string): boolean {
  return typeof key === 'string' && key.length <= 300 && RUN_KEY_RE.test(key);
}

/** The card's key for a history session key (`<source>::<runId>`). */
export function runKeyFor(scope: Pick<ScorecardScope, 'prefix'>, sessionKey: string): string {
  return `${scope.prefix}${sessionKey}`;
}

/** The history session key (`<source>::<runId>`) of a card's run key. */
export function sessionKeyOf(runKey: string): string {
  const slash = runKey.indexOf('/');
  return slash >= 0 && slash < runKey.indexOf('::') ? runKey.slice(slash + 1) : runKey;
}

/** The `<projectKey>` a global run key names, or null for a project key. */
export function projectKeyOfRun(runKey: string): string | null {
  const m = /^([0-9a-f]{16})\//.exec(runKey);
  return m ? m[1] : null;
}

/** Does this run key belong to the scope's project? A project scope's keys always do. */
export function runInProject(scope: Pick<ScorecardScope, 'prefix'>, runKey: string): boolean {
  return scope.prefix === '' ? projectKeyOfRun(runKey) === null : runKey.startsWith(scope.prefix);
}

export function splitSessionKey(sessionKey: string): { source: string; runId: string } | null {
  const at = sessionKey.indexOf('::');
  if (at <= 0) return null;
  return { source: sessionKey.slice(0, at), runId: sessionKey.slice(at + 2) };
}

// ─── Read ──────────────────────────────────────────────────────────────────────

function isSymlinkOrNotDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() || !st.isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

interface Parsed {
  file: ScorecardFile;
  /** The damaged copy's file name, when the file on disk could not be read as a v1 scorecard. */
  damaged: string | null;
}

function damagedCopies(file: string): string[] {
  try {
    const base = basename(file);
    return readdirSync(dirname(file)).filter((n) => n.startsWith(`${base}.damaged-`)).sort();
  } catch {
    return [];
  }
}

function cleanFile(raw: unknown): ScorecardFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as { v?: unknown; members?: unknown };
  if (f.v !== 1 || !f.members || typeof f.members !== 'object' || Array.isArray(f.members)) return null;
  return { v: 1, members: f.members as Record<string, MemberCard> };
}

/** Read the scope's file. A present but unreadable file is copied aside once and never overwritten. */
function readFileOf(scope: ScorecardScope, now: Date = new Date()): Parsed {
  const empty: ScorecardFile = { v: 1, members: {} };
  let st;
  try { st = lstatSync(scope.file); } catch { return { file: empty, damaged: null }; }
  if (st.isSymbolicLink() || !st.isFile()) return { file: empty, damaged: 'refused-symlink' };
  let parsed: ScorecardFile | null = null;
  let text = '';
  try {
    text = readFileSync(scope.file, 'utf-8');
    parsed = cleanFile(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (parsed) return { file: parsed, damaged: null };
  const copies = damagedCopies(scope.file);
  if (copies.length > 0) return { file: empty, damaged: copies[copies.length - 1] };
  const copy = `${scope.file}.damaged-${now.toISOString().replace(/[:.]/g, '-')}`;
  try { copyFileSync(scope.file, copy); } catch { /* the refusal still stands */ }
  return { file: empty, damaged: basename(copy) };
}

/** Every field present and of its type, whatever an older or hand-edited file held. */
export function normalizeCard(raw: unknown): MemberCard {
  const c = raw && typeof raw === 'object' ? raw as Partial<MemberCard> : {};
  const obj = <T>(v: unknown): Record<string, T> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, T> : {});
  const card: MemberCard = {
    criteria: Array.isArray(c.criteria) ? c.criteria.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string') : [],
    ratings: obj<Rating>(c.ratings),
    checks: obj<Check>(c.checks),
    lessons: Array.isArray(c.lessons) ? c.lessons.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string') : [],
    goal: c.goal && typeof c.goal === 'object' ? c.goal : null,
    usedQuoteTurns: Array.isArray(c.usedQuoteTurns) ? c.usedQuoteTurns.filter((x) => typeof x === 'string') : [],
    telegramAsks: cleanAsks(obj<unknown>(c.telegramAsks)),
  };
  for (const r of Object.values(card.ratings)) cleanRating(r);
  return card;
}

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Each W3 field shape-checked, so a hand edit can never put a wrong type in front of a reader. */
function cleanRating(r: Rating): void {
  if (!r || typeof r !== 'object') return;
  if (r.via !== undefined && r.via !== 'mac' && r.via !== 'telegram' && r.via !== 'super') delete r.via;
  if (r.judged !== undefined && r.judged !== true) delete r.judged;
  if (r.viaSuper !== undefined && r.viaSuper !== true) delete r.viaSuper;
  if (r.corrections !== undefined) {
    const list = Array.isArray(r.corrections) ? r.corrections.filter((x) => x && isStr(x.id) && isStr(x.note) && isStr(x.noteFold) && isStr(x.quoteTurn) && isStr(x.at)) : [];
    for (const x of list) x.note = x.note.slice(0, SCORECARD_LIMITS.noteChars);
    if (list.length) r.corrections = list; else delete r.corrections;
  }
}

function cleanAsks(raw: Record<string, unknown>): Record<string, TgAsk> {
  const out: Record<string, TgAsk> = {};
  for (const [k, v] of Object.entries(raw)) {
    const a = v as Partial<TgAsk> | null;
    if (!a || typeof a !== 'object' || !isStr(a.askId) || !/^[0-9a-f]{16}$/.test(a.askId) || !isStr(a.botId) || !isStr(a.chatId) || !isStr(a.endedAt) || !isStr(a.at)) continue;
    out[k] = {
      askId: a.askId, botId: a.botId, chatId: a.chatId, endedAt: a.endedAt, at: a.at,
      notePromptIds: Array.isArray(a.notePromptIds) ? a.notePromptIds.filter((x): x is number => Number.isInteger(x)) : [],
      ...(Number.isInteger(a.messageId) ? { messageId: a.messageId } : {}),
      ...(isStr(a.closedAt) ? { closedAt: a.closedAt } : {}),
      ...(Number.isInteger(a.sweepTries) ? { sweepTries: a.sweepTries } : {}),
    };
  }
  return out;
}

export interface CardRead {
  card: MemberCard;
  scope: ScorecardScope;
  /** The damaged copy's name, when the file could not be read (every write is then refused). */
  damaged?: string;
}

/** The member's card, never throwing past `unknown_member`. */
export function readScorecard(projectRoot: string, member: string, home?: string): CardRead {
  const { scope } = resolveScorecard(projectRoot, member, home);
  return readScorecardAt(scope);
}

export function readScorecardAt(scope: ScorecardScope): CardRead {
  const { file, damaged } = readFileOf(scope);
  return { card: normalizeCard(file.members[scope.member]), scope, ...(damaged ? { damaged } : {}) };
}

/** The member's card from its scope's file, or null when it has none (never creates one). */
export function peekCard(scope: ScorecardScope): MemberCard | null {
  const { file, damaged } = readFileOf(scope);
  if (damaged) return null;
  const raw = file.members[scope.member];
  return raw ? normalizeCard(raw) : null;
}

// ─── Write ─────────────────────────────────────────────────────────────────────

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureDirFor(scope: ScorecardScope): void {
  if (scope.kind === 'global') {
    // The member's home is made only while its file exists: a check that ends after the delete
    // (file and home removed) finds no file and writes nothing.
    const home = globalAgentHome(scope.member, scope.home);
    const file = globalAgentPath(scope.member, scope.home);
    let alive = false;
    try { alive = lstatSync(file).isFile(); } catch { alive = false; }
    if (!alive) throw new ScorecardRefused('unknown_member', 404, `No member "${scope.member}".`);
    if (!exists(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
    if (isSymlinkOrNotDir(home)) throw new ScorecardRefused('unknown_member', 404, `No member "${scope.member}".`);
    if (!exists(scope.dir)) mkdirSync(scope.dir, { mode: 0o700 });
  } else {
    mkdirSync(scope.dir, { recursive: true, mode: 0o700 });
  }
  if (isSymlinkOrNotDir(scope.dir)) throw new ScorecardRefused('scorecard_unreadable', 409, 'The scorecard folder is not a plain folder.');
  try { chmodSync(scope.dir, 0o700); } catch { /* best effort */ }
}

function lockFile(scope: ScorecardScope): () => void {
  const lock = `${scope.file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!acquireFileLock(lock, Date.now(), LOCK_STALE_MS, { verifyPidLiveness: true })) {
    if (Date.now() > deadline) throw new Error('The scorecard is busy; try again.');
    sleepMs(25);
  }
  return () => { try { rmSync(lock, { force: true }); } catch { /* gone */ } };
}

function writeFileOf(scope: ScorecardScope, file: ScorecardFile): void {
  const tmp = `${scope.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, scope.file);
}

export interface WithScorecardOpts {
  home?: string;
  /** Skip the member check (rename and delete own the member's lifecycle themselves). */
  lifecycle?: boolean;
}

/**
 * Read, change and write one member's card under the file's PID lock. `mutate` changes the card
 * in place and returns a value; returning `NO_WRITE` leaves the file untouched. Refuses a member
 * that is gone (`unknown_member`), a member this machine does not own, and a damaged file
 * (`scorecard_unreadable`).
 */
export const NO_WRITE = Symbol('no-write');

export function withScorecard<T>(
  projectRoot: string,
  member: string,
  mutate: (card: MemberCard, scope: ScorecardScope) => T | typeof NO_WRITE,
  opts: WithScorecardOpts = {},
): T | undefined {
  const { manifest, scope } = resolveScorecard(projectRoot, member, opts.home);
  assertOwned(manifest, manifest.title || member);
  return withScorecardAt(scope, mutate);
}

export function withScorecardAt<T>(scope: ScorecardScope, mutate: (card: MemberCard, scope: ScorecardScope) => T | typeof NO_WRITE): T | undefined {
  ensureDirFor(scope);
  if (exists(scope.file)) {
    const st = lstatSync(scope.file);
    if (st.isSymbolicLink() || !st.isFile()) throw new ScorecardRefused('scorecard_unreadable', 409, 'The scorecard file is not a plain file.');
  }
  const release = lockFile(scope);
  try {
    const { file, damaged } = readFileOf(scope);
    if (damaged) throw new ScorecardRefused('scorecard_unreadable', 409, `The scorecard could not be read; a copy was kept as ${damaged}. Start fresh to use it again.`);
    const card = normalizeCard(file.members[scope.member]);
    const out = mutate(card, scope);
    if (out === NO_WRITE) return undefined;
    file.members[scope.member] = card;
    writeFileOf(scope, file);
    return out;
  } finally {
    release();
  }
}

/** Move a damaged (or any) file aside so the card starts fresh. The owner's tap only. */
export function startFresh(projectRoot: string, member: string, home?: string, now: Date = new Date()): { movedTo: string | null } {
  const { manifest, scope } = resolveScorecard(projectRoot, member, home);
  assertOwned(manifest, manifest.title || member);
  if (!exists(scope.file)) return { movedTo: null };
  const release = lockFile(scope);
  try {
    const { damaged } = readFileOf(scope, now);
    if (!damaged) return { movedTo: null };
    const aside = `${scope.file}.set-aside-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(scope.file, aside);
    return { movedTo: basename(aside) };
  } finally {
    release();
  }
}

/** Remove one member's card (its member is deleted). Never throws. */
export function dropScorecard(projectRoot: string, member: string, kind: 'project' | 'global' = 'project', home?: string): void {
  if (!isSafeAutomationSlug(member)) return;
  const scope = scopeFor(projectRoot, member, kind, home);
  if (!exists(scope.file)) return;
  try {
    if (kind === 'global') { rmSync(scope.file, { force: true }); return; }
    const release = lockFile(scope);
    try {
      const { file, damaged } = readFileOf(scope);
      if (damaged || !file.members[member]) return;
      delete file.members[member];
      writeFileOf(scope, file);
    } finally {
      release();
    }
  } catch { /* a card left behind is never read: its member is gone */ }
}

function rekey(key: string, from: string, to: string): string {
  const slash = projectKeyOfRun(key) ? key.indexOf('/') + 1 : 0;
  const head = key.slice(slash);
  return head.startsWith(`${from}::`) ? `${key.slice(0, slash)}${to}::${head.slice(from.length + 2)}` : key;
}

function rekeyCard(card: MemberCard, from: string, to: string): boolean {
  let changed = false;
  const remap = <T>(rec: Record<string, T>): Record<string, T> => {
    const next: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec)) {
      const nk = rekey(k, from, to);
      if (nk !== k) changed = true;
      if (!(nk in next) || nk !== k) next[nk] = v;
    }
    return next;
  };
  card.ratings = remap(card.ratings);
  card.checks = remap(card.checks);
  card.telegramAsks = remap(card.telegramAsks);
  for (const l of card.lessons) {
    const nk = rekey(l.run, from, to);
    if (nk !== l.run) { l.run = nk; changed = true; }
  }
  return changed;
}

function mergeCards(into: MemberCard, from: MemberCard): MemberCard {
  return {
    criteria: [...into.criteria, ...from.criteria.filter((c) => !into.criteria.some((x) => x.id === c.id))],
    ratings: { ...from.ratings, ...into.ratings },
    checks: { ...from.checks, ...into.checks },
    lessons: [...into.lessons, ...from.lessons.filter((l) => !into.lessons.some((x) => x.id === l.id))],
    goal: into.goal ?? from.goal,
    usedQuoteTurns: [...new Set([...into.usedQuoteTurns, ...from.usedQuoteTurns])],
    telegramAsks: { ...from.telegramAsks, ...into.telegramAsks },
  };
}

/**
 * Rename step (C2). `agent`: the project member's card moves to its new slug (merging into one
 * already there, the way amendments move) and its run keys whose source was the member re-key.
 * `routine`: every run key whose source is the routine re-keys, in every card of the project and
 * of every global member. Never throws: a rename never fails for its scorecard.
 */
export function renameScorecardMember(projectRoot: string, from: string, to: string, kind: 'agent' | 'routine', home?: string): void {
  if (!isSafeAutomationSlug(from) || !isSafeAutomationSlug(to) || from === to) return;
  const projectScope = scopeFor(projectRoot, from, 'project', home);
  if (exists(projectScope.file)) {
    try {
      const release = lockFile(projectScope);
      try {
        const { file, damaged } = readFileOf(projectScope);
        if (!damaged) {
          let changed = false;
          // The member's own card (an agent, or an automation that is its own member) moves too.
          if (file.members[from]) {
            const moved = normalizeCard(file.members[from]);
            delete file.members[from];
            file.members[to] = file.members[to] ? mergeCards(normalizeCard(file.members[to]), moved) : moved;
            changed = true;
          }
          for (const slug of Object.keys(file.members)) {
            const card = normalizeCard(file.members[slug]);
            if (rekeyCard(card, from, to)) { file.members[slug] = card; changed = true; }
          }
          if (changed) writeFileOf(projectScope, file);
        }
      } finally {
        release();
      }
    } catch { /* best effort */ }
  }
  if (kind !== 'routine') return;
  // A routine of this project may be bound to a global member: its run keys carry this project's prefix.
  let globals: string[] = [];
  try {
    const dir = dirname(globalAgentHome('x', home));
    globals = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && isSafeAutomationSlug(d.name)).map((d) => d.name);
  } catch { globals = []; }
  const prefix = `${projectKey(projectRoot)}/`;
  for (const g of globals) {
    const scope = scopeFor(projectRoot, g, 'global', home);
    if (!exists(scope.file)) continue;
    try {
      const release = lockFile(scope);
      try {
        const { file, damaged } = readFileOf(scope);
        if (damaged || !file.members[g]) continue;
        const card = normalizeCard(file.members[g]);
        // Only this project's keys: a routine of the same name elsewhere is another routine.
        const before = JSON.stringify(card);
        const keep = (k: string): boolean => k.startsWith(prefix);
        const remapOwn = <T>(rec: Record<string, T>): Record<string, T> =>
          Object.fromEntries(Object.entries(rec).map(([k, v]) => [keep(k) ? rekey(k, from, to) : k, v]));
        card.ratings = remapOwn(card.ratings);
        card.checks = remapOwn(card.checks);
        for (const l of card.lessons) if (keep(l.run)) l.run = rekey(l.run, from, to);
        if (JSON.stringify(card) !== before) { file.members[g] = card; writeFileOf(scope, file); }
      } finally {
        release();
      }
    } catch { /* best effort */ }
  }
}

// ─── Helpers the card and the model work share ────────────────────────────────

export function newId(prefix: 'cr' | 'le'): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

/** The note's fold: what "the same note" means (case, spacing and Unicode form ignored). */
export function foldNote(note: string): string {
  return note.normalize('NFKC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
}

export function activeCriteria(card: MemberCard): Criterion[] {
  return card.criteria.filter((c) => !c.removedAt);
}

export function criteriaHash(card: MemberCard): string {
  return createHash('sha1').update(activeCriteria(card).map((c) => `${c.id}:${c.text}`).join('\n'), 'utf8').digest('hex').slice(0, 12);
}

/** The ceiling past which a `running` state is stale whatever its pid says. */
export const RUNNING_MAX_MS = UNUSABLE_TRIES * JUDGE_TIMEOUT_MS + 60_000;

/** How long a `running` with no pid yet (the spawner's mark) counts as starting. */
export const STARTING_MS = 20_000;

/** The process start time of `pid`, as the OS prints it, or null when it cannot be read. */
export function processStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return fields[19] ?? null;
    }
    if (process.platform === 'win32') return null;
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is a `running` state live? Its pid is alive, the process behind that pid is the one that
 * marked it (same start time, when readable) and it is younger than {@link RUNNING_MAX_MS}.
 */
export function isLiveRunning(s: Pick<ModelState, 'pid' | 'pidStart' | 'at'> & { state: string } | undefined, nowMs: number = Date.now(), startOf: (pid: number) => string | null = processStart): boolean {
  if (!s || s.state !== 'running') return false;
  const at = Date.parse(s.at);
  if (!Number.isFinite(at) || nowMs - at > RUNNING_MAX_MS) return false;
  // Marked by the spawner, before the detached process marks itself: "starting" for a few seconds.
  if (typeof s.pid !== 'number') return nowMs - at < STARTING_MS;
  if (!pidAlive(s.pid)) return false;
  if (s.pidStart) {
    const now = startOf(s.pid);
    if (now !== null && now !== s.pidStart) return false;
  }
  return true;
}

/** A state as the card shows it: a `running` no live process holds reads as failed. */
export function effectiveState<S extends { state: string; lastError?: string; pid?: number; pidStart?: string; at: string }>(s: S | undefined, nowMs?: number, startOf?: (pid: number) => string | null): S | undefined {
  if (!s || s.state !== 'running') return s;
  if (isLiveRunning(s, nowMs, startOf)) return s;
  return { ...s, state: 'failed', lastError: 'stopped before it finished' };
}

export const TERMINAL_RUN_STATUSES = new Set(['ok', 'failed', 'stopped', 'skipped']);

// ─── Rating requests (W3 E2) ──────────────────────────────────────────────────────

/** A run asks to be rated for 72 hours from its end (owner 22 Nov: "3 gün içerisinde"). */
export const RATE_ASK_TTL_MS = 72 * 3_600_000;

export type AskState = 'open' | 'rated' | 'none';

/** THE rule every request surface reads (the chat row, Telegram, "N to rate"); mirrored in
 *  `dashboard/src/lib/scorecardModel.ts` and held equal by a drift test. */
export function askState(facts: { eligible: boolean; endedAt: string } | null | undefined, rating: unknown, nowMs: number): AskState {
  if (rating) return 'rated';
  if (!facts || !facts.eligible) return 'none';
  const end = Date.parse(facts.endedAt);
  return Number.isFinite(end) && nowMs < end + RATE_ASK_TTL_MS ? 'open' : 'none';
}

/** A read-only look (W3 C15): does this member's card hold a rating for this run? Null when the
 *  member is gone or the card cannot be read. No write, no lock. */
export function ratingExists(projectRoot: string, member: string, sessionKey: string, home?: string): boolean | null {
  try {
    const { scope } = resolveScorecard(projectRoot, member, home);
    const read = readScorecardAt(scope);
    if (read.damaged) return null;
    return !!read.card.ratings[runKeyFor(scope, sessionKeyOf(sessionKey))];
  } catch { return null; }
}
