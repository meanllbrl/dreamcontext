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
 * Three stores (plan global-uye-ogrenme D1): `me` (him, every project), `project` (this product),
 * `member` (how one AI Team member works, every project it works in). In a member's session
 * `--member` defaults to that member, and its process writes only its OWN store (`own_member_only`).
 * An agent only ADDS or NARROWS a member's rules (create, replace, same, keep on his word; undo,
 * supersede): an edit or a move is his, at his own shell or through one `run` card (D2).
 *
 * Idempotency, one rule for every caller: the same cited turns with the same text return the
 * first receipt; a call whose quotes all resolve to turns an existing record already cites, and
 * whose text clears the twin bar against it, IS that record (a retry, a forwarded line, a sleep run
 * repeated after a failure); a different text citing the same turn is a new record.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { resolveContextRoot } from '../../lib/context-path.js';
import { readGitIdentity } from '../../lib/git-sync/git.js';
import { ownerProcess, sessionMember, sessionMemberSlug } from '../../lib/agents/session-member.js';
import { memberScope, globalAgentExists } from '../../lib/agents/scope.js';
import { ensureAgentsGitignore, getAgent } from '../../lib/agents/store.js';
import { isSafeAutomationSlug } from '../../lib/agents/slot.js';
import {
  conversationKeysFromEnv,
  findQuoteTurn,
  readOwnerTurns,
  OWNER_WORDS_MAX_AGE_DAYS,
  type OwnerTurnLine,
} from '../../lib/owner-words.js';
import { resolveOwnerQuotes } from '../../lib/owner-quote.js';
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
  locateIn,
  memberStoreRef,
  memberStoreRefs,
  visibleStores,
  withStore,
  MEMBER_EDIT_REFUSAL,
  type Actor,
  type MemberGate,
  type MemberStoreRef,
  type RuleLocator,
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
import { realPath } from '../../lib/real-path.js';

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
}

