/**
 * `dreamcontext learn` (learning loop C1): one verb on every surface.
 *
 * It decides nothing that needs judgement. The agent says the scope, same-or-new and his words;
 * `learn` verifies (gate G1 against the owner-words ledger), stores the rule as an event history
 * (src/lib/rules-store.ts), and prints the one line the agent repeats to him.
 *
 *   line 1  LEARNED <id> <status> <scope>
 *   line 2  his line, in Turkish, no command in it (repeat it verbatim)
 *
 * Idempotency, one rule for every caller: the same cited turns with the same text return the
 * first receipt; a call whose quotes all resolve to turns an existing record already cites, and
 * whose text clears the twin bar against it, IS that record (a retry, a forwarded line, a sleep run
 * repeated after a failure); a different text citing the same turn is a new record.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readGitIdentity } from '../../lib/git-sync/git.js';
import { isAgentSession } from '../../lib/owner-guard-cli.js';
import {
  conversationKeysFromEnv,
  findQuoteTurn,
  occasion,
  readOwnerTurns,
  OWNER_WORDS_MAX_AGE_DAYS,
  type OwnerTurnLine,
} from '../../lib/owner-words.js';
import { resolveActivePerson } from '../../lib/people-resolve.js';
import { tokenize } from '../../lib/recall.js';
import { detectRememberIntent } from '../../lib/remember-intent.js';
import {
  AT_TAGS,
  RulesStoreError,
  TEXT_LIMITS,
  containedVaultFile,
  deriveAll,
  deriveRule,
  dropRule,
  editRule,
  ensureMeFile,
  findRecord,
  foldText,
  headlineFrom,
  keepRule,
  moveRule,
  newEventId,
  newRuleId,
  oneLine,
  personalRulesVisible,
  personalStoreRef,
  projectStoreRef,
  readStore,
  serializeStore,
  supersedeFlags,
  undoRule,
  validateRuleText,
  weeklySayings,
  applyStatusOp,
  eventsOf,
  withStore,
  type Actor,
  type AtTag,
  type RuleBy,
  type RuleEdit,
  type RuleEvent,
  type RuleQuote,
  type RuleRecord,
  type RuleScope,
  type RuleStatus,
  type RuleSupersedes,
  type RuleView,
  type StatusChange,
  type StoreRef,
} from '../../lib/rules-store.js';
import { redactSecrets } from '../../lib/telegram/format.js';
import { inspectSleepLock, type SleepState } from '../../lib/sleep-consolidation.js';

// ─── Context ────────────────────────────────────────────────────────────────

export interface LearnContext {
  /** The vault's `_dream_context`, or null outside one. */
  contextRoot: string | null;
  home: string;
  env: NodeJS.ProcessEnv;
  now: Date;
  /** The ledger (tests inject it); read from `home` when absent. */
  turns?: OwnerTurnLine[];
  /** git `user.email` for a first personal store; read from git when undefined. */
  gitEmail?: string | null;
  /** `--scope member`: delegate to `automations learn <slug> --lesson`. */
  delegateMember?: (slug: string, lesson: string) => number;
}

export interface LearnOutcome {
  code: 0 | 1;
  lines: string[];
  id?: string;
  status?: RuleStatus;
  scope?: RuleScope | 'member';
}

export interface LearnFlags {
  scope?: string;
  quote?: string[];
  headline?: string;
  says?: string;
  at?: string;
  same?: string;
  replaces?: string;
  new?: boolean;
  supersedes?: string[];
  doc?: string;
  member?: string;
  by?: string;
  when?: string;
}

/** A near-twin: this share of the smaller rule's content terms, and at least two terms, in common. */
export const TWIN_BAR = 0.6;
const TWIN_MIN_SHARED = 2;


function refuse(...lines: string[]): LearnOutcome {
  return { code: 1, lines: lines.map((l, i) => (i === 0 ? `REFUSED: ${l}` : l)) };
}

function actorOf(ctx: LearnContext, by?: RuleBy): Actor {
  const keys = conversationKeysFromEnv(ctx.env);
  return {
    by: by ?? (isAgentSession(ctx.env) ? 'agent' : 'owner'),
    conversation: keys[0] ?? '',
    now: ctx.now,
  };
}

