import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { nextOwedReveal, type PadStatus, type SuperChild, type SuperState } from '../../../lib/superTypes';
import type { OwnerInboxRow } from '../../../hooks/useAgents';
import { tr } from '../../../lib/assignToAgent';
import { superNotepad, superUnanswered, type AgendaRow, type JobLook, type ThreadKey } from './superHandover';
import { showApprovalRow, superApprovalSentence, type SuperApproval } from './superApprovals';
import { requestOpenAgents } from '../../../lib/openAgents';
import { ownerSlotMounted, showOwnerSlot } from './superJobsStore';
import { indexStopLine } from '../../../lib/indexStop';
import type { SuperQueueItem } from '../../../lib/superTypes';
import {
  TODAY_GROUPS, agendaProgress, dayGroups, filterEntries, holdOrder, localDay, placeBeside, rowActions, smallEntries, todayGroups,
  type AgendaEntry, type AgendaFilter, type AgendaGroup, type DayGroup, type RowActions,
} from './agendaGroups';
import { AgendaRowView, type AgendaSize } from './AgendaRow';
import { AgendaStatusMenu, FloatLayer } from './AgendaStatusMenu';
import { AgendaDetail, type DetailJob } from './AgendaDetail';
import { AgendaDayNav, AgendaWeekStrip } from './AgendaDayNav';
import type { AgendaDay } from './superApi';
import './SuperAgenda.css';

export type { AgendaSize } from './AgendaRow';

/** A thread row's press (ajanda-filtre D1): the host filters the Super chat and answers whether
 *  the filter is now on (false: the same row was pressed again and it cleared). */
export interface ThreadPress {
  rowKey: string;
  row: AgendaRow;
  key: ThreadKey;
  /** A question or owner-card row: its card, brought into view after the filter lands. */
  focusItem?: string;
}

/** The row's machine detail (index-stop.ts writes JSON); an unreadable one still reads as a failed update. */
function parseStopDetail(detail: string | undefined): { reason: string; asOf: string | null; estUsd: number | null } {
  try {
    const d = JSON.parse(detail ?? '') as { reason?: unknown; asOf?: unknown; estUsd?: unknown };
    return {
      reason: typeof d.reason === 'string' ? d.reason : 'failed',
      asOf: typeof d.asOf === 'string' ? d.asOf : null,
      estUsd: typeof d.estUsd === 'number' ? d.estUsd : null,
    };
  } catch {
    return { reason: 'failed', asOf: null, estUsd: null };
  }
}

/** The paused brain sync's reason (brain-auto-sync.ts writes it in `detail`); unknown reads as held. */
function syncReason(row: OwnerInboxRow): string {
  try {
    const r = (JSON.parse(row.detail ?? '') as { reason?: unknown }).reason;
    return typeof r === 'string' && ['conflict', 'code-conflict', 'scrub', 'held', 'failed'].includes(r) ? r : 'held';
  } catch {
    return 'held';
  }
}

/** A Waiting line whose item is a card a child left (K7): it opens that card in the Super chat's
 *  slot, the same card the bar and the slot draw. */
export function agendaOpensSlot(queue: readonly Pick<SuperQueueItem, 'id' | 'card' | 'state'>[], itemId: string | undefined | null): boolean {
  return !!itemId && queue.some((q) => q.id === itemId && !!q.card && q.state !== 'done');
}

/** The error code a refused request carries (client.ts RequestError), or ''. */
const codeOf = (e: unknown): string => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '');

/** Milliseconds to the next local midnight (the header and Today move to the new day by themselves). */
const toMidnight = (now: number) => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime() - now; };

/**
 * The owner's agenda, shared by him and the Super (task ajanda-gunluk, owner 14 Nov: "Günlük
 * tarzında"): a stage widget in four sizes plus the full / side-by-side view, live at every size
 * (learned rule d5xlppqj5a). A `‹ day ›` header browses days (the 7-day strip only in the full
 * view); lines are grouped by who acts next (Waiting on you, Super is on it, Added by you, Done,
 * "From earlier days" above them), newest update on top in each group, the order held while the
 * pointer is over the list. Each line carries one of five statuses; hover shows Done and Ask; his
 * own lines come from the add box. What any row may do is `rowActions` (agendaGroups.ts, C8):
 * this component draws exactly that and decides nothing itself.
 *
 * Nothing polls: the record is pushed; a day's archived Done lines come from `loadDay` (today's
 * merge on open, on a day change and after a pad change).
 */
