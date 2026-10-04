/**
 * transcript-history — parse a Claude Code transcript JSONL into replayable
 * items.
 *
 * Extracted from `server/routes/agent-chat.ts` (which still re-exports it, so
 * its callers and tests are unchanged) because three surfaces now need the
 * same answer to "what happened in that session": the chat view replaying a
 * resumed conversation, the dashboard showing what an unattended automation
 * did, and `dreamcontext automations session` doing the same from a terminal.
 * A second parser for the third caller would drift from this one within a
 * release, and this file's whole reason for existing is that it is tolerant of
 * a log format written by a DIFFERENT program than ours.
 *
 * Pure: no I/O, no fs, no http. That is what lets the CLI use it without
 * pulling the server in.
 */

/** One replayed transcript item — the wire shape of `chat-history`'s `items`, mirroring the
 *  client's ChatItem vocabulary (chatSession.ts) minus live-only bookkeeping. */
export interface ChatHistoryItem {
  kind: 'user' | 'text' | 'thinking' | 'tool' | 'compact';
  uuid?: string;
  text?: string;
  toolUseId?: string;
  name?: string;
  input?: unknown;
  status?: 'done' | 'error';
  result?: unknown;
  /** When the transcript wrote this row, epoch ms. Absent when the row carries no timestamp. */
  at?: number;
  /** A tool's result row time, epoch ms: when the call finished. */
  endAt?: number;
  /** A `compact` item: what started it and the window before and after. Its `text` is the raw
   *  summary Claude Code wrote, which the client trims for display. */
  trigger?: 'manual' | 'auto';
  preTokens?: number;
  postTokens?: number;
}

/** A transcript row's own `timestamp`, as epoch ms, or undefined. Never 0: that is no time. */
function rowTime(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Ceiling on replayed items — a months-old conversation can hold thousands of entries;
 *  the tail is what a returning user needs (and rewind targets live there too). */
export const HISTORY_MAX_ITEMS = 500;
/** Per-value ceiling for tool inputs/results (a single Read result can be hundreds of KB —
 *  pointless over the seed payload; the collapsible card shows the head + a truncation mark). */
export const HISTORY_MAX_VALUE_CHARS = 4000;

export function truncateValue(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (typeof v === 'string') {
    return v.length > HISTORY_MAX_VALUE_CHARS ? v.slice(0, HISTORY_MAX_VALUE_CHARS) + '\n… [truncated]' : v;
  }
  try {
    const s = JSON.stringify(v);
    if (s.length <= HISTORY_MAX_VALUE_CHARS) return v;
    return s.slice(0, HISTORY_MAX_VALUE_CHARS) + '… [truncated]';
  } catch { return String(v); }
}

/**
 * The text a HUMAN typed in one `user` transcript entry — `''` when the entry is not a
 * human prompt at all: a tool result, a meta/synthetic entry, or a `<…>`-wrapped command
 * stub / system reminder / caveat block (the CLI writes several of those as ordinary
 * `user` entries).
 *
 * Shared by the transcript REPLAY below and the past-sessions index
 * (`transcript-sessions.ts`), so "what counts as something the user said" is decided in
 * exactly ONE place. The two disagreeing is how a resumed conversation replays clean while
 * the same session shows up in the history picker titled `<command-name>clear</command-name>`.
 *
 * Does NOT apply the `isSidechain` guard — that one means opposite things in a parent
 * transcript and in a sub-agent's own file, so it stays with each caller (see the note in
 * {@link parseTranscriptHistory}).
 */
export function userPromptOf(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const o = obj as {
    type?: unknown; isMeta?: unknown; isSynthetic?: unknown;
    message?: { content?: unknown };
  };
  if (o.type !== 'user') return '';
  if (o.isMeta === true || o.isSynthetic === true) return '';
  // A compaction's summary: written as a `user` entry, never typed by anyone.
  if ((o as { isCompactSummary?: unknown }).isCompactSummary === true) return '';
  const content = o.message?.content;
  if (typeof content === 'string') {
    const text = content.trim();
    return text && !text.startsWith('<') ? text : '';
  }
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    const t = b.text.trim();
    if (t && !t.startsWith('<')) texts.push(t);
  }
  return texts.join('\n').trim();
}

/**
 * Parse a Claude Code transcript JSONL into replayable history items. Exported pure for
 * unit tests. Tolerates every foreign entry type (`summary`, `file-history-snapshot`,
 * queued-command stubs, …) and malformed lines by skipping them — a transcript is an
 * append-only log written by a different program version than ours, so unknown shapes are
 * the NORM, not an error. Filters what a human never typed: meta/synthetic entries and
 * `<`-wrapped command/reminder stubs.
 *
 * `opts.sidechain` says WHICH transcript this is, because the same parser reads both and the
 * `isSidechain` marker means opposite things in each: in a PARENT transcript it marks another
 * agent's turns (drop them — see the guard below), while in a SUB-AGENT's own file every entry
 * carries it and dropping them would empty the drill-in. Default false = parent.
 */