function ledger(ctx: LearnContext): OwnerTurnLine[] {
  if (ctx.turns) return ctx.turns;
  const since = new Date(ctx.now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return readOwnerTurns({ home: ctx.home, since });
}

function storeRef(ctx: LearnContext, scope: RuleScope): StoreRef {
  if (scope === 'me') return personalStoreRef(ctx.home);
  if (!ctx.contextRoot) throw new RulesStoreError('scope project needs a vault: run it inside a project with _dream_context/', 'refused');
  return projectStoreRef(ctx.contextRoot, ctx.home);
}

// ─── The owner's line ───────────────────────────────────────────────────────

/** Line 2 of the receipt: his language, no command in it. */
export function ownerLine(v: RuleView, replacedHeadline?: string): string {
  switch (v.status) {
    case 'active': {
      const where = v.scope === 'me' ? 'senin tercihlerin, her projede' : 'bu projenin kuralları';
      const old = replacedHeadline ? ` · eskisi saklandı: "${replacedHeadline}"` : '';
      return `Kaydedildi: "${v.headline}" · ${where}${old} · yanlışsa "geri al" de`;
    }
    case 'proposed':
      return `Önerildi: "${v.headline}" · onaylarsan geçerli olur`;
    case 'undone':
      return `Geri alınmış bir kural: "${v.headline}" · sözün eklendi, kural kapalı kalıyor`;
    case 'superseded':
      return `Bu kuralın yerine yenisi geçmişti: "${v.headline}"`;
    default:
      return `Kaydedilemedi: "${v.headline}" · kural geçersiz`;
  }
}

function receipt(_ctx: LearnContext, v: RuleView, opts: { replaced?: string; notice?: string | null } = {}): LearnOutcome {
  // Line 2 is repeated verbatim on Telegram and in a terminal; in the app's chat the agent pastes the
  // `learned` card instead (C9), which reads the record by the id on line 1.
  const lines = [`LEARNED ${v.id} ${v.status} ${v.scope}`, ownerLine(v, opts.replaced)];
  if (opts.notice) lines.push(opts.notice);
  return { code: 0, lines, id: v.id, status: v.status, scope: v.scope };
}

// ─── Twins ──────────────────────────────────────────────────────────────────

function termSet(...parts: string[]): Set<string> {
  return new Set(tokenize(parts.join(' ')));
}

/** How much of the smaller rule the two share (0..1); 0 under {@link TWIN_MIN_SHARED} shared terms. */
export function twinScore(headline: string, text: string, v: RuleView): number {
  const a = termSet(headline, text);
  const b = termSet(v.headline, v.text, ...v.says);
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  if (shared < TWIN_MIN_SHARED) return 0;
  return shared / Math.min(a.size, b.size);
}

// ─── `--supersedes` excerpts ────────────────────────────────────────────────

function supersedesEntry(contextRoot: string, arg: string, ruleText: string): RuleSupersedes {
  const sepAt = arg.indexOf('::');
  const path = sepAt >= 0 ? arg.slice(0, sepAt) : arg;
  const given = sepAt >= 0 ? oneLine(arg.slice(sepAt + 2)) : '';
  const { abs, rel } = containedVaultFile(contextRoot, path);
  const body = readFileSync(abs, 'utf-8');
  if (given) {
    if (!body.replace(/\s+/g, ' ').toLowerCase().includes(given.toLowerCase())) {
      throw new RulesStoreError(`${path} does not contain "${given}"`, 'refused');
    }
    return { path: rel, excerpt: given.slice(0, TEXT_LIMITS.quote) };
  }
  // No excerpt named: the line that shares the most terms with the rule.
  const want = termSet(ruleText);
  let best = '';
  let bestShared = 0;
  for (const line of body.split('\n')) {
    const t = oneLine(line);
    if (!t) continue;
    let shared = 0;
    for (const term of new Set(tokenize(t))) if (want.has(term)) shared += 1;
    if (shared > bestShared) { best = t; bestShared = shared; }
  }
  if (!best) throw new RulesStoreError(`nothing in ${path} reads like this rule: name the text with ${path}::"<excerpt>"`, 'refused');
  return { path: rel, excerpt: best.slice(0, TEXT_LIMITS.quote) };
}

// ─── learn "<text>" ─────────────────────────────────────────────────────────

function cleanQuote(q: string): string {
  return redactSecrets(oneLine(q)).slice(0, TEXT_LIMITS.quote);
}

export function learn(rawText: string, flags: LearnFlags, ctx: LearnContext): LearnOutcome {
  const scope = flags.scope;
  if (scope !== 'me' && scope !== 'project' && scope !== 'member') {
    return refuse('--scope must be me, project or member');
  }
  const text = oneLine(rawText ?? '');
  if (!text) return refuse('the rule text is empty');

  if (scope === 'member') {
    if (!flags.member) return refuse('--scope member needs --member <slug>');
    const run = ctx.delegateMember ?? defaultDelegateMember;
    const code = run(flags.member, text);
    return { code: code === 0 ? 0 : 1, lines: [], scope: 'member' };
  }

  const pinned = [flags.same, flags.replaces, flags.new ? 'new' : undefined].filter(Boolean);
  if (pinned.length > 1) return refuse('pass only one of --same, --replaces, --new');
  if (flags.by !== undefined && flags.by !== 'sleep') return refuse('--by takes only "sleep"');
  const atTag = flags.at as AtTag | undefined;
  if (atTag !== undefined && !AT_TAGS.includes(atTag)) return refuse(`--at must be one of ${AT_TAGS.join(', ')}`);

  const headline = flags.headline !== undefined ? oneLine(flags.headline) : headlineFrom(text);
  const says = flags.says ? flags.says.split('|').map(oneLine).filter(Boolean) : undefined;
  const when = flags.when !== undefined ? oneLine(flags.when) : undefined;
  const bad = validateRuleText({ headline, text, says, when });
  if (bad) return refuse(bad);

  const rawQuotes = (flags.quote ?? []).map(oneLine).filter(Boolean);
  if (rawQuotes.length === 0) return refuse('--quote "<his words>" is required: a rule cites what he said');

  const bySleep = flags.by === 'sleep';
  if (bySleep && !sleepInProgress(ctx)) {
    return refuse('--by sleep is for a sleep run: no sleep is in progress in this vault (`dreamcontext sleep start` holds it)');
  }
  const actor = actorOf(ctx, bySleep ? 'sleep' : undefined);
  const keys = conversationKeysFromEnv(ctx.env);

  let supersedes: RuleSupersedes[] | undefined;
  let doc: string | undefined;
  try {
    if ((flags.supersedes ?? []).length > 0 || flags.doc) {
      if (!ctx.contextRoot) return refuse('--supersedes and --doc name files in a vault: run inside one');
      supersedes = (flags.supersedes ?? []).map((s) => supersedesEntry(ctx.contextRoot!, s, `${headline} ${text}`));
      if (flags.doc) doc = containedVaultFile(ctx.contextRoot, flags.doc).rel;
    }
  } catch (e) {
    return refuse((e as Error).message);
  }

  if (scope === 'me') {
    const email = ctx.gitEmail !== undefined ? ctx.gitEmail
      : readGitIdentity(ctx.contextRoot ? dirname(ctx.contextRoot) : process.cwd()).email;
    if (!ensureMeFile(ctx.home, email)) {
      return refuse('there is no personal store: no ~/.dreamcontext/me/me.json and no git user.email on this Mac');
    }
  }

  // G1: where each quote was typed.
  let turns = ledger(ctx);
  if (bySleep && ctx.contextRoot) {
    const vault = dirname(ctx.contextRoot);
    turns = turns.filter((t) => !t.vault || t.vault === vault || sameRealPath(t.vault, vault));
  }
  const cache = new Map<string, string[]>();
  /**
   * Resolve every quote to its ledger turn and run the gate. `prefer`: turns to look past first
   * (`--same` cites a turn its rule does not cite yet, so saying it again in the same words counts).
   */
  const resolveQuotes = (prefer: ReadonlySet<string> = new Set<string>()) => {
    const fresh = prefer.size > 0 ? turns.filter((t) => !prefer.has(t.turn)) : turns;
    const used = new Set<string>();
    const resolved = rawQuotes.map((q) => {
      // Two quotes of one call name two turns when they can (his two sayings of one rule).
      const pools = [fresh.filter((t) => !used.has(t.turn)), fresh, turns];
      let hit = findQuoteTurn(q, pools[0]!, bySleep ? [] : keys, cache);
      for (const pool of pools.slice(1)) { if (hit.turn) break; hit = findQuoteTurn(q, pool, bySleep ? [] : keys, cache); }
      if (hit.turn) used.add(hit.turn.turn);
      return { q, ...hit };
    });
    const quotes: RuleQuote[] = resolved.map((r) => ({
      text: cleanQuote(r.q),
      turn: r.turn?.turn ?? '',
      via: r.turn?.via ?? '',
      occasion: r.turn ? occasion(r.turn) : '',
    }));
    const allResolved = resolved.every((r) => r.turn !== null);
    let gate: 'active' | 'proposed';
    if (bySleep) {
      const occasions = new Set(resolved.map((r) => (r.turn ? occasion(r.turn) : '')).filter(Boolean));
      const explicit = resolved.some((r) => r.turn && detectRememberIntent(r.turn.own));
      gate = allResolved && (occasions.size >= 2 || explicit) ? 'active' : 'proposed';
    } else {
      gate = keys.length > 0 && resolved.every((r) => r.here) ? 'active' : 'proposed';
    }
    const cited = [...new Set(quotes.map((q) => q.turn).filter(Boolean))];
    return { quotes, allResolved, gate, cited };
  };
  const base = resolveQuotes();

  let ref: StoreRef;
  try { ref = storeRef(ctx, scope); } catch (e) { return refuse((e as Error).message); }
  let person = '';
  if (ctx.contextRoot) { try { person = resolveActivePerson(ctx.contextRoot).slug ?? ''; } catch { person = ''; } }

  type Out = { outcome?: LearnOutcome; view?: RuleView; replaced?: string };
  let done: { result: Out; notice: string | null };
  try {
    done = withStore<Out>(ref, (store) => {
      const views = store.rules.map((r) => ({ rec: r, v: deriveRule(r, ctx.now) }));
      const sameTarget = flags.same ? findRecord(store, flags.same) : undefined;
      const { quotes, allResolved, gate, cited } = sameTarget
        ? resolveQuotes(new Set(deriveRule(sameTarget, ctx.now).cited_turns))
        : base;
      const stamp = (): Pick<RuleEvent, 'eid' | 'at' | 'by' | 'conversation'> => ({
        eid: newEventId(), at: ctx.now.toISOString(), by: actor.by, conversation: actor.conversation,
      });
      const noop = (v: RuleView): { result: Out; changed: boolean } => ({ result: { view: v }, changed: false });

      // D5d: a sleep run never learns again from sayings he undid.
      if (bySleep && cited.length > 0) {
        const held = views.find(({ v }) => v.status === 'undone' && !v.moved_to && cited.some((t) => v.cited_turns.includes(t)));
        if (held) return { result: { outcome: refuse(`he undid ${held.v.id} ("${held.v.headline}"), which cites the same words`) }, changed: false };
      }

      // (1) The same cited turns with the same text: the first receipt.
      const sameText = (v: RuleView, rec: RuleRecord): boolean => {
        const first = eventsOf(rec).find((e) => e.op === 'create' || e.op === 'replace');
        return foldText(v.text) === foldText(text) || (!!first?.text && foldText(first.text) === foldText(text));
      };
      for (const { rec, v } of views) {
        if (v.moved_to) continue;
        const creatingTurns = [...new Set(v.sayings.filter((s) => s.creating && s.turn).map((s) => s.turn))];
        const sameTurns = cited.length > 0
          ? creatingTurns.length === cited.length && cited.every((t) => creatingTurns.includes(t))
          : creatingTurns.length === 0;
        if (sameTurns && sameText(v, rec)) {
          if (v.status === 'undone') return { result: { outcome: refuse(`he undid ${v.id} ("${v.headline}")`) }, changed: false };
          if (v.status === 'proposed' && gate === 'active') {
            rec.events.push({ ...stamp(), op: 'same', status: 'active', quotes });
            return { result: { view: deriveRule(rec, ctx.now) }, changed: true };
          }
          return noop(v);
        }
      }

      // (2) Every quote resolves to turns an existing record already cites, and the text is its twin: it IS that record.
      if (allResolved && cited.length > 0) {
        for (const { rec, v } of views) {
          if (v.moved_to) continue;
          if (!cited.every((t) => v.cited_turns.includes(t))) continue;
          if (twinScore(headline, text, v) < TWIN_BAR) continue;
          if (v.status === 'undone') return { result: { outcome: refuse(`he undid ${v.id} ("${v.headline}"), which cites the same words`) }, changed: false };
          if (v.status === 'proposed' && gate === 'active') {
            rec.events.push({ ...stamp(), op: 'same', status: 'active', quotes });
            return { result: { view: deriveRule(rec, ctx.now) }, changed: true };
          }
          return noop(v);
        }
      }

      if (flags.same) {
        const rec = findRecord(store, flags.same);
        if (!rec) return { result: { outcome: refuse(`no rule ${flags.same} in the ${scope} store`) }, changed: false };
        const target = deriveRule(rec, ctx.now);
        if (target.moved_to) return { result: { outcome: refuse(`${rec.id} moved to the ${target.moved_to} store`) }, changed: false };
        // Every quote already one of its sayings: a retry, nothing new.
        if (allResolved && cited.every((t) => target.cited_turns.includes(t))) return noop(target);
        rec.events.push({ ...stamp(), op: 'same', status: gate, quotes });
        return { result: { view: deriveRule(rec, ctx.now) }, changed: true };
      }

      const create = (op: 'create' | 'replace', refId?: string): RuleRecord => ({
        id: newRuleId(),
        scope,
        created: { at: ctx.now.toISOString(), by: actor.by, person },
        events: [{
          ...stamp(),
          op,
          status: gate,
          headline,
          text,
          ...(says ? { says } : {}),
          ...(when ? { when } : {}),
          ...(atTag ? { at_tag: atTag } : {}),
          ...(doc ? { doc } : {}),
          ...(supersedes && supersedes.length ? { supersedes } : {}),
          quotes,
          ...(refId ? { ref: refId } : {}),
        }],
      });

      if (flags.replaces) {
        const old = findRecord(store, flags.replaces);
        if (!old) return { result: { outcome: refuse(`no rule ${flags.replaces} in the ${scope} store`) }, changed: false };
        const ov = deriveRule(old, ctx.now);
        const rec = create('replace', old.id);
        // The one place that decides status (rules-store applyStatusOp): it refuses a rule already
        // replaced or moved, and a later undo gives the old rule back the status it had, never more.
        const step = applyStatusOp(store, old.id, 'supersede', actor, { ref: rec.id, scope });
        if (!step.ok) return { result: { outcome: refuse(step.reason) }, changed: false };
        store.rules.push(rec);
        return { result: { view: deriveRule(rec, ctx.now), replaced: ov.headline }, changed: true };
      }

      if (!flags.new) {
        const twins = views
          .filter(({ v }) => (v.status === 'active' || v.status === 'proposed') && twinScore(headline, text, v) >= TWIN_BAR)
          .map(({ v }) => v);
        if (twins.length > 0) {
          return {
            result: {
              outcome: refuse(
                'this reads like a rule already stored. Answer with one of: --same <id> (he said it again), --replaces <id> (his new word replaces it), --new (a different rule).',
                ...twins.map((v) => `  ${v.id}  ${v.status}  "${v.headline}"`),
              ),
            },
            changed: false,
          };
        }
      }

      const rec = create('create');
      store.rules.push(rec);
      return { result: { view: deriveRule(rec, ctx.now) }, changed: true };
    }, { now: ctx.now });
  } catch (e) {
    return storeFailure(e);
  }

  if (done.result.outcome) return done.result.outcome;
  return receipt(ctx, done.result.view!, { replaced: done.result.replaced, notice: done.notice });
}

/**
 * True while a sleep holds this vault's consolidation lock (`sleep start` stamps
 * `state/.sleep.json` `sleep_started_at`, `sleep done` clears it), and the lock is not stale.
 */
export function sleepInProgress(ctx: Pick<LearnContext, 'contextRoot' | 'now'>): boolean {
  if (!ctx.contextRoot) return false;
  const file = join(ctx.contextRoot, 'state', '.sleep.json');
  try {
    if (lstatSync(file).isSymbolicLink()) return false;
    const state = JSON.parse(readFileSync(file, 'utf-8')) as Partial<SleepState>;
    const lock = inspectSleepLock({ sleep_started_at: state.sleep_started_at ?? null } as SleepState, ctx.now.getTime());
    return lock.locked && !lock.stale;
  } catch { return false; }
}

function sameRealPath(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

function storeFailure(e: unknown): LearnOutcome {
  if (e instanceof RulesStoreError && e.code === 'unreadable') {
    return refuse(`${e.message}. Nothing was written; the last good copy is the store's .bak file.`, 'store unreadable');
  }
  return refuse((e as Error).message);
}

function defaultDelegateMember(slug: string, lesson: string): number {
  const res = spawnSync(process.execPath, [process.argv[1]!, 'automations', 'learn', slug, '--lesson', lesson], { stdio: 'inherit' });
  return res.status ?? 1;
}

// ─── Finding a rule by id ───────────────────────────────────────────────────

function refsOf(ctx: LearnContext): StoreRef[] {
  const refs: StoreRef[] = [];
  if (ctx.contextRoot) refs.push(projectStoreRef(ctx.contextRoot, ctx.home));
  refs.push(personalStoreRef(ctx.home));
  return refs;
}

export function locateRule(ctx: LearnContext, id: string): { ref: StoreRef; view: RuleView } | null {
  for (const ref of refsOf(ctx)) {
    const store = readStore(ref);
    const rec = findRecord(store, id);
    if (rec) {
      const view = deriveRule(rec, ctx.now);
      if (view.moved_to) continue;
      return { ref, view };
    }
  }
  return null;
}

// ─── undo / keep / drop / edit ──────────────────────────────────────────────

/** What the undo receipt says about the rule it gave back: the status it really has now. */
function restoredLine(v: RuleView | undefined): string {
  if (!v) return '';
  if (v.status === 'active') return ` · eskisi yeniden geçerli: "${v.headline}"`;
  if (v.status === 'proposed') return ` · eskisi yine onayını bekliyor: "${v.headline}"`;
  return '';
}

export function learnUndo(id: string, ctx: LearnContext): LearnOutcome {
  try {
    const found = locateRule(ctx, id);
    if (!found) return refuse(`no rule ${id}`);
    const r = undoRule(found.ref, id, actorOf(ctx));
    if (!r.ok) return refuse(r.reason);
    const lines = [`UNDONE ${id} ${found.ref.scope}`, `Geri alındı: "${r.rule.headline}"${restoredLine(r.restored)}`];
    if (r.notice) lines.push(r.notice);
    return { code: 0, lines, id, status: r.rule.status, scope: found.ref.scope };
  } catch (e) { return storeFailure(e); }
}

/** His word to keep a waiting rule ("tut", "kalsın", "keep it"). */
const KEEP_WORD = /(?<![a-zçğıöşü])(tut|tutalım|tutalim|kalsın|kalsin|onayla|onaylıyorum|onayliyorum|geçerli olsun|gecerli olsun)(?![a-zçğıöşü])|\bkeep (it|this|that|them)\b|^\s*keep\b/iu;
/** His word to drop one ("at", "istemiyorum", "drop it"). */
const DROP_WORD = /(?<![a-zçğıöşü])(at|atalım|atalim|sil|kaldır|kaldir|istemiyorum|gerek yok|olmasın|olmasin)(?![a-zçğıöşü])|\bdrop (it|this|that|them)\b|\b(don't|do not) keep\b|^\s*drop\b/iu;

/**
 * Whether an agent may run keep or drop for `v`: his word about THAT rule. The `--quote` must pass
 * G1 in this conversation, on a turn written after the rule, and that turn's own text must carry
 * the keep (or drop) word AND name the rule: its id, or two content terms of its headline (all of
 * them when it has fewer). An everyday "kısa tut" in another turn is not his word about a rule.
 * Returns the refusal, or null. His own shell and the card's route never come here.
 */
export function hisWordAbout(v: RuleView, quote: string | undefined, word: RegExp, ctx: LearnContext): string | null {
  const ask = word === KEEP_WORD ? 'keep' : 'drop';
  const how = `${ask} needs his word about this rule: --quote "<his words>" from this chat, where he says ${ask === 'keep' ? '"tut"' : '"at"'} and names it (its id or its headline's words), or the card's button, or this command from his own shell`;
  const q = oneLine(quote ?? '');
  if (!q) return how;
  const keys = conversationKeysFromEnv(ctx.env);
  if (keys.length === 0) return how;
  const since = Date.parse(v.created.at);
  const turns = ledger(ctx).filter((t) => Date.parse(t.at) >= since);
  const hit = findQuoteTurn(q, turns, keys);
  if (!hit.turn || !hit.here) return how;
  const own = hit.turn.own;
  if (!word.test(own)) return how;
  const named = own.toLowerCase().includes(v.id) || (() => {
    const head = [...new Set(tokenize(v.headline))];
    const said = new Set(tokenize(own));
    const need = Math.min(2, head.length);
    return need > 0 && head.filter((t) => said.has(t)).length >= need;
  })();
  return named ? null : how;
}

/** Keep: from his own shell, or from an agent with {@link hisWordAbout}. The card's route calls `keepRule` itself (W2). */
export function learnKeep(id: string, ctx: LearnContext, quote?: string): LearnOutcome {
  try {
    const found = locateRule(ctx, id);
    if (!found) return refuse(`no rule ${id}`);
    if (isAgentSession(ctx.env)) {
      const why = hisWordAbout(found.view, quote, KEEP_WORD, ctx);
      if (why) return refuse(why);
    }
    const r = keepRule(found.ref, id, actorOf(ctx));
    if (!r.ok) return refuse(r.reason);
    return receipt(ctx, r.rule, { notice: r.notice });
  } catch (e) { return storeFailure(e); }
}

/** Drop: the same gate as keep, with his drop word. */
export function learnDrop(id: string, ctx: LearnContext, quote?: string): LearnOutcome {
  try {
    const found = locateRule(ctx, id);
    if (!found) return refuse(`no rule ${id}`);
    if (isAgentSession(ctx.env)) {
      const why = hisWordAbout(found.view, quote, DROP_WORD, ctx);
      if (why) return refuse(why);
    }
    const r = dropRule(found.ref, id, actorOf(ctx));
    if (!r.ok) return refuse(r.reason);
    const lines = [`DROPPED ${id} ${found.ref.scope}`, `Atıldı: "${r.rule.headline}"`];
    if (r.notice) lines.push(r.notice);
    return { code: 0, lines, id, status: r.rule.status, scope: found.ref.scope };
  } catch (e) { return storeFailure(e); }
}

export interface EditFlags { headline?: string; text?: string; says?: string; at?: string; doc?: string; when?: string; scope?: string }

export function learnEdit(id: string, flags: EditFlags, ctx: LearnContext): LearnOutcome {
  try {
    const found = locateRule(ctx, id);
    if (!found) return refuse(`no rule ${id}`);
    if (flags.at !== undefined && !AT_TAGS.includes(flags.at as AtTag)) return refuse(`--at must be one of ${AT_TAGS.join(', ')}`);
    const edit: RuleEdit = {
      headline: flags.headline !== undefined ? oneLine(flags.headline) : undefined,
      text: flags.text !== undefined ? oneLine(flags.text) : undefined,
      says: flags.says !== undefined ? flags.says.split('|').map(oneLine).filter(Boolean) : undefined,
      when: flags.when !== undefined ? oneLine(flags.when) : undefined,
      at_tag: flags.at as AtTag | undefined,
      doc: flags.doc !== undefined ? (ctx.contextRoot ? containedVaultFile(ctx.contextRoot, flags.doc).rel : undefined) : undefined,
    };
    if (flags.doc !== undefined && !ctx.contextRoot) return refuse('--doc names a file in a vault: run inside one');
    const actor = actorOf(ctx);
    let r: StatusChange;
    if (flags.scope !== undefined && flags.scope !== found.ref.scope) {
      if (flags.scope !== 'me' && flags.scope !== 'project') return refuse('--scope must be me or project');
      if (flags.scope === 'me') {
        const email = ctx.gitEmail !== undefined ? ctx.gitEmail : readGitIdentity(ctx.contextRoot ? dirname(ctx.contextRoot) : process.cwd()).email;
        if (!ensureMeFile(ctx.home, email)) return refuse('there is no personal store: no ~/.dreamcontext/me/me.json and no git user.email');
      }
      r = moveRule(found.ref, storeRef(ctx, flags.scope), id, edit, actor);
    } else {
      r = editRule(found.ref, id, edit, actor);
    }
    if (!r.ok) return refuse(r.reason);
    return receipt(ctx, r.rule, { notice: r.notice });
  } catch (e) { return storeFailure(e); }
}

// ─── list / show / stats / import / export ──────────────────────────────────

function describe(v: RuleView, contextRoot: string | null): string[] {
  const meta = [`by ${v.created.by}`];
  if (v.at_tag) meta.push(`at ${v.at_tag}`);
  if (v.repeats > 0) meta.push(`repeated ${v.repeats}`);
  if (v.hot) meta.push('hot');
  if (v.escalate) meta.push('said again while hot: offer a check');
  if (v.status === 'superseded') meta.push(`replaced by ${v.superseded_by}`);
  if (v.status === 'undone') meta.push(v.dropped ? `dropped by ${v.status_by}` : `undone by ${v.status_by}`);
  if (v.status === 'invalid') meta.push(`invalid: ${v.invalid_reason}`);
  const lines = [`  ${v.id}  ${v.status.padEnd(10)} "${v.headline}"  (${meta.join(' · ')})`];
  for (const f of supersedeFlags(contextRoot, v)) {
    if (f.still) lines.push(`      old text still says the opposite: ${f.path}: "${f.excerpt}"`);
  }
  return lines;
}

export function learnList(ctx: LearnContext, opts: { me?: boolean; project?: boolean; all?: boolean } = {}): { lines: string[]; rules: RuleView[] } {
  const showMe = opts.me || !opts.project;
  const showProject = (opts.project || !opts.me) && !!ctx.contextRoot;
  const lines: string[] = [];
  const all: RuleView[] = [];
  const section = (title: string, ref: StoreRef): void => {
    let views: RuleView[];
    try { views = deriveAll(readStore(ref), ctx.now); } catch (e) { lines.push(`${title}: store unreadable (${(e as Error).message})`); return; }
    views = views.filter((v) => !v.moved_to);
    if (!opts.all) views = views.filter((v) => v.status === 'active' || v.status === 'proposed' || v.status === 'invalid');
    all.push(...views);
    lines.push(`${title} (${views.length})`);
    for (const v of views) lines.push(...describe(v, ctx.contextRoot));
  };
  if (showMe) {
    section('His preferences, every project', personalStoreRef(ctx.home));
    if (ctx.contextRoot) {
      const vis = personalRulesVisible(ctx.contextRoot, ctx.home);
      if (vis.line) lines.push(`  ${vis.line}`);
    }
  }
  if (showProject) section('This project\'s rules', projectStoreRef(ctx.contextRoot!, ctx.home));
  return { lines, rules: all };
}

export function learnStats(ctx: LearnContext, weeks = 4): { lines: string[]; weeks: ReturnType<typeof weeklySayings> } {
  const records: RuleRecord[] = [];
  for (const ref of refsOf(ctx)) {
    try { records.push(...readStore(ref).rules); } catch { /* an unreadable store is reported by list */ }
  }
  const stats = weeklySayings(records, ctx.now, weeks);
  const lines = stats.map((w) => `week of ${w.week}: ${w.sayings} sayings of a stored rule (${w.rules} rules), ${w.repeats} on another occasion`);
  lines.push('Delivered before it was said again: not measurable (no delivery ledger on this base).');
  return { lines, weeks: stats };
}

interface ImportItem { scope?: string; headline?: string; text?: string; quote?: string; says?: string[] | string; at?: string; ticked?: boolean }

/** D11's list: lines already in force come pre-ticked (active), the rest wait as proposed. `by: migration`. */
export function learnImport(items: ImportItem[], ctx: LearnContext): LearnOutcome {
  const lines: string[] = [];
  let failed = false;
  for (const [i, item] of items.entries()) {
    const scope = item.scope === 'me' || item.scope === 'project' ? item.scope : null;
    const text = oneLine(item.text ?? '');
    if (!scope || !text) { lines.push(`  item ${i + 1}: skipped (needs scope me|project and text)`); failed = true; continue; }
    const headline = item.headline ? oneLine(item.headline) : headlineFrom(text);
    const says = Array.isArray(item.says) ? item.says.map(oneLine).filter(Boolean) : typeof item.says === 'string' ? item.says.split('|').map(oneLine).filter(Boolean) : undefined;
    const atTag = item.at && AT_TAGS.includes(item.at as AtTag) ? (item.at as AtTag) : undefined;
    const bad = validateRuleText({ headline, text, says });
    if (bad) { lines.push(`  item ${i + 1}: skipped (${bad})`); failed = true; continue; }
    try {
      if (scope === 'me') {
        const email = ctx.gitEmail !== undefined ? ctx.gitEmail : readGitIdentity(ctx.contextRoot ? dirname(ctx.contextRoot) : process.cwd()).email;
        if (!ensureMeFile(ctx.home, email)) { lines.push(`  item ${i + 1}: skipped (no personal store)`); failed = true; continue; }
      }
      const ref = storeRef(ctx, scope);
      const { result } = withStore<string>(ref, (store) => {
        const have = deriveAll(store, ctx.now).find((v) => foldText(v.text) === foldText(text) && !v.moved_to);
        if (have) return { result: `  ${have.id}  already stored  "${have.headline}"`, changed: false };
        const id = newRuleId();
        store.rules.push({
          id,
          scope,
          created: { at: ctx.now.toISOString(), by: 'migration', person: '' },
          events: [{
            eid: newEventId(), at: ctx.now.toISOString(), op: 'create', by: 'migration', conversation: '',
            status: item.ticked ? 'active' : 'proposed', headline, text,
            ...(says ? { says } : {}), ...(atTag ? { at_tag: atTag } : {}),
            quotes: item.quote ? [{ text: cleanQuote(item.quote), turn: '', via: '', occasion: '' }] : [],
          }],
        });
        return { result: `  ${id}  ${item.ticked ? 'active' : 'proposed'}  "${headline}"`, changed: true };
      }, { now: ctx.now });
      lines.push(result);
    } catch (e) {
      lines.push(`  item ${i + 1}: ${(e as Error).message}`);
      failed = true;
    }
  }
  return { code: failed ? 1 : 0, lines };
}

// ─── Command ────────────────────────────────────────────────────────────────

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function liveContext(): LearnContext {
  let contextRoot: string | null = null;
  try { contextRoot = resolveContextRoot(); } catch { contextRoot = null; }
  return { contextRoot, home: homedir(), env: process.env, now: new Date() };
}

function print(out: LearnOutcome, json?: boolean): void {
  if (json) console.log(JSON.stringify({ ok: out.code === 0, id: out.id ?? null, status: out.status ?? null, scope: out.scope ?? null, lines: out.lines }, null, 2));
  else for (const l of out.lines) (out.code === 0 ? console.log : console.error)(l);
  if (out.code !== 0) process.exitCode = 1;
}

export function registerLearnCommand(program: Command): void {
  const learnCmd = program
    .command('learn')
    .argument('[text]', 'The rule, one line, never stricter than his words')
    .description('Store a rule he stated (his preference, this project\'s rule, or a member\'s lesson) and print the line to repeat to him')
    .option('--scope <scope>', 'me (how to work with him, every project) | project | member')
    .option('--quote <words>', 'His words the rule comes from, copied verbatim (repeatable)', collect, [])
    .option('--headline <text>', 'The rule itself in at most 60 characters')
    .option('--says <phrases>', 'Other ways he says it, in his languages, split by |')
    .option('--at <tag>', `When it applies: ${AT_TAGS.join('|')}`)
    .option('--when <sentence>', 'The situation it is about, one sentence')
    .option('--same <id>', 'He said an existing rule again')
    .option('--replaces <id>', 'His new word replaces an existing rule')
    .option('--new', 'A different rule from the near-twins learn found')
    .option('--supersedes <path>', 'A file whose text says the opposite (path or path::"excerpt"; repeatable)', collect, [])
    .option('--doc <path>', 'A long-form pattern in this vault the rule links to')
    .option('--member <slug>', 'With --scope member: the member whose lesson this is')
    .option('--by <who>', 'sleep (a sleep run proposing from his words)')
    .option('--json', 'Machine-readable receipt')
    .action((text: string | undefined, opts: LearnFlags & { json?: boolean }) => {
      if (!text) { learnCmd.help(); return; }
      print(learn(text, opts, liveContext()), opts.json);
    });

  learnCmd
    .command('list')
    .description('The rules he taught: his preferences and this project\'s rules, with who wrote each')
    .option('--me', 'Only his preferences')
    .option('--project', 'Only this project\'s rules')
    .option('--all', 'Also replaced and undone rules')
    .option('--json', 'Machine-readable')
    .action((opts: { me?: boolean; project?: boolean; all?: boolean; json?: boolean }) => {
      const out = learnList(liveContext(), opts);
      if (opts.json) console.log(JSON.stringify(out.rules, null, 2));
      else for (const l of out.lines) console.log(l);
    });

  learnCmd
    .command('show')
    .argument('<id>', 'Rule id')
    .description('One rule with its history')
    .option('--json', 'Machine-readable')
    .action((id: string, opts: { json?: boolean }) => {
      const ctx = liveContext();
      const found = locateRule(ctx, id);
      if (!found) { console.error(`REFUSED: no rule ${id}`); process.exitCode = 1; return; }
      const v = found.view;
      if (opts.json) { console.log(JSON.stringify(v, null, 2)); return; }
      for (const l of describe(v, ctx.contextRoot)) console.log(l);
      if (v.text !== v.headline) console.log(`  ${v.text}`);
      for (const s of v.sayings) console.log(`    ${s.at.slice(0, 10)}  "${s.text}"  (${s.via || 'no ledger turn'}, by ${s.by})`);
    });

  learnCmd.command('undo').argument('<id>', 'Rule id').description('Undo a rule ("geri al"); the rule it replaced comes back')
    .action((id: string) => print(learnUndo(id, liveContext())));
  learnCmd.command('keep').argument('<id>', 'Rule id').description('Make a waiting rule active (needs his word about it)')
    .option('--quote <words>', 'His words in this chat keeping this rule (an agent must pass them)')
    .action((id: string, opts: { quote?: string }) => print(learnKeep(id, liveContext(), opts.quote)));
  learnCmd.command('drop').argument('<id>', 'Rule id').description('Drop a rule that waits for his word (needs his word about it)')
    .option('--quote <words>', 'His words in this chat dropping this rule (an agent must pass them)')
    .action((id: string, opts: { quote?: string }) => print(learnDrop(id, liveContext(), opts.quote)));

  learnCmd
    .command('edit')
    .argument('<id>', 'Rule id')
    .description('Edit a rule by id (never add a twin); --scope moves it')
    .option('--headline <text>', 'New headline')
    .option('--text <text>', 'New text')
    .option('--says <phrases>', 'New phrases, split by |')
    .option('--at <tag>', `${AT_TAGS.join('|')}`)
    .option('--when <sentence>', 'New situation sentence')
    .option('--doc <path>', 'New linked pattern')
    .option('--scope <scope>', 'Move to me or project')
    .action((id: string, opts: EditFlags) => print(learnEdit(id, opts, liveContext())));

  learnCmd
    .command('import')
    .argument('<file>', 'JSON list: [{scope, text, headline?, quote?, says?, at?, ticked?}]')
    .description('Import his approved list (ticked lines active, the rest proposed; by migration)')
    .action((file: string) => {
      let items: ImportItem[];
      try {
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
        items = Array.isArray(raw) ? raw as ImportItem[] : ((raw as { rules?: ImportItem[] }).rules ?? []);
      } catch (e) { console.error(`REFUSED: ${(e as Error).message}`); process.exitCode = 1; return; }
      print(learnImport(items, liveContext()));
    });

  learnCmd
    .command('export')
    .description('Print a store as JSON (to carry his preferences to another Mac)')
    .option('--me', 'His preferences (default)')
    .option('--project', 'This project\'s rules')
    .action((opts: { me?: boolean; project?: boolean }) => {
      const ctx = liveContext();
      try {
        const ref = opts.project ? storeRef(ctx, 'project') : personalStoreRef(ctx.home);
        process.stdout.write(serializeStore(readStore(ref)));
      } catch (e) { console.error(`REFUSED: ${(e as Error).message}`); process.exitCode = 1; }
    });

  learnCmd
    .command('stats')
    .description('Each week\'s sayings of an already stored rule')
    .option('--weeks <n>', 'How many weeks', '4')
    .option('--json', 'Machine-readable')
    .action((opts: { weeks?: string; json?: boolean }) => {
      const n = Math.max(1, Math.min(52, Number.parseInt(opts.weeks ?? '4', 10) || 4));
      const out = learnStats(liveContext(), n);
      if (opts.json) console.log(JSON.stringify(out.weeks, null, 2));
      else for (const l of out.lines) console.log(l);
    });
}
