import { readFileSync } from 'node:fs';

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

/** The line to print on UserPromptSubmit, or null. Pure apart from the transcript read. */
export function chatTabTitleNudge(env: NodeJS.ProcessEnv, transcriptPath: string | undefined): string | null {
  if (env.DREAMCONTEXT_CHAT_TAB !== '1') return null;
  if (transcriptPath && transcriptHasAgentTitle(transcriptPath)) return null;
  return CHAT_TAB_TITLE_NUDGE;
}
