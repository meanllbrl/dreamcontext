import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentProfilePanel } from '../agents/AgentProfilePanel';
import { findAgent, useAgents } from '../../hooks/useAgents';
import { SlotRowEditor } from '../agents/AutomationDialog';
import { useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import {
  useAutomation, useRunAutomation, useSetAutomationEnabled, useUpdateAgent,
  type AutomationRunEvent, type FeedMessage,
} from '../../hooks/useAutomations';
import { initialSlotRows, newSlotRow, nextFireWords, slotsFromRows, type SlotRow } from '../../lib/agentDraft';
import { openTrainChat } from '../../lib/automationRunChat';
import { runDuration } from '../agents/agentRunState';
import type { TeamAutomation } from './teamModel';
import { TeamIcon } from './TeamIcons';
import { PlaceInTeam } from './PlaceInTeam';
import { TeamTab } from './TeamTab';
import type { TeamTree } from '../../../../src/lib/agents/tree.js';
import type { TeamRow } from './teamModel';
import '../agents/AutomationDialog.css';
import '../agents/AgentMemberCard.css';
import '../agents/AgentProfilePanel.css';
import '../automations/AutomationDetailPanel.css';

export type PanelTab = 'profile' | 'team' | 'routines' | 'files';

/**
 * THE RIGHT PANEL: who this teammate is (Profile, with its review), what it does on its own
 * (Routines), and what it has made (Files). It sits beside the conversation and narrows it;
 * at phone width the page draws it over the conversation instead.
 */
export function TeamPanel({
  slug,
  title,
  tab,
  onTab,
  onClose,
  routines,
  messages,
  onEdit,
  onDeleted,
  onOpenFile,
  onToast,
  onSelectAgent,
  team,
}: {
  slug: string;
  title: string;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  routines: TeamAutomation[];
  messages: FeedMessage[];
  onEdit: (slug: string) => void;
  onDeleted: () => void;
  onOpenFile: (path: string) => void;
  onToast: (msg: string) => void;
  /** Open another teammate (a chip in "Place in team"). */
  onSelectAgent?: (slug: string) => void;
  /** The Team tab's data: every row, the tree, and how to open a conversation. */
  team?: { rows: TeamRow[]; tree: TeamTree; onTalk: (slug: string) => void };
}) {
  const { t } = useI18n();
  // A teammate's agent (B1-4): every tab reads, nothing writes.
  const member = findAgent(useAgents().data, slug);
  const readOnly = member?.readOnly === true;
  // A global agent reports to the owner in every project: it has no place in one project's team (D1).
  const global = member?.scope === 'global';
  const reports = team?.tree.nodes.get(slug)?.children.length ?? 0;
  const tabs: { id: PanelTab; label: string; count?: number }[] = [
    { id: 'profile', label: t('aiteam.panel.profile') },
    ...(team ? [{ id: 'team' as const, label: t('aiteam.panel.team'), count: reports }] : []),
    { id: 'routines', label: t('aiteam.panel.routines'), count: routines.length },
    { id: 'files', label: t('aiteam.panel.files') },
  ];
  return (
    <aside className="aiteam-panel" aria-label={t('aiteam.details')}>
      <div className="aiteam-panel-head">
        <div className="agents-switch" role="tablist" aria-label={t('aiteam.details')}>
          {tabs.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              className={`agents-switch-opt${tab === x.id ? ' agents-switch-opt--on' : ''}`}
              onClick={() => onTab(x.id)}
              data-panel-tab={x.id}
            >
              {x.label}
              {x.count !== undefined && x.count > 0 && <span className="agents-switch-count">{x.count}</span>}
            </button>
          ))}
        </div>
        <span className="aiteam-spacer" />
        <button type="button" className="aiteam-panel-close" onClick={onClose} aria-label={t('aiteam.panel.close')}>
          <TeamIcon name="close" size={14} />
        </button>
      </div>
      {tab === 'profile' && (
        <AgentProfilePanel slug={slug} onClose={onClose} onEdit={onEdit} onDeleted={onDeleted} onToast={onToast}
          placement={readOnly || global ? null : <PlaceInTeam slug={slug} onOpen={onSelectAgent} onToast={onToast} />} />
      )}
      {tab === 'team' && team && (
        <TeamTab
          slug={slug}
          rows={team.rows}
          tree={team.tree}
          onOpen={(s) => onSelectAgent?.(s)}
          onTalk={team.onTalk}
          onToast={onToast}
        />
      )}
      {tab === 'routines' && (
        <div className="aiteam-panel-body">
          <div className="aiteam-tip">
            <TeamIcon name="clock" size={16} />
            <span>{t('aiteam.routines.tip').replace('{name}', title)}</span>
          </div>
          {routines.length === 0 && <p className="aiteam-panel-empty">{t('aiteam.routines.empty').replace('{name}', title)}</p>}
          {routines.map((r, i) => (readOnly ? (
            <div key={r.slug} className="aiteam-routine" data-routine={r.slug} data-routine-readonly>
              <div className="aiteam-routine-top">
                <span className="aiteam-routine-id">
                  <span className="aiteam-routine-name">{r.title}</span>
                  <span className="aiteam-routine-when">{r.enabled ? r.cadenceLabel : t('aiteam.routine.paused')}</span>
                </span>
              </div>
            </div>
          ) : (
            <RoutineCard key={r.slug} routine={r} agentTitle={title} startOpen={i === 0} onToast={onToast} />
          )))}
        </div>
      )}
      {tab === 'files' && <TeamFiles messages={messages} onOpenFile={onOpenFile} />}
    </aside>
  );
}

