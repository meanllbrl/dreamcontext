import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '../../../context/I18nContext';
import { useApi } from '../../../context/VaultContext';
import { findAgent, useAgent, useAgents } from '../../../hooks/useAgents';
import { useAutomations, useDeleteAgent } from '../../../hooks/useAutomations';
import { confirmAction } from '../../../lib/desktop';
import { RoutineCard } from '../../aiteam/TeamPanel';
import { routineOf, setMemberEnabled, type TeamAutomation } from '../../aiteam/teamModel';
import { AutomationDialog } from '../../agents/AutomationDialog';
import { AgentIdentityDialog } from '../../agents/AgentIdentityDialog';
import type { MemberCardRef } from '../../../lib/superTypes';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import './MemberCardBody.css';

/**
 * A member stage's own cards' bodies (plan r4 K2, R3, R4, G2): Rutinler (its routines, a new one
 * made FOR it), Talimatlar (its soul and job; Düzenle is the existing identity edit and its
 * approval path), Üye (the on/off switch and "Bu üyeyi sil"). Drawn by SuperContainer through a
 * render prop handed in from the Chat surface, so the stage modules never import chat UI. A small
 * card is a summary tile; medium and up the full body, live on the card (the agenda's way).
 * Delete asks in-app (never `window.confirm`), filled from the server's dry run.
 */

export interface MemberCardBodyProps {
  slug: string;
  cardRef: MemberCardRef;
  variant: 'tile' | 'full';
  /** The member's call is on (the Team summary's word). */
  enabled: boolean;
  /** It works right now (for the owner or for main): delete waits. */
  working: boolean;
  /** A phone: the switch and delete are the Mac's. */
  phone?: boolean;
  /** The member is gone: the stage goes back to main's. */
  onDeleted: () => void;
  /** "+ New routine" on the stage: hands the job to this member's Super as a card chip titled
   *  `title` (owner 2026-11-05). False = no Super chat can take it: the form opens as before. */
  onNewRoutine?: (title: string) => boolean;
}

interface DeletePlan { slug: string; title: string; global: boolean; routines: Array<{ project: string; slug: string; title: string }>; blockers: string[] }

type CardProps = MemberCardBodyProps & { onToast: (msg: string) => void };

export function MemberCardBody(props: MemberCardBodyProps) {
  // What a card's action said last (a save, a refusal): one quiet line on the card itself.
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return undefined;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);
  const p: CardProps = { ...props, onToast: setNote };
  const body = p.cardRef === 'routines' ? <RoutinesCard {...p} /> : p.cardRef === 'instructions' ? <InstructionsCard {...p} /> : <SettingsCard {...p} />;
  return (
    <>
      {body}
      {note && props.variant === 'full' && <p className="mcb-note" role="status" data-testid="member-card-note">{note}</p>}
    </>
  );
}

/**
 * A dialog a card opens, drawn at the window's level: a floating card's clip has `contain:
 * strict`, which would lay a fixed overlay out (and clip it) inside the card. Its pointer events
 * stop here, so a press in the dialog never arms the card's drag behind it.
 */
function WindowLayer({ children }: { children: ReactNode }) {
  return createPortal(
    <div data-member-card-layer onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>{children}</div>,
    document.body,
  );
}

/** Its routines. An UNSPLIT member's own manifest IS the member (`implicit`, read from the agent
 *  record: the list API names every automation's agent, so the automation cannot tell): never a
 *  routine row with a Sil. A split member's same-name routine is a routine like any other. */
export function memberRoutines(all: readonly TeamAutomation[], slug: string, implicit: boolean): TeamAutomation[] {
  return all.filter((a) => routineOf(a, slug) && !(implicit && a.slug === slug));
}

function useMemberRoutines(slug: string): TeamAutomation[] {
  const autos = useAutomations();
  const implicit = !!findAgent(useAgents().data, slug)?.implicit;
  // The member's own unsplit scheduled manifest IS the member (the server's rule): never a row
  // here, so a routine's Sil can never delete the member itself, and the count is the dialog's.
  return useMemo(() => memberRoutines((autos.data ?? []) as TeamAutomation[], slug, implicit), [autos.data, slug, implicit]);
}

