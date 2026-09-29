/**
 * A mode picked for an OPEN conversation reaches the model — even though its system prompt
 * cannot change.
 *
 * ── The defect this closes ────────────────────────────────────────────────────────────
 * A chat's mode is its `--append-system-prompt-file` (chat-modes.ts), and a mode switch on an
 * open chat respawns the SAME conversation with `--resume` and the new file
 * (`AgentSurface.changeChatMode`). That stopped working: Claude Code 2.1.x writes the system
 * prompt into the transcript as a `prompt_snapshot` attachment when the conversation is born,
 * and a `--resume` RESTORES it from there instead of rebuilding it — the new append file is
 * read and ignored. Measured 2026-09-29 (CLI 2.1.281): born with "codeword ALPHA", resumed
 * with an append file saying "BETA", the model answered ALPHA; a fresh session with the BETA
 * file answered BETA; both snapshots in the transcript still said ALPHA. Owner's report: the
 * badge read "Plan", the model kept building in Basic.
 *
 * ── The fix: tell the conversation, not the system prompt ─────────────────────────────
 * What a resume CAN still add is conversation content. A SessionStart hook's
 * `additionalContext` is persisted into the transcript as a `hook_additional_context`
 * attachment, and — measured the same day — a note saying "this replaces the mode
 * instructions in your system prompt" wins over the stale snapshot, and keeps winning on later
 * resumes with no hook at all ("Originally ALPHA, now BETA").
 *
 * ── Ask the transcript, not the registry ──────────────────────────────────────────────
 * Which mode the model is ACTUALLY holding is read from the transcript itself (the latest
 * snapshot, then any later note of ours), never from `.agent-sessions.json`: the registry
 * records the mode the UI asked for, which is precisely the value that drifted from the truth.
 * A compaction summarises our notes away but not the snapshot, so a `compact_boundary` drops
 * them and the model is back to the snapshot's mode — which is why the hook also runs on
 * `compact`.
 *
 * No snapshot at all (an older CLI) means the append file still works on resume: nothing to
 * do. The Assistant is out of scope — its brief is bound to its own vault and never switched.
 */
import type { ChatMode } from './chat-modes.js';

/** What the model can be holding: a chat mode, or `none` — a conversation born OUTSIDE the
 *  Chat view (a terminal session resumed into a chat), whose system prompt has no mode. */
export type HeldMode = ChatMode | 'none';

/** Stamped into every note we inject, so a later resume can tell which mode the model was
 *  last told. Only read out of `hook_additional_context` attachments — never out of message
 *  text, where a conversation ABOUT this marker (this repo's own) would fake it. */
const MARKER_RE = /<!-- dreamcontext-chat-mode:([a-z]+) -->/g;
const marker = (mode: ChatMode) => `<!-- dreamcontext-chat-mode:${mode} -->`;

const SURFACE_HEAD = '# Surface: dreamcontext Chat';
const MODE_HEADINGS: Array<[string, ChatMode]> = [
  ['# Mode: Plan', 'plan'],
  ['# Mode: Develop', 'develop'],
  ['# Mode: Train Me', 'train'],
  ['# Mode: dreamcontext Assistant', 'assistant'],
];

const MODE_LABEL: Record<ChatMode, string> = {
  basic: 'Basic', plan: 'Plan', develop: 'Develop', train: 'Train Me', assistant: 'Assistant',
};

/** The mode a system prompt was briefed with. A heading must open a line — a mode NAMED in
 *  passing elsewhere in the prompt is not a brief. The surface briefing with no mode heading
 *  is Basic (its brief carries no heading — at one time it was empty). */
export function modeFromSystemPrompt(text: string): HeldMode {
  for (const [heading, mode] of MODE_HEADINGS) {
    if (new RegExp(`(^|\\n)${heading}\\s*\\n`).test(text)) return mode;
  }
  return text.includes(SURFACE_HEAD) ? 'basic' : 'none';
}

const isChatMode = (m: string): m is ChatMode =>
  (Object.keys(MODE_LABEL) as string[]).includes(m);