export function parseTranscriptHistory(raw: string, opts: { sidechain?: boolean } = {}): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  const toolPos = new Map<string, number>(); // tool_use_id -> index in items
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj: {
      type?: unknown; uuid?: unknown; isMeta?: unknown; isSynthetic?: unknown;
      isSidechain?: unknown; timestamp?: unknown; subtype?: unknown; isCompactSummary?: unknown;
      compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown };
      message?: { role?: unknown; content?: unknown };
    };
    try { obj = JSON.parse(s); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // A SUB-AGENT's turn, not this conversation's. CLI 2.1.220 keeps sub-agent turns in a
    // separate `<uuid>/subagents/agent-<taskId>.jsonl` (verified across 15 real transcripts:
    // zero `isSidechain` entries in the main file, and every entry of a sampled subagent file
    // carries it), so this guards conversations written by an OLDER CLI that inlined them —
    // resuming one would replay every sub-agent Read/Bash into the parent transcript, the same
    // leak the live path had. `isSidechain` is the only discriminant confirmed present on real
    // sidechain entries, and the one this repo's usage accounting already trusts
    // (agent-terminal.ts's `isSidechain !== true`). Skipped when READING a sidechain file:
    // there the marker is on every entry and is not a foreign-turn signal at all.
    if (!opts.sidechain && obj.isSidechain === true) continue;
    // Where the row sits in time: how a reopened chat places a card no call names.
    const at = rowTime(obj.timestamp);
    const when = at != null ? { at } : {};

    // A compaction: the boundary row carries the token drop, the summary row right after it the
    // text (CLI 2.1.261). One item from the pair; a summary with no boundary before it still shows.
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      const m = obj.compactMetadata ?? {};
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      items.push({
        kind: 'compact',
        ...(m.trigger === 'manual' || m.trigger === 'auto' ? { trigger: m.trigger } : {}),
        ...(num(m.preTokens) !== undefined ? { preTokens: num(m.preTokens) } : {}),
        ...(num(m.postTokens) !== undefined ? { postTokens: num(m.postTokens) } : {}),
        ...when,
      });
      continue;
    }
    if (obj.type === 'user' && obj.isCompactSummary === true) {
      const content = obj.message?.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : '';
      const last = items[items.length - 1];
      if (last?.kind === 'compact' && last.text === undefined) items[items.length - 1] = { ...last, text };
      else items.push({ kind: 'compact', text, ...when });
      continue;
    }

    if (obj.type === 'user') {
      if (obj.isMeta === true || obj.isSynthetic === true) continue;
      const content = obj.message?.content;
      const uuid = typeof obj.uuid === 'string' ? obj.uuid : undefined;
      // tool_result backfill — the one part of a user entry that MUTATES an
      // already-pushed item, so it can't live in the shared text extractor. Runs
      // before the push below, exactly as it did when both were one loop.
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const pos = toolPos.get(b.tool_use_id);
          if (pos !== undefined) {
            items[pos] = {
              ...items[pos],
              status: b.is_error === true ? 'error' : 'done',
              result: truncateValue(b.content),
              ...(at != null ? { endAt: at } : {}),
            };
          }
        }
      }
      const text = userPromptOf(obj);
      if (text) items.push({ kind: 'user', uuid, text, ...when });
      continue;
    }

    if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          items.push({ kind: 'text', text: b.text, ...when });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          items.push({ kind: 'thinking', text: b.thinking, ...when });
        } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          toolPos.set(b.id, items.length);
          items.push({ kind: 'tool', toolUseId: b.id, name: b.name, input: truncateValue(b.input), status: 'done', ...when });
        }
      }
      continue;
    }
    // Every other entry type (system, summary, file-history-snapshot, …) — not transcript UI.
  }
  return items.length > HISTORY_MAX_ITEMS ? items.slice(-HISTORY_MAX_ITEMS) : items;
}

/**
 * A one-line label for a tool call, for surfaces that list what a session DID
 * rather than replaying it (the CLI's `automations session`, the dashboard's
 * run drill-in). Deliberately reads the handful of argument names this repo's
 * own tools use and falls back to the bare tool name — a label is a
 * convenience, never a parser, so an unrecognized tool degrades to its name
 * instead of dumping raw JSON at someone reading a terminal.
 */
export function toolCallLabel(item: ChatHistoryItem): string {
  const name = item.name ?? 'tool';
  const input = item.input;
  if (!input || typeof input !== 'object') return name;
  const rec = input as Record<string, unknown>;
  const detail =
    pickString(rec.command) ??
    pickString(rec.file_path) ??
    pickString(rec.path) ??
    pickString(rec.pattern) ??
    pickString(rec.query) ??
    pickString(rec.url) ??
    pickString(rec.description);
  if (!detail) return name;
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return `${name} ${oneLine.length > 88 ? `${oneLine.slice(0, 87)}…` : oneLine}`;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