function RoutinesCard(p: CardProps) {
  const { t } = useI18n();
  const routines = useMemberRoutines(p.slug);
  const agents = useAgents();
  const agent = findAgent(agents.data, p.slug);
  const remove = useDeleteAgent();
  const [creating, setCreating] = useState(false);
  const readOnly = !!agent?.readOnly;
  if (p.variant === 'tile') {
    const on = routines.filter((r) => r.enabled).length;
    return (
      <div className="mcb-tile" data-testid="member-card-tile" data-ref="routines">
        <span className="mcb-big">{routines.length}</span>
        <span className="mcb-sub">{t('superStage.member.cards.routinesSub').replace('{n}', String(on))}</span>
      </div>
    );
  }
  const del = async (r: TeamAutomation) => {
    const yes = await confirmAction({
      title: t('superStage.member.cards.routineDeleteTitle').replace('{name}', r.title),
      body: t('superStage.member.cards.routineDeleteBody'),
      confirmLabel: t('superStage.member.cards.routineDelete'),
      cancelLabel: t('superStage.member.cards.cancel'),
      destructive: true,
    });
    if (!yes) return;
    remove.mutate(r.slug, { onError: (err) => p.onToast((err as Error).message) });
  };
  return (
    <div className="mcb-body" data-testid="member-card-routines">
      {routines.length === 0 && <p className="mcb-muted">{t('superStage.member.cards.routinesEmpty')}</p>}
      {routines.map((r) => (
        <RoutineCard key={r.slug} routine={r} agentTitle={agent?.title || p.slug} startOpen={false} onToast={p.onToast}
          {...(readOnly ? {} : { onDelete: () => void del(r) })} />
      ))}
      {!readOnly && (
        <button type="button" className="mcb-new" data-testid="member-routine-new"
          onClick={() => { if (!p.onNewRoutine?.(t('superStage.member.cards.routineNewChip'))) setCreating(true); }}>
          {t('superStage.member.cards.routineNew')}
        </button>
      )}
      {creating && (
        <WindowLayer>
          <AutomationDialog automation={null} onToast={p.onToast} onClose={() => setCreating(false)}
            initial={{ title: '', description: '', mode: 'sched', agent: p.slug }} />
        </WindowLayer>
      )}
    </div>
  );
}

/** A job split for the card: its opening paragraph as the lede (plain words, the member's job in
 *  a line or two) and the rest, drawn as markdown below it. A job that opens with a heading, a
 *  list or a fence has no lede: all of it is the body, so nothing is said twice or lost. */
export function instructionsParts(job: string): { lede: string; rest: string } {
  const text = job.replace(/\r\n?/g, '\n').trim();
  const cut = text.search(/\n\s*\n/);
  const first = (cut < 0 ? text : text.slice(0, cut)).trim();
  if (!first || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|>|\|)/.test(first)) return { lede: '', rest: text };
  return { lede: first.replace(/\s+/g, ' '), rest: cut < 0 ? '' : text.slice(cut).trim() };
}

/** Markdown read as plain words (a tile, a lede): no marks, one line. */
export function plainWords(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_~]+/g, '').replace(/^#{1,6}\s+/gm, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/** How long a read may take before the card says so and offers a retry (a hung request would
 *  otherwise read as "loading" forever). */
const SLOW_READ_MS = 8000;