/**
 * Which mode the model is holding, read from a transcript's JSONL text.
 *
 * `snapshot` — the mode its (latest) system-prompt snapshot was briefed with; what a
 * compaction falls back to. `held` — that, overridden by the last note of ours after it and
 * after the last compaction. `null` when there is no snapshot: that CLI rebuilds the system
 * prompt on resume, so the append file is honoured and there is nothing to correct.
 */
export function heldModeFromTranscript(jsonl: string): { snapshot: HeldMode; held: HeldMode } | null {
  let snapshot: HeldMode | null = null;
  let held: HeldMode | null = null;
  for (const line of jsonl.split('\n')) {
    // Cheap pre-filter: transcripts run to tens of MB and only three kinds of line matter.
    if (!line.includes('prompt_snapshot') && !line.includes('hook_additional_context')
      && !line.includes('compact_boundary')) continue;
    let o: { type?: string; subtype?: string; attachment?: { type?: string; systemPrompt?: unknown; content?: unknown } };
    try { o = JSON.parse(line); } catch { continue; }
    const a = o.attachment;
    if (a?.type === 'prompt_snapshot') {
      const sp = Array.isArray(a.systemPrompt) ? a.systemPrompt.join('\n') : String(a.systemPrompt ?? '');
      snapshot = held = modeFromSystemPrompt(sp);
    } else if (a?.type === 'hook_additional_context' && snapshot !== null) {
      const text = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
      for (const m of text.matchAll(MARKER_RE)) if (isChatMode(m[1])) held = m[1];
    } else if (o.type === 'system' && o.subtype === 'compact_boundary' && snapshot !== null) {
      held = snapshot;
    }
  }
  return snapshot === null || held === null ? null : { snapshot, held };
}

/**
 * The note that switches the conversation to `to`. It has to say, in so many words, that it
 * REPLACES the system prompt's mode section — measured: without that the model sees two
 * briefs and has no reason to prefer the later one. `brief` is `modeBriefing(to, …)`.
 */
export function modeSwitchNote(from: HeldMode, to: ChatMode, brief: string): string {
  const fromLabel = from === 'none' ? 'no chat mode' : `${MODE_LABEL[from]} mode`;
  const lines = [
    marker(to),
    `# Chat mode is now: ${MODE_LABEL[to]}`,
    '',
    `The user switched this conversation to ${MODE_LABEL[to]} mode after it began. Your system`,
    `prompt was written when it started, in ${fromLabel}, and could not be updated: its mode`,
    'section (a "# Mode: …" heading, or the absence of one) is OUTDATED. Any mode instructions',
    'given earlier in this conversation are outdated too. The instructions below REPLACE them',
    'and apply from now on.',
  ];
  if (to === 'basic') {
    lines.push('', 'Basic is plain Claude Code: no Plan, Develop or Train Me procedure applies. Work',
      'normally, including editing code when asked.');
  }
  return `${lines.join('\n')}\n\n${brief.trim()}\n`;
}

/**
 * Should this spawn inject a note, and on which SessionStart sources? `resume` when the model
 * holds a different mode than `mode` right now; `compact` whenever the SNAPSHOT differs,
 * because a compaction drops our notes and falls back to it. `[]` = nothing to do.
 */
export function modeNoteSources(state: { snapshot: HeldMode; held: HeldMode } | null, mode: ChatMode): Array<'resume' | 'compact'> {
  if (!state || mode === 'assistant' || state.snapshot === 'assistant') return [];
  const sources: Array<'resume' | 'compact'> = [];
  if (state.held !== mode) sources.push('resume');
  if (state.snapshot !== mode) sources.push('compact');
  return sources;
}

/** The `--settings` JSON that runs `command` (which prints `hookOutput`) on those sources. */
export function modeNoteSettings(command: string, sources: Array<'resume' | 'compact'>): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: sources.join('|'), hooks: [{ type: 'command', command }] }],
    },
  });
}

/** What the hook prints: a SessionStart `additionalContext` carrying the note. */
export function modeNoteHookOutput(note: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note } });
}
