import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { AutomationError } from '../automations/types.js';
import { readLocalJson, updateLocalJson } from '../local-store.js';
import { approveAutomation, checkApproval, manifestHash } from '../automations/registry.js';
import { getRunTarget, readManifestParts, updateAutomation } from '../automations/store.js';
import { assertOwned } from './owner.js';
import { agentUsage, getAgent, previewCallTarget, restampTargets, widenViewOf, withRestamp } from './store.js';
import { normalizeSoul } from './soul-templates.js';
import type { AgentIdentityPatch, AgentManifest } from './types.js';
import { localWriteStamps, widensAuthority, type InstructionField, type MemberActor } from './instruction-fields.js';

/**
 * AMENDMENTS: the Super Agent corrects a member's instructions, the member stays approved, and the
 * owner reads and undoes it afterwards.
 *
 * Approval answers "is this still what a human here trusted?" with a hash. An amendment moves that
 * trust forward without a card, so it carries what the hash cannot: who changed what, why, and the
 * text it replaced. The record is machine-local, like the approval it re-stamps: a prompt is
 * private by default and the brain syncs, so its old text never sits in a synced folder.
 *
 * The Super Agent reads text it did not write (a child's output, the web, a message). So the door
 * is narrow on purpose, and each limit below answers one way that text could abuse it:
 *  - instruction fields only (`instruction-fields.ts`), never what widens a member's reach;
 *  - a member with a change nobody reviewed is refused, so an amendment never buries one;
 *  - a daily ceiling, lowest for a member that runs unattended;
 *  - added text that brings a new destination, a command or a hidden character goes to the owner,
 *    and so does a changed or removed line with a rule that stopped it or asked: a gate is reach too;
 *  - a `## ` line would start a section of the file: never text, always refused;
 *  - once the owner takes a change back, that field waits a week, and that text never returns.
 */

const FILE = 'agent-amendments.json';

export const AMENDMENT_LIMITS = {
  /** Kept per member, newest first: the oldest falls off. */
  keptPerMember: 20,
  /** A reason is a line the owner reads. */
  whyChars: 500,
  /** One field's whole new text. */
  fieldChars: 64 * 1024,
  /** New text in one amendment: a correction, not a rewrite. */
  addedChars: 6_000,
  /** Text taken out in one amendment: past this it is a rewrite, the owner's. */
  removedChars: 3_000,
  /** After the owner takes a change back, the field is his this long. */
  revertHoldDays: 7,
  perMemberPerDay: 3,
  perUnattendedMemberPerDay: 1,
  perProjectPerDay: 10,
} as const;

const DAY_MS = 86_400_000;
/** More than half of a text taken out is a new text, however short it is. */
const MAX_REMOVED_SHARE = 0.5;
const MIN_RATIO_CHARS = 80;

export interface AmendmentChange {
  field: InstructionField;
  /** The routine a `job` belongs to; absent for the member's own prompt and soul. */
  routine?: string;
  before: string;
  after: string;
}

/** Who wrote an amendment: the Super Agent (`super team amend`), an in-app chat session, or a
 *  process that never talks to the owner (a member's run, a routine, a Super or member child). */
export type AmendBy = Exclude<MemberActor, 'owner'>;

export interface Amendment {
  id: string;
  at: string;
  member: string;
  /** `owner`: his own edit (dashboard or his terminal), traced and revertable like the rest, with
   *  no caps, no daily ceiling and never a card (plan-r10 1e). */
  by: MemberActor;
  /** What the risk filter flagged (`amendmentRisks`). Super and an in-app session are applied and
   *  stamped anyway (the owner talks to both); the trace row says what was flagged. */
  risks?: string[];
  /** What this change widened (`widensAuthority`), when it did. */
  widened?: string[];
  /** Written and NOT stamped: it waits for the one approval card. */
  waits?: true;
  /** A member an agent or a session created: no text to take back, the row is its trace. */
  created?: true;
  /** The Super Agent session that made it. */
  session: string | null;
  why: string;
  changes: AmendmentChange[];
  revertedAt?: string;
}

interface AmendmentFile {
  members: Record<string, Amendment[]>;
}

const EMPTY = (): AmendmentFile => ({ members: {} });

