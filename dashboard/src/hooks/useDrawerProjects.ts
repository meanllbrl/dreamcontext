/**
 * The chat drawer's rows for projects this window has NOT mounted (D7): client fan-out over the
 * existing routes, no new route. Each project's own `ApiClient` sends its vault header.
 *
 * Read for a project that is not mounted (a mounted one publishes its own facts):
 *  - `GET /agent/sessions?summary=1`: tab count and the Super flag, never the drafts;
 *  - `GET /agents`, `/automations`, `/automations/threads` → `buildRoster`, members with work.
 *
 * Polls every 15 s (through `pollMs`) only while the drawer is on screen and the window
 * focused, at most `DRAWER_POLL_CAP` projects; the rest are read once when they expand.
 *
 * A folded project's row needs its Super Agent's marks and its Ekip row (plan-r10 1d): the same
 * summary (its `members`) and `GET /agents` (names, faces), under the same rule, for at most
 * `DRAWER_POLL_CAP` projects. Past the cap a row has no ring and no Ekip row.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from '../api/client';
import type { AgentSummary } from './useAgents';
import type { AgentFeed, AutomationSummary } from './useAutomations';
import { buildRoster, type EkipIdentity, type EkipSummary, type TeamAgent } from '../components/aiteam/teamModel';
import {
  DRAWER_POLL_MS, fanoutTargets, fanoutWithMarks, foldedTargets, headlessRowsOf, type DrawerEkipFacts, type FanoutFacts,
} from '../components/layout/newshell/drawerModel';
import { moveBefore } from '../components/sleepy/chatWindows';
import { pollMs, useWindowActivity } from '../lib/windowActivity';

type SuperMarks = NonNullable<FanoutFacts['superMarks']>;

function marksOf(summary: { superWorking?: unknown; superAsking?: unknown } | null): SuperMarks {
  return { working: typeof summary?.superWorking === 'number' ? summary.superWorking : 0, asking: summary?.superAsking === true };
}

/** The summary's `members`, each entry checked (another project's answer, read over the wire). */
export function membersOf(summary: { members?: unknown } | null): EkipSummary[] | undefined {
  if (!summary || !Array.isArray(summary.members)) return undefined;
  return summary.members.filter((m): m is EkipSummary => !!m && typeof m === 'object' && typeof (m as { slug?: unknown }).slug === 'string');
}

/** Who the members are: the agents' names, faces and scope. */
export function identitiesOf(agents: readonly (Pick<AgentSummary, 'slug' | 'title' | 'hasPhoto' | 'scope'> & { face?: AgentSummary['face'] })[]): EkipIdentity[] {
  return agents.map((a) => ({ slug: a.slug, title: a.title, hasPhoto: a.hasPhoto, global: a.scope === 'global', ...(a.face ? { face: a.face } : {}) }));
}

/** A folded project's marks and Ekip read; null when the summary read failed, so no old number
 *  stays on its row. */
export function readFoldedMarks(vault: string): Promise<{ marks: SuperMarks; ekip: DrawerEkipFacts } | null> {
  const api = new ApiClient(vault);
  return Promise.all([
    api.get<{ superWorking?: unknown; superAsking?: unknown; members?: unknown }>('/agent/sessions?summary=1'),
    api.get<{ agents: AgentSummary[] }>('/agents').then((r) => r.agents).catch(() => [] as AgentSummary[]),
  ]).then(([summary, agents]) => {
    const members = membersOf(summary);
    return { marks: marksOf(summary), ekip: members ? { members, identities: identitiesOf(agents) } : {} };
  }, () => null);
}