const HISTORY_WORD: Record<string, string> = {
  ok: 'aiteam.history.ok',
  failed: 'aiteam.history.failed',
  timeout: 'aiteam.history.failed',
  'awaiting-review': 'aiteam.history.asked',
};

/**
 * ONE ROUTINE: on/off, Run now, Train, and its name, job, times and "ask me first", saved
 * through the same update the old automation dialog used (which re-approves it here).
 * Closed, it is one line: its name and when it runs.
 */
function RoutineCard({
  routine, agentTitle, startOpen, onToast,
}: {
  routine: TeamAutomation;
  agentTitle: string;
  startOpen: boolean;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const { bus } = useVault();
  const [open, setOpen] = useState(startOpen);
  const detail = useAutomation(open ? routine.slug : null, { fresh: true });
  const manifest = detail.isFetchedAfterMount ? detail.data?.automation ?? null : null;
  const bound = !!routine.agent && routine.agent !== routine.slug;

  const [title, setTitle] = useState(routine.title);
  const [job, setJob] = useState('');
  const [rows, setRows] = useState<SlotRow[]>([]);
  const [review, setReview] = useState(false);
  const seeded = useRef(false);
  /** The slots the form opened with, so a save that did not touch the times never rewrites them. */
  const seededSlots = useRef('');
  useEffect(() => {
    if (seeded.current || !manifest) return;
    seeded.current = true;
    const startRows = initialSlotRows(manifest.schedule?.slots, undefined, new Date());
    const start = slotsFromRows(startRows);
    seededSlots.current = 'error' in start ? '' : JSON.stringify(start.slots);
    setTitle(manifest.title);
    setJob(bound ? manifest.job ?? '' : manifest.prompt);
    setRows(startRows);
    setReview(manifest.review !== 'off');
  }, [manifest, bound]);

  const enable = useSetAutomationEnabled();
  const run = useRunAutomation();
  const update = useUpdateAgent();
  const parsed = useMemo(() => slotsFromRows(rows), [rows]);
  const next = nextFireWords(routine.nextFireAt, new Date());
  const when = routine.enabled
    ? [routine.cadenceLabel, next ? t('aiteam.routine.next').replace('{when}', next) : null].filter(Boolean).join(' · ')
    : t('aiteam.routine.paused');

  const save = () => {
    if (!manifest || 'error' in parsed) return;
    update.mutate({
      slug: routine.slug,
      draft: {
        title: title.trim(),
        ...(bound ? { job: job.trim() } : { prompt: job.trim() }),
        ...(JSON.stringify(parsed.slots) !== seededSlots.current ? { slots: parsed.slots } : {}),
        review: review ? (manifest.review === 'off' ? 'agent' : manifest.review) : 'off',
      },
    }, {
      onSuccess: () => onToast(t('aiteam.routine.saved').replace('{name}', title.trim())),
      onError: (err) => onToast((err as Error).message),
    });
  };
  const train = () => {
    if (manifest && !manifest.learning) { onToast(t('aiteam.routine.trainOff')); return; }
    if (!openTrainChat(bus, { slug: routine.slug, automationTitle: routine.title })) onToast(t('aiteam.routine.trainFailed'));
  };
  const history: AutomationRunEvent[] = Array.isArray(detail.data?.cache?.history) ? detail.data!.cache!.history : [];

  return (
    <div className={`aiteam-routine${open ? ' aiteam-routine--open' : ''}`} data-routine={routine.slug}>
      <div className="aiteam-routine-top">
        <button type="button" className="aiteam-routine-id" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="aiteam-routine-name">{routine.title}</span>
          <span className="aiteam-routine-when">{when}</span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={routine.enabled}
          aria-label={t('aiteam.routine.toggle').replace('{name}', routine.title)}
          className={`agent-switch${routine.enabled ? ' agent-switch--on' : ''}`}
          onClick={() => enable.mutate({ slug: routine.slug, enabled: !routine.enabled }, {
            onError: (err) => onToast((err as Error).message),
          })}
        >
          <span className="agent-switch-knob" aria-hidden="true" />
        </button>
      </div>
      {open && (
        <>
          <div className="aiteam-routine-actions">
            <button
              type="button"
              className="agent-btn"
              disabled={run.isPending || !routine.approved}
              title={routine.approved ? undefined : t('aiteam.routine.unapproved')}
              onClick={() => run.mutate(routine.slug, {
                onSuccess: () => onToast(t('aiteam.routine.started').replace('{name}', routine.title)),
                onError: (err) => onToast((err as Error).message),
              })}
            >
              <TeamIcon name="play" size={12} /> {t('aiteam.routine.runNow')}
            </button>
            <button type="button" className="agent-btn" onClick={train}>{t('aiteam.routine.train')}</button>
          </div>
          {!manifest ? (
            <p className="agent-note" role={detail.isError ? 'alert' : undefined}>
              {detail.isError ? t('agents.page.loadFailed') : t('agents.page.loading')}
            </p>
          ) : (
            <>
              <label className="agent-field">
                <span className="agent-label">{t('aiteam.routine.name')}</span>
                <input className="agent-input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="agent-field">
                <span className="agent-label">{t('aiteam.routine.job')}</span>
                <textarea className="agent-textarea" value={job} onChange={(e) => setJob(e.target.value)} />
                <span className="agent-note">{t('aiteam.routine.jobHint').replace('{name}', agentTitle)}</span>
              </label>
              <div className="agent-field">
                <span className="agent-label">{t('aiteam.routine.when')}</span>
                {rows.map((r, i) => (
                  <SlotRowEditor
                    key={r.id}
                    row={r}
                    index={i}
                    canRemove={rows.length > 1}
                    onChange={(nextRow) => setRows((cur) => cur.map((x, j) => (j === i ? nextRow : x)))}
                    onRemove={() => setRows((cur) => cur.filter((_, j) => j !== i))}
                    onTimeTouched={() => {}}
                  />
                ))}
                <button
                  type="button"
                  className="agent-btn agent-slot-add"
                  onClick={() => setRows((cur) => [...cur, newSlotRow(new Date())])}
                >
                  {t('aiteam.routine.addTime')}
                </button>
              </div>
              <div className="aiteam-check">
                <span>
                  {t('aiteam.routine.review')}
                  <small>{t('aiteam.routine.reviewHint')}</small>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={review}
                  aria-label={t('aiteam.routine.review')}
                  className={`agent-switch${review ? ' agent-switch--on' : ''}`}
                  onClick={() => setReview((v) => !v)}
                >
                  <span className="agent-switch-knob" aria-hidden="true" />
                </button>
              </div>
              <div className="aiteam-routine-foot">
                <span className="agent-note">{t('aiteam.routine.reapprove')}</span>
                <span className="aiteam-spacer" />
                <button
                  type="button"
                  className="agent-btn agent-btn--primary"
                  /* A bound routine may ask nothing beyond who its agent is; a self-contained one needs its prompt. */
                  disabled={update.isPending || !title.trim() || (!bound && !job.trim()) || 'error' in parsed}
                  onClick={save}
                >
                  {t('aiteam.routine.save')}
                </button>
              </div>
            </>
          )}
          {history.length > 0 && (
            <>
              <div className="adp-section-label">
                {t('aiteam.routine.recent')}<span className="adp-history-count">{history.length}</span>
              </div>
              <div className="adp-history">
                {history.slice(0, 5).map((ev, i) => (
                  <div key={`${ev.firedAt}-${i}`} className="adp-history-row">
                    <span className="adp-history-line">
                      <span className={`adp-history-dot adp-history-dot--${ev.status}`} />
                      <span className="adp-history-status">{t(HISTORY_WORD[ev.status] ?? 'aiteam.history.other')}</span>
                      <span className="adp-history-when">
                        {new Date(ev.firedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </span>
                    <span className="adp-history-sub">
                      {ev.durationMs > 0 && <span>{runDuration(ev.durationMs)}</span>}
                      {ev.numTurns !== null && <span>{t('aiteam.history.turns').replace('{n}', String(ev.numTurns))}</span>}
                      {ev.costUsd !== null && <span>${ev.costUsd.toFixed(3)}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * EVERY FILE THIS TEAMMATE HAS POSTED, newest first: its runs' documents and the files its
 * posts attached, one row per path. Read off the conversation's own messages, so the list
 * and the conversation can never disagree about what was attached.
 */
export function teamFiles(messages: readonly FeedMessage[]): { path: string; name: string; title: string; at: string }[] {
  const seen = new Set<string>();
  const out: { path: string; name: string; title: string; at: string }[] = [];
  for (const m of [...messages].reverse()) {
    for (const f of m.document ? [...m.files, m.document] : m.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push({ path: f.path, name: f.name, title: m.title, at: m.at });
    }
  }
  return out;
}

function TeamFiles({ messages, onOpenFile }: { messages: FeedMessage[]; onOpenFile: (path: string) => void }) {
  const { t } = useI18n();
  const rows = useMemo(() => teamFiles(messages), [messages]);
  return (
    <div className="aiteam-panel-body">
      {rows.length === 0 ? (
        <p className="aiteam-panel-empty">{t('aiteam.files.empty')}</p>
      ) : (
        <div className="agent-msg-files">
          {rows.map((r) => (
            <button key={r.path} type="button" className="agent-msg-file" onClick={() => onOpenFile(r.path)} title={r.path}>
              <span className="agent-msg-file-glyph" aria-hidden="true">◧</span>
              <span className="agent-msg-file-name">{r.name}</span>
              <span className="agent-msg-file-note">{r.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