function InstructionsCard(p: CardProps) {
  const { t } = useI18n();
  const detail = useAgent(p.slug);
  const agents = useAgents();
  const agent = findAgent(agents.data, p.slug);
  const routines = useMemberRoutines(p.slug);
  const [editing, setEditing] = useState(false);
  const [slow, setSlow] = useState(false);
  // Each retry is a new attempt with its own clock: a retried request that hangs again is said
  // again (the query stays pending across a refetch, so `pending` alone would not restart it).
  const [attempt, setAttempt] = useState(0);
  const pending = detail.isPending && detail.fetchStatus !== 'idle';
  useEffect(() => {
    if (!pending) { setSlow(false); return undefined; }
    const timer = window.setTimeout(() => setSlow(true), SLOW_READ_MS);
    return () => window.clearTimeout(timer);
  }, [pending, attempt]);
  // Only the full record: the roster's description is clipped by the server, never the job.
  const soul = detail.data?.soul?.trim() ?? '';
  const job = detail.data?.prompt?.trim() ?? '';
  const { lede, rest } = useMemo(() => instructionsParts(job), [job]);
  if (p.variant === 'tile') {
    const words = plainWords(job || agent?.description || '');
    return (
      <div className="mcb-tile" data-testid="member-card-tile" data-ref="instructions">
        <span className="mcb-clip">{words.slice(0, 220)}</span>
      </div>
    );
  }
  const summary = detail.data?.agent ?? agent;
  const model = summary?.model ? summary.model.charAt(0).toUpperCase() + summary.model.slice(1) : t('agents.profile.modelDefault');
  const effort = summary?.effort ? t(`superStage.member.cards.effort.${summary.effort}`) : null;
  const meta = [model, effort, t('superStage.member.cards.metaRoutines').replace('{n}', String(routines.length))].filter(Boolean).join(' · ');
  const retry = () => { setSlow(false); setAttempt((n) => n + 1); void detail.refetch(); };
  return (
    <div className="mcb-body mcb-ins" data-testid="member-card-instructions">
      <div className="mcb-ins-top">
        <span className="mcb-ins-meta" data-testid="member-instructions-meta" title={meta}>{detail.data ? meta : ''}</span>
        {!agent?.readOnly && (
          <button type="button" className="mcb-icon" data-testid="member-instructions-edit" disabled={!detail.data}
            aria-label={t('superStage.member.cards.edit')} title={t('superStage.member.cards.edit')} onClick={() => setEditing(true)}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3z" /><path d="M9 4l3 3" />
            </svg>
          </button>
        )}
      </div>
      <div className="mcb-ins-scroll" data-testid="member-instructions-scroll">
        {detail.isError || slow ? (
          <div className="mcb-ins-state" role="status" data-testid="member-instructions-error">
            <p className="mcb-muted">{t(detail.isError ? 'superStage.member.cards.readFailed' : 'superStage.member.cards.readSlow')}</p>
            <button type="button" className="mcb-link" data-testid="member-instructions-retry" onClick={retry}>{t('superStage.member.retry')}</button>
          </div>
        ) : !detail.data ? (
          <div className="mcb-ins-skeleton" aria-hidden="true" data-testid="member-instructions-pending"><span /><span /><span /></div>
        ) : (
          <>
            {lede && <p className="mcb-ins-lede" data-testid="member-instructions-lede">{lede}</p>}
            {rest && <div className="mcb-ins-md" data-testid="member-job"><MarkdownPreview content={rest} /></div>}
            {!job && <p className="mcb-muted">{t('superStage.member.cards.jobEmpty')}</p>}
            {soul && (
              <section className="mcb-ins-soul" data-testid="member-soul">
                <h4 className="mcb-h">{t('superStage.member.cards.soul')}</h4>
                <div className="mcb-ins-md"><MarkdownPreview content={soul} /></div>
              </section>
            )}
          </>
        )}
      </div>
      {editing && (
        <WindowLayer>
          <AgentIdentityDialog slug={p.slug} onClose={() => setEditing(false)}
            onSaved={(_slug, message) => { setEditing(false); p.onToast(message); }} />
        </WindowLayer>
      )}
    </div>
  );
}

