import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanTabTitle } from './chat-view-spec.js';

/**
 * How a Chat tab gets its name.
 *
 * History: the surface briefing asks the agent for a `title` dream-view, but only ~1 chat in 5
 * wrote one (2026-09-27), so a per-prompt nudge was added, then (2026-10-04, still 1 in 6) a Stop
 * block that held the first turn open ONCE for the name. Measured 2026-11-12 that block cost one
 * extra full-context turn in 37% of sessions (median 186,759 cache-read tokens to write ~34).
 *
 * Now the tab is named OUT OF BAND: the chat server derives a name from the owner's first
 * message ({@link titleFromOwnerMessage}) and hands it to the tab as a `_meta/tab_title` frame;
 * the tab takes it only while it still carries its default "Chat N" name, marked as the agent's
 * so the agent may still rename it with its own `title` block (the briefing keeps that rule).
 * Neither the nudge nor the Stop block is sent any more: both return null. They stay exported
 * because the hook and the Codex bridge still call them.
 *
 * The chat spawn exports `DREAMCONTEXT_CHAT_TAB=1` (routes/agent-chat.ts); the terminal and the
 * Assistant do not.
 */
export const CHAT_TAB_TITLE_NUDGE =
  'This Chat tab still has its default name. In this reply, once you know what the work is, ' +
  'include the tab-name dream-view from your surface briefing (type "title", 2-5 plain words ' +
  "in the user's language, spaced like a sentence, never a slug or hyphens). It is drawn " +
  'nowhere; the tab takes it.';

/** An assistant line whose text holds a `{"type":"title",...}` view — JSON-escaped in JSONL. */
const TITLE_VIEW_RE = /\\"type\\"\s*:\s*\\"title\\"/;

/**
 * Whether an ASSISTANT message in this transcript already wrote a title block. Only assistant
 * lines count: the briefing's own example and this nudge (hook output lands in the transcript
 * too) must not read as the agent having done it. A missing or unreadable transcript is "not
 * yet" — the first prompt of a fresh chat arrives before the file exists.
 */
export function transcriptHasAgentTitle(transcriptPath: string): boolean {
  let raw: string;
  try { raw = readFileSync(transcriptPath, 'utf-8'); } catch { return false; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"assistant"') || !TITLE_VIEW_RE.test(line)) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; isSidechain?: boolean; message?: { content?: unknown } };
      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const blocks = Array.isArray(entry.message?.content) ? entry.message!.content as Array<{ type?: string; text?: unknown }> : [];
      if (blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && /"type"\s*:\s*"title"/.test(b.text))) return true;
    } catch { /* a torn last line is not a title */ }
  }
  return false;
}

/** Mirrors the dashboard's DEFAULT_TAB_TITLE_RE (AgentSurface.tsx): the names we hand out. */
const DEFAULT_TAB_TITLE_RE = /^(?:Agent|Chat) \d+$/;

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

/**
 * Whether the tab would actually TAKE a title — the app's own gate, read from disk, so the
 * hook never spends a turn on a name the surface will throw away:
 *  - the auto-name switch (~/.dreamcontext/agent-ui.json, same migration rule as
 *    `coerceAgentSettings`: an explicit `false` only counts past the default-on flip);
 *  - the tab's roster entry (`state/.agent-sessions.json`): a name the user or a purpose
 *    gave it wins, and `titleByAgent` means the agent already named it — which also covers
 *    a conversation that rotated (`/clear`, a context hand-off) away from the transcript
 *    that holds the title.
 * An unreadable file or a tab not in the roster yet reads as "still default".
 */
export function tabWantsAgentTitle(env: NodeJS.ProcessEnv, contextRoot: string | null, home: string = homedir()): boolean {
  const ui = readJson(join(home, '.dreamcontext', 'agent-ui.json'));
  if (ui && (ui.enabled === false || (ui.titleMigrated === true && ui.autoTitle === false))) return false;
  const tabId = env.DREAMCONTEXT_TAB_SESSION;
  if (!contextRoot || !tabId) return true;
  // The desktop's roster, then a Mac-mode phone's (its own file, same shape).
  let entry: Record<string, unknown> | undefined;
  for (const file of ['.agent-sessions.json', '.agent-sessions.phone.json']) {
    const roster = readJson(join(contextRoot, 'state', file));
    entry = Array.isArray(roster?.sessions)
      ? (roster!.sessions as Array<Record<string, unknown>>).find((m) => m && m.sessionId === tabId)
      : undefined;
    if (entry) break;
  }
  if (!entry) return true;
  if (entry.titleByAgent === true) return false;
  return typeof entry.title !== 'string' || DEFAULT_TAB_TITLE_RE.test(entry.title.trim());
}

