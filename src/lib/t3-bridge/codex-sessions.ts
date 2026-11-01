/**
 * This project's past Codex threads, as "Past chats" rows (plan r5 §4c): only threads whose
 * rollout says they started in this project, realpath'd, the same ownership rule every other
 * Codex route uses. Everything is read from `~/.codex/sessions`; a rollout is parsed once per
 * mtime + size.
 *
 * A thread a tab ran under keeps the tab's id as its row id, so the list knows it is open and a
 * pick lands on that tab; its name is the tab's remembered name.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { UUID_RE } from '../agent-session-map.js';
import { foldCase, isUnattendedRun, matchSnippet, oneLine, promptLabel, type PastSession } from '../transcript-sessions.js';
import { parseCodexRolloutHistory } from './codex-history.js';
import { CODEX_THREAD_RE, codexRolloutCwd, findCodexRollout } from './codex-threads.js';

export type CodexPastSession = PastSession & { tool: 'codex'; unattended: boolean };

/** Rollouts looked at per listing, newest day first: bounds a machine with years of threads. */
const MAX_ROLLOUTS = 2000;
const MAX_CACHED = 4000;

interface Summary {
  readonly id: string;
  readonly prompts: readonly string[];
  readonly startedAt: number | null;
  readonly gitBranch: string;
}

interface Rollout { readonly path: string; readonly id: string; readonly mtimeMs: number; readonly size: number }

const cache = new Map<string, { mtimeMs: number; size: number; summary: Summary | null; cwd: string | null }>();

/** The newest rollouts on disk (`sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`). */
export function listCodexRollouts(codexHome: string, max = MAX_ROLLOUTS): Rollout[] {
  const root = join(codexHome, 'sessions');
  const out: Rollout[] = [];
  const dirs = (p: string): string[] => {
    try { return readdirSync(p).filter((n) => /^\d{2,4}$/.test(n)).sort().reverse(); } catch { return []; }
  };
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    let names: string[] = [];
    try { names = readdirSync(join(root, y, m, d)); } catch { continue; }
    for (const name of names) {
      const id = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1];
      if (!id || !CODEX_THREAD_RE.test(id)) continue;
      const path = join(root, y, m, d, name);
      try {
        const st = statSync(path);
        if (st.isFile()) out.push({ path, id: id.toLowerCase(), mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* gone */ }
    }
    if (out.length >= max) return out;
  }
  return out;
}

function summarize(r: Rollout): Summary | null {
  let raw: string;
  try { raw = readFileSync(r.path, 'utf-8'); } catch { return null; }
  const items = parseCodexRolloutHistory(raw);
  const prompts = items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text);
  // A thread nobody said anything in is not a chat.
  if (!prompts.length) return null;
  const firstAt = (items[0] as { at?: number } | undefined)?.at ?? null;
  let gitBranch = '';
  try {
    const meta = JSON.parse(raw.slice(0, raw.indexOf('\n'))) as { payload?: { git?: { branch?: unknown } } };
    if (typeof meta.payload?.git?.branch === 'string') gitBranch = meta.payload.git.branch.slice(0, 200);
  } catch { /* no branch */ }
  return { id: r.id, prompts, startedAt: firstAt, gitBranch };
}

function read(r: Rollout, cwdOnly: boolean): { cwd: string | null; summary: Summary | null } {
  const hit = cache.get(r.path);
  if (hit && hit.mtimeMs === r.mtimeMs && hit.size === r.size && (cwdOnly || hit.summary)) return hit;
  const cwd = hit && hit.mtimeMs === r.mtimeMs && hit.size === r.size ? hit.cwd : codexRolloutCwd(r.path);
  const summary = cwdOnly ? null : summarize(r);
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(r.path, { mtimeMs: r.mtimeMs, size: r.size, summary, cwd });
  return { cwd, summary };
}

/** Did this Codex thread run with nobody at it? Its rollout's first prompt says, from its first
 *  turn on: no hook notes a Codex run, and its binding lands only when it ends. */