function SettingsCard(p: CardProps) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const agents = useAgents();
  const agent = findAgent(agents.data, p.slug);
  const [on, setOn] = useState(p.enabled);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOn(p.enabled); }, [p.enabled]);
  const mac = !p.phone;
  const readOnly = !!agent?.readOnly;
  const flip = () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    void setMemberEnabled(api, p.slug, next).then(
      () => { setBusy(false); void qc.invalidateQueries({ queryKey: ['agents'] }); },
      (err: unknown) => { setBusy(false); setOn(!next); p.onToast((err as Error).message); },
    );
  };
  const del = async () => {
    setBusy(true);
    let plan: DeletePlan;
    try {
      plan = (await api.post<{ plan: DeletePlan }>(`/agents/${encodeURIComponent(p.slug)}/delete`, { withRoutines: true, dryRun: true })).plan;
    } catch (err) { setBusy(false); p.onToast((err as Error).message); return; }
    if (plan.blockers.length) { setBusy(false); p.onToast(t(plan.blockers.includes('read_only') ? 'superStage.member.cards.deleteReadOnly' : 'superStage.member.cards.deleteWorking')); return; }
    const yes = await confirmAction(deleteDialog(plan, t));
    if (!yes) { setBusy(false); return; }
    try {
      await api.post(`/agents/${encodeURIComponent(p.slug)}/delete`, { withRoutines: true });
    } catch (err) { setBusy(false); p.onToast((err as Error).message); return; }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ['agents'] });
    void qc.invalidateQueries({ queryKey: ['automations'] });
    p.onToast(t('superStage.member.cards.deleted').replace('{name}', plan.title));
    p.onDeleted();
  };
  const switchEl = (
    <button type="button" role="switch" aria-checked={on} disabled={busy || !mac || readOnly}
      aria-label={t('superStage.member.cards.toggle')} data-testid="member-card-switch"
      className={`agent-switch${on ? ' agent-switch--on' : ''}`} onClick={flip}>
      <span className="agent-switch-knob" aria-hidden="true" />
    </button>
  );
  if (p.variant === 'tile') {
    return (
      <div className="mcb-tile mcb-settings-tile" data-testid="member-card-tile" data-ref="settings">
        <span className="mcb-row"><span>{on ? t('superStage.member.cards.on') : t('superStage.member.cards.off')}</span>{switchEl}</span>
      </div>
    );
  }
  return (
    <div className="mcb-body" data-testid="member-card-settings">
      <div className="mcb-row">
        <span className="mcb-strong">{on ? t('superStage.member.cards.on') : t('superStage.member.cards.off')}</span>
        {switchEl}
      </div>
      <p className="mcb-muted">{t('superStage.member.cards.offMeans')}</p>
      {!mac && <p className="mcb-muted">{t('superStage.member.cards.macOnly')}</p>}
      {mac && !readOnly && (
        <button type="button" className="mcb-danger" data-testid="member-delete" disabled={busy || p.working}
          title={p.working ? t('superStage.member.cards.deleteWorking') : undefined} onClick={() => void del()}>
          {t('superStage.member.cards.delete')}
        </button>
      )}
      {mac && p.working && <p className="mcb-muted" data-testid="member-delete-working">{t('superStage.member.cards.deleteWorking')}</p>}
    </div>
  );
}

/** The in-app dialog's words, from the server's plan (plan r4 R4, F4, F5): what goes, by project
 *  for a global member, what stays, no undo, a trash copy. */
export function deleteDialog(plan: DeletePlan, t: (k: string) => string): { title: string; body: string; confirmLabel: string; cancelLabel: string; destructive: true } {
  const lines = [t('superStage.member.cards.deleteGoes'), `• ${t('superStage.member.cards.deleteSelf')}`];
  if (plan.routines.length) {
    const names = plan.global
      ? plan.routines.map((r) => `${r.title} (${r.project})`).join(', ')
      : plan.routines.map((r) => r.title).join(', ');
    lines.push(`• ${t('superStage.member.cards.deleteRoutines').replace('{n}', String(plan.routines.length)).replace('{names}', () => names)}`);
  }
  lines.push(`• ${t('superStage.member.cards.deleteApprovals')}`);
  if (plan.global) lines.push(`• ${t('superStage.member.cards.deleteEveryProject')}`);
  lines.push('', t('superStage.member.cards.deleteStays'));
  return {
    title: t('superStage.member.cards.deleteTitle').replace('{name}', plan.title),
    body: lines.join('\n'),
    confirmLabel: plan.routines.length
      ? t('superStage.member.cards.deleteConfirmRoutines').replace('{n}', String(plan.routines.length))
      : t('superStage.member.cards.deleteConfirm'),
    cancelLabel: t('superStage.member.cards.cancel'),
    destructive: true,
  };
}
