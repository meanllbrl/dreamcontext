/**
 * The learned-rules stores (learning loop C2).
 *
 * Three stores, one shape: the personal one under `~/.dreamcontext/me/rules.json` (dir 0700, file
 * 0600, never synced, with `me.json {emails}`), the project one at `_dream_context/core/RULES.json`
 * (git-tracked, created by the first `learn`), and one per AI Team member (plan global-uye-ogrenme
 * D1): a global member's at `~/.dreamcontext/agents/<slug>/rules.json` (machine-local, 0700/0600), a
 * project member's at `_dream_context/agents/<slug>.rules.json` (git-ignored unless the member is
 * shared). A member's store is written through ONE gate ({@link memberWriteGate}): an agent only adds
 * or narrows there, and a rule rides only on his proven words. A rule is a record with a history of events; every
 * field an agent, the card or a view reads is DERIVED from the events on every read
 * ({@link deriveRule}). `undo`, `supersede` and `drop` are sticky: only a later `keep` (or a new
 * replace) changes them, and a `same` after an `undo` adds the saying and leaves the rule undone.
 *
 * Brain sync merges a conflicted project store by the union of records by id and, inside a record,
 * the union of events by `eid` ({@link mergeRulesStores}): nothing is chosen, so nothing is lost.
 *
 * After every write (and every merge) the store rewrites one readable view, generated and never
 * parsed back: `knowledge/patterns/learned-rules.md` for the project, `~/.dreamcontext/me/preferences.md`
 * for him. A hand edit of a view is not applied and not lost: it is copied aside and the caller
 * is told to use `learn edit`.
 *
 * Text is checked at write AND at render (G3): a synced or hand-edited store passes the same check
 * or the rule is skipped and listed as invalid. Every path is checked (G2): no symlink, contained.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withFileLockSync } from './file-lock.js';
import { amendmentRisks } from './agents/amendments.js';
import { globalAgentHome, listGlobalAgentSlugs } from './agents/scope.js';
import { isSafeAutomationSlug } from './agents/slot.js';
import { quoteCoversChange } from './owner-quote.js';
import { readPeople } from './people-store.js';
import { resolveActivePerson } from './people-resolve.js';
import { keyPath, realPath } from './real-path.js';

// ─── Shape ──────────────────────────────────────────────────────────────────

export const RULES_JSON_REL = 'core/RULES.json';
export const LEARNED_RULES_VIEW_REL = 'knowledge/patterns/learned-rules.md';
export const RULES_STORE_VERSION = 1;
/** A rule said again on another occasion stays at the front this long. */
export const HOT_DAYS = 7;
export const TEXT_LIMITS = { headline: 60, text: 240, phrase: 120, quote: 200 } as const;

export type RuleScope = 'me' | 'project' | 'member';
export type RuleBy = 'owner' | 'sleep' | 'agent' | 'migration';
export type RuleOp = 'create' | 'edit' | 'same' | 'replace' | 'supersede' | 'undo' | 'keep' | 'drop' | 'restore';
export type AtTag = 'always' | 'report' | 'ask' | 'plan' | 'build' | 'act';
export const AT_TAGS: readonly AtTag[] = ['always', 'report', 'ask', 'plan', 'build', 'act'];
export type RuleStatus = 'active' | 'proposed' | 'superseded' | 'undone' | 'invalid';

export interface RuleQuote {
  /** His words, redacted, at most {@link TEXT_LIMITS.quote}. */
  text: string;
  /** The ledger turn it was found in ('' when none: a terminal, a card answer). */
  turn: string;
  via: string;
  /** The occasion of that turn ('' when none: such a saying never raises `repeats`). */
  occasion: string;
}

export interface RuleSupersedes {
  /** Relative to the context root. */
  path: string;
  excerpt: string;
}

export interface RuleEvent {
  eid: string;
  at: string;
  op: RuleOp;
  by: RuleBy;
  /** The conversation that made the event (its first key), '' when none. */
  conversation: string;
  /** create / replace / same: what gate G1 said for this call. */
  status?: 'active' | 'proposed';
  headline?: string;
  text?: string;
  says?: string[];
  when?: string;
  at_tag?: AtTag;
  doc?: string;
  quotes?: RuleQuote[];
  /** replace: the rule replaced; supersede: the rule that replaced this one; restore: the undone rule that gave it back. */
  ref?: string;
  supersedes?: RuleSupersedes[];
  /** edit: the scope a moved rule went to. */
  moved_to?: RuleScope;
  /** restore: the status the rule had before it was superseded (never more than that). */
  prior_status?: 'active' | 'proposed' | 'undone';
  prior_dropped?: boolean;
}

export interface RuleRecord {
  id: string;
  scope: RuleScope;
  /** The member a `member` record belongs to (its slug); absent on the other scopes. */
  member?: string;
  created: { at: string; by: RuleBy; person: string };
  events: RuleEvent[];
}

export interface RulesStoreFile {
  version: number;
  rules: RuleRecord[];
  /**
   * Entries of the stored list that are not records (a bad hand edit, a newer writer). Never read,
   * never rewritten away: they are written back verbatim. Their own malformed events, likewise,
   * stay inside their record and are skipped by every read ({@link eventsOf}).
   */
  foreign?: unknown[];
  /** sha256 of the view this store last wrote (a hand edit is told apart by it). */
  view_hash?: string;
}

export class RulesStoreError extends Error {
  constructor(message: string, readonly code: 'unreadable' | 'unsafe' | 'invalid' | 'missing' | 'refused') {
    super(message);
    this.name = 'RulesStoreError';
  }
}

// ─── Ids ────────────────────────────────────────────────────────────────────

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += B32[bytes[i]! & 31];
  return out;
}
/** 10 random base-32 characters. */
export function newRuleId(): string { return base32(10); }
export function newEventId(): string { return base32(12); }
export const RULE_ID_RE = /^[a-z2-7]{10}$/;

// ─── Text (G3) ──────────────────────────────────────────────────────────────

const TAG_RE = /<[^<>\n]*>/;

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Why these fields cannot be a rule, or null. The same check runs at write and at render. */
export function validateRuleText(f: { headline?: string; text?: string; says?: string[]; when?: string }): string | null {
  const check = (label: string, v: string | undefined, max: number): string | null => {
    if (v === undefined) return null;
    if (/[\r\n]/.test(v)) return `${label} must be one line`;
    if (TAG_RE.test(v)) return `${label} must not carry <tags>`;
    if (v.length > max) return `${label} is ${v.length} chars, at most ${max}`;
    return null;
  };
  if (f.headline !== undefined && !f.headline.trim()) return 'headline is empty';
  if (f.text !== undefined && !f.text.trim()) return 'text is empty';
  return check('headline', f.headline, TEXT_LIMITS.headline)
    ?? check('text', f.text, TEXT_LIMITS.text)
    ?? check('when', f.when, TEXT_LIMITS.phrase)
    ?? (f.says ?? []).map((p) => check('phrase', p, TEXT_LIMITS.phrase)).find((r) => r !== null)
    ?? null;
}