export function codexThreadUnattended(thread: string, home: string = homedir()): boolean {
  const path = findCodexRollout(thread, join(home, '.codex'));
  if (!path) return false;
  try {
    const st = statSync(path);
    const { summary } = read({ path, id: thread.toLowerCase(), mtimeMs: st.mtimeMs, size: st.size }, false);
    return !!summary && isUnattendedRun(promptLabel(summary.prompts[0]!));
  } catch { return false; }
}

/** Tests: forget what was read. */
export function clearCodexSessionCache(): void {
  cache.clear();
}

const real = (p: string): string | null => {
  try { return realpathSync(p); } catch { return null; }
};

/** Thread id → the tab that last ran it, from the tab map (`state/.agent-session-map/<tab>.json`). */
export function tabsByThread(contextRoot: string): Map<string, string> {
  const dir = join(contextRoot, 'state', '.agent-session-map');
  const out = new Map<string, string>();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const tab = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!UUID_RE.test(tab)) continue;
    try {
      const { current } = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as { current?: unknown };
      if (typeof current === 'string' && CODEX_THREAD_RE.test(current) && current !== tab) out.set(current.toLowerCase(), tab);
    } catch { /* a torn entry names nothing */ }
  }
  return out;
}

export function listCodexSessions(
  projectRoot: string,
  o: {
    home?: string;
    query?: string;
    limit?: number;
    contextRoot?: string;
    titles?: ReadonlyMap<string, string>;
  } = {},
): CodexPastSession[] {
  const project = real(projectRoot);
  if (!project) return [];
  const codexHome = join(o.home ?? homedir(), '.codex');
  const limit = o.limit ?? 200;
  const tokens = foldCase((o.query ?? '').trim()).split(/\s+/).filter(Boolean);
  const tabs = o.contextRoot ? tabsByThread(o.contextRoot) : new Map<string, string>();
  const rows: CodexPastSession[] = [];
  for (const r of listCodexRollouts(codexHome).sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    if (rows.length >= limit) break;
    const { cwd } = read(r, true);
    if (!cwd || real(cwd) !== project) continue;
    const { summary } = read(r, false);
    if (!summary) continue;
    const id = tabs.get(r.id) ?? r.id;
    const remembered = o.titles?.get(id) ?? o.titles?.get(r.id);
    const title = remembered || oneLine(promptLabel(summary.prompts[0]!), 120);
    const last = summary.prompts[summary.prompts.length - 1]!;
    let hit: Pick<PastSession, 'match' | 'matchIn'> = {};
    if (tokens.length) {
      const inTitle = foldCase(title);
      const lines = [title, ...summary.prompts.map((p) => oneLine(p, 400))];
      const hay = foldCase(lines.join('\n'));
      if (!tokens.every((t) => hay.includes(t))) continue;
      hit = { match: matchSnippet(lines, tokens[0]!), matchIn: tokens.every((t) => inTitle.includes(t)) ? 'title' : 'prompt' };
    }
    const preview = summary.prompts.length > 1 ? oneLine(last, 120) : '';
    rows.push({
      id, title, named: !!remembered, preview, updatedAt: r.mtimeMs, startedAt: summary.startedAt,
      sizeBytes: r.size, gitBranch: summary.gitBranch, agentRun: false, tool: 'codex',
      unattended: isUnattendedRun(promptLabel(summary.prompts[0]!)), ...hit,
    });
  }
  return rows;
}

const RANK: Record<string, number> = { title: 0, prompt: 1, content: 2 };

/** Claude rows and Codex rows as one list: newest first, or by match rank on a queried listing. */
export function mergeSessionRows<R extends { updatedAt: number; matchIn?: string }>(a: readonly R[], b: readonly R[], limit: number, queried: boolean): R[] {
  const rank = (r: R): number => (queried ? RANK[r.matchIn ?? ''] ?? 3 : 0);
  return [...a, ...b].sort((x, y) => rank(x) - rank(y) || y.updatedAt - x.updatedAt).slice(0, limit);
}
