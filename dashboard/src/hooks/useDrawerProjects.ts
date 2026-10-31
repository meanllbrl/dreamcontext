/**
 * The chat drawer's rows for projects this window has NOT mounted (D7): client fan-out over the
 * existing routes, no new route. Each project's own `ApiClient` sends its vault header.
 *
 * Read for an expanded project that is not mounted (a mounted one publishes its own facts):
 *  - `GET /agent/sessions?summary=1`: tab count and the Super flag, never the drafts;
 *  - `GET /agents`, `/automations`, `/automations/threads` → `buildRoster`, members with work.
 *
 * Polls every 15 s (through `pollMs`) only while the drawer is on screen and the window
 * focused, at most `DRAWER_POLL_CAP` projects; the rest are read once when they expand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from '../api/client';
import type { AgentSummary } from './useAgents';
import type { AgentFeed, AutomationSummary } from './useAutomations';
import { buildRoster, type TeamAgent } from '../components/aiteam/teamModel';
import {
  DRAWER_POLL_MS, fanoutTargets, teamRowsOf, type FanoutFacts,
} from '../components/layout/newshell/drawerModel';
import { pollMs, useWindowActivity } from '../lib/windowActivity';

export async function readFanoutFacts(vault: string): Promise<FanoutFacts> {
  const api = new ApiClient(vault);
  const [summary, agents, automations, feed] = await Promise.all([
    api.get<{ tabs?: unknown; superOn?: unknown; perWindow?: unknown; superWorking?: unknown; superAsking?: unknown }>('/agent/sessions?summary=1').catch(() => null),
    api.get<{ agents: AgentSummary[] }>('/agents').then((r) => r.agents).catch(() => []),
    api.get<{ automations: AutomationSummary[] }>('/automations').then((r) => r.automations).catch(() => []),
    api.get<AgentFeed>('/automations/threads').catch(() => null),
  ]);
  return {
    tabs: typeof summary?.tabs === 'number' ? summary.tabs : 0,
    superOn: summary?.superOn === true,
    superMarks: { working: typeof summary?.superWorking === 'number' ? summary.superWorking : 0, asking: summary?.superAsking === true },
    team: teamRowsOf(buildRoster(agents as TeamAgent[], automations, feed)),
    ...(Array.isArray(summary?.perWindow) ? { windows: perWindowOf(summary.perWindow) } : {}),
  };
}

/** The summary's windows, each checked (the reply is another project's, read over the wire). */
export function perWindowOf(raw: unknown[]): Array<{ id: string; name: string; tabs: number }> {
  return raw.flatMap((w) => {
    if (!w || typeof w !== 'object') return [];
    const o = w as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.name !== 'string') return [];
    return [{ id: o.id, name: o.name, tabs: typeof o.tabs === 'number' && o.tabs >= 0 ? o.tabs : 0 }];
  });
}

export function useDrawerProjects(expanded: readonly string[], mounted: readonly string[], visible: boolean): Record<string, FanoutFacts> {
  const activity = useWindowActivity();
  const live = visible && activity.focused && !activity.hidden;
  const [facts, setFacts] = useState<Record<string, FanoutFacts>>({});
  const { poll, once } = useMemo(
    () => fanoutTargets(expanded, mounted, live),
    // Arrays by value: a parent re-render with the same names must not restart the polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded.join('\n'), mounted.join('\n'), live],
  );
  const readOnce = useRef(new Set<string>());

  // Once: every far project not yet read (a project that expands while the drawer is hidden is
  // read when it shows).
  useEffect(() => {
    if (!visible) return;
    let gone = false;
    const started: string[] = [];
    const landed = new Set<string>();
    for (const v of [...poll, ...once]) {
      if (readOnce.current.has(v)) continue;
      readOnce.current.add(v);
      started.push(v);
      void readFanoutFacts(v).then((f) => {
        landed.add(v);
        if (!gone) setFacts((prev) => ({ ...prev, [v]: f }));
      }, () => { /* each read already degrades to empty; this keeps the chain quiet */ });
    }
    // A read cut short by a change (another project expanded, focus moved) is read again next time.
    return () => {
      gone = true;
      for (const v of started) if (!landed.has(v)) readOnce.current.delete(v);
    };
  }, [poll, once, visible]);

  // Then every 15 s, the capped few.
  useEffect(() => {
    if (!poll.length) return undefined;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      timer = setTimeout(() => {
        void Promise.all(poll.map((v) => readFanoutFacts(v).then((f) => [v, f] as const)))
          .then((pairs) => { if (!gone) setFacts((prev) => ({ ...prev, ...Object.fromEntries(pairs) })); })
          .catch((err) => console.warn('[drawer] a project read failed:', err))
          // A failed round never stops the polling.
          .finally(() => { if (!gone) tick(); });
      }, pollMs(DRAWER_POLL_MS));
    };
    tick();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [poll]);

  // A project collapsed or mounted: its reading may be re-done fresh next time.
  useEffect(() => {
    for (const v of [...readOnce.current]) {
      if (!expanded.includes(v) || mounted.includes(v)) readOnce.current.delete(v);
    }
  }, [expanded, mounted]);

  return facts;
}