/** A headline that IS the rule: the text itself, or its first words when it is longer. */
export function headlineFrom(text: string): string {
  const t = oneLine(text);
  if (t.length <= TEXT_LIMITS.headline) return t;
  const cut = t.slice(0, TEXT_LIMITS.headline - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 20 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function foldText(s: string): string {
  return oneLine(s).toLowerCase();
}

// ─── Paths (G2) ─────────────────────────────────────────────────────────────

export interface StoreRef {
  scope: RuleScope;
  /** The store file. */
  file: string;
  /** The generated view. */
  view: string;
  /** Machine-local lock (never inside a synced folder). */
  lock: string;
  /** Where a hand-edited view is copied. */
  editedDir: string;
  /** The vault's `_dream_context` for a project store or a project member's (null otherwise). */
  contextRoot: string | null;
  home: string;
  /** A member store's member: its slug and where it lives. */
  member?: { slug: string; scope: 'global' | 'project' };
}

/** A member's store: a write through `withStore` must carry the gate's facts (C1). */
export type MemberStoreRef = StoreRef & { scope: 'member'; member: { slug: string; scope: 'global' | 'project' } };

export function isMemberRef(ref: StoreRef): ref is MemberStoreRef {
  return ref.scope === 'member' && !!ref.member;
}

export function meDir(home: string = homedir()): string {
  return join(home, '.dreamcontext', 'me');
}

export function personalStoreRef(home: string = homedir()): StoreRef {
  const dir = meDir(home);
  return {
    scope: 'me',
    file: join(dir, 'rules.json'),
    view: join(dir, 'preferences.md'),
    lock: join(dir, 'rules.json.lock'),
    editedDir: join(dir, 'edited'),
    contextRoot: null,
    home,
  };
}

export function projectStoreRef(contextRoot: string, home: string = homedir()): StoreRef {
  let real = contextRoot;
  try { real = keyPath(contextRoot); } catch { /* not there yet */ }
  const tag = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return {
    scope: 'project',
    file: join(contextRoot, RULES_JSON_REL),
    view: join(contextRoot, LEARNED_RULES_VIEW_REL),
    lock: join(home, '.dreamcontext', 'locks', `rules-${tag}.lock`),
    editedDir: join(contextRoot, 'tmp', 'learn'),
    contextRoot,
    home,
  };
}

/** A project member's store file, relative to the context root. */
export function memberRulesRel(slug: string): string {
  return `agents/${slug}.rules.json`;
}

/**
 * A member's store (D1). A global member: `~/.dreamcontext/agents/<slug>/rules.json` and its view
 * `rules.md`, machine-local and private. A project member: `<contextRoot>/agents/<slug>.rules.json`
 * and `<slug>.rules.md` (the view is ignored by `agents/*.md`, the store unless the member is shared).
 * Throws on a slug that is not path-safe (SG4).
 */
export function memberStoreRef(member: { slug: string; scope: 'global' | 'project' }, contextRoot: string | null, home: string = homedir()): MemberStoreRef {
  if (!isSafeAutomationSlug(member.slug)) throw new RulesStoreError(`"${member.slug}" is not a member slug`, 'unsafe');
  if (member.scope === 'global') {
    const dir = globalAgentHome(member.slug, home);
    return {
      scope: 'member', member: { slug: member.slug, scope: 'global' },
      file: join(dir, 'rules.json'),
      view: join(dir, 'rules.md'),
      lock: join(home, '.dreamcontext', 'locks', `rules-member-${member.slug}.lock`),
      editedDir: join(dir, 'edited'),
      contextRoot: null,
      home,
    };
  }
  if (!contextRoot) throw new RulesStoreError(`${member.slug} is a project member: run inside its project`, 'refused');
  let real = contextRoot;
  try { real = keyPath(contextRoot); } catch { /* not there yet */ }
  const tag = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return {
    scope: 'member', member: { slug: member.slug, scope: 'project' },
    file: join(contextRoot, memberRulesRel(member.slug)),
    view: join(contextRoot, 'agents', `${member.slug}.rules.md`),
    lock: join(home, '.dreamcontext', 'locks', `rules-${tag}-${member.slug}.lock`),
    editedDir: join(contextRoot, 'tmp', 'learn'),
    contextRoot,
    home,
  };
}

/** Machine-local and private: his personal store and a global member's. */
function isPrivateRef(ref: StoreRef): boolean {
  return ref.scope === 'me' || (ref.scope === 'member' && ref.member?.scope === 'global');
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Refuse a store path that is a symlink or whose real path leaves its root. */
function assertSafe(ref: StoreRef): void {
  const globalMember = ref.scope === 'member' && ref.member?.scope === 'global';
  if (ref.member && !isSafeAutomationSlug(ref.member.slug)) throw new RulesStoreError(`"${ref.member.slug}" is not a member slug`, 'unsafe');
  const root = globalMember ? dirname(ref.file) : ref.contextRoot ?? meDir(ref.home);
  const checks = ref.contextRoot
    ? [dirname(ref.file), ref.file, dirname(ref.view), ref.view, ref.editedDir]
    : globalMember
      ? [dirname(root), root, ref.file, ref.view, ref.editedDir]
      : [root, ref.file, ref.view, ref.editedDir];
  for (const p of checks) {
    if (isSymlink(p)) throw new RulesStoreError(`${p} is a symlink: refused`, 'unsafe');
  }
  if (globalMember && existsSync(root)) {
    // A global member's folder must really be ~/.dreamcontext/agents/<slug> (no link up the chain).
    const agentsRoot = join(ref.home, '.dreamcontext', 'agents');
    const real = realPath(root);
    let realAgents = agentsRoot;
    try { realAgents = realPath(agentsRoot); } catch { /* checked by the symlink test above */ }
    if (real !== join(realAgents, basename(root))) throw new RulesStoreError(`${root} leaves ~/.dreamcontext/agents: refused`, 'unsafe');
  }
  if (ref.contextRoot && existsSync(ref.contextRoot)) {
    const realRoot = realPath(ref.contextRoot);
    for (const p of [dirname(ref.file), dirname(ref.view)]) {
      if (!existsSync(p)) continue;
      const real = realPath(p);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new RulesStoreError(`${p} leaves the vault: refused`, 'unsafe');
      }
    }
  }
}

/**
 * A file named by an agent (`--doc`, `--supersedes`), resolved inside the vault: relative to the
 * context root, or to the project root when it starts with `_dream_context/`. A symlink, a missing
 * file or a path whose real location leaves the vault is refused. Returns the context-root-relative path.
 */
export function containedVaultFile(contextRoot: string, p: string): { abs: string; rel: string } {
  const projectRoot = dirname(contextRoot);
  const norm = p.replace(/\\/g, '/');
  const abs = isAbsolute(norm)
    ? resolve(norm)
    : norm.startsWith(`${basename(contextRoot)}/`) ? resolve(projectRoot, norm) : resolve(contextRoot, norm);
  let st;
  try { st = lstatSync(abs); } catch { throw new RulesStoreError(`${p}: no such file in this vault`, 'refused'); }
  if (st.isSymbolicLink()) throw new RulesStoreError(`${p} is a symlink: refused`, 'unsafe');
  if (!st.isFile()) throw new RulesStoreError(`${p} is not a file`, 'refused');
  const realRoot = realPath(contextRoot);
  const real = realPath(abs);
  if (!real.startsWith(realRoot + sep)) throw new RulesStoreError(`${p} is outside the vault: refused`, 'unsafe');
  return { abs: real, rel: relative(realRoot, real).split(sep).join('/') };
}

// ─── Read / write ───────────────────────────────────────────────────────────

export function emptyStore(): RulesStoreFile {
  return { version: RULES_STORE_VERSION, rules: [] };
}

function isRecord(v: unknown): v is RuleRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const scoped = r.scope === 'me' || r.scope === 'project' || (r.scope === 'member' && typeof r.member === 'string' && isSafeAutomationSlug(r.member));
  return typeof r.id === 'string' && scoped
    && !!r.created && typeof r.created === 'object' && Array.isArray(r.events);
}

/** Parse a store's text; throws `unreadable` (never "empty") when it is not a store. '' is empty. */
export function parseStore(text: string): RulesStoreFile {
  if (!text.trim()) return emptyStore();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    throw new RulesStoreError(`the rules store does not parse: ${(e as Error).message}`, 'unreadable');
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as RulesStoreFile).rules)) {
    throw new RulesStoreError('the rules store has no rules list', 'unreadable');
  }
  const s = raw as RulesStoreFile;
  return {
    version: typeof s.version === 'number' ? s.version : RULES_STORE_VERSION,
    rules: s.rules.filter(isRecord),
    ...(s.rules.some((r) => !isRecord(r)) ? { foreign: (s.rules as unknown[]).filter((r) => !isRecord(r)) } : {}),
    ...(typeof s.view_hash === 'string' ? { view_hash: s.view_hash } : {}),
  };
}

