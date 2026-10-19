import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { foldAscii } from './fold-ascii.js';
import type { SessionRecord } from './sleep-consolidation.js';
import { humanTurnText, isInjectedUserRecord, isSystemNoiseMessage } from './transcript-records.js';
import { isEmptyOfWords, isServerTurn, stripAppPrompts } from './app-prompts.js';

/**
 * ask-basis — proof that a task sleep files directly rests on something real.
 *
 * Sleep may open a new top-level task on its own only at high confidence (owner
 * decision 8): the owner explicitly asked for it in a session (`--basis ask
 * --quote "<their words>"`), or there is a concrete defect with evidence
 * (`--basis defect --evidence "<the failing output>"`). Both are checked against
 * the transcripts of the sessions this sleep is consolidating, so a basis cannot
 * be invented:
 *
 *   ask     the quote must appear in a turn a HUMAN typed. Tool results, hook
 *           context, sub-agent notifications, skill-loader text, `tasks show`
 *           output and any other harness-injected text do not count — the
 *           classifier is `humanTurnText` (transcript-records.ts), plus the
 *           blocks this module strips out of a typed turn (system reminders,
 *           hook tags, the task-context fence, pasted content, shell output, the
 *           harness's command and agent-message wrappers, the server's
 *           `<live-context>` and `<super-agent-note>`), and minus every prompt
 *           dreamcontext itself types as a user turn (app-prompts.ts). Only a
 *           record whose `type` is "user" can be a human turn: the raw API
 *           request copy (`api-request-blob`) repeats reminders, sub-agent
 *           hand-backs and tool results under `role: "user"`.
 *   defect  the excerpt must appear in a tool result (a failing test, an error)
 *           or in a human turn. The assistant saying "there is a bug" is not
 *           evidence.
 *
 * Sessions an orchestrator spawned (builders, automation runs, background
 * sleep) are skipped: their "user" turns were written by a program.
 *
 * Matching is verbatim in WORDS: both sides are lowercased, ASCII-folded and
 * reduced to alphanumeric runs, so punctuation, case and diacritics may differ
 * but no word may, and a match starts and ends on a word edge ("fix the readme"
 * is not inside "prefix the readme").
 */

/** A quote shorter than this proves nothing ("yes", "do it"). */
export const MIN_QUOTE_CHARS = 15;
export const MIN_QUOTE_WORDS = 3;
/** A defect excerpt shorter than this is not evidence of anything specific. */
export const MIN_EVIDENCE_CHARS = 20;
/** Transcripts larger than this are skipped (named in the refusal, never silently). */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export type BasisSource =
  | 'human turn'
  | 'tool result'
  | 'hook context'
  | 'injected message'
  | 'sub-agent notification or skill-loader text'
  | 'task data or injected block inside a turn'
  | 'assistant text'
  | 'sub-agent transcript'
  | 'raw API request copy'
  | 'dreamcontext prompt';

export interface BasisSession {
  id: string;
  path: string;
}

/** The sessions this sleep consolidates: recorded, not spawned, transcript on disk. */
export function basisSessions(sessions: readonly SessionRecord[]): BasisSession[] {
  const out: BasisSession[] = [];
  for (const s of sessions) {
    if (s.spawn) continue;
    const p = s.transcript_path;
    if (!p || !p.endsWith('.jsonl') || !existsSync(p)) continue;
    out.push({ id: s.session_id, path: p });
  }
  return out;
}

