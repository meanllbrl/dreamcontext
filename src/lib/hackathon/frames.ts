/**
 * Live frames (plan C5): each team's members and its "computer screen", from the team's own
 * transcripts (the last tool event). No model call, no git call. Every string passes the pattern
 * redactor (`[gizli]`) and a length cut; the transcript tail is read, never the whole file.
 */
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../telegram/format.js';
import type { Design, TeamDesign } from './designer.js';
import { runDir } from './run-store.js';

export type MemberRole = 'kaptan' | 'yapici' | 'elestirmen';
export type MemberState = 'working' | 'asking' | 'idle';
export type ScreenKind = 'edit' | 'read' | 'bash' | 'browser' | 'note';

export interface Screen { role: MemberRole; kind: ScreenKind; path?: string; lines?: string[]; command?: string; resultLine?: string; screenshot?: string }
export interface Frame { team: string; members: { role: MemberRole; state: MemberState }[]; screen: Screen | null; updatedAt: string | null; edited: string[]; reads: number; ended: boolean }

export const TAIL_BYTES = 256 * 1024;
export const LIVE_MS = 90_000;
const LINE_MAX = 160;

const cut = (s: string, n = LINE_MAX) => redactSecrets(s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The last `bytes` of a file (never through a link). */
export function readTail(path: string, bytes = TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return '';
    fd = openSync(path, 'r');
    const n = Math.min(st.size, bytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, st.size - n);
    const s = buf.toString('utf-8');
    return st.size > n ? s.slice(s.indexOf('\n') + 1) : s;
  } catch {
    return '';
  } finally {
    if (fd != null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** A team's transcripts, oldest first (by mtime): one per turn (r1, r2, …, sunum). */
export function teamTranscripts(contextRoot: string, runId: string, team: string): { path: string; mtime: number }[] {
  const dir = join(runDir(contextRoot, runId), 'teams', team);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { path: string; mtime: number }[] = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (st.isFile()) out.push({ path: join(dir, n), mtime: st.mtimeMs });
    } catch { /* gone */ }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

/** The newest transcript of a team (by mtime) and its mtime. */
export function latestTranscript(contextRoot: string, runId: string, team: string): { path: string; mtime: number } | null {
  return teamTranscripts(contextRoot, runId, team).pop() ?? null;
}

interface ToolEvent { id?: string; role: MemberRole; name: string; input: Record<string, unknown>; result?: string; at: number }

function roleOfAgent(input: Record<string, unknown>): MemberRole {
  const t = String(input.subagent_type ?? input.agent ?? '').toLowerCase();
  return t.includes('elestir') || t.includes('eleştir') ? 'elestirmen' : 'yapici';
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: unknown }).text) : '')).join('\n');
  return '';
}

/** Tool events from a Claude stream-json or a Codex --json transcript. */
export function parseEvents(raw: string): { events: ToolEvent[]; ended: boolean } {
  const events: ToolEvent[] = [];
  const byId = new Map<string, ToolEvent>();
  /** Sub-agent tool_use id → its role. */
  const agentRole = new Map<string, MemberRole>();
  let ended = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = o.type;
    if (type === 'result' || type === 'turn.completed' || type === 'refused') { ended = true; continue; }
    if (type === 'system' && o.subtype === 'init') { ended = false; continue; }
    if (type === 'assistant' || type === 'user') {
      const parent = typeof o.parent_tool_use_id === 'string' ? o.parent_tool_use_id : null;
      const role: MemberRole = parent ? agentRole.get(parent) ?? 'yapici' : 'kaptan';
      const content = ((o.message as { content?: unknown } | undefined)?.content ?? []) as unknown[];
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const b = c as Record<string, unknown>;
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
          const ev: ToolEvent = { id: String(b.id ?? ''), role, name: b.name, input, at: events.length };
          if (b.name === 'Agent' || b.name === 'Task') agentRole.set(ev.id!, roleOfAgent(input));
          events.push(ev);
          if (ev.id) byId.set(ev.id, ev);
        } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const ev = byId.get(b.tool_use_id);
          if (ev) ev.result = resultText(b.content);
        }
      }
      ended = false;
      continue;
    }
    // Codex `exec --json`: item.started / item.completed.
    if ((type === 'item.completed' || type === 'item.started') && o.item && typeof o.item === 'object') {
      const it = o.item as Record<string, unknown>;
      if (it.type === 'command_execution') {
        events.push({ role: 'kaptan', name: 'Bash', input: { command: it.command }, result: typeof it.aggregated_output === 'string' ? it.aggregated_output : undefined, at: events.length });
      } else if (it.type === 'file_change' && Array.isArray(it.changes)) {
        for (const ch of it.changes as { path?: unknown }[]) events.push({ role: 'kaptan', name: 'Edit', input: { file_path: ch.path }, at: events.length });
      }
      ended = false;
    }
  }
  return { events, ended };
}

