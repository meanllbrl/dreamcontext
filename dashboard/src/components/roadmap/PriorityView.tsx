import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../../context/VaultContext';
import { RequestError } from '../../api/client';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { useUpdateTask } from '../../hooks/useTasks';
import {
  useAcceptObjectiveSuggestion, useAcceptTaskSuggestion, useDismissObjectiveSuggestion, useDismissTaskSuggestion,
  useUpdateObjective, type AcceptSuggestionResult,
} from '../../hooks/useObjectives';
import { PRIORITY_KEY, startScoring, stopScoring, useMoveObjectiveLink } from '../../hooks/usePriorityBoard';
import { scoreWithAgent } from '../../lib/scoreWithAgent';
import { ObjectiveLanes } from './ObjectiveLanes';
import { TaskLanes } from './TaskLanes';
import { PriorityMap } from './PriorityMap';
import { PriorityPanel, type PanelTarget } from './PriorityPanel';
import {
  BAND_LABEL, UNLINKED, agentButtonState, applyMoveLocal, objectivePlace, pendingItems, planDrop, priorityBand,
  rankObjectives, taskLanes, taskPlace, visibleObjectives,
  type MoveOp, type ObjectiveFilter, type PendingItem, type PriorityPayload, type RiceKey, type TaskCardModel,
} from './priorityModel';
import type { RoadmapLevel } from './chrome';
import './Priority.css';

interface Toast { text: string; error?: boolean; undo?: () => void; id: number }

type Selection = { kind: 'objective' | 'task'; slug: string; key: string } | null;

export interface PriorityViewProps {
  data: PriorityPayload | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  level: RoadmapLevel;
  layout: 'lanes' | 'map';
  search: string;
  filters: ObjectiveFilter;
  /** Bumped by the "✦ N suggestions" button: open the panel on the first suggestion. */
  walkRequest: number;
  onShowLanes: () => void;
  onOpenTask?: (slug: string) => void;
  /** Open the objective's full detail panel (status, dates, metric, dependencies). */
  onOpenObjective?: (slug: string) => void;
  onNewObjective: () => void;
}

const UNDO_MS = 6000;