export async function readFanoutFacts(vault: string): Promise<FanoutFacts> {
  const api = new ApiClient(vault);
  const [summary, agents, automations, feed] = await Promise.all([
    api.get<{ tabs?: unknown; superOn?: unknown; perWindow?: unknown; superWorking?: unknown; superAsking?: unknown; members?: unknown }>('/agent/sessions?summary=1').catch(() => null),
    api.get<{ agents: AgentSummary[] }>('/agents').then((r) => r.agents).catch(() => []),
    api.get<{ automations: AutomationSummary[] }>('/automations').then((r) => r.automations).catch(() => []),
    api.get<AgentFeed>('/automations/threads').catch(() => null),
  ]);
  return {
    tabs: typeof summary?.tabs === 'number' ? summary.tabs : 0,
    superOn: summary?.superOn === true,
    superMarks: marksOf(summary),
    // The headless rule only: in-flight headless `team` jobs and a routine's question. The
    // Ekip row reads the summary's `members`.
    team: headlessRowsOf(buildRoster(agents as TeamAgent[], automations, feed)),
    ...(Array.isArray(summary?.perWindow) ? { windows: perWindowOf(summary.perWindow) } : {}),
    ...(membersOf(summary) ? { members: membersOf(summary), identities: identitiesOf(agents) } : {}),
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

export function useDrawerProjects(expanded: readonly string[], mounted: readonly string[], visible: boolean, folded: readonly string[] = []): {
  facts: Record<string, FanoutFacts>;
  /** A window row of a project that is not mounted, dragged: the row moves now, the roster on
   *  disk follows, and a fresh read settles it (a refused write puts the row back). */
  moveWindow: (vault: string, id: string, before: string | null) => void;
} {
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
  const factsRef = useRef(facts);
  factsRef.current = facts;
  /** Drags per project: a read that began before the latest one holds the old order, so it
   *  must not land (the row would jump back, and the next drag would save from it). */
  const moves = useRef(new Map<string, number>());
  const movesOf = (v: string) => moves.current.get(v) ?? 0;
  const moveWindow = useCallback((vault: string, id: string, before: string | null) => {
    const far = factsRef.current[vault];
    if (!far?.windows) return;
    const windows = moveBefore(far.windows, id, before);
    const move = movesOf(vault) + 1;
    moves.current.set(vault, move);
    setFacts((prev) => (prev[vault] ? { ...prev, [vault]: { ...prev[vault], windows } } : prev));
    void new ApiClient(vault).put<unknown>('/agent/sessions/window-order', { order: windows.map((w) => w.id) })
      .catch((err) => console.warn('[drawer] a window order was not saved:', err))
      .then(() => readFanoutFacts(vault))
      .then((f) => { if (movesOf(vault) === move) setFacts((prev) => ({ ...prev, [vault]: f })); }, () => { /* each read degrades to empty */ });
  }, []);

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
      const seen = movesOf(v);
      void readFanoutFacts(v).then((f) => {
        landed.add(v);
        if (!gone && movesOf(v) === seen) setFacts((prev) => ({ ...prev, [v]: f }));
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
        const seen = new Map(poll.map((v) => [v, movesOf(v)] as const));
        void Promise.all(poll.map((v) => readFanoutFacts(v).then((f) => [v, f] as const)))
          .then((pairs) => {
            const fresh = pairs.filter(([v]) => movesOf(v) === seen.get(v));
            if (!gone) setFacts((prev) => ({ ...prev, ...Object.fromEntries(fresh) }));
          })
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

  // The folded rows' marks: read at once and every 15 s while live, and only the capped few are kept.
  const [marks, setMarks] = useState<Record<string, SuperMarks>>({});
  const [teams, setTeams] = useState<Record<string, DrawerEkipFacts>>({});
  const targets = useMemo(
    () => foldedTargets(folded, mounted),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folded.join('\n'), mounted.join('\n')],
  );
  useEffect(() => {
    setMarks((prev) => (Object.keys(prev).every((v) => targets.includes(v))
      ? prev
      : Object.fromEntries(Object.entries(prev).filter(([v]) => targets.includes(v)))));
    if (!live || !targets.length) return undefined;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void Promise.all(targets.map((v) => readFoldedMarks(v).then((m) => [v, m] as const))).then((pairs) => {
        if (gone) return;
        const got = pairs.filter((pair): pair is readonly [string, { marks: SuperMarks; ekip: DrawerEkipFacts }] => pair[1] !== null);
        setMarks(Object.fromEntries(got.map(([v, r]) => [v, r.marks])));
        setTeams(Object.fromEntries(got.map(([v, r]) => [v, r.ekip])));
        timer = setTimeout(read, pollMs(DRAWER_POLL_MS));
      });
    };
    read();
    return () => { gone = true; if (timer) clearTimeout(timer); };
  }, [targets, live]);

  const merged = useMemo(
    () => fanoutWithMarks(facts, marks, folded, teams),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facts, marks, teams, folded.join('\n')],
  );
  return { facts: merged, moveWindow };
}