/** Sessions recorded in `state/.sleep.json`. Never throws. */
export function sessionsFromSleepState(contextRoot: string): SessionRecord[] {
  try {
    const raw = readFileSync(join(contextRoot, 'state', '.sleep.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    return Array.isArray(parsed.sessions) ? (parsed.sessions as SessionRecord[]) : [];
  } catch {
    return [];
  }
}

/** Lowercase, ASCII-fold, keep only alphanumeric runs separated by one space. */
export function matchForm(text: string): string {
  return foldAscii(text.toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Blocks the harness or a program writes INTO a typed turn. Removed before an
 * ask quote is matched: the owner did not say what they contain.
 */
/** A tag block, with or without attributes (`<system-reminder id="…">`): the tag and all inside it. */
const tagBlock = (tag: string): RegExp => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');

const INJECTED_TAGS = [
  // FIRST: another project's text, fenced by `wrapUntrusted`. It sits INSIDE the blocks below
  // (a chat topic in `<live-context>`), and a fence written before every `<` in it was
  // neutralised may hold a forged `</live-context>`: stripped first, the forgery goes with it.
  'untrusted-project-output',
  // The harness's own.
  'system-reminder',
  'user-prompt-submit-hook',
  'pasted_content',
  'local-command-stdout',
  'local-command-caveat',
  'bash-stdout',
  'bash-stderr',
  'agent-message',
  'task-notification',
  // A slash command's name: what the harness records for `/clear` or `/effort low`.
  'command-name',
  'command-message',
  // Blocks dreamcontext's server adds to an owner turn (agent-chat.ts).
  'live-context',
  'super-agent-note',
] as const;

const INJECTED_BLOCKS: readonly RegExp[] = [
  ...INJECTED_TAGS.map(tagBlock),
  // `tasks show` / the Read hook / a Develop kickoff: the fenced task packet.
  /--- TASK CONTEXT (\S+) ---[\s\S]*?--- END OF TASK CONTEXT \1 ---/g,
];

/**
 * Fail closed: an injected block's opening tag still there once every whole block is gone has
 * lost its close (cut short, or a forged closer ended it early). All from the opener to the
 * end of the turn is the block's, never the owner's.
 */
const UNCLOSED_OPENER = new RegExp(`<(?:${INJECTED_TAGS.join('|')})\\b[^>]*>[\\s\\S]*$`, 'i');

/** A slash command's arguments ARE what the owner typed after it: the wrapper goes, the words stay. */
const COMMAND_ARGS = /<command-args\b[^>]*>([\s\S]*?)<\/command-args>/gi;

export function stripInjected(text: string): string {
  let out = text;
  for (const re of INJECTED_BLOCKS) out = out.replace(re, ' ');
  out = out.replace(UNCLOSED_OPENER, ' ');
  return out.replace(COMMAND_ARGS, ' $1 ');
}

function blockTexts(content: unknown, type: string): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: unknown; text?: unknown; content?: unknown };
    if (block.type !== type) continue;
    if (typeof block.text === 'string') out.push(block.text);
    if (typeof block.content === 'string') out.push(block.content);
    if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        const i = inner as { type?: unknown; text?: unknown };
        if (i && i.type === 'text' && typeof i.text === 'string') out.push(i.text);
      }
    }
  }
  return out;
}

function allText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allText).join('\n');
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return ['text', 'content', 'stdout', 'stderr'].map((k) => allText(v[k])).join('\n');
  }
  return '';
}

/** One record, split into the text a human typed and every other text, by source. */
interface Classified {
  human: string | null;
  other: Array<{ source: BasisSource; text: string }>;
}

function classify(rec: Record<string, unknown>): Classified {
  const other: Classified['other'] = [];
  if (rec.type === 'attachment') {
    const a = (rec.attachment ?? {}) as Record<string, unknown>;
    other.push({ source: 'hook context', text: allText(a.content) + '\n' + allText(a.text) });
    return { human: null, other };
  }
  const msg = (rec.message ?? rec) as { role?: unknown; content?: unknown };
  const role = typeof msg.role === 'string' ? msg.role : rec.type;
  const content = msg.content;
  // Only a `type: "user"` record can be a human turn. Claude Code also writes the raw API request
  // (`api-request-blob`, role user): reminders, sub-agent hand-backs and tool results, copied.
  // Any other typed record that carries a message is the same: text, never a turn.
  if (typeof rec.type === 'string' && rec.type !== 'user' && rec.type !== 'assistant') {
    const text = typeof content === 'string' ? content : allText(content);
    if (text.trim()) other.push({ source: rec.type === 'api-request-blob' ? 'raw API request copy' : 'injected message', text });
    return { human: null, other };
  }
  if (role === 'assistant') {
    other.push({ source: 'assistant text', text: typeof content === 'string' ? content : blockTexts(content, 'text').join('\n') });
    return { human: null, other };
  }
  if (role !== 'user') return { human: null, other };
  for (const t of blockTexts(content, 'tool_result')) other.push({ source: 'tool result', text: t });
  if (rec.isSidechain === true) {
    other.push({ source: 'sub-agent transcript', text: allText(content) });
    return { human: null, other };
  }
  const typed = humanTurnText(rec);
  if (typed === null) {
    const raw = typeof content === 'string' ? content : blockTexts(content, 'text').join('\n');
    if (raw.trim()) {
      other.push({
        source: isInjectedUserRecord(rec) ? 'injected message'
          : isSystemNoiseMessage(raw) ? 'sub-agent notification or skill-loader text'
            : 'injected message',
        text: raw,
      });
    }
    return { human: null, other };
  }
  // A whole turn the server writes (an Assistant or Super Agent event) is never the owner's.
  // A server turn's header may follow an injected block (a reminder before it): checked both ways.
  const injected = stripInjected(typed);
  if (isServerTurn(typed) || isServerTurn(injected)) {
    other.push({ source: 'dreamcontext prompt', text: typed });
    return { human: null, other };
  }
  if (injected.length < typed.length) other.push({ source: 'task data or injected block inside a turn', text: typed });
  // Every prompt dreamcontext types as a user turn (a kickoff, a delegate draft, the usage-limit
  // continue) is dropped sentence by sentence; what the owner typed around it stays.
  const { rest, matched } = stripAppPrompts(injected);
  if (matched.length > 0) other.push({ source: 'dreamcontext prompt', text: injected });
  if (isEmptyOfWords(rest)) return { human: null, other };
  return { human: rest, other };
}

