import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The hook half of "a Chat tab is named by the agent talking in it".
 *
 * The surface briefing asks the agent for a `title` dream-view once it understands the work,
 * but it is one rule among many in a long system prompt, and measured on 2026-09-27 only ~1
 * chat in 5 ever wrote one — the rest sat at "Chat N" all day. A rule that must not be missed
 * belongs in the hook (pattern: hook-delivered must-not-miss rules), so every user prompt in a
 * chat whose agent has not named its tab yet carries one line saying so. Once any assistant
 * message in the transcript carries a title block it goes silent for good, which also covers a
 * resumed conversation that was named yesterday.
 *
 * The chat spawn exports `DREAMCONTEXT_CHAT_TAB=1` (routes/agent-chat.ts); the terminal and the
 * Assistant do not, so neither is nudged about a tab they cannot name.
 *
 * The nudge alone did not move the number: on 2026-10-04, 1 tab in 6 was named, every one of
 * the other five had been nudged on every prompt. It rides inside a UserPromptSubmit blob big
 * enough to be persisted to a file, and "once you know what the work is" lets a long turn end
 * without it. So the Stop hook now holds the turn open ONCE (`chatTabTitleStopBlock`): the
 * agent writes the block in a short continuation, which draws nothing in the chat.
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
  const roster = readJson(join(contextRoot, 'state', '.agent-sessions.json'));
  const entry = Array.isArray(roster?.sessions)
    ? (roster!.sessions as Array<Record<string, unknown>>).find((m) => m && m.sessionId === tabId)
    : undefined;
  if (!entry) return true;
  if (entry.titleByAgent === true) return false;
  return typeof entry.title !== 'string' || DEFAULT_TAB_TITLE_RE.test(entry.title.trim());
}

/** The line to print on UserPromptSubmit, or null. Pure apart from the file reads. */
export function chatTabTitleNudge(
  env: NodeJS.ProcessEnv, transcriptPath: string | undefined,
  contextRoot: string | null = null, home?: string,
): string | null {
  if (env.DREAMCONTEXT_CHAT_TAB !== '1') return null;
  if (!tabWantsAgentTitle(env, contextRoot, home)) return null;
  if (transcriptPath && transcriptHasAgentTitle(transcriptPath)) return null;
  return CHAT_TAB_TITLE_NUDGE;
}

/** What the Stop hook hands back as `reason` — the agent reads it as the next user turn. */
export const CHAT_TAB_TITLE_STOP_REASON =
  'Before you finish: this Chat tab still has its default name. Reply with ONLY the tab-name ' +
  'block, no other words (it is drawn nowhere, the tab takes it):\n\n' +
  '```dream-view\n{"type":"title","text":"<2-5 plain words>"}\n```\n\n' +
  "Name the work this chat is about, in the user's language, spaced like a sentence, never a " +
  'slug or hyphens.';

const TITLE_IN_TEXT_RE = /"type"\s*:\s*"title"/;

/**
 * The Stop hook's `{decision:'block', reason}` for a Chat tab whose agent ended a turn
 * without naming it, or null. `stop_hook_active` is Claude Code's own "you already blocked
 * this stop" flag, so it asks at most once per turn and can never loop.
 */
export function chatTabTitleStopBlock(
  env: NodeJS.ProcessEnv,
  input: { stop_hook_active?: unknown; transcript_path?: unknown; last_assistant_message?: unknown },
  contextRoot: string | null, home?: string,
): { decision: 'block'; reason: string } | null {
  if (env.DREAMCONTEXT_CHAT_TAB !== '1') return null;
  if (input.stop_hook_active === true) return null;
  if (typeof input.last_assistant_message === 'string' && TITLE_IN_TEXT_RE.test(input.last_assistant_message)) return null;
  if (!tabWantsAgentTitle(env, contextRoot, home)) return null;
  if (typeof input.transcript_path === 'string' && transcriptHasAgentTitle(input.transcript_path)) return null;
  return { decision: 'block', reason: CHAT_TAB_TITLE_STOP_REASON };
}