function screenOf(ev: ToolEvent, repo: string): Screen {
  const rel = (p: unknown) => {
    const s = typeof p === 'string' ? p : '';
    return cut(s.startsWith(repo) ? s.slice(repo.length + 1) : s.split('/').slice(-3).join('/'), 120);
  };
  const lastLine = (s?: string) => (s ? cut(s.trim().split('\n').filter(Boolean).pop() ?? '') : undefined);
  switch (ev.name) {
    case 'Edit': case 'Write': case 'MultiEdit': {
      const body = String(ev.input.new_string ?? ev.input.content ?? '');
      return { role: ev.role, kind: 'edit', path: rel(ev.input.file_path), lines: body.split('\n').slice(0, 6).map((l) => cut(l)) };
    }
    case 'Read': case 'Grep': case 'Glob':
      return { role: ev.role, kind: 'read', path: rel(ev.input.file_path ?? ev.input.path ?? ev.input.pattern) };
    case 'Bash':
      return { role: ev.role, kind: 'bash', command: cut(String(ev.input.command ?? ''), 200), resultLine: lastLine(ev.result) };
    default:
      return { role: ev.role, kind: 'note', lines: [cut(`${ev.name}`)] };
  }
}

/**
 * One team's frame now. Live state and the screen come from the newest turn; the files it edited
 * and the sources it read count the whole run (every turn's transcript), so a new round does not
 * read as "0 files changed" for a team that changed files in an earlier one. A turn that has made
 * no move yet shows the team's last move from an earlier turn.
 */
export function teamFrame(contextRoot: string, runId: string, team: TeamDesign, repo: string, now: number = Date.now()): Frame {
  const all = teamTranscripts(contextRoot, runId, team.id);
  const t = all[all.length - 1];
  const roles: MemberRole[] = team.inner === 'trio' ? ['kaptan', 'yapici', 'elestirmen'] : ['kaptan'];
  if (!t) return { team: team.id, members: roles.map((role) => ({ role, state: 'idle' })), screen: null, updatedAt: null, edited: [], reads: 0, ended: false };
  const turns = all.map((x) => parseEvents(readTail(x.path)));
  const { events, ended } = turns[turns.length - 1]!;
  const everything = turns.flatMap((x) => x.events);
  const live = !ended && now - t.mtime < LIVE_MS;
  const last = events[events.length - 1];
  const shown = last ?? everything[everything.length - 1];
  const openAgent = [...events].reverse().find((e) => (e.name === 'Agent' || e.name === 'Task') && e.result === undefined);
  const members = roles.map((role) => {
    let state: MemberState = 'idle';
    if (live) {
      if (role === 'kaptan') state = openAgent ? 'asking' : last?.role === 'kaptan' ? 'working' : 'idle';
      else state = openAgent && roleOfAgent(openAgent.input) === role ? 'working' : 'idle';
    }
    return { role, state };
  });
  const inRepo = (e: ToolEvent) => typeof e.input.file_path === 'string' && e.input.file_path.startsWith(`${repo}/`);
  const editedAll = everything.filter((e) => ['Edit', 'Write', 'MultiEdit'].includes(e.name) && inRepo(e)).map((e) => screenOf(e, repo).path!).filter(Boolean);
  // Newest last, each path once (at its latest edit).
  const edited = editedAll.filter((p, i) => editedAll.lastIndexOf(p) === i).slice(-30);
  return {
    team: team.id,
    members,
    screen: shown ? screenOf(shown, repo) : null,
    updatedAt: new Date(t.mtime).toISOString(),
    edited,
    reads: everything.filter((e) => ['Read', 'Grep', 'Glob'].includes(e.name)).length,
    ended,
  };
}

export function runFrames(contextRoot: string, runId: string, design: Design, repoOf: (team: string) => string, now?: number): Frame[] {
  return design.teams.map((t) => teamFrame(contextRoot, runId, t, repoOf(t.id), now));
}
