/**
 * A Codex rollout → the chat history items a reopened pane draws (the same `ChatHistoryItem`
 * shape `parseTranscriptHistory` gives a Claude transcript).
 *
 * Only what the owner and the agent said and did: developer messages, and user messages that are
 * injected context (`<environment_context>`, `<user_instructions>`, any `<tag>`-wrapped block a
 * harness adds), are skipped, so neither a briefing nor brain context ever renders as owner text.
 */
import type { ChatHistoryItem } from '../transcript-history.js';

const MAX_ITEMS = 2000;
const MAX_TEXT = 20_000;

type Rec = { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };

const at = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function textOf(content: unknown, kind: 'input_text' | 'output_text'): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === kind && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
}

/** A user message a harness injected rather than the owner typed. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return /^<[a-z_][a-z0-9_-]*[\s>]/i.test(t);
}

export function parseCodexRolloutHistory(raw: string): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  const tools = new Map<string, ChatHistoryItem>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec: Rec;
    try { rec = JSON.parse(line) as Rec; } catch { continue; }
    if (rec.type !== 'response_item' || !rec.payload) continue;
    const p = rec.payload;
    const when = at(rec.timestamp);
    if (p.type === 'message') {
      if (p.role === 'user') {
        const text = textOf(p.content, 'input_text');
        if (text.trim() && !isInjectedUserText(text)) items.push({ kind: 'user', text: text.slice(0, MAX_TEXT), ...(when ? { at: when } : {}) });
      } else if (p.role === 'assistant') {
        const text = textOf(p.content, 'output_text');
        if (text.trim()) items.push({ kind: 'text', text: text.slice(0, MAX_TEXT), ...(when ? { at: when } : {}) });
      }
      continue;
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const id = typeof p.call_id === 'string' ? p.call_id : `call-${items.length}`;
      const rawInput = p.arguments ?? p.input ?? p.action ?? null;
      const item: ChatHistoryItem = {
        kind: 'tool',
        toolUseId: id,
        name: 'Bash',
        input: { command: typeof rawInput === 'string' ? rawInput.slice(0, MAX_TEXT) : JSON.stringify(rawInput ?? '').slice(0, MAX_TEXT) },
        ...(when ? { at: when } : {}),
      };
      tools.set(id, item);
      items.push(item);
      continue;
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const id = typeof p.call_id === 'string' ? p.call_id : '';
      const item = tools.get(id);
      if (!item) continue;
      const out = typeof p.output === 'string' ? p.output : textOf(p.output, 'input_text') || JSON.stringify(p.output ?? '');
      item.result = out.slice(0, MAX_TEXT);
      item.status = /Script failed|exit code [1-9]/i.test(out.slice(0, 200)) ? 'error' : 'done';
      if (when) item.endAt = when;
    }
  }
  // The newest items, as a Claude history keeps its newest: a long thread shows where it is now.
  return items.length > MAX_ITEMS ? items.slice(-MAX_ITEMS) : items;
}