export function readStore(ref: StoreRef): RulesStoreFile {
  assertSafe(ref);
  let text: string;
  try { text = readFileSync(ref.file, 'utf-8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new RulesStoreError(`the rules store cannot be read: ${(e as Error).message}`, 'unreadable');
  }
  return parseStore(text);
}

export function serializeStore(store: RulesStoreFile): string {
  const rules = [...store.rules].sort((a, b) => (a.created.at < b.created.at ? -1 : a.created.at > b.created.at ? 1 : a.id < b.id ? -1 : 1));
  for (const r of rules) r.events = [...eventsOf(r), ...r.events.filter((e) => !isEvent(e))];
  const all: unknown[] = [...rules, ...(store.foreign ?? [])];
  return `${JSON.stringify({ version: store.version, rules: all, ...(store.view_hash ? { view_hash: store.view_hash } : {}) }, null, 2)}\n`;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function atomicWrite(file: string, text: string, mode: number | undefined): void {
  const tmp = `${file}.${process.pid}.${base32(6)}.tmp`;
  writeFileSync(tmp, text, mode === undefined ? 'utf-8' : { encoding: 'utf-8', mode });
  renameSync(tmp, file);
  if (mode !== undefined) { try { chmodSync(file, mode); } catch { /* best effort */ } }
}

/**
 * Write the store (temp + rename; the previous good file stays as `.bak`) and its view. Returns
 * a notice when the view on disk was edited by hand (its copy is kept, the edit is not applied).
 * `fromMerge`: the view on disk is a conflicted file, never a hand edit.
 */
export function writeStore(ref: StoreRef, store: RulesStoreFile, opts: { now?: Date; fromMerge?: boolean } = {}): string | null {
  assertSafe(ref);
  const personal = isPrivateRef(ref);
  mkdirSync(dirname(ref.file), { recursive: true, ...(personal ? { mode: 0o700 } : {}) });
  if (personal) { try { chmodSync(dirname(ref.file), 0o700); } catch { /* best effort */ } }
  mkdirSync(dirname(ref.view), { recursive: true });

  let notice: string | null = null;
  const view = renderRulesView(store, ref, { now: opts.now });
  let onDisk: string | null = null;
  try { onDisk = readFileSync(ref.view, 'utf-8'); } catch { onDisk = null; }
  if (!opts.fromMerge && onDisk !== null && store.view_hash && sha(onDisk) !== store.view_hash && onDisk !== view) {
    mkdirSync(ref.editedDir, { recursive: true, ...(personal ? { mode: 0o700 } : {}) });
    const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const copy = join(ref.editedDir, `${basename(ref.view, '.md')}.${stamp}.md`);
    writeFileSync(copy, onDisk, personal ? { encoding: 'utf-8', mode: 0o600 } : 'utf-8');
    notice = `The view ${ref.view} was edited by hand. The edit is not applied; it is kept at ${copy}. Change a rule with \`dreamcontext learn edit <id>\`.`;
  }

  store.view_hash = sha(view);
  // The previous good store stays as `.bak`: an unparsable store is never treated as empty.
  if (existsSync(ref.file)) {
    try {
      parseStore(readFileSync(ref.file, 'utf-8'));
      copyFileSync(ref.file, `${ref.file}.bak`);
      if (personal) chmodSync(`${ref.file}.bak`, 0o600);
    } catch { /* an unreadable current file is not copied over a good .bak */ }
  }
  atomicWrite(ref.file, serializeStore(store), personal ? 0o600 : undefined);
  atomicWrite(ref.view, view, personal ? 0o600 : undefined);
  return notice;
}

// ─── The member store's gate (D2, SG1, SG3) ─────────────────────────────────

/** Who writes into a member store, as the gate reads it. */
export interface GateActor {
  /** `ownerProcess` (session-member.ts): he himself at his own shell. */
  owner: boolean;
}

/** What the gate needs for every write into a member store: who, and his proven words. */
export interface MemberGate {
  actor: GateActor;
  quote: {
    /** His words this write cites, joined ('' when none). */
    text: string;
    /** Every quote resolved to a turn of THIS conversation (G1, relays included). */
    here: boolean;
  };
  /** For a `--replaces`: the replaced rule's text, read from its own store before this write. */
  replacedText?: string;
}

export interface WithStoreOpts { now?: Date }

/** What a gated write decided, one line each: why an event the call added was written `proposed`. */
export interface GateNote { id: string; reason: string }

/** The text that RIDES once a rule is in force: what the gate reads (never only the new saying). */
export function rideText(v: Pick<RuleView, 'headline' | 'text' | 'says' | 'when'>): string {
  return [v.headline, v.text, ...v.says, v.when].filter(Boolean).join('\n');
}

const REMOVAL_RISKS = /^(?:removing the whole text|replacing most of the text|changing or removing a line)/;

/**
 * THE gate of a member store (D2): what an event an agent added may be. Never runs for his own
 * shell (`actor.owner`). `active` only when (a) the text that will ride reads like no payload
 * (`amendmentRisks`, the same screen an instruction change meets), (b) every quote was typed in
 * this conversation, and (c) into a GLOBAL member's store, his words are about this text
 * (`quoteCoversChange`). Otherwise `proposed`, with why: it waits for his `learned` card.
 */
export function memberWriteGate(
  before: string,
  after: RuleView,
  ref: MemberStoreRef,
  gate: MemberGate,
): { status: 'active' | 'proposed'; reason: string | null } {
  if (gate.actor.owner) return { status: 'active', reason: null };
  const text = rideText(after);
  const risks = amendmentRisks(before, text).filter((r) => !REMOVAL_RISKS.test(r));
  if (risks.length > 0) return { status: 'proposed', reason: `its text reads like an instruction from outside (${risks.join('; ')}): it waits for his card` };
  if (!gate.quote.here) return { status: 'proposed', reason: 'his words were not typed in this conversation: it waits for his card' };
  if (ref.member.scope === 'global' && !quoteCoversChange(gate.quote.text, before, text)) {
    return { status: 'proposed', reason: 'his quoted words are not about this rule\'s text (a rule every project carries): it waits for his card' };
  }
  return { status: 'active', reason: null };
}

/** Events an agent may add to a member store without his own shell: adds and narrowings. */
const AGENT_MEMBER_OPS: ReadonlySet<RuleOp> = new Set(['create', 'replace', 'same', 'keep', 'undo', 'drop', 'supersede', 'restore']);

/**
 * Run the gate over the events `fn` added to a member store, before the file is written: an
 * `active` event the gate does not pass is written `proposed` (never changed later in place); a
 * `keep` whose rule text the screen flags, or an `edit` (or move) by anyone but him, is refused.
 */
function gateAddedEvents(ref: MemberStoreRef, before: Map<string, Set<string>>, store: RulesStoreFile, gate: MemberGate, now: Date | undefined): GateNote[] {
  const notes: GateNote[] = [];
  for (const rec of store.rules) {
    const had = before.get(rec.id);
    const added = eventsOf(rec).filter((e) => !had?.has(e.eid));
    if (added.length === 0) continue;
    if (rec.scope !== 'member' || rec.member !== ref.member.slug) {
      if (!gate.actor.owner) throw new RulesStoreError(`a record of another store cannot be written into ${ref.member.slug}'s rules`, 'refused');
    }
    if (gate.actor.owner) continue;
    for (const e of added) {
      if (!AGENT_MEMBER_OPS.has(e.op)) {
        throw new RulesStoreError(`an agent cannot ${e.op} a member's rule: write a new rule on his words with --replaces <id>, or give him the change as a run card`, 'refused');
      }
      if (e.op === 'restore' || e.op === 'undo' || e.op === 'drop' || e.op === 'supersede') continue;
      const upTo = eventsOf(rec);
      const view = deriveRule({ ...rec, events: upTo.slice(0, upTo.indexOf(e) + 1) }, now);
      const old = e.op === 'replace' ? gate.replacedText ?? '' : '';
      if (e.op === 'keep') {
        const risks = amendmentRisks('', rideText(view)).filter((r) => !REMOVAL_RISKS.test(r));
        if (risks.length > 0) throw new RulesStoreError(`${rec.id} reads like an instruction from outside (${risks.join('; ')}): only his card keeps it`, 'refused');
        continue;
      }
      if (e.status !== 'active') continue;
      const verdict = memberWriteGate(old, view, ref, gate);
      if (verdict.status === 'proposed') {
        e.status = 'proposed';
        notes.push({ id: rec.id, reason: verdict.reason ?? 'it waits for his card' });
      }
    }
  }
  return notes;
}

/**
 * Read-modify-write under the store's lock. `fn` returns whether it changed the store. On a member
 * store the gate's facts are required (C1): every event the call adds passes {@link memberWriteGate}
 * before the file is written.
 */
export function withStore<T>(ref: MemberStoreRef, fn: (store: RulesStoreFile) => { result: T; changed: boolean }, opts: WithStoreOpts & { gate: MemberGate }): { result: T; notice: string | null; gated: GateNote[] };
export function withStore<T>(ref: StoreRef, fn: (store: RulesStoreFile) => { result: T; changed: boolean }, opts?: WithStoreOpts & { gate?: MemberGate }): { result: T; notice: string | null; gated: GateNote[] };
export function withStore<T>(ref: StoreRef, fn: (store: RulesStoreFile) => { result: T; changed: boolean }, opts: WithStoreOpts & { gate?: MemberGate } = {}): { result: T; notice: string | null; gated: GateNote[] } {
  if (ref.scope === 'member' && (!isMemberRef(ref) || !opts.gate)) {
    throw new RulesStoreError('a member store is written only through its gate', 'refused');
  }
  mkdirSync(dirname(ref.lock), { recursive: true, mode: 0o700 });
  return withFileLockSync(ref.lock, () => {
    const store = readStore(ref);
    const before = new Map(store.rules.map((r) => [r.id, new Set(eventsOf(r).map((e) => e.eid))]));
    const { result, changed } = fn(store);
    const gated = changed && isMemberRef(ref) ? gateAddedEvents(ref, before, store, opts.gate!, opts.now) : [];
    const notice = changed ? writeStore(ref, store, opts) : null;
    return { result, notice, gated };
  });
}

// ─── Derive ─────────────────────────────────────────────────────────────────

export interface RuleSaying extends RuleQuote {
  at: string;
  by: RuleBy;
  /** True for the sayings of the call that created the rule. */
  creating: boolean;
}

export interface RuleView {
  id: string;
  scope: RuleScope;
  /** A member rule's member. */
  member?: string;
  status: RuleStatus;
  /** Why an active or proposed rule is invalid (G3 at render). */
  invalid_reason?: string;
  headline: string;
  text: string;
  says: string[];
  when: string;
  at_tag: AtTag | null;
  doc: string;
  created: RuleRecord['created'];
  sayings: RuleSaying[];
  cited_turns: string[];
  repeats: number;
  hot_until: string | null;
  hot: boolean;
  escalate: boolean;
  replaces: string | null;
  superseded_by: string | null;
  dropped: boolean;
  moved_to: RuleScope | null;
  supersedes: RuleSupersedes[];
  /** Who wrote the latest status change. */
  status_by: RuleBy;
  /** When the record last changed (its newest event): "new since this session started" reads it. */
  changed_at: string;
}

function isEvent(e: unknown): e is RuleEvent {
  return !!e && typeof e === 'object' && typeof (e as RuleEvent).eid === 'string' && typeof (e as RuleEvent).at === 'string';
}

/** A record's well-formed events, in order: what every read sees (a malformed one is kept, never read). */
export function eventsOf(rec: RuleRecord): RuleEvent[] {
  return rec.events.filter(isEvent).sort(eventOrder);
}

/** By time; events of one instant keep the order they were written in (a stable sort), never a random id order. */
function eventOrder(a: RuleEvent, b: RuleEvent): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function deriveRule(rec: RuleRecord, now: Date = new Date()): RuleView {
  const events = eventsOf(rec);
  const first = events.find((e) => e.op === 'create' || e.op === 'replace');
  const v: RuleView = {
    id: rec.id,
    scope: rec.scope,
    ...(rec.member ? { member: rec.member } : {}),
    status: first?.status === 'active' ? 'active' : 'proposed',
    headline: '',
    text: '',
    says: [],
    when: '',
    at_tag: null,
    doc: '',
    created: rec.created,
    sayings: [],
    cited_turns: [],
    repeats: 0,
    hot_until: null,
    hot: false,
    escalate: false,
    replaces: first?.op === 'replace' ? first.ref ?? null : null,
    superseded_by: null,
    dropped: false,
    moved_to: null,
    supersedes: [],
    status_by: first?.by ?? rec.created.by,
    changed_at: events.at(-1)?.at ?? rec.created.at,
  };
  const apply = (e: RuleEvent): void => {
    if (e.headline !== undefined) v.headline = e.headline;
    if (e.text !== undefined) v.text = e.text;
    if (e.says !== undefined) v.says = [...e.says];
    if (e.when !== undefined) v.when = e.when;
    if (e.at_tag !== undefined) v.at_tag = e.at_tag;
    if (e.doc !== undefined) v.doc = e.doc;
    if (e.supersedes !== undefined) for (const s of e.supersedes) {
      if (!v.supersedes.some((x) => x.path === s.path && x.excerpt === s.excerpt)) v.supersedes.push(s);
    }
  };
  const seen = new Set<string>();
  const hot: { until: number | null } = { until: null };
  const addSayings = (e: RuleEvent, creating: boolean): void => {
    for (const q of e.quotes ?? []) {
      v.sayings.push({ ...q, at: e.at, by: e.by, creating });
      if (q.turn && !v.cited_turns.includes(q.turn)) v.cited_turns.push(q.turn);
      if (creating) { if (q.occasion) seen.add(q.occasion); continue; }
      if (!q.occasion || seen.has(q.occasion)) continue;
      seen.add(q.occasion);
      v.repeats += 1;
      const t = Date.parse(e.at);
      if (hot.until !== null && t < hot.until) v.escalate = true;
      hot.until = t + HOT_DAYS * DAY_MS;
    }
  };
  if (first) { apply(first); addSayings(first, true); }
  for (const e of events) {
    if (e === first) continue;
    switch (e.op) {
      case 'edit':
        apply(e);
        if (e.moved_to) { v.moved_to = e.moved_to; v.status = 'undone'; v.status_by = e.by; }
        break;
      case 'same':
        addSayings(e, false);
        if (e.status === 'active' && v.status === 'proposed') { v.status = 'active'; v.status_by = e.by; }
        break;
      case 'supersede':
        if (e.supersedes) apply(e);
        if (e.ref) { v.status = 'superseded'; v.superseded_by = e.ref; v.status_by = e.by; }
        break;
      case 'undo':
        v.status = 'undone'; v.status_by = e.by;
        break;
      case 'drop':
        v.status = 'undone'; v.dropped = true; v.status_by = e.by;
        break;
      case 'keep':
        v.status = 'active'; v.dropped = false; v.superseded_by = null; v.status_by = e.by;
        break;
      case 'restore':
        // Undo of the rule that replaced this one: the status it had before, never more.
        if (v.status === 'superseded') {
          v.status = e.prior_status ?? 'proposed'; v.dropped = !!e.prior_dropped; v.superseded_by = null; v.status_by = e.by;
        }
        break;
      default:
        break;
    }
  }
  if (hot.until !== null) {
    v.hot_until = new Date(hot.until).toISOString();
    v.hot = now.getTime() < hot.until;
  }
  if (v.status === 'active' || v.status === 'proposed') {
    const why = !first ? 'no create event' : validateRuleText({ headline: v.headline, text: v.text, says: v.says, when: v.when || undefined });
    if (why) { v.status = 'invalid'; v.invalid_reason = why; }
  }
  return v;
}

/** Every phrase a rule can be matched on (D7): headline, `when`, each `says`, each stored quote. */
export function rulePhrases(v: RuleView): string[] {
  const out: string[] = [];
  const push = (s: string): void => { const t = oneLine(s); if (t && !out.includes(t)) out.push(t); };
  push(v.headline);
  if (v.when) push(v.when);
  for (const s of v.says) push(s);
  for (const s of v.sayings) push(s.text);
  return out;
}

const STATUS_RANK: Record<RuleStatus, number> = { active: 0, proposed: 1, superseded: 2, undone: 3, invalid: 4 };

/** Heaviest first: hot, then repeats, then the most recent saying. */
export function byWeight(a: RuleView, b: RuleView): number {
  if (a.hot !== b.hot) return a.hot ? -1 : 1;
  if (a.repeats !== b.repeats) return b.repeats - a.repeats;
  const la = a.sayings.at(-1)?.at ?? a.created.at;
  const lb = b.sayings.at(-1)?.at ?? b.created.at;
  return la < lb ? 1 : la > lb ? -1 : 0;
}

export function deriveAll(store: RulesStoreFile, now: Date = new Date()): RuleView[] {
  return store.rules.map((r) => deriveRule(r, now)).sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byWeight(a, b));
}

export function findRecord(store: RulesStoreFile, id: string): RuleRecord | undefined {
  return store.rules.find((r) => r.id === id);
}

// ─── Flags: old text that still says the opposite (D9, D16e) ────────────────

export interface SupersedeFlag extends RuleSupersedes {
  /** True while the file still contains the excerpt. */
  still: boolean;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Only an active or proposed rule flags: undo and drop take the flag away. */
export function supersedeFlags(contextRoot: string | null, v: RuleView): SupersedeFlag[] {
  if (!contextRoot || (v.status !== 'active' && v.status !== 'proposed')) return [];
  return v.supersedes.map((s) => {
    let still = false;
    try {
      const { abs } = containedVaultFile(contextRoot, s.path);
      still = norm(readFileSync(abs, 'utf-8')).includes(norm(s.excerpt));
    } catch { still = false; }
    return { ...s, still };
  });
}

// ─── Status changes (the CLI and, in W2, the card's route call these) ───────

export interface Actor {
  by: RuleBy;
  conversation: string;
  now?: Date;
}

function stamp(actor: Actor): { eid: string; at: string; by: RuleBy; conversation: string } {
  return { eid: newEventId(), at: (actor.now ?? new Date()).toISOString(), by: actor.by, conversation: actor.conversation };
}

export type StatusChange =
  | { ok: true; rule: RuleView; restored?: RuleView; notice: string | null }
  | { ok: false; reason: string };

/** What one status step decided, before the store is written. */
type Step = { ok: true; rule: RuleView; restored?: RuleView } | { ok: false; reason: string };

export type StatusOp = 'keep' | 'undo' | 'drop' | 'supersede';

/**
 * The ONE place that decides a status transition (every writer of a status event comes through
 * here: keep, undo, drop, and the supersede a `--replaces` writes). Mutates `store` and returns
 * what happened, or why not.
 *
 * - keep: proposed, undone or superseded to active. Who may ask is the caller's check (the card's
 *   route, his word in this conversation, his own shell).
 * - undo: an active or proposed rule to undone. The rule it replaced comes back only while that
 *   rule is still superseded by this one, and only to the status it had BEFORE it was superseded
 *   (a `restore` event): a proposed rule stays proposed, an undone one stays undone. Never active
 *   on its own.
 * - drop: a rule waiting for his word (or an invalid one) to undone.
 * - supersede: `ref` replaces this rule; refused when it is already replaced or moved.
 */
export function applyStatusOp(store: RulesStoreFile, id: string, op: StatusOp, actor: Actor, opts: { ref?: string; scope?: RuleScope } = {}): Step {
  const rec = findRecord(store, id);
  if (!rec) return { ok: false, reason: `no rule ${id} in the ${opts.scope ?? store.rules[0]?.scope ?? 'rules'} store` };
  const v = deriveRule(rec, actor.now);
  if (v.moved_to) return { ok: false, reason: `${id} moved to the ${v.moved_to} store` };
  const done = (): Step => ({ ok: true, rule: deriveRule(rec, actor.now) });
  switch (op) {
    case 'keep':
      if (v.status === 'active') return { ok: false, reason: `${id} is already active` };
      if (v.status === 'invalid') return { ok: false, reason: `${id} is invalid (${v.invalid_reason}): fix it with \`learn edit\`` };
      rec.events.push({ ...stamp(actor), op: 'keep' });
      return done();
    case 'drop':
      if (v.status !== 'proposed' && v.status !== 'invalid') {
        return { ok: false, reason: `${id} is ${v.status}: drop is for a rule waiting for his word${v.status === 'active' ? ' (use undo)' : ''}` };
      }
      rec.events.push({ ...stamp(actor), op: 'drop' });
      return done();
    case 'supersede':
      if (!opts.ref) return { ok: false, reason: 'supersede needs the replacing rule' };
      if (v.status === 'superseded') return { ok: false, reason: `${id} was already replaced by ${v.superseded_by}: replace that one` };
      rec.events.push({ ...stamp(actor), op: 'supersede', ref: opts.ref });
      return done();
    case 'undo': {
      if (v.status === 'undone') return { ok: false, reason: `${id} is already undone` };
      if (v.status === 'superseded') return { ok: false, reason: `${id} was replaced by ${v.superseded_by}: undo that one instead` };
      rec.events.push({ ...stamp(actor), op: 'undo' });
      // The rule it replaced comes back through releaseReplaced, in whichever store it lives.
      return done();
    }
    default:
      return { ok: false, reason: `unknown status op ${String(op)}` };
  }
}

/**
 * Give the replaced rule back (D11): after a record that replaces another ends its life (undo,
 * drop), in the store where the old rule lives, under its own lock, only while that rule is still
 * superseded BY this record with a matching supersede event (a forged `replaces` pointer restores
 * nothing), and only to the status it had before. Mutates `store`; the restored view, or undefined.
 */
export function restoreReplaced(store: RulesStoreFile, oldId: string, byId: string, actor: Actor): RuleView | undefined {
  const old = findRecord(store, oldId);
  if (!old) return undefined;
  const ov = deriveRule(old, actor.now);
  const sup = eventsOf(old).filter((e) => e.op === 'supersede' && e.ref === byId).at(-1);
  if (ov.status !== 'superseded' || ov.superseded_by !== byId || !sup) return undefined;
  const before = statusBefore(old, sup, actor.now);
  old.events.push({ ...stamp(actor), op: 'restore', ref: byId, prior_status: before.status, ...(before.dropped ? { prior_dropped: true } : {}) });
  return deriveRule(old, actor.now);
}

/** The status a record had just before `event` (its supersede): what a restore puts back. */
function statusBefore(rec: RuleRecord, event: RuleEvent, now?: Date): { status: 'active' | 'proposed' | 'undone'; dropped: boolean } {
  const sorted = eventsOf(rec);
  const upTo = sorted.slice(0, sorted.indexOf(event));
  const v = deriveRule({ ...rec, events: upTo }, now);
  if (v.status === 'active' || v.status === 'undone') return { status: v.status, dropped: v.dropped };
  // proposed, invalid (a render-time verdict) or anything else: never more than proposed.
  return { status: 'proposed', dropped: false };
}

/**
 * Every store a rule id can live in, as one caller sees them (C1): `me` (where shown), this
 * project, and every member store on this Mac (global members, this vault's project members). The
 * CLI and the `learned` card route build it the same way ({@link visibleStores}).
 */
export interface RuleLocator {
  refs: () => StoreRef[];
}

/** The store and record holding `id`, first match in the locator's order; a moved-away copy is skipped. */
export function locateIn(locator: RuleLocator, id: string, now?: Date): { ref: StoreRef; rec: RuleRecord; view: RuleView } | null {
  for (const ref of locator.refs()) {
    let store: RulesStoreFile;
    try { store = readStore(ref); } catch (e) { if (e instanceof RulesStoreError && e.code === 'unsafe') continue; throw e; }
    const rec = findRecord(store, id);
    if (!rec) continue;
    const view = deriveRule(rec, now);
    if (view.moved_to) continue;
    return { ref, rec, view };
  }
  return null;
}

/** Status changes that may write a member store carry its gate facts (an undo or drop is a narrowing). */
export interface StatusOpts {
  locate: RuleLocator;
  gate?: MemberGate;
}

const NARROWING_GATE: MemberGate = { actor: { owner: false }, quote: { text: '', here: false } };

function storeWrite<T>(ref: StoreRef, fn: (store: RulesStoreFile) => { result: T; changed: boolean }, now: Date | undefined, gate: MemberGate | undefined): { result: T; notice: string | null } {
  return isMemberRef(ref)
    ? withStore<T>(ref, fn, { now, gate: gate ?? NARROWING_GATE })
    : withStore<T>(ref, fn, { now });
}

/**
 * After a status change that ended a replacing record's life: find the rule it replaced in any
 * visible store and give it back ({@link restoreReplaced}), in a second write after the first landed
 * (never nested). Exempt from `own_member_only`: it only returns a status that was gated, and only
 * for the rule its own record replaced.
 */
export function releaseReplaced(locate: RuleLocator, rule: RuleView, actor: Actor): { restored?: RuleView; failed?: string } {
  if (!rule.replaces) return {};
  try {
    const found = locateIn(locate, rule.replaces, actor.now);
    if (!found) return {};
    const { result } = storeWrite<RuleView | undefined>(found.ref, (store) => {
      const r = restoreReplaced(store, rule.replaces!, rule.id, actor);
      return { result: r, changed: !!r };
    }, actor.now, NARROWING_GATE);
    return result ? { restored: result } : {};
  } catch (e) {
    return { failed: `${rule.replaces} could not be given back (${(e as Error).message}): it is still replaced` };
  }
}

function statusChange(ref: StoreRef, id: string, op: StatusOp, actor: Actor, opts: StatusOpts): StatusChange {
  const { result, notice } = storeWrite<Step>(ref, (store) => {
    const step = applyStatusOp(store, id, op, actor, { scope: ref.scope });
    return { result: step, changed: step.ok };
  }, actor.now, opts.gate);
  if (!result.ok) return result;
  if (op !== 'undo' && op !== 'drop') return { ...result, notice };
  const back = releaseReplaced(opts.locate, result.rule, actor);
  const note = [notice, back.failed ?? null].filter(Boolean).join(' ') || null;
  return { ...result, ...(back.restored ? { restored: back.restored } : {}), notice: note };
}

/** Proposed (or undone, or superseded) to active. Who may ask is the caller's check. */
export function keepRule(ref: StoreRef, id: string, actor: Actor, opts: StatusOpts): StatusChange {
  return statusChange(ref, id, 'keep', actor, opts);
}

/** Undo; the rule it replaced, in any store, gets back the status it had before ({@link releaseReplaced}). */
export function undoRule(ref: StoreRef, id: string, actor: Actor, opts: StatusOpts): StatusChange {
  return statusChange(ref, id, 'undo', actor, opts);
}

/** Drop a rule that waits for his word; the rule it replaced comes back too. An active rule is undone, not dropped. */
export function dropRule(ref: StoreRef, id: string, actor: Actor, opts: StatusOpts): StatusChange {
  return statusChange(ref, id, 'drop', actor, opts);
}

export interface RuleEdit {
  headline?: string;
  text?: string;
  says?: string[];
  when?: string;
  at_tag?: AtTag;
  doc?: string;
}

const editFields = (edit: RuleEdit): RuleEdit =>
  Object.fromEntries(Object.entries(edit).filter(([, val]) => val !== undefined)) as RuleEdit;

/** Edit a rule by id (never a twin). Status is untouched. */
/** An agent never edits nor moves a member's rule (owner, 21 Nov "Daralt"): one line saying what to do. */
export const MEMBER_EDIT_REFUSAL = 'an agent does not edit or move a member\'s rule: write a new rule on his words with `--replaces <id>` (it replaces the old one, in any store), or give him the change as a `run` card';

export function editRule(ref: StoreRef, id: string, edit: RuleEdit, actor: Actor & { owner?: boolean }): StatusChange {
  const bad = validateRuleText(edit);
  if (bad) return { ok: false, reason: bad };
  if (ref.scope === 'member' && !actor.owner) return { ok: false, reason: MEMBER_EDIT_REFUSAL };
  const { result, notice } = storeWrite<Step>(ref, (store) => {
    const rec = findRecord(store, id);
    if (!rec) return { result: { ok: false, reason: `no rule ${id} in the ${ref.scope} store` }, changed: false };
    const fields = editFields(edit);
    if (Object.keys(fields).length === 0) return { result: { ok: false, reason: 'nothing to edit' }, changed: false };
    rec.events.push({ ...stamp(actor), op: 'edit', ...fields });
    return { result: { ok: true, rule: deriveRule(rec, actor.now) }, changed: true };
  }, actor.now, { actor: { owner: !!actor.owner }, quote: { text: '', here: false } });
  return result.ok ? { ...result, notice } : result;
}

/**
 * Move a rule to the other store (`learn edit --scope`). The target is written FIRST (the whole
 * history plus an edit); only then is the source record marked moved, so a failed target write
 * leaves the rule where it was. The source keeps the record (a merge never brings a twin back).
 */
export function moveRule(from: StoreRef, to: StoreRef, id: string, edit: RuleEdit, actor: Actor & { owner?: boolean }): StatusChange {
  if (from.scope === to.scope) return { ok: false, reason: `${id} is already in the ${to.scope} store` };
  if ((from.scope === 'member' || to.scope === 'member') && !actor.owner) return { ok: false, reason: MEMBER_EDIT_REFUSAL };
  const bad = validateRuleText(edit);
  if (bad) return { ok: false, reason: bad };
  const source = findRecord(readStore(from), id);
  if (!source || deriveRule(source, actor.now).moved_to) return { ok: false, reason: `no movable rule ${id} in the ${from.scope} store` };
  const taken: RuleRecord = JSON.parse(JSON.stringify(source));
  const ownerGate: MemberGate = { actor: { owner: !!actor.owner }, quote: { text: '', here: false } };
  const { result, notice } = storeWrite<RuleView>(to, (store) => {
    const existing = findRecord(store, id);
    const { member: _drop, ...rest } = taken;
    void _drop;
    const rec: RuleRecord = existing ?? { ...rest, scope: to.scope, ...(to.member ? { member: to.member.slug } : {}) };
    if (existing) {
      for (const e of eventsOf(taken)) if (!eventsOf(existing).some((x) => x.eid === e.eid)) existing.events.push(e);
    } else store.rules.push(rec);
    rec.events.push({ ...stamp(actor), op: 'edit', ...editFields(edit) });
    return { result: deriveRule(rec, actor.now), changed: true };
  }, actor.now, ownerGate);
  storeWrite<null>(from, (store) => {
    const rec = findRecord(store, id);
    if (!rec || deriveRule(rec, actor.now).moved_to) return { result: null, changed: false };
    rec.events.push({ ...stamp(actor), op: 'edit', moved_to: to.scope });
    return { result: null, changed: true };
  }, actor.now, ownerGate);
  return { ok: true, rule: result, notice };
}

// ─── Views (generated, never parsed back) ───────────────────────────────────

const fmDate = (iso: string): string => iso.slice(0, 10);

function ruleLine(v: RuleView, contextRoot: string | null): string[] {
  const lines = [`- **${v.headline}** (\`${v.id}\`)${v.text && v.text !== v.headline ? `: ${v.text}` : ''}`];
  const said = v.sayings.filter((s) => s.text);
  const last = said.at(-1);
  if (last) lines.push(`  - His words: "${last.text}" (${fmDate(last.at)}${said.length > 1 ? `, said ${said.length} times` : ''})`);
  const meta = [`written by ${v.created.by}`];
  if (v.at_tag) meta.push(`at ${v.at_tag}`);
  if (v.repeats > 0) meta.push(`repeated ${v.repeats}`);
  if (v.hot) meta.push(`hot until ${fmDate(v.hot_until!)}`);
  if (v.doc) meta.push(`detail: ${v.doc}`);
  lines.push(`  - ${meta.join(', ')}`);
  for (const f of supersedeFlags(contextRoot, v)) {
    if (f.still) lines.push(`  - Old text still says the opposite: ${f.path}: "${f.excerpt}"`);
  }
  return lines;
}

/** The readable view of a store: active, then waiting for his word, then replaced and undone. */
export function renderRulesView(store: RulesStoreFile, ref: Pick<StoreRef, 'scope' | 'contextRoot'> & { member?: StoreRef['member'] }, opts: { now?: Date } = {}): string {
  const views = deriveAll(store, opts.now);
  const personal = ref.scope === 'me';
  const member = ref.scope === 'member' ? (ref as Partial<StoreRef>).member?.slug ?? 'member' : null;
  const title = personal ? 'His preferences' : member ? `${member}'s rules` : 'Learned rules';
  const out: string[] = [
    '---',
    `name: ${title}`,
    `description: ${personal ? 'How to work with him, on every project on this Mac' : member ? `How ${member} works, in every project it works in, from the owner's words` : 'Rules this project learned from the owner\'s words'}. Generated by dreamcontext learn; change a rule with dreamcontext learn edit.`,
    'generated: true',
    '---',
    '',
    `# ${title}`,
    '',
    `Generated from \`${personal ? '~/.dreamcontext/me/rules.json' : member ? `the ${member} rules store` : RULES_JSON_REL}\` by \`dreamcontext learn\`. A hand edit here is not applied: use \`dreamcontext learn edit <id>\`.`,
    '',
  ];
  const section = (heading: string, list: RuleView[], render: (v: RuleView) => string[]): void => {
    out.push(`## ${heading}`, '');
    if (list.length === 0) out.push('None.');
    for (const v of list) out.push(...render(v));
    out.push('');
  };
  section('Active', views.filter((v) => v.status === 'active'), (v) => ruleLine(v, ref.contextRoot));
  section('Waiting for his word', views.filter((v) => v.status === 'proposed'), (v) => ruleLine(v, ref.contextRoot));
  section('Replaced and undone', views.filter((v) => v.status === 'superseded' || v.status === 'undone'), (v) => {
    const why = v.status === 'superseded' ? `replaced by \`${v.superseded_by}\``
      : v.moved_to ? `moved to the ${v.moved_to === 'me' ? 'personal' : v.moved_to === 'member' ? 'member' : 'project'} store`
        : v.dropped ? `dropped by ${v.status_by}` : `undone by ${v.status_by}`;
    return [`- ~~${v.headline}~~ (\`${v.id}\`): ${why}`];
  });
  const invalid = views.filter((v) => v.status === 'invalid');
  if (invalid.length > 0) {
    section('Invalid (not delivered)', invalid, (v) => [`- \`${v.id}\`: ${v.invalid_reason}`]);
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ─── Merge (brain sync's `rules-json` class) ────────────────────────────────

/**
 * The union of records by id and, inside a record, of events by `eid`. Nothing is chosen.
 * '' is an empty side. Returns null when a non-empty side does not parse (never treated as empty).
 */
export function mergeRulesStores(sides: readonly string[]): RulesStoreFile | null {
  const parsed: RulesStoreFile[] = [];
  for (const s of sides) {
    try { parsed.push(parseStore(s)); } catch { return null; }
  }
  const byId = new Map<string, RuleRecord>();
  for (const store of parsed) {
    for (const rec of store.rules) {
      const have = byId.get(rec.id);
      if (!have) { byId.set(rec.id, JSON.parse(JSON.stringify(rec))); continue; }
      if (rec.created.at < have.created.at) have.created = { ...rec.created };
      for (const e of eventsOf(rec)) if (!eventsOf(have).some((x) => x.eid === e.eid)) have.events.push(JSON.parse(JSON.stringify(e)));
    }
  }
  // Entries that are not records are kept too, once each: a merge never drops what it cannot read.
  const foreign: unknown[] = [];
  const seenForeign = new Set<string>();
  for (const store of parsed) for (const f of store.foreign ?? []) {
    const key = JSON.stringify(f);
    if (!seenForeign.has(key)) { seenForeign.add(key); foreign.push(f); }
  }
  return { version: RULES_STORE_VERSION, rules: [...byId.values()], ...(foreign.length ? { foreign } : {}) };
}

// ─── Personal store identity ────────────────────────────────────────────────

/**
 * Who the personal store belongs to. `local_owner`: written on a Mac with no email to name him
 * (D10): the store is his, shown in a vault with no roster; elsewhere one line says how to add it.
 */
export interface MeFile { emails: string[]; local_owner?: boolean }

export function readMeFile(home: string = homedir()): MeFile | null {
  const file = join(meDir(home), 'me.json');
  if (isSymlink(meDir(home)) || isSymlink(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { emails?: unknown; local_owner?: unknown };
    const emails = Array.isArray(raw.emails) ? raw.emails.filter((e): e is string => typeof e === 'string' && e.includes('@')).map((e) => e.trim().toLowerCase()) : [];
    if (emails.length > 0) return { emails };
    return raw.local_owner === true ? { emails: [], local_owner: true } : null;
  } catch { return null; }
}

/**
 * `me.json` when there is none: from the project's git `user.email`, else the global one, else a
 * `local_owner` file with no email (D10: the personal store never refuses). Null only when the
 * folder is a link (G2).
 */
export function ensureMeFile(home: string, gitEmail: string | null, globalEmail: string | null = null): MeFile | null {
  const have = readMeFile(home);
  if (have && (have.emails.length > 0 || !(gitEmail?.includes('@') || globalEmail?.includes('@')))) return have;
  const dir = meDir(home);
  if (isSymlink(dir)) return null;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const email = [gitEmail, globalEmail].find((e) => !!e && e.includes('@'));
  const me: MeFile = email ? { emails: [email.trim().toLowerCase()] } : { emails: [], local_owner: true };
  atomicWrite(join(dir, 'me.json'), `${JSON.stringify(me, null, 2)}\n`, 0o600);
  return me;
}

/**
 * Whether this vault shows his personal rules (C2): when its active person shares an email with
 * `me.json`, or the vault has no roster. Otherwise one line says they are not shown.
 */
export function personalRulesVisible(contextRoot: string, home: string = homedir()): { visible: boolean; line: string | null } {
  const me = readMeFile(home);
  if (!me) return { visible: false, line: null };
  let people: ReturnType<typeof readPeople> | null = null;
  try { people = readPeople(contextRoot); } catch { people = null; }
  if (!people || Object.keys(people).length === 0) return { visible: true, line: null };
  const active = resolveActivePerson(contextRoot);
  const person = active.slug ? people[active.slug] : undefined;
  const emails = (person?.emails ?? []).map((e) => e.trim().toLowerCase());
  if (emails.some((e) => me.emails.includes(e))) return { visible: true, line: null };
  if (me.local_owner) return { visible: false, line: 'His preferences are not shown here: ~/.dreamcontext/me/me.json names no email yet (add his once: {"emails": ["<his email>"]}).' };
  return { visible: false, line: 'His preferences are not shown here: this vault\'s active person shares no email with ~/.dreamcontext/me/me.json.' };
}

// ─── Every store an id can live in (C1) ─────────────────────────────────────

/** Every member store on this Mac a caller in `contextRoot` can reach: global members, this vault's project members. */
export function memberStoreRefs(contextRoot: string | null, home: string = homedir()): MemberStoreRef[] {
  const out: MemberStoreRef[] = [];
  for (const slug of listGlobalAgentSlugs(home)) {
    try { out.push(memberStoreRef({ slug, scope: 'global' }, contextRoot, home)); } catch { /* unsafe slug */ }
  }
  if (contextRoot) {
    let names: string[] = [];
    try { names = readdirSync(join(contextRoot, 'agents')); } catch { names = []; }
    for (const n of names.sort()) {
      const m = /^([a-z0-9][a-z0-9-]*)\.rules\.json$/.exec(n);
      if (!m || !isSafeAutomationSlug(m[1]!)) continue;
      try { out.push(memberStoreRef({ slug: m[1]!, scope: 'project' }, contextRoot, home)); } catch { /* unsafe */ }
    }
  }
  return out;
}

/**
 * The one locator the CLI, the `learned` card route and Telegram build (C1): this project, his
 * personal store (where `personal`), then every member store.
 */
export function visibleStores(contextRoot: string | null, home: string = homedir(), opts: { personal?: boolean } = {}): RuleLocator {
  return {
    refs: () => {
      const refs: StoreRef[] = [];
      if (contextRoot) refs.push(projectStoreRef(contextRoot, home));
      if (opts.personal !== false) refs.push(personalStoreRef(home));
      refs.push(...memberStoreRefs(contextRoot, home));
      return refs;
    },
  };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export interface WeekStat {
  /** Monday of the week (UTC), YYYY-MM-DD. */
  week: string;
  /** Sayings of an already stored rule (`same` events). */
  sayings: number;
  /** Distinct rules said again. */
  rules: number;
  /** Sayings that raised `repeats` (another occasion). */
  repeats: number;
}

function mondayOf(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Per week, newest first, the sayings of an already stored rule (C9's weekly repeat count). */
export function weeklySayings(records: readonly RuleRecord[], now: Date = new Date(), weeks = 4): WeekStat[] {
  const out = new Map<string, { sayings: number; rules: Set<string>; repeats: number }>();
  for (let i = 0; i < weeks; i++) out.set(mondayOf(now.getTime() - i * 7 * DAY_MS), { sayings: 0, rules: new Set(), repeats: 0 });
  for (const rec of records) {
    const v = deriveRule(rec, now);
    const raising = new Set<string>();
    const seen = new Set(v.sayings.filter((s) => s.creating && s.occasion).map((s) => s.occasion));
    for (const s of v.sayings) {
      if (s.creating) continue;
      if (s.occasion && !seen.has(s.occasion)) { seen.add(s.occasion); raising.add(`${s.at}|${s.turn}`); }
    }
    for (const e of eventsOf(rec)) {
      if (e.op !== 'same') continue;
      const w = out.get(mondayOf(Date.parse(e.at)));
      if (!w) continue;
      w.sayings += 1;
      w.rules.add(rec.id);
      if ((e.quotes ?? []).some((q) => raising.has(`${e.at}|${q.turn}`))) w.repeats += 1;
    }
  }
  return [...out.entries()].map(([week, w]) => ({ week, sayings: w.sayings, rules: w.rules.size, repeats: w.repeats }));
}
