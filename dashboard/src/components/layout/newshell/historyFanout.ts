/**
 * History "All projects" (D7): the existing `GET /agent/chat-sessions?q=` asked of every
 * registered project, at most {@link HISTORY_PARALLEL} at once, the first
 * {@link HISTORY_PER_VAULT} of each, merged by time. Content search builds a per-project index,
 * so the caller debounces and a newer query stops this one launching more requests.
 *
 * Every row carries its `vault`, so a pick reopens the chat in ITS OWN project.
 */
export const HISTORY_PER_VAULT = 30;
export const HISTORY_PARALLEL = 3;
export const HISTORY_DEBOUNCE_MS = 300;

export interface FanRow { id: string; updatedAt: number }

export interface FanResult<T extends FanRow> {
  sessions: Array<T & { vault: string }>;
  total: number;
  agentRuns: number;
  /** Projects whose read failed (named, never silently dropped). */
  failed: string[];
}

export function historyPath(q: string, agentRuns: boolean, limit: number): string {
  return `/agent/chat-sessions?limit=${limit}&q=${encodeURIComponent(q.trim())}${agentRuns ? '&agentRuns=1' : ''}`;
}

export async function fanOutHistory<T extends FanRow>(
  vaults: readonly string[],
  read: (vault: string) => Promise<{ sessions: T[]; total?: number; agentRuns?: number }>,
  /** False once a newer query took over: no more requests start. */
  current: () => boolean,
): Promise<FanResult<T>> {
  const out: FanResult<T> = { sessions: [], total: 0, agentRuns: 0, failed: [] };
  let next = 0;
  const worker = async () => {
    while (next < vaults.length && current()) {
      const vault = vaults[next++];
      try {
        const r = await read(vault);
        for (const s of r.sessions.slice(0, HISTORY_PER_VAULT)) out.sessions.push({ ...s, vault });
        out.total += r.total ?? r.sessions.length;
        out.agentRuns += r.agentRuns ?? 0;
      } catch {
        out.failed.push(vault);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HISTORY_PARALLEL, vaults.length) }, worker));
  out.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}