export function SuperAgenda({ state, look, size: sizeProp, variant = 'full', wide = false, canShowChild, canOpenMember = true, remote = false, readOnly = false, onShowChild, onShowQuestion, onWriteAbout, onThread, threadRowKey = null, onPadStatus, onPadAdd, onPadRemove, loadDay, onDropOwed, taskRows = [], onOpenTask, recallRows = [], syncRows = [], onUpdateIndex, indexUpdate = 'idle', approvals = [], onShowApproval, extra }: {
  /** The record (the stage), or the phone's digest of it (PhoneAgenda): only these read. */
  state: Pick<SuperState, 'queue' | 'pad' | 'owed'> & { children?: Readonly<Record<string, SuperChild>> };
  /** The drawn size (small, medium, large, wide) or the full / side-by-side view. */
  size?: AgendaSize;
  /** Older callers: `tile` = small (medium when `wide`), `full` = the full view. */
  variant?: 'tile' | 'full';
  wide?: boolean;
  look: JobLook;
  canShowChild: (sid: string) => boolean;
  onShowChild: (sid: string) => void;
  /** A question waiting on the owner: bring its card into view. */
  onShowQuestion: (item: string) => void;
  /** Ask on a row: its About chip into the Super composer. Absent: no Ask. */
  onWriteAbout?: (row: AgendaRow) => void;
  /** A row with a thread key was pressed (ajanda-filtre D1): filter the Super chat to it. The same
   *  row again clears it (the store decides). Absent: a line's press opens its detail, as before. */
  onThread?: (press: ThreadPress) => boolean;
  /** The row whose thread the Super chat shows: drawn highlighted while the filter is on. */
  threadRowKey?: string | null;
  /** His status change, Done included (`POST /api/super/pad`). Absent: no circle menu, no Done. */
  onPadStatus?: (id: string, status: PadStatus) => Promise<void>;
  /** His own line (`POST /api/super/pad/add`). Absent (no owner key here): no add box. */
  onPadAdd?: (text: string) => Promise<void>;
  /** His own open line taken off (`POST /api/super/pad/remove`). */
  onPadRemove?: (id: string) => Promise<void>;
  /** One day of the agenda (`GET /api/super/agenda-day`). Absent: no day browsing (the phone). */
  loadDay?: (date: string) => Promise<AgendaDay | null>;
  /** The phone's web view: rows are read, never changed (rowActions readOnly). */
  readOnly?: boolean;
  taskRows?: OwnerInboxRow[];
  onOpenTask?: (slug: string) => void;
  recallRows?: OwnerInboxRow[];
  syncRows?: OwnerInboxRow[];
  onUpdateIndex?: (row: OwnerInboxRow) => void;
  indexUpdate?: 'idle' | 'running' | 'failed';
  approvals?: SuperApproval[];
  onShowApproval?: (key: string) => void;
  /** His "Not needed" on an unanswered line; absent = read only. */
  onDropOwed?: (id: string) => void;
  /** Drawn after the groups in the large views: a member's "Görevleri". */
  extra?: ReactNode;
  canOpenMember?: boolean;
  /** The phone: a refused command cannot be allowed from its web view. */
  remote?: boolean;
}) {
  const { t, locale } = useI18n();
  const size: AgendaSize = sizeProp ?? (variant === 'tile' ? (wide ? 'medium' : 'small') : 'full');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The clock: a parked unanswered line shows ten minutes after his Stop, and the day turns at
  // local midnight. One timer each, nothing polls.
  const [clock, setClock] = useState(() => Date.now());
  const reveal = nextOwedReveal(state.owed, clock);
  useEffect(() => {
    if (reveal === null) return undefined;
    const id = window.setTimeout(() => setClock(Date.now()), Math.max(0, reveal - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [reveal]);
  useEffect(() => {
    const id = window.setTimeout(() => setClock(Date.now()), toMidnight(Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [clock]);
  const now = Math.max(clock, Date.now());
  const today = localDay(now);

  // The day shown. It follows today across midnight unless he browsed away.
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked && picked !== today ? picked : today;
  // A browsed day that has become today stops being browsed, so the card follows today again.
  useEffect(() => { if (picked === today) setPicked(null); }, [picked, today]);
  const onDay = (d: string) => { setPicked(d === today ? null : d); setSelected(null); setMenu(null); };

  // A day's Done lines from its file (C4). Today's is merged into the pushed pad; a past day is
  // the route's answer. Fetched on open, on a day change and after a pushed pad change.
  const pad = state.pad ?? [];
  const padKey = pad.map((p) => `${p.id}:${p.at}:${p.section}`).join(',');
  const [dayData, setDayData] = useState<Record<string, AgendaDay>>({});
  useEffect(() => {
    if (!loadDay) return undefined;
    let live = true;
    loadDay(day).then((d) => { if (live && d) setDayData((m) => ({ ...m, [day]: d })); }).catch(() => { /* the pushed pad still draws today */ });
    return () => { live = false; };
  }, [loadDay, day, padKey]);

  const notepad = superNotepad(state, look, now);
  const unanswered = superUnanswered(state, now);
  const groups = todayGroups({
    notepad, unanswered, pad, routeDone: dayData[today]?.done ?? null,
    approvals, taskRows, recallRows, syncRows, children: state.children, now,
  });
  const past = day !== today ? dayGroups(day, pad, dayData[day]?.done ?? null) : null;
  // Every count and the bar describe the day on screen (review r1): a past day's from its lines.
  const progress = past
    ? { done: past.dayDone.length, total: past.dayDone.length + past.dayOpen.length, working: 0, waiting: 0 }
    : agendaProgress(groups);

  // The order holds while the pointer is over the list (C3): it re-sorts on leave.
  const [held, setHeld] = useState<string[] | null>(null);
  const order = (entries: AgendaEntry[]) => holdOrder(entries, held);
  const listHandlers = {
    onPointerEnter: (e: ReactPointerEvent) => {
      if (e.pointerType === 'touch') return;
      setHeld([...TODAY_GROUPS.flatMap((g) => groups[g]), ...(past ? [...past.dayDone, ...past.dayOpen] : [])].map((x) => x.key));
    },
    onPointerLeave: () => setHeld(null),
  };

  // The detail (one at a time), the status menu, medium's filter, the small card's add popover.
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLElement } | null>(null);
  const [filter, setFilter] = useState<AgendaFilter>('waiting');
  // List or board (owner 15 Nov: "büyük görünümdeyken board görünümü de opsiyon olarak kalsın"):
  // his pick, kept on this Mac; the list is the default.
  const [view, setView] = useState<'list' | 'board'>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
  });
  const pickView = (v: 'list' | 'board') => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
    // Every agenda drawn now (the card and its full screen) follows the pick at once.
    window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: v }));
  };
  useEffect(() => {
    const on = (e: Event) => { const v = (e as CustomEvent).detail; if (v === 'list' || v === 'board') setView(v); };
    window.addEventListener(VIEW_EVENT, on);
    return () => window.removeEventListener(VIEW_EVENT, on);
  }, []);
  // A refused write (C8): its words and the line it belongs to (absent = the card's). Shown where
  // he is looking at every size: that line's detail when it is open, else the card's error line;
  // the add box shows its own (review r1, action-failure-shown-where-he-looks).
  const [error, setError] = useState<{ text: string; note?: string } | null>(null);

  const all = [...TODAY_GROUPS.flatMap((g) => groups[g]), ...(past ? [...past.dayDone, ...past.dayOpen] : [])];
  const selectedEntry = selected ? all.find((e) => e.key === selected) ?? null : null;
  useEffect(() => { if (selected && !selectedEntry) setSelected(null); }, [selected, selectedEntry]);
  useEffect(() => { setError(null); }, [selected]);
  // The small and medium cards have no room to keep a stale refusal: it leaves after a while.
  useEffect(() => {
    if (!error) return undefined;
    const t = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(t);
  }, [error]);

  const actionsOf = (e: AgendaEntry): RowActions => rowActions(e, { readOnly });
  const explain = (e: unknown): string => {
    const code = codeOf(e);
    return code === 'unknown_note' ? t('super.agenda.detail.archived') : code === 'pad_full' ? t('super.agenda.full') : (e instanceof Error && e.message) || t('super.agenda.failed');
  };
  const fail = (e: unknown, note?: string) => setError({ text: explain(e), ...(note ? { note } : {}) });
  const setStatus = async (id: string, status: PadStatus) => {
    if (!onPadStatus) return;
    setError(null);
    try { await onPadStatus(id, status); } catch (e) { fail(e, id); }
  };

  // A question's own press, as today: a card a child left opens in the Super chat's slot; a
  // routine, its approval row; a member, its page; a child's permission or need, that child.
  const showsChild = (r: AgendaRow) => !r.member && !r.routine
    && (r.chip === 'permission' || r.chip === 'queued' || r.chip === 'needsYou' || r.chip === 'refusal' || r.chip === 'stalled' || !!r.direct);
  const cardItem = (r: AgendaRow) => agendaOpensSlot(state.queue, r.item);
  const pressQuestion = (r: AgendaRow) => {
    if (!r.item) return;
    if (cardItem(r) && showOwnerSlot(r.item)) return;
    if (r.routine) {
      if (canOpenMember && !showApprovalRow(`routine:${r.routine}`)) requestOpenAgents({ slug: r.member || r.routine });
      return;
    }
    if (r.member) { if (canOpenMember) requestOpenAgents({ slug: r.member }); return; }
    if (showsChild(r)) { if (r.sid && canShowChild(r.sid)) onShowChild(r.sid); return; }
    onShowQuestion(r.item);
  };
  const fallbackActs = (r: AgendaRow) => (r.member || r.routine ? canOpenMember : showsChild(r) ? !!r.sid && canShowChild(r.sid) : true);
  const questionClickable = (r: AgendaRow) => !!r.item && ((cardItem(r) && ownerSlotMounted(r.item)) || fallbackActs(r));

  const fmtTime = useCallback((ms: number) => {
    const sameDay = localDay(ms) === today;
    return sameDay
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)
      : new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
  }, [locale, today]);
  const fmtDay = useCallback((d: string) => {
    const [y, m, dd] = d.split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(y, m - 1, dd, 12));
  }, [locale]);

  const jobOf = (e: AgendaEntry): DetailJob | null => {
    const sid = e.row?.for;
    if (!sid) return null;
    const ch = state.children?.[sid];
    return { mode: ch?.mode, line: e.row?.line || ch?.brief, task: ch?.task, canOpen: canShowChild(sid) };
  };
  const groupName = (g: AgendaGroup | DayGroup) => t(`super.agenda.group.${g}`);

  const inlineDetail = size === 'wide' || size === 'full';
  // An archived line keeps its day file's id: a message about it joins its thread (C3).
  const aboutRow = (e: AgendaEntry): AgendaRow => (e.live || e.kind !== 'line' ? e.row! : { ...e.row!, archived: true });
  /** A thread row's press: filter (or, the same row, unfilter); a question or owner-card row then
   *  brings its card into view through its own door, once the filtered chat has drawn (D3). */
  const pressThread = (e: AgendaEntry, r: AgendaRow, focusItem?: string): boolean => {
    if (!onThread || !r.thread) return false;
    const on = onThread({ rowKey: e.key, row: r, key: r.thread, ...(focusItem ? { focusItem } : {}) });
    if (on && focusItem) requestAnimationFrame(() => requestAnimationFrame(() => pressQuestion(r)));
    return on;
  };

  // ── One row, by kind ──────────────────────────────────────────────────────────
  const rowOf = (e: AgendaEntry) => {
    const a = actionsOf(e);
    if (e.kind === 'approval' && e.approval) {
      const ap = e.approval;
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={ap.title}
          line={superApprovalSentence(ap, t)}
          chips={<span className="super-agenda-chip" data-kind="approval">{t('super.jobs.chip.approval')}</span>}
          time="" onPress={onShowApproval ? () => onShowApproval(ap.key) : undefined} onHover={{}}
        />
      );
    }
    if (e.kind === 'recall' && e.inbox) {
      const r = e.inbox;
      const line = indexStopLine(parseStopDetail(r.detail), t);
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={line}
          chips={<span className="super-agenda-chip" data-kind="recall" data-state={indexUpdate}>{t(indexUpdate === 'running' ? 'super.agenda.index.running' : indexUpdate === 'failed' ? 'super.agenda.index.failed' : 'aiteam.inbox.update-index')}</span>}
          time={e.at !== null ? fmtTime(e.at) : ''}
          onPress={onUpdateIndex && indexUpdate !== 'running' ? () => onUpdateIndex(r) : undefined} onHover={{}}
        />
      );
    }
    if (e.kind === 'sync' && e.inbox) {
      const line = tr(t, `super.agenda.sync.${syncReason(e.inbox)}`, e.inbox.title);
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={line}
          chips={<span className="super-agenda-chip" data-kind="sync">{tr(t, 'super.agenda.chip.sync', 'Brain sync')}</span>}
          time={e.at !== null ? fmtTime(e.at) : ''} onHover={{}}
        />
      );
    }
    if (e.kind === 'task' && e.inbox) {
      const r = e.inbox;
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={r.title} line={r.detail}
          chips={<span className="super-agenda-chip" data-kind="task">{tr(t, 'super.agenda.chip.task', 'Task')}</span>}
          time={e.at !== null ? fmtTime(e.at) : ''}
          onPress={onOpenTask ? () => onOpenTask(r.ref) : undefined} onHover={{}}
        />
      );
    }
    const r = e.row;
    if (!r) return null;
    if (e.kind === 'owed') {
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={r.text}
          chips={<span className="super-agenda-chip" data-kind="owed">{tr(t, r.owedKind === 'result' ? 'super.agenda.owed.result' : 'super.agenda.owed.msg', r.owedKind === 'result' ? 'Result' : 'Your message')}</span>}
          time={e.at !== null ? fmtTime(e.at) : ''}
          onPress={a.press === 'thread' && onThread ? () => pressThread(e, r) : undefined}
          threadOn={threadRowKey === e.key}
          onHover={{ ask: onWriteAbout ? () => onWriteAbout(r) : undefined, notNeeded: onDropOwed && r.owed ? () => onDropOwed(r.owed as string) : undefined }}
        />
      );
    }
    if (e.kind === 'question') {
      // The Super's own question is named by its words (approved drawing): its chip already says
      // who asks. A job's or member's question keeps who asks as its name, the words under it.
      const own = r.chip === 'ask' && !!r.line;
      const line = r.allowed
        ? <span data-testid="super-agenda-allowed">{t('owner.answer.allowedWaiting')}</span>
        : remote && r.chip === 'refusal'
          ? <span data-testid="super-agenda-phone-refusal">{t('owner.answer.phoneRefusal')}</span>
          : own ? undefined : r.line || undefined;
      return (
        <AgendaRowView
          key={e.key} entry={e} actions={a} size={size} label={own ? r.line as string : r.text} line={line}
          chips={r.chip ? <span className="super-agenda-chip" data-kind={r.chip}>{t(`super.jobs.chip.${r.chip}`)}</span> : undefined}
          time={e.at !== null ? fmtTime(e.at) : ''}
          onPress={a.press === 'thread' && onThread ? () => pressThread(e, r, r.item) : questionClickable(r) ? () => pressQuestion(r) : undefined}
          threadOn={threadRowKey === e.key}
          onHover={{ ask: onWriteAbout ? () => onWriteAbout(r) : undefined }}
        />
      );
    }
    // An agenda line: live or archived (C8).
    const id = r.note as string | undefined;
    const job = r.for ? state.children?.[r.for] : undefined;
    const chips = (
      <>
        {e.fromDay && <span className="super-agenda-chip" data-kind="day">{e.group === 'earlier' ? fmtDay(e.fromDay) : tr(t, 'super.agenda.detail.fromDay', 'from {day}', { day: fmtDay(e.fromDay) })}</span>}
        {r.auto && <span className="super-agenda-chip" data-kind="auto" data-testid="super-agenda-auto">{t('super.agenda.auto')}</span>}
        {(size === 'full' || size === 'wide') && job?.mode && e.group !== 'done' && <span className="super-agenda-chip" data-kind="mode">{job.mode}</span>}
        {size === 'full' && r.author === 'owner' && r.status && r.section !== 'done' && <span className="super-agenda-chip" data-kind="status">{t(`super.agenda.status.${r.status}`)}</span>}
      </>
    );
    const ask = onWriteAbout ? () => onWriteAbout(aboutRow(e)) : undefined;
    const toggleDetail = () => { setMenu(null); setSelected((k) => (k === e.key ? null : e.key)); };
    const threaded = a.press === 'thread' && !!onThread;
    // Small and medium: the press filters only; the detail moves to the row's hover (D2).
    const la = threaded && !inlineDetail && a.detail !== 'none' && !readOnly ? { ...a, hover: [...a.hover, 'detail' as const] } : a;
    return (
      <AgendaRowView
        key={e.key} entry={e} actions={la} size={size} label={r.text} chips={chips}
        time={e.group === 'earlier' ? '' : fmtTime(e.at ?? r.at)}
        selected={selected === e.key}
        threadOn={threadRowKey === e.key}
        onPress={threaded
          ? () => {
            const on = pressThread(e, aboutRow(e));
            // Wide/full: the inline detail follows the filter, on with it and off with it (D2).
            if (inlineDetail && a.detail !== 'none') { setMenu(null); setSelected(on ? e.key : null); }
          }
          : a.press === 'detail' || a.press === 'thread' ? toggleDetail : undefined}
        onMenu={a.menu && onPadStatus ? (anchor) => setMenu({ key: e.key, anchor }) : undefined}
        onHover={{ done: onPadStatus && id ? () => { void setStatus(id, 'done'); } : undefined, ask, detail: toggleDetail }}
      />
    );
  };

  const menuEntry = menu ? all.find((e) => e.key === menu.key) : null;
  const statusMenu = menu && menuEntry?.row?.status && menuEntry.row.note && (
    <AgendaStatusMenu
      anchor={menu.anchor}
      current={menuEntry.row.status}
      onClose={() => setMenu(null)}
      onPick={(s) => { void setStatus(menuEntry.row!.note as string, s); }}
    />
  );

  // ── The detail: inside the card when wide or full, beside it otherwise ───────────
  const detailBody = (e: AgendaEntry) => {
    const a = actionsOf(e);
    const r = e.row!;
    const id = r.note as string | undefined;
    const job = jobOf(e);
    return (
      <AgendaDetail
        entry={e} actions={a} group={groupName(e.group)} job={job} fmtTime={fmtTime} fmtDay={fmtDay}
        error={error && error.note === id ? error.text : ''}
        onClose={() => setSelected(null)}
        onAsk={a.hover.includes('ask') && onWriteAbout ? () => onWriteAbout(aboutRow(e)) : undefined}
        onDone={a.hover.includes('done') && onPadStatus && id ? () => { void setStatus(id, 'done'); } : undefined}
        onRemove={a.remove && onPadRemove && id ? () => {
          setError(null);
          onPadRemove(id).then(() => setSelected(null)).catch((e) => fail(e, id));
        } : undefined}
        onOpenChat={job?.canOpen && r.for ? () => onShowChild(r.for as string) : undefined}
        onOpenTask={job?.task && onOpenTask ? () => onOpenTask(job.task as string) : undefined}
      />
    );
  };
  const floatingDetail = !inlineDetail && selectedEntry && actionsOf(selectedEntry).detail !== 'none' && (
    <FloatLayer
      anchorOf={() => (rootRef.current?.closest('[data-stage-key]') as HTMLElement | null) ?? rootRef.current}
      place={(card, s) => {
        const centre = rootRef.current?.closest('.super-surface')?.querySelector('[data-testid="super-centre"]')?.getBoundingClientRect() ?? null;
        return placeBeside({ x: card.left, y: card.top, width: card.width, height: card.height }, s.width, s.height, { width: window.innerWidth, height: window.innerHeight }, centre ? { x: centre.left, y: centre.top, width: centre.width, height: centre.height } : null);
      }}
      onClose={() => setSelected(null)}
      className="agenda-detail agenda-detail--float"
      testId="super-agenda-detail-float"
      role="dialog"
      label={selectedEntry.row?.text}
    >
      {detailBody(selectedEntry)}
    </FloatLayer>
  );

  // ── The add button (one box, no picker: a line he adds is his) ──────────────────
  // A round + floating at the card's bottom-right corner at every size (owner 15 Nov: "kartın sağ
  // alt köşesine bir floating artı butonu"); it opens a small box in place.
  const fab = onPadAdd && !readOnly && day === today && <AgendaFab onAdd={onPadAdd} explain={explain} onStart={() => setError(null)} />;
  // Its own corner: a strip under the scrolling lines, so the visible list ends above the + and no
  // line ever sits under it, at rest or scrolling (owner 15 Nov).
  const strip = fab && <div className="agenda-strip" data-testid="super-agenda-strip">{fab}</div>;
  const pct = (n: number) => (progress.total ? Math.round((n / progress.total) * 100) : 0);
  const bar = (
    <div className="agenda-bar" aria-hidden>
      <span className="agenda-bar-done" style={{ width: `${pct(progress.done)}%` }} />
      <span className="agenda-bar-run" style={{ width: `${pct(progress.working)}%` }} />
    </div>
  );
  const nav = (long: boolean) => (loadDay
    ? <AgendaDayNav day={day} onDay={onDay} locale={locale} long={long} />
    : <span className="agenda-day" data-testid="super-agenda-day" data-day={day}>{new Intl.DateTimeFormat(locale, { day: 'numeric', month: long ? 'long' : 'short' }).format(now)}</span>);
  const progressText = tr(t, 'super.agenda.progress', '{done} of {total} done', { done: String(progress.done), total: String(progress.total) });

  // ── The lists ───────────────────────────────────────────────────────────────
  const [doneOpen, setDoneOpen] = useState(false);
  // Lines no job keeps true and unchanged 2h+ are said ONCE, quietly, on their group's head
  // (owner pick A, 15 Nov: a pill on every row crowded the list), never per row.
  const staleNote = (g: string, rows: AgendaEntry[]) => {
    const n = rows.filter((e) => e.row?.stale).length;
    return n > 0 && (
      <span className="super-agenda-stale-n" data-testid={`super-agenda-stale-${g}`} title={t('super.agenda.staleTitle')}>
        {'· '}{tr(t, 'super.agenda.stale', '{n} unchanged 2h+', { n: String(n) })}
      </span>
    );
  };
  const groupList = (cap: boolean) => {
    if (past) {
      const sections: DayGroup[] = ['dayDone', 'dayOpen'];
      const empty = sections.every((g) => past[g].length === 0);
      return (
        <div className="agenda-groups" {...listHandlers}>
          {empty && <div className="super-agenda-empty">{t('super.agenda.nothingDay')}</div>}
          {sections.map((g) => past[g].length > 0 && (
            <section key={g} className="super-agenda-sec" data-section={g} data-testid={`super-agenda-section-${g}`}>
              <h3 className="super-agenda-sec-h"><span>{groupName(g)}</span><span className="super-agenda-n">{past[g].length}</span>{staleNote(g, past[g])}</h3>
              {order(past[g]).map(rowOf)}
            </section>
          ))}
        </div>
      );
    }
    const empty = TODAY_GROUPS.every((g) => groups[g].length === 0);
    return (
      <div className="agenda-groups" {...listHandlers}>
        {empty && <div className="super-agenda-empty">{t('super.agenda.nothing')}</div>}
        {TODAY_GROUPS.map((g) => {
          const rows = order(groups[g]);
          if (!rows.length) return null;
          const capped = cap && g === 'done' && !doneOpen && rows.length > 5;
          const shown = capped ? rows.slice(0, 5) : rows;
          const head = (
            <h3 className="super-agenda-sec-h">
              <span>{groupName(g)}</span>
              <span className="super-agenda-n" data-testid={`super-agenda-count-${g}`}>{rows.length}</span>
              {staleNote(g, rows)}
            </h3>
          );
          if (g === 'earlier') {
            return (
              <details key={g} className="super-agenda-sec agenda-earlier" data-section={g} data-testid="super-agenda-section-earlier" open>
                <summary>{head}</summary>
                {shown.map(rowOf)}
              </details>
            );
          }
          return (
            <section key={g} className="super-agenda-sec" data-section={g} data-testid={`super-agenda-section-${g}`}>
              {head}
              {shown.map(rowOf)}
              {capped && (
                <button type="button" className="agenda-more" data-testid="super-agenda-more" onClick={() => setDoneOpen(true)}>
                  {tr(t, 'super.agenda.more', '+ {n} more', { n: String(rows.length - 5) })}
                </button>
              )}
            </section>
          );
        })}
        {extra}
      </div>
    );
  };

  // ── The board: the same lines in three columns, waiting on him, on it, done ───────
  const board = () => {
    const cols: Array<[string, string, AgendaEntry[]]> = [
      ['waiting', groupName('waiting'), groups.waiting],
      ['onit', t('super.agenda.filter.onit'), [...groups.earlier, ...groups.super, ...groups.mine]],
      ['done', groupName('done'), groups.done],
    ];
    return (
      <div className="agenda-board" data-testid="super-agenda-board" {...listHandlers}>
        {cols.map(([k, name, rows]) => (
          <section key={k} className="agenda-board-col super-agenda-sec" data-section={k === 'onit' ? 'super' : k} data-testid={`super-agenda-board-${k}`}>
            <h3 className="super-agenda-sec-h"><span>{name}</span><span className="super-agenda-n">{rows.length}</span>{staleNote(k, rows)}</h3>
            {rows.length === 0 && <div className="super-agenda-empty">{t('super.agenda.nothing')}</div>}
            {order(rows).map(rowOf)}
          </section>
        ))}
      </div>
    );
  };
  const boardOn = view === 'board' && !past;
  // The member's tasks (extra) stay under the board, never a fourth column.
  const lines = (cap: boolean) => (boardOn ? <>{board()}{extra}</> : groupList(cap));
  const viewSwitch = !past && (
    <div className="agenda-viewswitch" role="group" aria-label={tr(t, 'super.agenda.view.label', 'View')}>
      {(['list', 'board'] as const).map((v) => (
        <button key={v} type="button" className="agenda-viewswitch-btn" data-testid={`super-agenda-view-${v}`} aria-pressed={view === v} data-on={view === v ? 'true' : undefined}
          title={tr(t, `super.agenda.view.${v}`, v === 'list' ? 'List' : 'Board')} aria-label={tr(t, `super.agenda.view.${v}`, v === 'list' ? 'List' : 'Board')} onClick={() => pickView(v)}>
          {v === 'list'
            ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><path d="M3 4h10M3 8h10M3 12h10" /></svg>
            : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden><rect x="2" y="3" width="3.5" height="10" rx="1" /><rect x="6.25" y="3" width="3.5" height="7" rx="1" /><rect x="10.5" y="3" width="3.5" height="5" rx="1" /></svg>}
        </button>
      ))}
    </div>
  );

  // Shown unless the open detail is the line it belongs to (that detail shows it).
  const inDetail = !!error?.note && selectedEntry?.row?.note === error.note && actionsOf(selectedEntry).detail !== 'none';
  const errorLine = error && !inDetail && <p className="agenda-error" role="alert" data-testid="super-agenda-error" title={error.text}>{error.text}</p>;

  const common = {
    ref: rootRef,
    'data-testid': 'super-agenda',
    'data-size': size,
    'data-variant': size === 'small' || size === 'medium' ? 'tile' : 'full',
    'data-day': day,
    'data-readonly': readOnly ? 'true' : undefined,
    role: 'region' as const,
    'aria-label': t('super.agenda.label'),
  };

  if (size === 'small') {
    const rows = past ? [...past.dayOpen, ...past.dayDone].slice(0, 3) : smallEntries(groups, 3);
    return (
      <div className="super-agenda" {...common}>
        <div className="agenda-head">
          {nav(false)}
          <span className="agenda-count" data-testid="super-agenda-progress">{progress.done}/{progress.total}</span>
        </div>
        {bar}
        <div className="agenda-groups" {...listHandlers}>
          {rows.length === 0 && <div className="super-agenda-empty">{t(past ? 'super.agenda.nothingDay' : 'super.agenda.nothing')}</div>}
          {order(rows).map(rowOf)}
        </div>
        <div className="agenda-foot">
          {errorLine || (!past && (
            <span className="agenda-foot-waiting" data-on={progress.waiting > 0 ? 'true' : undefined}>
              {tr(t, 'super.agenda.summaryWaiting', '{n} waiting on you', { n: String(progress.waiting) })}
            </span>
          ))}
          {fab}
        </div>
        {statusMenu}{floatingDetail}
      </div>
    );
  }

  if (size === 'medium') {
    const counts: Record<AgendaFilter, number> = { waiting: groups.waiting.length, onit: groups.super.length + groups.mine.length + groups.earlier.length, done: groups.done.length };
    const rows = past ? [] : filterEntries(groups, filter);
    return (
      <div className="super-agenda" {...common}>
        <div className="agenda-side">
          {nav(false)}
          {bar}
          {!past && (['waiting', 'onit', 'done'] as const).map((f) => (
            <button key={f} type="button" className="agenda-filter" data-filter={f} data-on={filter === f ? 'true' : undefined} aria-pressed={filter === f} data-testid={`super-agenda-filter-${f}`} onClick={() => setFilter(f)}>
              <span className="agenda-filter-dot" aria-hidden />
              <span className="agenda-filter-l">{t(`super.agenda.filter.${f}`)}</span>
              <span className="agenda-filter-n">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="agenda-main">
          <div className="agenda-main-head">
            <span>{past ? tr(t, 'super.agenda.progress', '{done} of {total} done', { done: String(progress.done), total: String(progress.total) }) : groupName(filter === 'onit' ? 'super' : filter)}</span>
          </div>
          <div className="agenda-scroll">
            {errorLine}
            {past ? groupList(false) : (
              <div className="agenda-groups" {...listHandlers}>
                {rows.length === 0 && <div className="super-agenda-empty">{t('super.agenda.nothing')}</div>}
                {order(rows).map(rowOf)}
              </div>
            )}
          </div>
          {strip}
        </div>
        {statusMenu}{floatingDetail}
      </div>
    );
  }

  const header = (long: boolean) => (
    <div className="agenda-head">
      {nav(long)}
      {day === today && <span className="agenda-today">{t('super.agenda.today')}</span>}
      {/* Large is 344 px: the count in short (3/18), so the day, Today and the list/board switch fit. */}
      <span className="agenda-count" data-testid="super-agenda-progress" title={progressText}>{size === 'large' ? `${progress.done}/${progress.total}` : progressText}</span>
      {viewSwitch}
    </div>
  );

  if (size === 'large') {
    return (
      <div className="super-agenda" {...common}>
        <div className="agenda-scroll">
          {header(true)}
          {bar}
          {errorLine}
          {lines(false)}
        </div>
        {strip}
        {statusMenu}{floatingDetail}
      </div>
    );
  }

  // Wide and full: the selected line's detail INSIDE the card, on the right.
  const detailPane = selectedEntry && actionsOf(selectedEntry).detail !== 'none' && (
    <aside className="agenda-detail agenda-detail--inline" data-testid="super-agenda-detail-inline">{detailBody(selectedEntry)}</aside>
  );
  if (size === 'wide') {
    return (
      <div className="super-agenda" {...common} data-detail={detailPane ? 'true' : undefined}>
        <div className="agenda-col">
          <div className="agenda-scroll">
            {header(true)}
            {bar}
            {errorLine}
            {lines(false)}
          </div>
          {strip}
        </div>
        {detailPane}
        {statusMenu}
      </div>
    );
  }

  const summary = [
    progressText,
    progress.working ? tr(t, 'super.agenda.summaryWorking', '{n} in progress', { n: String(progress.working) }) : '',
    progress.waiting ? tr(t, 'super.agenda.summaryWaiting', '{n} waiting on you', { n: String(progress.waiting) }) : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="super-agenda" {...common} data-detail={detailPane ? 'true' : undefined}>
      <div className="agenda-col">
        <div className="agenda-scroll">
        {loadDay && <AgendaWeekStrip day={day} today={today} onDay={onDay} locale={locale} />}
        <div className="agenda-title-row">
          <h2 className="agenda-title">{new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' }).format(new Date(`${day}T12:00:00`))}</h2>
          {day === today && <span className="agenda-today">{t('super.agenda.today')}</span>}
          {viewSwitch}
        </div>
        <div className="agenda-progress-row">
          {bar}
          <span className="agenda-count" data-testid="super-agenda-progress">{summary}</span>
        </div>
        {errorLine}
        {lines(true)}
        </div>
        {strip}
      </div>
      {detailPane}
      {statusMenu}
    </div>
  );
}


const VIEW_KEY = 'dc-super-agenda-view';
const VIEW_EVENT = 'dc-super-agenda-view';

/** The floating + and the small box it opens (one box, no picker: a line he adds is his). Enter
 *  adds, Escape or leaving the box cancels. Read-only while its request runs, so a double Enter
 *  writes one line and the box keeps its focus. Its own component, so a pushed record never wipes
 *  what he is typing. */
function AgendaFab({ onAdd, explain, onStart }: {
  onAdd: (text: string) => Promise<void>;
  /** A refusal's words; the box shows them over itself, where he is typing. */
  explain: (e: unknown) => string;
  onStart?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState('');
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const close = (focusBack: boolean) => {
    setOpen(false); setText(''); setRefused('');
    if (focusBack) requestAnimationFrame(() => btnRef.current?.focus());
  };
  const submit = async () => {
    const line = text.trim();
    if (!line || busy) return;
    setBusy(true);
    setRefused('');
    onStart?.();
    try { await onAdd(line); close(true); } catch (e) { setRefused(explain(e)); } finally { setBusy(false); }
  };
  const label = t('super.agenda.addTitle');
  return (
    <div className="agenda-fab" data-open={open ? 'true' : undefined}>
      {open ? (
        <form
          className="agenda-fab-form"
          data-testid="super-agenda-add"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
          onBlur={(e) => { if (!busy && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false); }}
        >
          {refused && <p className="agenda-error agenda-add-error" role="alert" data-testid="super-agenda-add-error">{refused}</p>}
          <input
            className="agenda-fab-input"
            data-testid="super-agenda-add-input"
            value={text}
            maxLength={160}
            autoFocus
            readOnly={busy}
            placeholder={t('super.agenda.addPlaceholder')}
            aria-label={label}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } }}
          />
          <button type="submit" className="agenda-fab-go" data-testid="super-agenda-add-submit" aria-label={t('super.agenda.add')} title={t('super.agenda.add')} disabled={busy || !text.trim()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </form>
      ) : (
        <button ref={btnRef} type="button" className="agenda-fab-btn" data-testid="super-agenda-plus" aria-label={label} title={label} onClick={() => setOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
      )}
    </div>
  );
}