export interface LearnOutcome {
  code: 0 | 1;
  lines: string[];
  id?: string;
  status?: RuleStatus;
  scope?: RuleScope;
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

function actorOf(ctx: LearnContext, by?: RuleBy): Actor & { owner: boolean } {
  const keys = conversationKeysFromEnv(ctx.env);
  const owner = ownerProcess(ctx.env);
  return {
    by: by ?? (owner ? 'owner' : 'agent'),
    conversation: keys[0] ?? '',
    now: ctx.now,
    owner,
  };
}

/** The locator every by-id verb reads (C1): this project, his store where shown, every member store. */
function locator(ctx: LearnContext): RuleLocator {
  return visibleStores(ctx.contextRoot, ctx.home);
}

/** The member a `--scope member` call means, or why not. */
function resolveMember(ctx: LearnContext, flag: string | undefined): { slug: string; scope: 'global' | 'project' } | string {
  const slug = (flag ?? '').trim() || sessionMember(ctx.env, ctx.contextRoot, ctx.home)?.slug || '';
  if (!slug) return '--scope member needs --member <slug> (or run it in that member\'s own session)';
  if (!isSafeAutomationSlug(slug)) return `"${slug}" is not a member slug`;
  const scope = ctx.contextRoot ? memberScope(ctx.contextRoot, slug, ctx.home) : (globalAgentExists(slug, ctx.home) ? 'global' : null);
  if (!scope) return `no member "${slug}" here (\`dreamcontext agents list\`)`;
  return { slug, scope };
}

/**
 * One writer per member (D2): a member's process (its chat, Super, child or run) writes only its own
 * store. A session with no member (the main Super, a plain chat, his shell) may write any member's.
 */
export function ownMemberRefusal(ctx: LearnContext, target: string): string | null {
  const self = sessionMemberSlug(ctx.env);
  if (!self || self === target) return null;
  return `own_member_only: this is ${self}'s session; it writes only ${self}'s rules, not ${target}'s. Tell the Super, which can relay it to ${target}.`;
}

/** The gate facts of a member write (C1): who, and whether his words were typed here. */
function gateOf(ctx: LearnContext, quotes: readonly string[], here: boolean, replacedText?: string): MemberGate {
  return { actor: { owner: ownerProcess(ctx.env) }, quote: { text: quotes.join(' '), here }, ...(replacedText !== undefined ? { replacedText } : {}) };
}

function ledger(ctx: LearnContext): OwnerTurnLine[] {
  if (ctx.turns) return ctx.turns;
  const since = new Date(ctx.now.getTime() - OWNER_WORDS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return readOwnerTurns({ home: ctx.home, since });
}

function storeRef(ctx: LearnContext, scope: RuleScope, member?: { slug: string; scope: 'global' | 'project' }): StoreRef {
  if (scope === 'me') return personalStoreRef(ctx.home);
  if (scope === 'member') {
    if (!member) throw new RulesStoreError('scope member needs its member', 'refused');
    return memberStoreRef(member, ctx.contextRoot, ctx.home);
  }
  if (!ctx.contextRoot) throw new RulesStoreError('scope project needs a vault: run it inside a project with _dream_context/', 'refused');
  return projectStoreRef(ctx.contextRoot, ctx.home);
}

// ─── The owner's line ───────────────────────────────────────────────────────

/** Line 2 of the receipt: his language, no command in it. */
export function ownerLine(v: RuleView, replacedHeadline?: string, memberTitle?: string): string {
  switch (v.status) {
    case 'active': {
      const where = v.scope === 'me' ? 'senin tercihlerin, her projede'
        : v.scope === 'member' ? `${memberTitle || v.member || 'üye'}'nın kuralı, her projede`
          : 'bu projenin kuralları';
      if (v.scope === 'member') return `Kaydedildi: "${v.headline}" · ${where}${replacedHeadline ? ` · eskisi saklandı: "${replacedHeadline}"` : ''} · yanlışsa geri al de`;
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

function memberTitleOf(ctx: LearnContext, slug: string | undefined): string {
  if (!slug || !ctx.contextRoot) return slug ?? '';
  try { return getAgent(ctx.contextRoot, slug, ctx.home)?.title || slug; } catch { return slug; }
}

function receipt(ctx: LearnContext, v: RuleView, opts: { replaced?: string; notice?: string | null; extra?: string[] } = {}): LearnOutcome {
  // Line 2 is repeated verbatim on Telegram and in a terminal; in the app's chat the agent pastes the
  // `learned` card instead (C9), which reads the record by the id on line 1.
  const lines = [`LEARNED ${v.id} ${v.status} ${v.scope}`, ownerLine(v, opts.replaced, v.scope === 'member' ? memberTitleOf(ctx, v.member) : undefined)];
  if (opts.notice) lines.push(opts.notice);
  lines.push(...(opts.extra ?? []));
  return { code: 0, lines, id: v.id, status: v.status, scope: v.scope };
}

/**
 * D9: the member's instruction lines (its prompt and soul) that share the most terms with a new
 * rule, as one notice: when his new word changes such a line, the agent amends it in the same turn.
 */
export function instructionLinesNotice(ctx: LearnContext, slug: string, headline: string, text: string): string | null {
  if (!ctx.contextRoot) return null;
  let agent: ReturnType<typeof getAgent> = null;
  try { agent = getAgent(ctx.contextRoot, slug, ctx.home); } catch { agent = null; }
  if (!agent) return null;
  const want = termSet(headline, text);
  const scored: { line: string; field: string; shared: number }[] = [];
  for (const [field, body] of [['prompt', agent.prompt ?? ''], ['soul', agent.soul ?? '']] as const) {
    for (const raw of body.split(/\n|(?<=[.!?])\s+/)) {
      const line = oneLine(raw);
      if (!line) continue;
      let shared = 0;
      for (const t of new Set(tokenize(line))) if ([...want].some((w) => w === t || (w.length >= 4 && t.length >= 4 && w.slice(0, 4) === t.slice(0, 4)))) shared += 1;
      if (shared > 0) scored.push({ line, field, shared });
    }
  }
  if (scored.length === 0) return null;
  const top = Math.max(...scored.map((x) => x.shared));
  const lines = scored.filter((x) => x.shared === top).slice(0, 3);
  return [
    `Your instruction (${lines.map((l) => l.field).join(', ')}) has a line this rule touches:`,
    ...lines.map((l) => `  "${l.line}"`),
    `If his new word changes it, amend that line in this turn on his words: \`dreamcontext agents edit ${slug} --${lines[0]!.field} "<the new text>" --quote "<his words>"\`.`,
  ].join('\n');
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

  let member: { slug: string; scope: 'global' | 'project' } | undefined;
  if (scope === 'member') {
    const m = resolveMember(ctx, flags.member);
    if (typeof m === 'string') return refuse(m);
    const own = ownMemberRefusal(ctx, m.slug);
    if (own) return refuse(own);
    member = m;
  } else if (flags.member) {
    return refuse('--member goes with --scope member');
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
    // D10: never refused for want of an email; a `local_owner` store says how to add his once.
    if (!ensureMeFile(ctx.home, email)) {
      return refuse('~/.dreamcontext/me is a link: the personal store is refused there');
    }
  }

  // G1: where each quote was typed.
  let turns = ledger(ctx);
  if (bySleep && ctx.contextRoot) {
    const vault = dirname(ctx.contextRoot);
    turns = turns.filter((t) => !t.vault || t.vault === vault || sameRealPath(t.vault, vault));
  }
  /**
   * Resolve every quote to its ledger turn (owner-quote.ts, D13) and run the gate. `prefer`: turns
   * to look past first (`--same` cites a turn its rule does not cite yet).
   */
  const resolveQuotes = (prefer: ReadonlySet<string> = new Set<string>()) => {
    const set = resolveOwnerQuotes(rawQuotes, { keys: bySleep ? [] : keys, turns, prefer });
    const quotes: RuleQuote[] = set.quotes.map((r) => ({
      text: cleanQuote(r.text),
      turn: r.turn?.turn ?? '',
      via: r.turn?.via ?? '',
      occasion: r.occasion,
    }));
    let gate: 'active' | 'proposed';
    if (bySleep) {
      const occasions = new Set(set.quotes.map((r) => r.occasion).filter(Boolean));
      const explicit = set.quotes.some((r) => r.turn && detectRememberIntent(r.turn.own));
      gate = set.allResolved && (occasions.size >= 2 || explicit) ? 'active' : 'proposed';
    } else {
      gate = set.allHere ? 'active' : 'proposed';
    }
    const cited = [...new Set(quotes.map((q) => q.turn).filter(Boolean))];
    return { quotes, allResolved: set.allResolved, gate, cited, allHere: set.allHere };
  };
  const base = resolveQuotes();

  let ref: StoreRef;
  try { ref = storeRef(ctx, scope, member); } catch (e) { return refuse((e as Error).message); }
  let person = '';
  if (ctx.contextRoot) { try { person = resolveActivePerson(ctx.contextRoot).slug ?? ''; } catch { person = ''; } }

  // D11: a twin in ANOTHER visible store is refused with its id and scope (never a twin across stores).
  // A `--replaces` may name a rule of another store: it is read there first (gate (a) reads its text).
  let crossReplace: { ref: StoreRef; view: RuleView } | null = null;
  try {
    const others = locator(ctx).refs().filter((r) => r.file !== ref.file && (r.scope !== 'me' || !ctx.contextRoot || personalRulesVisible(ctx.contextRoot, ctx.home).visible));
    if (flags.replaces && !findRecord(readStore(ref), flags.replaces)) {
      for (const o of others) {
        const rec = findRecord(readStore(o), flags.replaces);
        if (rec && !deriveRule(rec, ctx.now).moved_to) { crossReplace = { ref: o, view: deriveRule(rec, ctx.now) }; break; }
      }
      if (crossReplace?.ref.scope === 'member') {
        const own = ownMemberRefusal(ctx, crossReplace.ref.member!.slug);
        if (own) return refuse(own);
      }
    }
    if (!flags.new && !flags.same && !flags.replaces) {
      const visibleOthers = others.filter((o) => o.scope !== 'member' || o.member?.slug === member?.slug || scope !== 'member');
      const twins: string[] = [];
      for (const o of visibleOthers) {
        if (o.scope === 'member' && o.member?.slug !== member?.slug) continue;
        for (const v of deriveAll(readStore(o), ctx.now)) {
          if ((v.status === 'active' || v.status === 'proposed') && !v.moved_to && twinScore(headline, text, v) >= TWIN_BAR) {
            twins.push(`  ${v.id}  ${v.status}  ${v.scope}${v.member ? ` (${v.member})` : ''}  "${v.headline}"`);
          }
        }
      }
      if (twins.length > 0) {
        return refuse(
          `this reads like a rule already stored in another store. Answer with one of: --replaces <id> (his new word replaces it; it may name a rule of another store), --new (a different rule)${scope === 'member' ? '' : ', or --same <id> in its own scope'}.`,
          ...twins,
        );
      }
    }
  } catch (e) {
    return storeFailure(e);
  }

  type Out = { outcome?: LearnOutcome; rec?: RuleRecord; replaced?: string };
  let done: { result: Out; notice: string | null; gated: { id: string; reason: string }[] };
  const body = (store: ReturnType<typeof readStore>): { result: Out; changed: boolean } => {
    const views = store.rules.map((r) => ({ rec: r, v: deriveRule(r, ctx.now) }));
    const sameTarget = flags.same ? findRecord(store, flags.same) : undefined;
    const { quotes, allResolved, gate, cited } = sameTarget
      ? resolveQuotes(new Set(deriveRule(sameTarget, ctx.now).cited_turns))
      : base;
    const stamp = (): Pick<RuleEvent, 'eid' | 'at' | 'by' | 'conversation'> => ({
      eid: newEventId(), at: ctx.now.toISOString(), by: actor.by, conversation: actor.conversation,
    });
    const noop = (rec: RuleRecord): { result: Out; changed: boolean } => ({ result: { rec }, changed: false });

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
          return { result: { rec }, changed: true };
        }
        return noop(rec);
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
          return { result: { rec }, changed: true };
        }
        return noop(rec);
      }
    }

    if (flags.same) {
      const rec = findRecord(store, flags.same);
      if (!rec) return { result: { outcome: refuse(`no rule ${flags.same} in the ${scope} store${member ? ` of ${member.slug}` : ''}`) }, changed: false };
      const target = deriveRule(rec, ctx.now);
      if (target.moved_to) return { result: { outcome: refuse(`${rec.id} moved to the ${target.moved_to} store`) }, changed: false };
      // Every quote already one of its sayings: a retry, nothing new.
      if (allResolved && cited.every((t) => target.cited_turns.includes(t))) return noop(rec);
      rec.events.push({ ...stamp(), op: 'same', status: gate, quotes });
      return { result: { rec }, changed: true };
    }

    const create = (op: 'create' | 'replace', refId?: string): RuleRecord => ({
      id: newRuleId(),
      scope,
      ...(member ? { member: member.slug } : {}),
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
      if (crossReplace) {
        // The new record here; the supersede in the old store after this write lands (never nested).
        if (crossReplace.view.status === 'superseded') return { result: { outcome: refuse(`${crossReplace.view.id} was already replaced by ${crossReplace.view.superseded_by}: replace that one`) }, changed: false };
        const rec = create('replace', crossReplace.view.id);
        store.rules.push(rec);
        return { result: { rec, replaced: crossReplace.view.headline }, changed: true };
      }
      const old = findRecord(store, flags.replaces);
      if (!old) return { result: { outcome: refuse(`no rule ${flags.replaces} in any store here`) }, changed: false };
      const ov = deriveRule(old, ctx.now);
      const rec = create('replace', old.id);
      // The one place that decides status (rules-store applyStatusOp): it refuses a rule already
      // replaced or moved, and a later undo gives the old rule back the status it had, never more.
      const step = applyStatusOp(store, old.id, 'supersede', actor, { ref: rec.id, scope });
      if (!step.ok) return { result: { outcome: refuse(step.reason) }, changed: false };
      store.rules.push(rec);
      return { result: { rec, replaced: ov.headline }, changed: true };
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
    return { result: { rec }, changed: true };
  };
  try {
    if (member) {
      // The ignore entry exists before the first write of a project member's store (D1, SG5).
      if (member.scope === 'project' && ctx.contextRoot) { try { ensureAgentsGitignore(ctx.contextRoot); } catch { /* the write below still checks its paths */ } }
      const replacedText = crossReplace ? crossReplace.view.text : flags.replaces ? (() => {
        const r = findRecord(readStore(ref), flags.replaces!);
        return r ? deriveRule(r, ctx.now).text : '';
      })() : undefined;
      done = withStore<Out>(ref as MemberStoreRef, body, { now: ctx.now, gate: gateOf(ctx, rawQuotes, base.allHere, replacedText) });
    } else {
      done = withStore<Out>(ref, body, { now: ctx.now });
    }
  } catch (e) {
    return storeFailure(e);
  }

  if (done.result.outcome) return done.result.outcome;
  const view = deriveRule(done.result.rec!, ctx.now);
  const extra: string[] = done.gated.filter((g) => g.id === view.id).map((g) => `Proposed, not in force: ${g.reason}.`);

  // The cross-store supersede, in the old rule's own store (D11). If it fails, the old rule stays
  // active beside the new one and the receipt says so: nothing is lost.
  if (crossReplace && done.result.rec && (view.status === 'active' || view.status === 'proposed')) {
    try {
      const fn = (store: ReturnType<typeof readStore>): { result: string | null; changed: boolean } => {
        const step = applyStatusOp(store, crossReplace!.view.id, 'supersede', actor, { ref: view.id, scope: crossReplace!.ref.scope });
        return { result: step.ok ? null : step.reason, changed: step.ok };
      };
      const r = crossReplace.ref.scope === 'member'
        ? withStore<string | null>(crossReplace.ref as MemberStoreRef, fn, { now: ctx.now, gate: gateOf(ctx, rawQuotes, base.allHere) })
        : withStore<string | null>(crossReplace.ref, fn, { now: ctx.now });
      if (r.result) extra.push(`The old rule ${crossReplace.view.id} (${crossReplace.ref.scope}) is still active beside this one: ${r.result}.`);
      else extra.push(`It replaces ${crossReplace.view.id} of the ${crossReplace.ref.scope === 'me' ? 'personal' : crossReplace.ref.scope} store${view.status === 'proposed' ? ', which is paused until his card' : ''}.`);
    } catch (e) {
      extra.push(`The old rule ${crossReplace.view.id} (${crossReplace.ref.scope}) is still active beside this one: ${(e as Error).message}.`);
    }
  } else if (view.status === 'proposed' && view.replaces) {
    extra.push(`The rule it replaces (${view.replaces}) is paused until his card.`);
  }
  if (member && (view.status === 'active' || view.status === 'proposed')) {
    const n = instructionLinesNotice(ctx, member.slug, view.headline, view.text);
    if (n) extra.push(n);
  }
  return receipt(ctx, view, { replaced: done.result.replaced, notice: done.notice, extra });
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
  try { return realPath(a) === realPath(b); } catch { return false; }
}

function storeFailure(e: unknown): LearnOutcome {
  if (e instanceof RulesStoreError && e.code === 'unreadable') {
    return refuse(`${e.message}. Nothing was written; the last good copy is the store's .bak file.`, 'store unreadable');
  }
  return refuse((e as Error).message);
}


// ─── Finding a rule by id ───────────────────────────────────────────────────

function refsOf(ctx: LearnContext): StoreRef[] {
  return locator(ctx).refs();
}

/** The store holding `id`, through the one locator (C1): this project, his store, every member store. */
export function locateRule(ctx: LearnContext, id: string): { ref: StoreRef; view: RuleView } | null {
  const found = locateIn(locator(ctx), id, ctx.now);
  return found ? { ref: found.ref, view: found.view } : null;
}

/** Which store, in words, for a receipt read from a session that may not be the rule's own. */
function storeName(ref: StoreRef): string {
  if (ref.scope === 'me') return 'his preferences';
  if (ref.scope === 'member') return `${ref.member?.slug ?? 'a member'}'s rules`;
  return 'this project\'s rules';
}

/** A member store is written only by that member's own process or a session with no member (D2). */
function memberWriteRefusal(ctx: LearnContext, ref: StoreRef): string | null {
  return ref.scope === 'member' && ref.member ? ownMemberRefusal(ctx, ref.member.slug) : null;
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
    const own = memberWriteRefusal(ctx, found.ref);
    if (own) return refuse(own);
    const r = undoRule(found.ref, id, actorOf(ctx), { locate: locator(ctx) });
    if (!r.ok) return refuse(r.reason);
    const lines = [`UNDONE ${id} ${found.ref.scope}`, `Geri alındı: "${r.rule.headline}"${restoredLine(r.restored)}`];
    // From a session that is not the rule's own (the main Super undoing a member's rule): say which store.
    if (found.ref.scope === 'member' && sessionMemberSlug(ctx.env) !== found.ref.member?.slug) lines.push(`It was one of ${storeName(found.ref)}.`);
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
    const own = memberWriteRefusal(ctx, found.ref);
    if (own) return refuse(own);
    if (!ownerProcess(ctx.env)) {
      const why = hisWordAbout(found.view, quote, KEEP_WORD, ctx);
      if (why) return refuse(why);
    }
    const r = keepRule(found.ref, id, actorOf(ctx), { locate: locator(ctx), gate: gateOf(ctx, quote ? [quote] : [], true) });
    if (!r.ok) return refuse(r.reason);
    return receipt(ctx, r.rule, { notice: r.notice });
  } catch (e) { return storeFailure(e); }
}

/** Drop: the same gate as keep, with his drop word. */
export function learnDrop(id: string, ctx: LearnContext, quote?: string): LearnOutcome {
  try {
    const found = locateRule(ctx, id);
    if (!found) return refuse(`no rule ${id}`);
    const own = memberWriteRefusal(ctx, found.ref);
    if (own) return refuse(own);
    if (!ownerProcess(ctx.env)) {
      const why = hisWordAbout(found.view, quote, DROP_WORD, ctx);
      if (why) return refuse(why);
    }
    const r = dropRule(found.ref, id, actorOf(ctx), { locate: locator(ctx) });
    if (!r.ok) return refuse(r.reason);
    const lines = [`DROPPED ${id} ${found.ref.scope}`, `Atıldı: "${r.rule.headline}"${restoredLine(r.restored)}`];
    if (r.notice) lines.push(r.notice);
    return { code: 0, lines, id, status: r.rule.status, scope: found.ref.scope };
  } catch (e) { return storeFailure(e); }
}

export interface EditFlags { headline?: string; text?: string; says?: string; at?: string; doc?: string; when?: string; scope?: string; member?: string }

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
    // Daralt (D2): an agent never edits or moves a member's rule; his shell (or his `run` card) does.
    const touchesMember = found.ref.scope === 'member' || flags.scope === 'member';
    if (touchesMember && !actor.owner) return refuse(MEMBER_EDIT_REFUSAL);
    if (flags.member !== undefined && flags.scope !== 'member') return refuse('--member goes with --scope member');
    let r: StatusChange;
    if (flags.scope !== undefined && flags.scope !== found.ref.scope) {
      if (flags.scope !== 'me' && flags.scope !== 'project' && flags.scope !== 'member') return refuse('--scope must be me, project or member');
      let target: StoreRef;
      if (flags.scope === 'member') {
        const m = resolveMember(ctx, flags.member);
        if (typeof m === 'string') return refuse(m);
        if (m.scope === 'project' && ctx.contextRoot) { try { ensureAgentsGitignore(ctx.contextRoot); } catch { /* the write still checks its paths */ } }
        target = storeRef(ctx, 'member', m);
      } else {
        if (flags.scope === 'me') {
          const email = ctx.gitEmail !== undefined ? ctx.gitEmail : readGitIdentity(ctx.contextRoot ? dirname(ctx.contextRoot) : process.cwd()).email;
          if (!ensureMeFile(ctx.home, email)) return refuse('~/.dreamcontext/me is a link: the personal store is refused there');
        }
        target = storeRef(ctx, flags.scope);
      }
      r = moveRule(found.ref, target, id, edit, actor);
    } else if (found.ref.scope === 'member' && flags.member !== undefined && flags.member !== found.ref.member?.slug) {
      return refuse('a rule moves from one member to another only as a new rule on his words (`--replaces <id>`)');
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

export function learnList(ctx: LearnContext, opts: { me?: boolean; project?: boolean; all?: boolean; member?: string } = {}): { lines: string[]; rules: RuleView[] } {
  const only = opts.me || opts.project || opts.member !== undefined;
  const showMe = opts.me || !only;
  const showProject = (opts.project || !only) && !!ctx.contextRoot;
  // A member's rules: the one named, else this session's own member (never another member's by default).
  const memberSlug = opts.member !== undefined ? opts.member.trim() : (!only ? sessionMemberSlug(ctx.env) : '');
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
  if (memberSlug) {
    const m = resolveMember(ctx, memberSlug);
    if (typeof m === 'string') lines.push(`Member rules: ${m}`);
    else {
      try { section(`${memberTitleOf(ctx, m.slug)}'s rules, every project it works in`, memberStoreRef(m, ctx.contextRoot, ctx.home)); }
      catch (e) { lines.push(`${m.slug}'s rules: ${(e as Error).message}`); }
    }
  }
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
    .description('Store a rule he stated (his preference, this project\'s rule, or how one AI Team member works) and print the line to repeat to him')
    .option('--scope <scope>', 'me (how to work with him in general, every project) | project (one product or project) | member (how this member works, every project it works in)')
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
    .option('--member <slug>', 'With --scope member: the member whose rule this is (default: this session\'s member)')
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
    .option('--member <slug>', 'Only this member\'s rules (default in a member session: its own, beside his and this project\'s)')
    .option('--all', 'Also replaced and undone rules')
    .option('--json', 'Machine-readable')
    .action((opts: { me?: boolean; project?: boolean; all?: boolean; member?: string; json?: boolean }) => {
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
    .option('--scope <scope>', 'Move to me, project or member (his shell only for a member rule)')
    .option('--member <slug>', 'With --scope member: the member whose store it moves to')
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
