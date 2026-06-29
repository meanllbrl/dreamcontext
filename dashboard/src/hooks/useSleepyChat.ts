import { api } from '../api/client';

/** UI tiers — the underlying model (sonnet/opus) is intentionally hidden. */
export type ChatTier = 'normal' | 'intelligent';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  tools?: string[];
  ts: number;
}

export interface ChatHistory {
  messages: ChatMessage[];
  hasSession: boolean;
  tier: ChatTier;
}

/** A single Server-Sent event from the chat stream. */
export interface ChatStreamEvent {
  kind: 'meta' | 'thinking' | 'text' | 'tool' | 'done' | 'error';
  text?: string;
  sessionId?: string;
  message?: string;
}

/** Load the persisted transcript for the active vault (hydration on mount). */
export function getChatHistory(): Promise<ChatHistory> {
  return api.get<ChatHistory>('/sleepy/chat');
}

/** Wipe the session id + transcript — the next message starts a fresh session. */
export function resetChat(): Promise<{ ok: boolean }> {
  return api.post<{ ok: boolean }>('/sleepy/chat/reset', {});
}

/**
 * Start a turn. Spawns a headless `claude` in the vault project dir (resuming the
 * stored session unless `reset`), and returns a run id. The caller then opens the
 * SSE stream for that run via {@link streamChat}.
 */
export async function startChat(message: string, model: ChatTier, reset = false): Promise<string> {
  const res = await api.post<{ ok: boolean; runId: string }>('/sleepy/chat', { message, model, reset });
  return res.runId;
}

interface StreamHandlers {
  onMeta?: (sessionId: string) => void;
  onThinking?: (text: string) => void;
  onText?: (text: string) => void;
  onTool?: (name: string) => void;
  onDone?: (finalText: string) => void;
  onError?: (message: string) => void;
}

/**
 * Subscribe to a run's live stream over SSE. The server replays any events it
 * already buffered, then forwards thinking/text/tool deltas until done. Returns a
 * cleanup function that closes the connection. EventSource is a same-origin GET —
 * no vault header is needed because the run id is the capability.
 */
export function streamChat(runId: string, handlers: StreamHandlers): () => void {
  const es = new EventSource(`/api/sleepy/chat/stream?id=${encodeURIComponent(runId)}`);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };

  es.onmessage = (e) => {
    if (!e.data) return;
    let ev: ChatStreamEvent;
    try { ev = JSON.parse(e.data) as ChatStreamEvent; } catch { return; }
    switch (ev.kind) {
      case 'meta': if (ev.sessionId) handlers.onMeta?.(ev.sessionId); break;
      case 'thinking': if (ev.text) handlers.onThinking?.(ev.text); break;
      case 'text': if (ev.text) handlers.onText?.(ev.text); break;
      case 'tool': if (ev.text) handlers.onTool?.(ev.text); break;
      case 'done': handlers.onDone?.(ev.text ?? ''); close(); break;
      case 'error': handlers.onError?.(ev.message ?? 'Something went wrong.'); close(); break;
    }
  };
  es.onerror = () => {
    // A network drop after the stream completed is benign; only surface it if we
    // were still mid-stream.
    if (!closed) { handlers.onError?.('The connection to Sleepy dropped.'); close(); }
  };

  return close;
}
