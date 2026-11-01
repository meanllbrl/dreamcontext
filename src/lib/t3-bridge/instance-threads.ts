/**
 * What an Antigravity chat said, kept by the bridge. The agent's threads live in a private profile
 * in its own format, so a reopened pane, History and an account move read this instead: the owner's
 * words and the final answers, one JSON line each, with the project on the first line. 0600 under
 * the T3 state root. Tool cards are not kept.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChatHistoryItem } from '../transcript-history.js';
import { tabsByThread } from './codex-sessions.js';

const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TEXT = 200_000;
/** How much of the earlier conversation an account move carries. */
export const MAX_CARRY = 16_000;

export const threadsDir = (home: string): string => join(home, '.dreamcontext', 't3', 'threads');
const fileOf = (id: string, home: string): string | null => (THREAD_RE.test(id) ? join(threadsDir(home), `${id}.jsonl`) : null);
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

export function recordThreadTurn(id: string, cwd: string, role: Turn['role'], text: string, home: string = homedir(), account = '', from = ''): void {
  const file = fileOf(id, home);
  if (!file || !text.trim()) return;
  try {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${JSON.stringify({ cwd, account: account || 'primary' })}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    appendFileSync(file, `${JSON.stringify({ role, text: text.slice(0, MAX_TEXT), at: Date.now(), ...(from ? { from } : {}) })}\n`);
  } catch { /* the chat goes on: only its replay is lost */ }
}

/** `carried`: the end of an earlier thread this one started from: read by a later move, never replayed. */
interface Turn { role: 'user' | 'assistant' | 'carried'; text: string; at?: number; from?: string }

function readThread(id: string, home: string): { cwd: string; account: string; turns: Turn[] } | null {
  const file = fileOf(id, home);
  if (!file) return null;
  try {
    const [head, ...rest] = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const { cwd, account } = JSON.parse(head ?? '{}') as { cwd?: unknown; account?: unknown };
    if (typeof cwd !== 'string') return null;
    const turns: Turn[] = [];
    for (const line of rest) {
      try {
        const t = JSON.parse(line) as Partial<Turn>;
        if ((t.role === 'user' || t.role === 'assistant' || t.role === 'carried') && typeof t.text === 'string') turns.push(t as Turn);
      } catch { /* a torn line is skipped */ }
    }
    return { cwd, account: typeof account === 'string' && account ? account : 'primary', turns };
  } catch {
    return null;
  }
}

const ownedBy = (thread: { cwd: string }, project: string): boolean => {
  const mine = real(project);
  return !!mine && real(thread.cwd) === mine;
};

/** The pane's history, only for a thread of this project. */
export function instanceHistory(o: { thread: string; contextRoot: string | null; home?: string }): { items: ChatHistoryItem[] } | 'refuse' {
  if (!o.thread) return { items: [] };
  const found = readThread(o.thread, o.home ?? homedir());
  if (!found) return { items: [] };
  if (!o.contextRoot || !ownedBy(found, dirname(o.contextRoot))) return 'refuse';
  return { items: replayTurns(o.thread, dirname(o.contextRoot), o.home ?? homedir(), 0).map((t) => ({ kind: t.role === 'user' ? 'user' as const : 'text' as const, text: t.text, ...(t.at ? { at: t.at } : {}) })) };
}

/** A thread's turns, after those of the threads it moved on from: a move is one conversation here. */
function replayTurns(id: string, project: string, home: string, depth: number): Turn[] {
  const found = readThread(id, home);
  if (!found || !ownedBy(found, project)) return [];
  const from = found.turns.find((t) => t.role === 'carried')?.from;
  const earlier = from && from !== id && depth < 8 ? replayTurns(from, project, home, depth + 1) : [];
  return [...earlier, ...found.turns.filter((t) => t.role !== 'carried')];
}

/** The account holding a thread of this project, or null when the thread is not this project's. */
export function instanceThreadAccount(thread: string, project: string, home: string = homedir()): string | null {
  const found = readThread(thread, home);
  return found && ownedBy(found, project) ? found.account : null;
}

/** The end of an earlier thread, for the fresh thread an account move opens. '' = nothing to carry. */
export function carriedText(thread: string, project: string, home: string = homedir()): string {
  const found = readThread(thread, home);
  if (!found || !ownedBy(found, project)) return '';
  const text = found.turns.map((t) => (t.role === 'carried' ? t.text : `${t.role === 'user' ? 'Owner' : 'Assistant'}: ${t.text}`)).join('\n\n');
  return text.slice(-MAX_CARRY);
}

export interface InstancePastSession {
  id: string; title: string; named: boolean; preview: string; updatedAt: number; startedAt: number | null;
  sizeBytes: number; gitBranch: string; agentRun: boolean; tool: 'antigravity'; match?: string; matchIn?: string;
}

/** This project's Antigravity threads for History, newest first. */
export function listInstanceSessions(projectRoot: string, o: { home?: string; query?: string; limit?: number; contextRoot?: string; titles?: ReadonlyMap<string, string> } = {}): InstancePastSession[] {
  const home = o.home ?? homedir();
  const q = (o.query ?? '').trim().toLowerCase();
  const tabs = o.contextRoot ? tabsByThread(o.contextRoot) : new Map<string, string>();
  let names: string[] = [];
  try { names = readdirSync(threadsDir(home)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const rows: InstancePastSession[] = [];
  for (const name of names) {
    const thread = name.slice(0, -6);
    const found = readThread(thread, home);
    if (!found || !ownedBy(found, projectRoot)) continue;
    const prompts = found.turns.filter((t) => t.role === 'user').map((t) => t.text.replace(/\s+/g, ' ').trim());
    if (!prompts.length) continue;
    const id = tabs.get(thread.toLowerCase()) ?? thread;
    const remembered = o.titles?.get(id) ?? o.titles?.get(thread);
    const title = remembered || prompts[0]!.slice(0, 120);
    if (q && !`${title}\n${prompts.join('\n')}`.toLowerCase().includes(q)) continue;
    let stat: { mtimeMs: number; size: number };
    try { stat = statSync(join(threadsDir(home), name)); } catch { continue; }
    rows.push({
      id, title, named: !!remembered, preview: prompts.length > 1 ? prompts[prompts.length - 1]!.slice(0, 120) : '',
      updatedAt: stat.mtimeMs, startedAt: found.turns[0]?.at ?? null, sizeBytes: stat.size, gitBranch: '', agentRun: false,
      tool: 'antigravity', ...(q ? { match: title, matchIn: title.toLowerCase().includes(q) ? 'title' : 'prompt' } : {}),
    });
  }
  // A pane opened from History keeps its id across a move: the newest thread is its row, and it
  // replays the older one.
  const seen = new Set<string>();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt).filter((r) => !seen.has(r.id) && !!seen.add(r.id)).slice(0, o.limit ?? 200);
}