export interface BasisMatch {
  ok: boolean;
  /** The session the words were found in (ok). */
  session?: string;
  /** Where the words DID appear when they were refused (empty = nowhere). */
  foundIn: BasisSource[];
  /** Transcripts that could not be searched (too large / unreadable). */
  skipped: string[];
  /** How many sessions were searched. */
  searched: number;
}

function* records(path: string): Generator<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec: unknown = JSON.parse(line);
      if (rec && typeof rec === 'object') yield rec as Record<string, unknown>;
    } catch {
      /* a torn last line is normal in a live transcript */
    }
  }
}

export interface OwnerTurn {
  /** What the owner typed, with injected blocks (reminders, hook tags, pasted content, the task fence) removed. */
  text: string;
  /** The record's timestamp, when it carries one. */
  at: string | null;
  /** The record's uuid, when it carries one (an idempotency handle for callers). */
  uuid: string | null;
}

/**
 * The owner's own turns in one transcript, in order: exactly the records this
 * module's classifier calls a human turn (so never a tool result, hook context,
 * a sub-agent notification, skill-loader text or a sub-agent transcript), with
 * the blocks a program writes into a typed turn stripped out. A transcript past
 * {@link MAX_TRANSCRIPT_BYTES}, or one that cannot be read, yields nothing.
 */
export function ownerTurns(path: string): OwnerTurn[] {
  const out: OwnerTurn[] = [];
  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return out;
    for (const rec of records(path)) {
      const c = classify(rec);
      if (!c.human) continue;
      const text = c.human.trim();
      if (!text) continue;
      out.push({
        text,
        at: typeof rec.timestamp === 'string' ? rec.timestamp : null,
        uuid: typeof rec.uuid === 'string' ? rec.uuid : null,
      });
    }
  } catch {
    return [];
  }
  return out;
}

/** `needle` (already in match form) appears in `text` as whole words, never inside one. */
function hasWords(text: string, needle: string): boolean {
  return ` ${matchForm(text)} `.includes(` ${needle} `);
}

function search(
  sessions: readonly BasisSession[],
  needle: string,
  accept: (c: Classified) => string[],
): BasisMatch {
  const foundIn = new Set<BasisSource>();
  const skipped: string[] = [];
  let searched = 0;
  for (const s of sessions) {
    try {
      if (statSync(s.path).size > MAX_TRANSCRIPT_BYTES) { skipped.push(s.path); continue; }
      searched++;
      for (const rec of records(s.path)) {
        const c = classify(rec);
        if (accept(c).some((t) => hasWords(t, needle))) {
          return { ok: true, session: s.id, foundIn: [], skipped, searched };
        }
        for (const o of c.other) if (hasWords(o.text, needle)) foundIn.add(o.source);
      }
    } catch {
      skipped.push(s.path);
    }
  }
  return { ok: false, foundIn: [...foundIn], skipped, searched };
}