/** The line to print on UserPromptSubmit, or null. Pure apart from the file reads. */
export function chatTabTitleNudge(
  _env: NodeJS.ProcessEnv, _transcriptPath: string | undefined,
  _contextRoot: string | null = null, _home?: string,
): string | null {
  // Retired: the server names the tab from the owner's first message (see the header).
  return null;
}

/** What the Stop hook hands back as `reason` — the agent reads it as the next user turn. */
export const CHAT_TAB_TITLE_STOP_REASON =
  'Before you finish: this Chat tab still has its default name. Reply with ONLY the tab-name ' +
  'block, no other words (it is drawn nowhere, the tab takes it):\n\n' +
  '```dream-view\n{"type":"title","text":"<2-5 plain words>"}\n```\n\n' +
  "Name the work this chat is about, in the user's language, spaced like a sentence, never a " +
  'slug or hyphens.';

/**
 * The Stop hook's `{decision:'block', reason}` for a Chat tab whose agent ended a turn
 * without naming it, or null. `stop_hook_active` is Claude Code's own "you already blocked
 * this stop" flag, so it asks at most once per turn and can never loop.
 */
export function chatTabTitleStopBlock(
  _env: NodeJS.ProcessEnv,
  _input: { stop_hook_active?: unknown; transcript_path?: unknown; last_assistant_message?: unknown },
  _contextRoot: string | null, _home?: string,
): { decision: 'block'; reason: string } | null {
  // Retired: a held-open Stop re-read the whole context to write ~34 tokens (see the header).
  return null;
}

/** Bracket headers the app writes into a message: `[Picture 2: path]`, `[About …]`, `[Reply …]`. */
const APP_HEADER_RE = /\[(?:Picture \d+|About|Reply)\b[^\]\n]*\]/g;
/** A clause ends at sentence punctuation, a colon or semicolon, a dash between spaces, or a line. */
const CLAUSE_END_RE = /[.!?;:\n\u2026]|\s[-\u2013\u2014]\s/;
const MAX_TITLE_WORDS = 6;

/**
 * A tab name from the owner's own words, or null when they hold nothing nameable (a greeting,
 * a bare slash command, only a path or a picture). Pure, no model call: the first clause of the
 * message, stripped of what the app or a paste put there (pasted blocks, code, picture and reply
 * headers, tags, links, paths), at most {@link MAX_TITLE_WORDS} words, cleaned by the same rule
 * as an agent's `title` block. Needs two words, so "hi" or "devam" waits for the next message
 * (the first three clauses are tried).
 */
export function titleFromOwnerMessage(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  let t = text
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/gi, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^>]*)?>/g, ' ')
    .replace(APP_HEADER_RE, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/(^|[\s(])(?:~|\.{1,2})?\/[^\s)]*/g, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\b[\w.-]+\/[\w./-]+/g, ' ')
    .replace(/[`*_]+/g, '')
    .replace(/^[ \t]*(?:#+|>|[-+]|\d+[.)])[ \t]+/gm, '');
  // A leading slash command is the app's verb, not the subject.
  t = t.replace(/^\s*\/[\w:-]+/, ' ');
  // The first clause that names something; a greeting before it ("Merhaba.") is skipped.
  let tried = 0;
  for (const raw of t.split(CLAUSE_END_RE)) {
    const clause = raw.replace(/\s+/g, ' ').trim();
    if (!clause) continue;
    if (++tried > 3) break;
    let words = clause.split(' ');
    // A comma usually starts the next thought ("fix X, it drops Y"): the part before it names it.
    const comma = clause.indexOf(',');
    if (comma > 0) {
      const head = clause.slice(0, comma).split(' ');
      if (head.filter((w) => /\p{L}/u.test(w)).length >= 2) words = head;
    }
    words = words.slice(0, MAX_TITLE_WORDS);
    const lettered = words.filter((w) => /\p{L}/u.test(w));
    if (lettered.length < 2) continue;
    const joined = words.join(' ').replace(/[,\s]+$/, '');
    const cleaned = cleanTabTitle(joined)?.replace(/[,;:\s]+$/, '') ?? null;
    if (!cleaned) return null;
    // Sentence case, except a leading i/ı whose capital depends on the language.
    const first = cleaned[0]!;
    return /[iı]/.test(first) ? cleaned : first.toUpperCase() + cleaned.slice(1);
  }
  return null;
}