export function PriorityView(props: PriorityViewProps) {
  const { data, isLoading, isError, refetch, level, layout, search, filters, walkRequest, onShowLanes, onOpenTask, onOpenObjective, onNewObjective } = props;
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<Selection>(null);
  const [walking, setWalking] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [expandNs, setExpandNs] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Links moved by a drag, held until the move settles so a poll cannot move the card back.
  const [held, setHeld] = useState<Array<{ slug: string; op: MoveOp }>>([]);

  const move = useMoveObjectiveLink();
  const updateTask = useUpdateTask();
  const updateObjective = useUpdateObjective();
  const acceptTask = useAcceptTaskSuggestion();
  const acceptObjective = useAcceptObjectiveSuggestion();
  const dismissTask = useDismissTaskSuggestion();
  const dismissObjective = useDismissObjectiveSuggestion();
  const busy = acceptTask.isPending || acceptObjective.isPending || dismissTask.isPending || dismissObjective.isPending;

  const showToast = useCallback((t: Omit<Toast, 'id'>, ms = 3200) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ...t, id: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const tasks = useMemo(() => {
    let list = data?.tasks ?? [];
    for (const h of held) list = applyMoveLocal(list, h.slug, h.op);
    return list;
  }, [data, held]);
  const liveObjectives = useMemo(() => rankObjectives((data?.objectives ?? []).filter((o) => o.status !== 'done')), [data]);
  const shownObjectives = useMemo(() => visibleObjectives(data?.objectives ?? [], search, filters), [data, search, filters]);
  const pending = useMemo<PendingItem[]>(() => (data ? pendingItems(data) : []), [data]);

  // "✦ N suggestions": walk the panel suggestion by suggestion.
  const lastWalk = useRef(walkRequest);
  useEffect(() => {
    if (walkRequest === lastWalk.current) return;
    lastWalk.current = walkRequest;
    const first = pending[0];
    if (first) {
      setWalking(true);
      setSelection({ kind: first.kind, slug: first.slug, key: first.slug });
    }
  }, [walkRequest, pending]);

  const advance = useCallback((doneSlug: string) => {
    if (!walking) { return; }
    const rest = pending.filter((p) => p.slug !== doneSlug);
    const next = rest[0];
    if (next) setSelection({ kind: next.kind, slug: next.slug, key: next.slug });
    else { setWalking(false); setSelection(null); }
  }, [walking, pending]);

  // ── Drag: optimistic, rollback + error toast, Undo for 6 s through the server's undo op ──
  const runMove = useCallback(async (slug: string, op: MoveOp, label: string, isUndo = false, sourceTitle?: string) => {
    await queryClient.cancelQueries({ queryKey: PRIORITY_KEY });
    const entry = { slug, op };
    setHeld((h) => [...h, entry]);
    try {
      const res = await move.mutateAsync({ slug, op });
      if (isUndo) {
        showToast({ text: 'Move undone' });
      } else {
        const text = res.note === 'already_linked'
          ? `Already linked there: removed the link to ${sourceTitle ?? 'the source objective'} only`
          : label;
        showToast({ text, undo: res.changed ? () => { void runMove(slug, res.undo, '', true); } : undefined }, UNDO_MS);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'The move failed.';
      showToast({ text: isUndo ? `Undo failed: ${msg}` : `Move failed: ${msg}`, error: true }, 5000);
    } finally {
      // Drop the hold once the refetch has the server's truth (or the rollback is the truth).
      await queryClient.invalidateQueries({ queryKey: PRIORITY_KEY });
      setHeld((h) => h.filter((x) => x !== entry));
    }
  }, [move, queryClient, showToast]);

  const onDrop = useCallback((card: TaskCardModel, target: string) => {
    const op = planDrop(card, target);
    if (!op) return;
    const title = (slug: string | null) => (slug ? liveObjectives.find((o) => o.slug === slug)?.title ?? slug : 'Unlinked');
    const label = target === UNLINKED ? `Unlinked from ${title(card.column)}` : `Linked to ${title(target)}`;
    void runMove(card.task.slug, op, label, false, title(card.column));
  }, [runMove, liveObjectives]);

  // ── Panel ──
  const target = useMemo<PanelTarget | null>(() => {
    if (!selection || !data) return null;
    if (selection.kind === 'objective') {
      const o = data.objectives.find((x) => x.slug === selection.slug);
      if (!o) return null;
      const place = objectivePlace(o);
      const band = priorityBand('objective', place.score);
      const rank = band ? rankObjectives(liveObjectives.filter((x) => priorityBand('objective', objectivePlace(x).score) === band)).findIndex((x) => x.slug === o.slug) + 1 : 0;
      return {
        kind: 'objective', slug: o.slug, title: o.title,
        rice: { reach: o.reach, impact: o.impact, confidence: o.confidence, effort: o.effort },
        suggestion: o.effective_suggestion, links: [],
        context: band ? `${BAND_LABEL[band]} · ${ordinal(rank)} objective` : 'Not scored',
      };
    }
    const t = tasks.find((x) => x.slug === selection.slug);
    if (!t) return null;
    const place = taskPlace(t);
    const band = priorityBand('task', place.score);
    const column = selection.key.split('::')[1];
    const lanes = taskLanes(data.objectives, tasks, '');
    const col = lanes.columns.find((c) => c.slug === column) ?? lanes.columns.find((c) => [...c.bands.now, ...c.bands.next, ...c.bands.later].some((k) => k.task.slug === t.slug));
    const inBand = col && band ? col.bands[band].findIndex((k) => k.task.slug === t.slug) + 1 : 0;
    return {
      kind: 'task', slug: t.slug, title: t.name, rice: t.rice, suggestion: t.effective_suggestion, links: t.links,
      context: band ? `${BAND_LABEL[band]}${col && inBand ? ` · ${ordinal(inBand)} in ${col.title}` : ''}` : 'Not scored',
    };
  }, [selection, data, tasks, liveObjectives]);

  const close = () => { setSelection(null); setWalking(false); };

  const handleSuggestionError = (err: unknown, slug: string) => {
    if (err instanceof RequestError && err.code === 'suggestion_changed') {
      // The suggestion moved under us (a newer one, or accepted elsewhere): just re-read it.
      void queryClient.invalidateQueries({ queryKey: PRIORITY_KEY });
      return;
    }
    showToast({ text: err instanceof Error ? err.message : 'Failed.', error: true }, 5000);
    void slug;
  };

  const onAccept = (edits: Partial<Record<RiceKey, number>>) => {
    if (!target?.suggestion) return;
    const { slug, kind } = target;
    const at = target.suggestion.at;
    const done = (r: AcceptSuggestionResult) => {
      const parts = ['Accepted'];
      if (r.link_dropped) parts.push(`the link to ${r.link_dropped} was dropped (that objective is done or gone)`);
      if (kind === 'objective' && r.filled.includes('effort')) parts.push('its effort now drives the forecast');
      showToast({ text: parts.join(': ') });
      advance(slug);
    };
    const m = kind === 'task' ? acceptTask : acceptObjective;
    m.mutate({ slug, at, rice: Object.keys(edits).length ? edits : undefined }, { onSuccess: done, onError: (e) => handleSuggestionError(e, slug) });
  };

  const onDismiss = () => {
    if (!target?.suggestion) return;
    const { slug, kind } = target;
    const m = kind === 'task' ? dismissTask : dismissObjective;
    m.mutate({ slug, at: target.suggestion.at }, { onSuccess: () => advance(slug), onError: (e) => handleSuggestionError(e, slug) });
  };

  const onSaveRice = (k: RiceKey, v: number) => {
    if (!target) return;
    if (target.kind === 'task') {
      updateTask.mutate({ slug: target.slug, updates: { rice: { [k]: v } } }, { onError: (e) => showToast({ text: e.message, error: true }, 5000) });
    } else {
      updateObjective.mutate({ slug: target.slug, patch: { [k]: v } }, { onError: (e) => showToast({ text: e.message, error: true }, 5000) });
    }
  };

  const onToggleLink = (objective: string, on: boolean) => {
    if (!target || target.kind !== 'task') return;
    const t = tasks.find((x) => x.slug === target.slug);
    const op: MoveOp = on
      ? { remove: t && t.links.length === 0 && t.mark ? t.all_links.find((l) => !t.links.includes(l)) ?? null : null, add: objective }
      : { remove: objective, add: null };
    const title = liveObjectives.find((o) => o.slug === objective)?.title ?? objective;
    void runMove(target.slug, op, on ? `Linked to ${title}` : `Unlinked from ${title}`);
  };

  // ── States ──
  let body: React.ReactNode;
  if (isLoading && !data) {
    body = (
      <div className="pv-skel" aria-busy="true" aria-label="Loading the priority board">
        <div className="pv-skel-band" /><div className="pv-skel-band" /><div className="pv-skel-band" />
      </div>
    );
  } else if (isError && !data) {
    body = (
      <div className="pv-state" role="alert">
        <h3>The priority board did not load</h3>
        <span>The server did not answer. Your data is unchanged.</span>
        <button type="button" className="pv-btn" onClick={refetch}>Retry</button>
      </div>
    );
  } else if (data && data.objectives.length === 0 && data.tasks.length === 0) {
    body = (
      <div className="pv-state">
        <h3>Nothing to rank yet</h3>
        <span>Create an objective, then score it to see what comes next.</span>
        <button type="button" className="pv-btn pv-btn--primary" onClick={onNewObjective}>+ New Objective</button>
      </div>
    );
  } else if (data && level === 'objectives' && liveObjectives.length === 0) {
    body = (
      <div className="pv-state">
        <h3>No objectives yet</h3>
        <span>{data.tasks.length} open task{data.tasks.length === 1 ? '' : 's'} are on the Tasks level. Add an objective to say what they work for.</span>
        <button type="button" className="pv-btn pv-btn--primary" onClick={onNewObjective}>+ New Objective</button>
      </div>
    );
  } else if (data && layout === 'map') {
    body = (
      <PriorityMap
        level={level === 'tasks' ? 'task' : 'objective'}
        objectives={shownObjectives}
        tasks={tasks.filter((t) => !search.trim() || t.name.toLowerCase().includes(search.trim().toLowerCase()))}
        selected={selection?.key ?? null}
        onOpen={(key) => setSelection({ kind: level === 'tasks' ? 'task' : 'objective', slug: key.split('::')[0], key })}
        onOpenUnscored={() => { setExpandNs((n) => n + 1); onShowLanes(); }}
      />
    );
  } else if (data && level === 'tasks') {
    body = (
      <TaskLanes
        objectives={data.objectives}
        tasks={tasks}
        search={search}
        selected={selection?.key ?? null}
        onOpen={(key) => setSelection({ kind: 'task', slug: key.split('::')[0], key })}
        onDrop={onDrop}
        expandRequest={expandNs}
      />
    );
  } else if (data) {
    body = (
      <ObjectiveLanes
        objectives={shownObjectives}
        all={data.objectives}
        selected={selection?.key ?? null}
        onOpen={(slug) => setSelection({ kind: 'objective', slug, key: slug })}
      />
    );
  }

  const walkIndex = walking && target ? pending.findIndex((p) => p.slug === target.slug) : -1;

  return (
    <div className="pv">
      <div className={`pv-scroll${level === 'tasks' && layout === 'lanes' ? ' pv-scroll--tl' : ''}`}>{body}</div>
      {target && (
        <PriorityPanel
          key={`${target.kind}:${target.slug}:${target.suggestion?.at ?? ''}`}
          target={target}
          objectives={liveObjectives}
          walk={walkIndex >= 0 ? `${walkIndex + 1} of ${pending.length}` : null}
          busy={busy}
          onClose={close}
          onAccept={onAccept}
          onDismiss={onDismiss}
          onSaveRice={onSaveRice}
          onToggleLink={onToggleLink}
          onOpenTask={target.kind === 'task' && onOpenTask ? () => onOpenTask(target.slug) : undefined}
          onOpenObjective={target.kind === 'objective' && onOpenObjective ? () => { const s = target.slug; close(); onOpenObjective(s); } : undefined}
        />
      )}
      {toast && (
        <div className={`pv-toast${toast.error ? ' is-error' : ''}`} role={toast.error ? 'alert' : 'status'} key={toast.id}>
          <span>{toast.text}</span>
          {toast.undo && <button type="button" onClick={() => { const u = toast.undo!; setToast(null); u(); }}>Undo</button>}
        </div>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * The agent button in the toolbar, from `scoring` in the priority payload.
 * A click claims the scoring marker (compare-and-set) and dispatches only if it
 * won; a false ACK or a thrown preparePrompt releases it.
 */
export function PriorityAgentButton({ scoring, onOpenSuggestions, onError }: {
  scoring: PriorityPayload['scoring'] | undefined;
  onOpenSuggestions: () => void;
  onError: (message: string) => void;
}) {
  const api = useApi();
  const { vault, bus } = useVault();
  const queryClient = useQueryClient();
  const { data: caps } = useAgentCapabilities();
  const [starting, setStarting] = useState(false);
  if (!scoring) return null;
  const state = agentButtonState(scoring);
  if (state.kind === 'hidden') return null;

  const unavailable = !caps
    ? null
    : !caps.embeddedTerminal || !caps.nodePty
      ? 'Scoring needs the desktop app'
      : !caps.claudeCli ? 'Install the Claude CLI to score' : null;

  if (state.kind === 'suggestions') {
    return <button type="button" className="rm-agent-btn is-pending" onClick={onOpenSuggestions}>{state.label}</button>;
  }
  if (state.kind === 'running') {
    return <button type="button" className="rm-agent-btn" disabled aria-busy="true">{state.label}</button>;
  }
  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const won = await startScoring(api);
      if (!won) return; // another window or click already started it
      let ok = false;
      try {
        ok = await scoreWithAgent(bus, vault, state.count);
      } catch {
        ok = false;
      }
      if (!ok) {
        await stopScoring(api);
        onError('The scoring agent did not start. Open the app\'s agent panel and try again.');
      }
    } finally {
      setStarting(false);
      void queryClient.invalidateQueries({ queryKey: PRIORITY_KEY });
    }
  };
  return (
    <>
      {unavailable && <span className="rm-agent-why">{unavailable}</span>}
      <button type="button" className="rm-agent-btn" disabled={!!unavailable || starting} onClick={() => void start()}>
        {starting ? 'Scoring…' : state.label}
      </button>
    </>
  );
}