/**
 * Function words that tie a quote to nothing, English and Turkish, ASCII-folded.
 * Shorter words are dropped by length.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'you', 'can', 'but', 'not', 'are', 'was', 'all', 'any', 'get', 'got',
  'let', 'our', 'its', 'has', 'had', 'how', 'why', 'who', 'now', 'yes', 'one', 'too', 'out',
  'this', 'that', 'with', 'from', 'have', 'make', 'please', 'could', 'would', 'should',
  'there', 'their', 'what', 'when', 'where', 'which', 'about', 'just', 'also', 'some', 'like',
  'want', 'need', 'into', 'then', 'than', 'them', 'they', 'your', 'will', 'been', 'were',
  'does', 'done', 'dont', 'lets', 'okay', 'maybe', 'really', 'very', 'more', 'much', 'only',
  'here', 'thing', 'things',
  'bir', 'ile', 'ama', 'ben', 'sen', 'biz', 'siz', 'var', 'yok', 'cok', 'icin', 'gibi', 'daha',
  'sonra', 'once', 'bunu', 'bunlar', 'sana', 'bana', 'simdi', 'lutfen', 'yani', 'olsun',
  'olarak', 'kadar', 'diye', 'neden', 'nasil', 'her', 'sey', 'seyi', 'bence', 'bile', 'artik',
  'zaten', 'tamam', 'evet', 'hayir', 'yap', 'yapar', 'yapalim', 'misin', 'musun',
]);

/** Content-word stems: 3+ characters, not a function word, cut to their first 6. */
function contentStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of matchForm(text).split(' ')) {
    if (w.length < 3 || FUNCTION_WORDS.has(w)) continue;
    out.add(w.slice(0, 6));
  }
  return out;
}

/**
 * Is this quote about this subject (the task's name, description and Why)? True
 * when they share at least one content word. A real owner line on another topic
 * is no basis for this task.
 */
export function quoteIsAbout(quote: string, subject: string): boolean {
  const q = contentStems(quote);
  for (const w of contentStems(subject)) if (q.has(w)) return true;
  return false;
}

/** Problems with the words themselves, before any transcript is read; null when fine. */
export function quoteProblem(quote: string | undefined): string | null {
  const q = matchForm(quote ?? '');
  if (q.length < MIN_QUOTE_CHARS || q.split(' ').length < MIN_QUOTE_WORDS) {
    return `--quote must be the owner's own words, verbatim: at least ${MIN_QUOTE_WORDS} words and ${MIN_QUOTE_CHARS} characters (got "${(quote ?? '').trim()}").`;
  }
  return null;
}

/** Did a human type these words in one of these sessions? */
export function verifyAskQuote(sessions: readonly BasisSession[], quote: string): BasisMatch {
  return search(sessions, matchForm(quote), (c) => (c.human ? [c.human] : []));
}

/** Do these words appear in a tool result or a human turn of one of these sessions? */
export function verifyDefectEvidence(sessions: readonly BasisSession[], evidence: string): BasisMatch {
  return search(sessions, matchForm(evidence), (c) => [
    ...(c.human ? [c.human] : []),
    ...c.other.filter((o) => o.source === 'tool result').map((o) => o.text),
  ]);
}

/** Do these words appear anywhere a person or a tool wrote them (a proposal's alıntı)? */
export function verifyProposalQuote(sessions: readonly BasisSession[], quote: string): BasisMatch {
  return search(sessions, matchForm(quote), (c) => [
    ...(c.human ? [c.human] : []),
    ...c.other.filter((o) => o.source === 'assistant text' || o.source === 'tool result').map((o) => o.text),
  ]);
}

/** One line naming why a match was refused, for a CLI refusal. */
export function describeMiss(m: BasisMatch, what: string): string {
  const where = m.foundIn.length > 0
    ? ` It appears only in: ${m.foundIn.join(', ')} — not something the owner typed.`
    : m.searched === 0
      ? ' No session transcript of this sleep was found to check it against.'
      : ` Not found in the ${m.searched} session(s) being consolidated.`;
  const skipped = m.skipped.length > 0 ? ` (${m.skipped.length} transcript(s) could not be read.)` : '';
  return `${what}${where}${skipped}`;
}