export type AmendmentRefusalCode =
  | 'unknown_member' | 'unknown_routine' | 'invalid_args' | 'amend_global' | 'amend_no_change' | 'amend_too_large'
  | 'amend_unapproved' | 'amend_unreviewed_change' | 'amend_section_heading' | 'amend_limit' | 'amend_needs_owner' | 'owner_reverted'
  | 'unknown_amendment' | 'already_reverted' | 'amendment_superseded';

/** A named refusal the caller can act on; nothing was written. */
export class AmendmentRefused extends AutomationError {
  constructor(readonly code: AmendmentRefusalCode, readonly status: number, message: string) {
    super(message);
  }
}

function clean(raw: unknown): Amendment[] {
  return Array.isArray(raw) ? raw.filter((a): a is Amendment => !!a && typeof a === 'object' && typeof (a as Amendment).id === 'string') : [];
}

/** One member's amendments, newest first. Never throws. */
export function listAmendments(projectRoot: string, member: string, home?: string): Amendment[] {
  const file = readLocalJson<AmendmentFile>(projectRoot, FILE, EMPTY(), home);
  return clean(file.members?.[member]);
}

/** The comparison key of an instruction text, the same normalisation the approval hash applies. */
function textKey(s: string): string {
  return createHash('sha256').update(s.replace(/\r\n/g, '\n').trim(), 'utf8').digest('hex');
}

// ─── What added text may not bring in without the owner ─────────────────────

/** Lines of `after` that `before` does not have. */
function addedText(before: string, after: string): string {
  const had = new Set(before.split('\n').map((l) => l.trim()));
  return after.split('\n').filter((l) => !had.has(l.trim())).join('\n');
}

/** A dotted name: a host until proven a file. Lowercased text only, see `amendmentRisks`. */
const BARE_HOST = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?![\w-])/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
/** Endings that name a file, not a host: `report.md`, `package.json`. */
const FILE_ENDING = /\.(?:md|mdx|txt|csv|tsv|json|ya?ml|toml|lock|log|env|sql|html?|css|scss|tsx?|jsx?|mjs|cjs|rb|zsh|java|swift|kt|png|jpe?g|gif|webp|svg|pdf|mp[34]|wav|gz|tar)$/;
/** Is the name at `at` the tail of a path: one slash before it, never a protocol-relative `//`. */
function isPathTail(text: string, at: number): boolean {
  return text[at - 1] === '/' && text[at - 2] !== '/';
}

/** Endings that are real domains too: a file only with a folder in front (`scripts/run.sh`). */
const PATH_ONLY_ENDING = /\.(?:sh|rs|py|go|zip|mov)$/;

function hostsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s'"`)>\]]+)/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** Each is one thing an injected instruction needs and an honest correction almost never adds. */
const RISKY_ADDITIONS: readonly { name: string; re: RegExp }[] = [
  { name: 'a raw IP address', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: 'piping into a shell or interpreter', re: /\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\|\s*(?:python\d?|node|perl|ruby)\b/i },
  { name: 'a download or transfer tool', re: /\b(?:curl|wget|scp|sftp|ssh|rsync|nc|ncat|ftp)\s+\S|\bgit\s+(?:push|remote\s+add|clone)\b|\bgh\s+\w/i },
  { name: 'decoded or evaluated code', re: /\bbase64\s+(?:-d|--decode)\b|\beval\s*[("'$`]|\b(?:python\d?|node|perl|ruby)\s+-[ce]\b|\b(?:ba|z|da)?sh\s+-c\b|\$\(/i },
  { name: 'a secret or a credential path', re: /(?:^|[\s/'"`~])\.(?:env|ssh|aws|netrc|npmrc|git-credentials|claude|config)\b|\bid_(?:rsa|ed25519)\b|\bkeychain\b|\b[A-Z][A-Z0-9_]*(?:_TOKEN|_SECRET|_API_KEY)\b/i },
  { name: 'dreamcontext\'s approval or machine state', re: /\bautomations\.json\b|\.dreamcontext\/|\bbypassPermissions\b|\bagents\s+approve\b|\bautomations\s+approve\b|\bsuper\s+team\s+amend\b/i },
  { name: 'an order to drop earlier instructions', re: /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|above|earlier|prior|all)\b[^.\n]{0,20}\b(?:instruction|rule|prompt)s?\b|önceki\s+(?:talimat|kural)\S*\s+(?:yok\s+say|unut|görmezden)/i },
  { name: 'an order to work behind the owner\'s back', re: /\bwithout\s+(?:asking|telling|approval|review)\b|\b(?:do\s+not|don'?t|never)\s+(?:tell|ask|mention|notify|report|log)\b|\bskip\s+(?:the\s+)?(?:review|approval)\b|(?:^|\s)(?:onay\s+almadan|izin\s+almadan|sormadan|haber\s+verme|bahsetme)/iu },
  { name: 'an invisible or direction-changing character', re: /[\p{Cf}\u034F\u{E0000}-\u{E007F}]/u },
];

function wordsOf(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** How much of a text's words are gone: a word changed in a one-line prompt is not a rewrite. */
function lostWordShare(before: string, after: string): number {
  const kept = new Set(wordsOf(after));
  const words = wordsOf(before);
  return words.filter((w) => !kept.has(w)).length / Math.max(1, words.length);
}

/** A line that stops the member or sends it to a human. Taking one out widens what it does alone. */
const GUARD_LINE = /\b(?:never|must|do\s+not|don'?t|forbidden|ask|approv\w*|confirm\w*|review|owner|stop|wait|only|escalate|human)\b|(?:^|[\s(])(?:yasak|asla|onay|izin|sorma|sadece|kurucu|sahib|danış|yalnız|mutlaka|bekle|dur\b|değil|yok\b)|\bsor[.!]?\s*$|\S{2,}(?:me|ma|meyin|mayın)[.!]?\s*$|\S{2,}(?:mez|maz)\b|\S{2,}(?:meli|malı)(?:dir|dır)?(?!\p{L})|\S{2,}(?:mayacak|meyecek|mayınız|meyiniz)(?!\p{L})/iu;

/** Both casings: Turkish lowercasing reads `İZİN` and turns `WAIT` into `waıt`, so neither alone. */
function holdsRule(line: string): boolean {
  return GUARD_LINE.test(line) || GUARD_LINE.test(line.toLocaleLowerCase('tr'));
}

/**
 * Why a change must go to the owner instead, one reason each; empty when it may go through.
 * A filter, not a proof: it stops what a payload usually needs, never what plain words can ask.
 */
export function amendmentRisks(before: string, after: string): string[] {
  const raw = addedText(before, after);
  // Fullwidth and look-alike forms fold into the ASCII the patterns read; the hidden-character
  // pattern reads the raw text, which still has them.
  const added = raw.normalize('NFKC');
  const risks: string[] = [];
  const known = hostsOf(before);
  const had = before.toLowerCase();
  const lowered = added.toLowerCase();
  // A URL's host matches the old URLs exactly: a look-alike of a known host is a new address.
  const fresh = [
    ...[...hostsOf(added)].filter((h) => !known.has(h)),
    ...[
      ...[...lowered.matchAll(BARE_HOST)]
        .filter((m) => !FILE_ENDING.test(m[0]) && !(PATH_ONLY_ENDING.test(m[0]) && isPathTail(lowered, m.index)))
        .map((m) => m[0]),
      ...[...lowered.matchAll(EMAIL)].map((m) => m[0]),
    ].filter((h) => !had.includes(h)),
  ];
  if (fresh.length > 0) risks.push(`a new address (${[...new Set(fresh)].slice(0, 3).join(', ')})`);
  for (const r of RISKY_ADDITIONS) if (r.re.test(r.name.startsWith('an invisible') ? raw : added)) risks.push(r.name);
  const dropped = addedText(after, before);
  if (before.trim() && !after.trim()) risks.push('removing the whole text');
  else if (before.length >= MIN_RATIO_CHARS && lostWordShare(before, after) > MAX_REMOVED_SHARE) risks.push('replacing most of the text');
  else if (dropped.split('\n').some(holdsRule)) risks.push('changing or removing a line with a rule that stops it or sends it to a person');
  return risks;
}

// ─── The write ───────────────────────────────────────────────────────────────

export interface AmendInput {
  member: string;
  why: string;
  prompt?: string;
  soul?: string;
  /** The routine's `## Job`; needs `routine`. '' removes it. */
  job?: string;
  routine?: string;
  session?: string | null;
  /** Who writes it. Default `super` (the `team amend` door). */
  by?: AmendBy;
  /** The member a member run belongs to (`DREAMCONTEXT_AGENT_SELF` / `DREAMCONTEXT_MEMBER_CREW`).
   *  Informational since 2026-11-07: a member's run editing another member is made on this Mac too. */
  self?: string | null;
  /** Other identity fields written in the same change (a session's or an agent's `agents edit`):
   *  judged by `widensAuthority`, never by the text checks. */
  extra?: Omit<AgentIdentityPatch, 'prompt' | 'soul'>;
}

export interface AmendOptions {
  home?: string;
  now?: Date;
}

/** The hash an agent target would keep through a job write, and the re-stamp. A sibling of
 *  `withRestamp` for the routine's own text: re-approved only when it was directly approved and
 *  the re-read hash is what this edit produced. */
function writeJob(contextRoot: string, routine: string, job: string, home: string | undefined, now: Date, stamp = true): void {
  const projectRoot = dirname(contextRoot);
  const target = getRunTarget(contextRoot, routine, 'automation');
  if (!target) throw new AutomationError(`No routine named "${routine}".`);
  const verdict = checkApproval(projectRoot, target, home, 'run');
  const expected = manifestHash({ ...target, job });
  updateAutomation(contextRoot, routine, { job: job.trim() ? job : null });
  if (!stamp || !verdict.approved) return;
  const reread = getRunTarget(contextRoot, routine, 'automation');
  if (reread && manifestHash(reread) === expected) approveAutomation(projectRoot, reread, now, home);
}

/** Apply a list of changes: the member's own fields in one edit, then each routine's job. */
function applyChanges(
  contextRoot: string,
  member: string,
  changes: readonly { field: InstructionField; routine?: string; text: string }[],
  home: string | undefined,
  now: Date,
  extra: Omit<AgentIdentityPatch, 'prompt' | 'soul'> = {},
  stamp = true,
): void {
  const patch: AgentIdentityPatch = { ...extra };
  for (const c of changes) {
    if (c.field === 'prompt') patch.prompt = c.text;
    if (c.field === 'soul') patch.soul = c.text;
  }
  if (Object.keys(patch).length > 0) withRestamp(contextRoot, dirname(contextRoot), member, patch, home, now, { stamp });
  for (const c of changes) {
    if (c.field === 'job' && c.routine) writeJob(contextRoot, c.routine, c.text, home, now, stamp);
  }
}

/** The routine's job as it stands, refused BEFORE anything is written when the write could not
 *  land: not this member's, a teammate's, or an unsplit file with no job of its own. */
function currentJob(contextRoot: string, member: string, routine: string): string {
  const target = getRunTarget(contextRoot, routine, 'automation');
  if (!target || target.agent !== member) {
    throw new AmendmentRefused('unknown_routine', 404, `"${routine}" is not a routine of "${member}" (\`dreamcontext agents show ${member}\` lists them).`);
  }
  assertOwned(target, target.title || routine);
  if (readManifestParts(target.path).kind !== 'bound') {
    throw new AmendmentRefused('unknown_routine', 404, `"${routine}" still lives in its old automation file, which has no job of its own: amend its prompt instead.`);
  }
  return typeof target.job === 'string' ? target.job : '';
}

/** The member's targets as they stand: refused when one carries a change nobody reviewed (a synced
 *  edit, or one waiting for his card): an amendment never buries it. A member never approved here
 *  is no refusal any more (plan-r10 1e): the change is written and waits for the one card, since
 *  `withRestamp` only re-stamps what was approved as it stood before the write. */
function assertApprovedAsItStands(contextRoot: string, member: string, home?: string): void {
  const projectRoot = dirname(contextRoot);
  const verdicts = restampTargets(contextRoot, member).map(({ target }) => checkApproval(projectRoot, target, home, 'run'));
  if (verdicts.some((v) => !v.approved && (v.reason === 'manifest-changed' || v.reason === 'payload-format-changed'))) {
    throw new AmendmentRefused('amend_unreviewed_change', 409, `"${member}" has a change the owner has not reviewed. He reviews it on its approval card first; an amendment never goes over it.`);
  }
}

/** The member's run targets approved right now, as `<kind>:<slug>`. */
export function approvedTargets(contextRoot: string, member: string, home?: string): string[] {
  const projectRoot = dirname(contextRoot);
  return restampTargets(contextRoot, member)
    .filter(({ target }) => checkApproval(projectRoot, target, home, 'run').approved)
    .map(({ kind, target }) => `${kind}:${target.slug}`);
}

/** Does this member run with nobody watching: a routine of it is on a schedule, switched on. */
function runsUnattended(contextRoot: string, member: string): boolean {
  return agentUsage(contextRoot, member).automations.some((slug) => {
    const t = getRunTarget(contextRoot, slug, 'automation');
    return !!t && t.enabled && t.mode === 'sched';
  });
}

/**
 * Change a member's instructions (and, from a session's or an agent's `agents edit`, its other
 * identity fields) through ONE door with `team amend`'s protections (plan-r10 1e): the section,
 * size and daily ceilings, the revert hold, the risk filter and a trace the owner reads and undoes.
 *
 * Who decides the stamp (`localWriteStamps`, the owner's rule of 2026-11-07): a change made on this
 * Mac is approved as written, by the Super Agent, an in-app session or a member's own run alike,
 * widening or not; the trace row names what it widened and what the risk filter flagged. Only a
 * process that never talks to him (`by: 'agent'`) writing text the risk filter flags is written and
 * left for the one card.
 * The trace is written FIRST, so a change that lands always has its record; a write that fails
 * takes the record back. Throws {@link AmendmentRefused} for every refusal, with nothing written.
 */
export function amendMember(contextRoot: string, input: AmendInput, opts: AmendOptions = {}): Amendment {
  const { home } = opts;
  const now = opts.now ?? new Date();
  const projectRoot = dirname(contextRoot);
  const member = input.member;
  const by: AmendBy = input.by ?? 'super';
  const extra = input.extra ?? {};
  const hasExtra = Object.keys(extra).length > 0;
  const why = input.why.replace(/\s+/g, ' ').trim();
  if (!why) throw new AmendmentRefused('invalid_args', 400, 'say which mistake this fixes: --why is what the owner reads.');
  if (why.length > AMENDMENT_LIMITS.whyChars) throw new AmendmentRefused('invalid_args', 400, `--why is at most ${AMENDMENT_LIMITS.whyChars} characters.`);
  if (input.job !== undefined && !input.routine) throw new AmendmentRefused('invalid_args', 400, 'a job belongs to a routine: name it with --routine.');

  const agent = getAgent(contextRoot, member, home);
  if (!agent) throw new AmendmentRefused('unknown_member', 404, `no AI Team member "${member}" in this project (\`dreamcontext agents list\`).`);
  const global = agent.scope === 'global';
  // A global member runs in every project: one project's Super Agent does not reach all of them.
  if (global && by === 'super') throw new AmendmentRefused('amend_global', 409, `"${member}" is a global agent, used by every project on this Mac: the owner edits it in AI Team.`);
  assertOwned({ owner: agent.owner }, agent.title || member);

  const changes: AmendmentChange[] = [];
  const add = (field: InstructionField, before: string, after: string, routine?: string): void => {
    // `extractSection` ends a section at such a line: the text after it would land in another
    // section of the file, `## Pattern` and `## Output instructions` among them.
    if (/^\s*##(?:\s|$)/m.test(after)) throw new AmendmentRefused('amend_section_heading', 400, `the new ${field} has a line that starts with "## ", which would start a new section of the member's file. Use "### " instead.`);
    if (after.length > AMENDMENT_LIMITS.fieldChars) throw new AmendmentRefused('amend_too_large', 413, `the new ${field} is over ${AMENDMENT_LIMITS.fieldChars} characters.`);
    if (textKey(before) !== textKey(after)) changes.push({ field, before, after, ...(routine ? { routine } : {}) });
  };
  if (input.prompt !== undefined) {
    if (!input.prompt.trim()) throw new AmendmentRefused('invalid_args', 400, 'a member needs a prompt: it is who it is.');
    add('prompt', agent.prompt, input.prompt.trim());
  }
  if (input.soul !== undefined) add('soul', agent.soul, normalizeSoul(input.soul));
  if (input.job !== undefined && input.routine) add('job', currentJob(contextRoot, member, input.routine), input.job.trim(), input.routine);
  if (changes.length === 0 && !hasExtra) throw new AmendmentRefused('amend_no_change', 409, 'nothing changes: the text is already what you sent.');

  assertApprovedAsItStands(contextRoot, member, home);

  const added = changes.reduce((n, c) => n + addedText(c.before, c.after).length, 0);
  if (added > AMENDMENT_LIMITS.addedChars) {
    throw new AmendmentRefused('amend_too_large', 413, `this adds ${added} characters; an amendment is a correction of at most ${AMENDMENT_LIMITS.addedChars}. A rewrite is the owner's, in AI Team.`);
  }
  const removed = changes.reduce((n, c) => n + addedText(c.after, c.before).length, 0);
  if (removed > AMENDMENT_LIMITS.removedChars) {
    throw new AmendmentRefused('amend_too_large', 413, `this takes out ${removed} characters; an amendment takes out at most ${AMENDMENT_LIMITS.removedChars}. A rewrite is the owner's, in AI Team.`);
  }
  const risks = [...new Set(changes.flatMap((c) => amendmentRisks(c.before, c.after)))];

  // Which way the member's reach moves (the identity part; a routine's job is text only).
  const identityPatch: AgentIdentityPatch = { ...extra };
  for (const c of changes) {
    if (c.field === 'prompt') identityPatch.prompt = c.after;
    if (c.field === 'soul') identityPatch.soul = c.after;
  }
  const preview = Object.keys(identityPatch).length > 0 ? previewCallTarget(contextRoot, member, identityPatch) : null;
  const widened = preview
    ? widensAuthority(widenViewOf(preview.before), widenViewOf(preview.after), by)
    : global && by === 'agent' ? ['global'] : [];
  // Made on this Mac, so approved as written (`localWriteStamps`): only a background process's risky
  // text waits for the card. `widened` stays on the trace row, for the owner to read.
  const stamp = localWriteStamps(by, risks);
  // `withRestamp` stamps only what was approved as it stood: a member never approved here waits too.
  const approvedBefore = approvedTargets(contextRoot, member, home).length > 0;

  const entry: Amendment = {
    id: `am_${randomBytes(6).toString('hex')}`,
    at: now.toISOString(),
    member,
    by,
    session: input.session ?? null,
    why,
    changes,
    ...(risks.length ? { risks } : {}),
    ...(widened.length ? { widened } : {}),
    ...(stamp && approvedBefore ? {} : { waits: true as const }),
  };

  // Only text has a trace to read and take back; a pure model or board change has none.
  if (changes.length > 0) {
    const unattended = runsUnattended(contextRoot, member);
    // Inside the record's own lock, so two calls cannot both pass the ceiling.
    updateLocalJson<AmendmentFile>(projectRoot, FILE, EMPTY(), (cur) => {
      const members = { ...(cur.members ?? {}) };
      const mine = clean(members[member]);
      const held = now.getTime() - AMENDMENT_LIMITS.revertHoldDays * DAY_MS;
      for (const c of changes) {
        const key = textKey(c.after);
        const same = mine.filter((a) => a.revertedAt).flatMap((a) => a.changes.filter((p) => p.field === c.field && p.routine === c.routine).map((p) => ({ p, at: a.revertedAt as string })));
        if (same.some(({ p }) => textKey(p.after) === key)) throw new AmendmentRefused('owner_reverted', 409, `the owner took this exact ${c.field} back. Do not write it again; tell him what you saw.`);
        if (same.some(({ at }) => Date.parse(at) > held)) throw new AmendmentRefused('owner_reverted', 409, `the owner took a change to this ${c.field} back in the last ${AMENDMENT_LIMITS.revertHoldDays} days, so it is his for now. Tell him what you saw.`);
      }
      const since = now.getTime() - DAY_MS;
      // The owner's own edits and created members never count against an agent's ceiling.
      const recent = (list: Amendment[]) => list.filter((a) => Date.parse(a.at) > since && !a.created && a.by !== 'owner').length;
      const ceiling = unattended ? AMENDMENT_LIMITS.perUnattendedMemberPerDay : AMENDMENT_LIMITS.perMemberPerDay;
      if (recent(mine) >= ceiling) {
        throw new AmendmentRefused('amend_limit', 429, `"${member}" had ${ceiling} amendment${ceiling === 1 ? '' : 's'} in the last 24 hours${unattended ? ' (it runs unattended, so one is the ceiling)' : ''}. Leave it, or tell the owner.`);
      }
      const all = Object.values(members).reduce((n, list) => n + recent(clean(list)), 0);
      if (all >= AMENDMENT_LIMITS.perProjectPerDay) {
        throw new AmendmentRefused('amend_limit', 429, `this project had ${AMENDMENT_LIMITS.perProjectPerDay} amendments in the last 24 hours. Tell the owner what is going on.`);
      }
      members[member] = [entry, ...mine].slice(0, AMENDMENT_LIMITS.keptPerMember);
      return { members };
    }, home);
  }

  try {
    applyChanges(contextRoot, member, changes.map((c) => ({ field: c.field, text: c.after, ...(c.routine ? { routine: c.routine } : {}) })), home, now, extra, stamp);
  } catch (err) {
    // A record is dropped only for what did not land: half a change keeps its trace and its undo.
    if (changes.length > 0) keepWhatLanded(contextRoot, member, entry, home);
    throw err;
  }
  return entry;
}

/**
 * The trace of a member an agent or a session created (plan-r10 1e): who, when, what the risk
 * filter flagged over its prompt and soul, what it widened, and whether it waits for the card.
 * No text to take back (the owner deletes a member he does not want). Best-effort: a create that
 * landed is never undone because its trace could not be written.
 */
export function traceMemberCreate(
  projectRoot: string,
  input: { member: string; by: AmendBy; risks: string[]; widened: string[]; waits: boolean; session?: string | null; routine?: string },
  opts: AmendOptions = {},
): Amendment {
  const now = opts.now ?? new Date();
  const entry: Amendment = {
    id: `am_${randomBytes(6).toString('hex')}`,
    at: now.toISOString(),
    member: input.member,
    by: input.by,
    session: input.session ?? null,
    why: input.routine ? `created the routine "${input.routine}"` : 'created this member',
    changes: [],
    created: true,
    ...(input.risks.length ? { risks: input.risks } : {}),
    ...(input.widened.length ? { widened: input.widened } : {}),
    ...(input.waits ? { waits: true as const } : {}),
  };
  try {
    updateLocalJson<AmendmentFile>(projectRoot, FILE, EMPTY(), (cur) => {
      const members = { ...(cur.members ?? {}) };
      members[input.member] = [entry, ...clean(members[input.member])].slice(0, AMENDMENT_LIMITS.keptPerMember);
      return { members };
    }, opts.home);
  } catch { /* the member exists; its trace is best-effort */ }
  return entry;
}

/**
 * The owner's own edit of a member (plan-r10 1e: "sahibin değişikliği iz bırakır, geri alınabilir"):
 * written through `withRestamp` exactly as before, then traced with `by: 'owner'` when its text
 * moved (prompt or soul), with what the risk filter flags named on the row. No size caps, no daily
 * ceiling, never a card: his save is his consent. `agents revert` takes it back. The trace is
 * best-effort: an edit that landed is never undone because its row could not be written.
 */
export function ownerEdit(
  contextRoot: string,
  member: string,
  patch: AgentIdentityPatch,
  opts: AmendOptions & { consent?: boolean; why?: string } = {},
): AgentManifest {
  const before = getAgent(contextRoot, member, opts.home);
  const now = opts.now ?? new Date();
  const updated = withRestamp(contextRoot, dirname(contextRoot), member, patch, opts.home, now, opts.consent ? { consent: true } : {});
  if (!before) return updated;
  const changes: AmendmentChange[] = [];
  if (patch.prompt !== undefined && textKey(before.prompt) !== textKey(updated.prompt)) changes.push({ field: 'prompt', before: before.prompt, after: updated.prompt });
  if (patch.soul !== undefined && textKey(before.soul) !== textKey(updated.soul)) changes.push({ field: 'soul', before: before.soul, after: updated.soul });
  if (changes.length === 0) return updated;
  const risks = [...new Set(changes.flatMap((c) => amendmentRisks(c.before, c.after)))];
  const entry: Amendment = {
    id: `am_${randomBytes(6).toString('hex')}`,
    at: now.toISOString(),
    member,
    by: 'owner',
    session: null,
    why: (opts.why ?? 'edited by the owner').replace(/\s+/g, ' ').trim().slice(0, AMENDMENT_LIMITS.whyChars),
    changes,
    ...(risks.length ? { risks } : {}),
  };
  try {
    updateLocalJson<AmendmentFile>(dirname(contextRoot), FILE, EMPTY(), (cur) => {
      const members = { ...(cur.members ?? {}) };
      members[member] = [entry, ...clean(members[member])].slice(0, AMENDMENT_LIMITS.keptPerMember);
      return { members };
    }, opts.home);
  } catch { /* the edit landed; its trace is best-effort */ }
  return updated;
}

/** The risks of a created member's text: everything in it is new. */
export function createRisks(prompt: string, soul: string): string[] {
  return [...new Set([...amendmentRisks('', prompt), ...(soul.trim() ? amendmentRisks('', soul) : [])])];
}

/** After a failed write: the record keeps the changes that are on disk, and goes if none is. */
function keepWhatLanded(contextRoot: string, member: string, entry: Amendment, home?: string): void {
  const landed = entry.changes.filter((c) => {
    const now = currentText(contextRoot, member, c, home);
    return now !== null && textKey(now) === textKey(c.after);
  });
  try {
    updateLocalJson<AmendmentFile>(dirname(contextRoot), FILE, EMPTY(), (cur) => {
      const members = { ...(cur.members ?? {}) };
      const list = clean(members[member]);
      members[member] = landed.length === 0
        ? list.filter((a) => a.id !== entry.id)
        : list.map((a) => (a.id === entry.id ? { ...a, changes: landed } : a));
      return { members };
    }, home);
  } catch {
    // the record keeps every change it named: a revert skips what never landed
  }
}

/** The text a change's field has right now. */
function currentText(contextRoot: string, member: string, c: AmendmentChange, home?: string): string | null {
  const agent = getAgent(contextRoot, member, home);
  if (!agent) return null;
  if (c.field === 'prompt') return agent.prompt;
  if (c.field === 'soul') return agent.soul;
  const target = c.routine ? getRunTarget(contextRoot, c.routine, 'automation') : null;
  return target ? (typeof target.job === 'string' ? target.job : '') : null;
}

/**
 * Put the text back, the OWNER's step: every surface that calls this is his (the AI Team page, the
 * CLI outside a session). The member stays as approved as it was. Refused when the text moved on
 * since: reverting would silently throw away the later change, so that one goes first.
 */
export function revertAmendment(contextRoot: string, member: string, id: string, opts: AmendOptions = {}): Amendment {
  const { home } = opts;
  const now = opts.now ?? new Date();
  const projectRoot = dirname(contextRoot);
  const entry = listAmendments(projectRoot, member, home).find((a) => a.id === id);
  if (!entry) throw new AmendmentRefused('unknown_amendment', 404, `no amendment ${id} for "${member}".`);
  if (entry.revertedAt) throw new AmendmentRefused('already_reverted', 409, 'this change was already taken back.');
  const agent = getAgent(contextRoot, member, home);
  if (agent) assertOwned({ owner: agent.owner }, agent.title || member);
  // A change already at its old text is done: a revert that stopped halfway finishes on a retry.
  const todo: AmendmentChange[] = [];
  for (const c of entry.changes) {
    const current = currentText(contextRoot, member, c, home);
    if (current !== null && textKey(current) === textKey(c.before)) continue;
    if (current === null || textKey(current) !== textKey(c.after)) {
      throw new AmendmentRefused('amendment_superseded', 409, `the ${c.field} changed after this amendment. Take the newer change back first, or edit it by hand.`);
    }
    todo.push(c);
  }
  applyChanges(contextRoot, member, todo.map((c) => ({ field: c.field, text: c.before, ...(c.routine ? { routine: c.routine } : {}) })), home, now);
  let done = entry;
  updateLocalJson<AmendmentFile>(projectRoot, FILE, EMPTY(), (cur) => {
    const members = { ...(cur.members ?? {}) };
    members[member] = clean(members[member]).map((a) => {
      if (a.id !== id) return a;
      done = { ...a, revertedAt: now.toISOString() };
      return done;
    });
    return { members };
  }, home);
  return done;
}
