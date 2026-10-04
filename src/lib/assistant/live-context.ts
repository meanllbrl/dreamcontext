import { activityOf, type ChatEntry } from './chat-registry.js';

/**
 * What is happening RIGHT NOW, attached to every owner message the Assistant receives.
 *
 * Owner, 2026-10-04: "the assistant always knows every session, and when I talk it sees them
 * and knows what I am doing at that time." The roster in the briefing is written once, at spawn,
 * and goes stale within minutes; this block is rebuilt for each owner turn.
 *
 * NO PROJECT TEXT, BY CONSTRUCTION. Every value is server-owned: a registered vault name
 * (sanitised), a UUID, enums, durations, a tool name reduced to `[A-Za-z0-9_:.-]`, an
 * automation slug. Chat titles, replies and questions are deliberately absent — those are other
 * agents' words, and carrying them in the owner's own turn would either launder them as the
 * owner's voice or taint every turn (and so turn every `auto` verb into a proposal). The
 * Assistant reads a session's words with `dreamcontext assistant sessions`, which taints as it
 * should.
 *
 * The block starts with `<`, so the transcript replay (`transcript-history.ts userPromptOf`)
 * drops it and a resumed conversation shows only what the owner said.
 */

export interface LiveRunningAutomation { vault: string; slug: string; since: number }

export interface LiveContextInput {
  chats: ChatEntry[];
  /** The project the owner is looking at, or null (another app). */
  lookingAt: string | null;
  running: LiveRunningAutomation[];
  /** Notifications waiting in the notch, by kind. */
  waiting: { finished: number; posts: number; account: number };
  now?: number;
}

const MAX_CHATS = 16;
const MAX_RUNNING = 8;

const safeName = (v: string) => v.replace(/[^\p{L}\p{N} _.-]/gu, '_').slice(0, 64);
const safeTool = (t: string) => t.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 64);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** "45s", "12m", "3h" — how long a state has held. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const RANK: Record<string, number> = { asking: 0, working: 1, starting: 2, stale: 3, idle: 4 };

export function buildLiveContext(input: LiveContextInput): string {
  const now = input.now ?? Date.now();
  const local = new Date(now);
  const hhmm = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  const lines: string[] = [
    `<live-context written-by="dreamcontext server" at="${hhmm}">`,
    'Server-written state, not the owner\'s words. Contains no project text.',
    input.lookingAt
      ? `Owner is looking at: ${safeName(input.lookingAt)} (its window is focused)`
      : 'Owner is looking at: no dreamcontext window (another app, or away)',
  ];

  const rows = input.chats
    .map((c) => ({ c, a: activityOf(c, now) }))
    .filter(({ a }) => a !== 'gone')
    .sort((x, y) => (RANK[x.a] ?? 9) - (RANK[y.a] ?? 9) || Date.parse(y.c.updatedAt) - Date.parse(x.c.updatedAt));
  const busy = rows.filter(({ a }) => a !== 'idle');
  const idle = rows.length - busy.length;
  if (busy.length === 0) {
    lines.push(`Live chats: none working or asking${idle ? ` (${idle} idle)` : ''}.`);
  } else {
    lines.push('Live chats (project · session · mode · state · for):');
    for (const { c, a } of busy.slice(0, MAX_CHATS)) {
      const since = Date.parse(a === 'stale' ? c.lastFrameAt : c.updatedAt);
      let state: string = a;
      if (a === 'asking' && c.pendingQuestion) {
        state = c.pendingQuestion.isPermission
          ? `asking permission for ${safeTool(c.pendingQuestion.toolName) || 'a tool'}`
          : 'asking the owner a question';
      } else if (a === 'working' && c.toolsInFlight > 0) {
        state = `working (${c.toolsInFlight} tool call${c.toolsInFlight === 1 ? '' : 's'} open)`;
      }
      lines.push(`- ${safeName(c.vault)} · ${c.sessionId} · ${safeName(c.mode)} · ${state} · ${span(now - (Number.isFinite(since) ? since : now))}`);
    }
    if (busy.length > MAX_CHATS) lines.push(`- … and ${busy.length - MAX_CHATS} more`);
    if (idle) lines.push(`(${idle} more open but idle)`);
  }

  const running = input.running.filter((r) => SLUG_RE.test(r.slug));
  if (running.length) {
    lines.push(`Automations running: ${running.slice(0, MAX_RUNNING).map((r) => `${safeName(r.vault)}/${r.slug} (${span(now - r.since)})`).join(', ')}`);
  }
  const w = input.waiting;
  if (w.finished + w.posts + w.account > 0) {
    const parts = [
      w.finished ? `${w.finished} finished chat${w.finished === 1 ? '' : 's'}` : '',
      w.posts ? `${w.posts} unread automation post${w.posts === 1 ? '' : 's'}` : '',
      w.account ? `${w.account} account notice${w.account === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    lines.push(`Waiting in the notch for the owner: ${parts.join(', ')}.`);
  }
  lines.push('</live-context>');
  return lines.join('\n');
}
