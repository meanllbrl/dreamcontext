import { useEffect, useRef, useState } from 'react';
import { RequestError } from '../../api/client';
import { emitInstance, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import {
  approvalState,
  findAgent,
  useAgent,
  useAgents,
  useApproveAgent,
  useDeleteAgentIdentity,
  type AgentPattern,
  type AgentSummary,
  type AgentUsageAutomation,
} from '../../hooks/useAgents';
import { openAgentSurface } from '../../lib/agentSettings';
import { DELETE_ARM_MS, deleteAction } from '../../lib/agentDraft';
import { requestTalkToAgent } from '../../lib/talkToAgent';
import { AgentAvatar } from './AgentAvatar';
import { APPROVAL_STATE_KEY, approvalChips, stateHasDot, tx } from './AgentRosterCard';
import './AgentProfilePanel.css';
import { fill } from '../../lib/fill';

/**
 * The review text (`AgentDetail.review`, the same `field: value` lines the CLI prints) as a map.
 * A multi-line value is written as `field:` followed by lines indented two spaces.
 */
export function parseReviewFields(review: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of review.split('\n')) {
    if (current !== null && line.startsWith('  ')) {
      const prev = out.get(current) ?? '';
      out.set(current, prev ? `${prev}\n${line.slice(2)}` : line.slice(2));
      continue;
    }
    const m = /^([A-Za-z]+):(?: (.*))?$/.exec(line);
    if (!m) { current = null; continue; }
    current = m[1];
    out.set(current, m[2] ?? '');
  }
  return out;
}

/** One read-only call setting, as the profile shows it. `value` null ⇒ not set. */
export interface CallSettingRow {
  key: 'timeout' | 'outputDir' | 'review' | 'flow';
  value: string | null;
}

/** The call settings the review carries, in the profile's order. Read-only: nothing here edits them. */
export function callSettingRows(review: string): CallSettingRow[] {
  const fields = parseReviewFields(review);
  const read = (name: string): string | null => {
    const v = fields.get(name);
    return v === undefined || v === '' || v === '(none)' ? null : v;
  };
  return [
    { key: 'timeout', value: read('timeoutMinutes') },
    { key: 'outputDir', value: read('outputDir') },
    { key: 'review', value: read('review') },
    { key: 'flow', value: read('flow') },
  ];
}

/**
 * What a refused delete names. The 409 `agent_in_use` says which automations still run as the
 * agent; the profile already holds their titles, so it names them in words, falling back to the
 * slugs for any it does not know.
 */
export function inUseNames(agent: Pick<AgentSummary, 'usedBy'>, slugs?: readonly string[]): string[] {
  const titles = new Map(agent.usedBy.automations.map((a) => [a.slug, a.title]));
  const list = slugs && slugs.length > 0 ? slugs : agent.usedBy.automations.map((a) => a.slug);
  return list.map((s) => titles.get(s) ?? s);
}

/** Is this delete failure the in-use refusal? */
export function isAgentInUse(err: unknown): boolean {
  return err instanceof RequestError && err.status === 409 && err.code === 'agent_in_use';
}

/** The i18n key for why the agent may not run, or the plain "not approved" line. */
export function approvalReasonKey(reason: string | null): string {
  return reason ? `agents.approval.reason.${reason}` : 'agents.approval.runNo';
}

/** One block of a soul or playbook as the profile draws it: a paragraph, or a bulleted list. */
export type TextBlock = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

/**
 * Split free text into paragraphs and bulleted lists, by line, with no markdown library: a run
 * of lines that start with `- ` (or `* `, `• `) is one list; every other non-empty line is its
 * own paragraph; blank lines only separate.
 */
export function textBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const last = out[out.length - 1];
      if (last && last.kind === 'ul') last.items.push(bullet[1]);
      else out.push({ kind: 'ul', items: [bullet[1]] });
    } else {
      out.push({ kind: 'p', text: line });
    }
  }
  return out;
}

/** How many lessons show before "Show all". */
export const LESSONS_SHOWN = 5;

/** The lessons the profile shows: the first `n` (newest first, as the server sends them), or all. */
export function visibleLessons<T>(lessons: readonly T[], expanded: boolean, n = LESSONS_SHOWN): T[] {
  return expanded ? [...lessons] : lessons.slice(0, n);
}

/** Which of the pattern's states the profile shows (D7). Off with notes kept is its own state:
 *  the notes are shown, with a line saying they are not used. */
export function patternView(learning: boolean, pattern: AgentPattern | undefined): 'off' | 'off-stale' | 'empty' | 'present' {
  const has = !!pattern && (pattern.playbook.trim() !== '' || pattern.lessons.length > 0);
  if (!learning) return has ? 'off-stale' : 'off';
  return has ? 'present' : 'empty';
}

/** One automation's state line: paused, next run, or "when you call it". */
function automationWhen(a: AgentUsageAutomation, t: (k: string) => string, locale: string): string {
  if (!a.enabled) return t('agents.profile.usage.paused');
  if (!a.nextFireAt) return t('agents.profile.usage.onCall');
  const when = new Date(a.nextFireAt).toLocaleString(locale, {
    weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
  });
  return fill(t('agents.profile.usage.next'), { time: when });
}

/**
 * One agent's profile, in the order a teammate is read: who it is and its state, then its soul
 * (how it works), its job (the prompt), its pattern (what it learned, read-only), where it works,
 * and approval for chat and approval to run, shown SEPARATELY. Approve
 * happens here, in place: the review (every field an approval grants) opens inside the panel,
 * and only the owner's click on Approve grants it. No browser dialog anywhere (they are silent
 * no-ops in the desktop app). No Run now and no Telegram on this page.
 */
export function AgentProfilePanel({
  slug, onClose, onEdit, onDeleted, onToast,
}: {
  slug: string;
  onClose: () => void;
  onEdit: (slug: string) => void;
  onDeleted: (slug: string) => void;
  onToast: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const { bus } = useVault();
  const roster = useAgents();
  const detail = useAgent(slug);
  const approve = useApproveAgent();
  const remove = useDeleteAgentIdentity();
  const agent = findAgent(roster.data, slug) ?? detail.data?.agent ?? null;

  const [reviewing, setReviewing] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [talkError, setTalkError] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const approvalRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // A different agent opens on a clean panel: no half-finished review or armed delete carries over.
  useEffect(() => {
    setReviewing(false);
    setApproveError(null);
    setArmed(false);
    setDeleteError(null);
    setTalkError(null);
    setLessonsOpen(false);
    // A different agent is read from the top, not from where the last one was scrolled to.
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [slug]);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  if (!agent) {
    const missing = !roster.isLoading && !detail.isLoading;
    return (
      <aside className="agp-panel" aria-label={t('agents.page.title')}>
        <div className="agp-panel-top">
          <span className="agp-muted">
            {missing ? tx(t, 'agents.profile.missing', 'This agent no longer exists.') : t('agents.page.loading')}
          </span>
          <button type="button" className="agp-btn" onClick={onClose}>{t('agents.profile.close')}</button>
        </div>
      </aside>
    );
  }

  const name = agent.title;
  const fullyApproved = agent.approvedForChat && agent.approvedToRun;

  const openReview = () => {
    setApproveError(null);
    setReviewing(true);
    // The review must be what Approve grants NOW, not a copy from when the panel opened.
    void detail.refetch();
  };

  const doApprove = () => {
    if (approve.isPending || detail.isFetching) return;
    approve.mutate(slug, {
      onSuccess: (fresh) => {
        setReviewing(false);
        onToast(fill(t('agents.approval.approved'), { name: fresh.title }));
      },
      onError: (err) => setApproveError(fill(t('agents.approval.failed'), { name, reason: (err as Error).message })),
    });
  };

  const talk = () => {
    if (talking) return;
    setTalkError(null);
    setTalking(true);
    void requestTalkToAgent(slug).then((accepted) => {
      setTalking(false);
      if (accepted) openAgentSurface(bus);
      else setTalkError(t('agents.profile.talkFailed'));
    });
  };

  const doDelete = () => {
    if (remove.isPending) return;
    if (deleteAction(armed) === 'arm') { setDeleteError(null); setArmed(true); return; }
    remove.mutate(slug, {
      onSuccess: () => {
        onToast(fill(t('agents.profile.deleted'), { name }));
        onDeleted(slug);
      },
      onError: (err) => {
        setArmed(false);
        if (isAgentInUse(err)) {
          setDeleteError(fill(t('agents.profile.deleteInUse'), { name, list: inUseNames(agent).join(', ') }));
        } else {
          setDeleteError(fill(t('agents.profile.deleteFailed'), { name, reason: (err as Error).message }));
        }
      },
    });
  };

  const usage = agent.usedBy;
  const nothingUses = usage.automations.length + usage.boards.length + usage.tasks.length === 0;
  const state = approvalState(agent);
  const data = detail.data;
  const soul = data?.soul ?? '';
  const view = data ? patternView(data.learning, data.pattern) : null;
  const lessons = data?.pattern.lessons ?? [];
  const shownLessons = visibleLessons(lessons, lessonsOpen);

  const reviewFromHeader = () => {
    openReview();
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    approvalRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <aside ref={panelRef} className="agp-panel" aria-label={fill(t('agents.profile.aria'), { name })} data-agent-profile={slug}>
      <div className="agp-panel-top">
        <AgentAvatar of="agent" slug={agent.slug} title={name} hasPhoto={agent.hasPhoto} size={72} version={agent.hasPhoto ? detail.dataUpdatedAt : undefined} />
        <div className="agp-ident">
          <h2 className="agp-name">{name}</h2>
          {agent.roleLine && <span className="agp-role">{agent.roleLine}</span>}
          <span className="agp-meta">
            {agent.model ?? t('agents.profile.modelDefault')}
            {' · '}
            {agent.effort ?? t('agents.profile.effortDefault')}
          </span>
        </div>
        <button type="button" className="agp-btn agp-btn--ghost" onClick={onClose}>{t('agents.profile.close')}</button>
      </div>

      <div className="agp-stateline">
        <span
          className={`agp-state agp-state--${state}`}
          data-approval-state={state}
          title={state === 'cant-run' ? tx(t, approvalReasonKey(agent.approvalReason), t('agents.approval.runNo')) : undefined}
        >
          {stateHasDot(state) && <span className="agp-dot" aria-hidden="true" />}
          {t(APPROVAL_STATE_KEY[state])}
        </span>
        {state !== 'ready' && (
          <button type="button" className="agp-textbtn" onClick={reviewFromHeader} data-review-approval>
            {t('agents.profile.reviewApproval')}
          </button>
        )}
        {agent.shared && <span className="agr-tag" title={t('agents.roster.sharedHint')}>{t('agents.roster.shared')}</span>}
        {agent.implicit && <span className="agr-tag" title={t('agents.roster.implicitHint')}>{t('agents.roster.implicit')}</span>}
      </div>

      <div className="agp-actions">
        <button
          type="button"
          className="agp-btn agp-btn--primary"
          onClick={talk}
          disabled={!agent.approvedForChat || talking}
          title={agent.approvedForChat ? fill(t('agents.profile.talkHint'), { name }) : t('agents.approval.chatNo')}
        >
          {t('agents.profile.talk')}
        </button>
        <button type="button" className="agp-btn" onClick={() => onEdit(slug)}>{t('agents.profile.edit')}</button>
      </div>
      {talkError && <p className="agp-error" role="alert">{talkError}</p>}

      <section className="agp-section" aria-label={t('agents.profile.soul')} data-section="soul">
        <div className="agp-head">
          <h3 className="agp-h">{t('agents.profile.soul')}</h3>
          <p className="agp-hint">{t('agents.profile.soulHint')}</p>
        </div>
        {!data
          ? <p className="agp-muted">{t('agents.page.loading')}</p>
          : soul
            ? <div className="agp-soul"><TextBlocks text={soul} /></div>
            : <p className="agp-empty">{t('agents.profile.soulEmpty')}</p>}
      </section>

      <section className="agp-section" aria-label={t('agents.profile.job')} data-section="job">
        <h3 className="agp-h">{t('agents.profile.job')}</h3>
        <p className="agp-prompt">{data?.prompt ?? agent.description}</p>
        <dl className="agp-facts">
          <dt>{t('agents.profile.model')}</dt>
          <dd>{agent.model ?? t('agents.profile.modelDefault')}</dd>
          <dt>{t('agents.profile.effort')}</dt>
          <dd>{agent.effort ?? t('agents.profile.effortDefault')}</dd>
          <dt>{t('agents.profile.board')}</dt>
          <dd>{agent.whiteboard ?? t('agents.profile.noBoard')}</dd>
        </dl>
        {data && (
          <p className="agp-muted">
            {data.learning ? t('agents.profile.learning') : t('agents.profile.learningOff')}
          </p>
        )}
        {agent.shared && <p className="agp-muted">{t('agents.roster.sharedHint')}</p>}
        {agent.implicit && <p className="agp-muted">{t('agents.roster.implicitHint')}</p>}
      </section>

      {/* Read-only: what it learned from its own runs. Notes, never instructions. */}
      <section className="agp-section" aria-label={t('agents.profile.pattern')} data-section="pattern" data-pattern-state={view ?? undefined}>
        <div className="agp-head">
          <h3 className="agp-h">{t('agents.profile.pattern')}</h3>
          <p className="agp-hint">{t('agents.profile.patternHint')}</p>
        </div>
        {!data && <p className="agp-muted">{t('agents.page.loading')}</p>}
        {view === 'off' && <p className="agp-empty">{t('agents.profile.patternOff')}</p>}
        {view === 'empty' && <p className="agp-empty">{t('agents.profile.patternEmpty')}</p>}
        {view === 'off-stale' && <p className="agp-empty">{t('agents.profile.patternOffStale')}</p>}
        {data && (view === 'present' || view === 'off-stale') && (
          <>
            {data.pattern.playbook.trim() && (
              <div className="agp-usage">
                <h4 className="agp-h4">{t('agents.profile.playbook')}</h4>
                <div className="agp-playbook"><TextBlocks text={data.pattern.playbook} /></div>
              </div>
            )}
            {lessons.length > 0 && (
              <div className="agp-usage">
                <h4 className="agp-h4">{t('agents.profile.lessons')}</h4>
                <ol className="agp-lessons">
                  {shownLessons.map((l, i) => (
                    <li key={`${l.date}-${i}`} className="agp-lesson" data-lesson>
                      <span className="agp-lesson-date">{l.date}</span>
                      <span className="agp-lesson-text">{l.text}</span>
                    </li>
                  ))}
                </ol>
                {lessons.length > LESSONS_SHOWN && !lessonsOpen && (
                  <button type="button" className="agp-textbtn" onClick={() => setLessonsOpen(true)}>
                    {fill(t('agents.profile.lessonsMore'), { n: String(lessons.length) })}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="agp-section" aria-label={t('agents.profile.usage')} data-usage data-section="usage">
        <h3 className="agp-h">{t('agents.profile.usage')}</h3>
        {nothingUses && <p className="agp-muted">{t('agents.profile.usage.none')}</p>}
        {usage.automations.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.automations')}</h4>
            <ul className="agp-list">
              {usage.automations.map((a) => (
                <li key={a.slug} className="agp-list-row">
                  <span className="agp-list-name">{a.title}</span>
                  <span className="agp-muted">{automationWhen(a, t, locale)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {usage.boards.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.boards')}</h4>
            <ul className="agp-list">
              {usage.boards.map((b) => (
                <li key={b} className="agp-list-row">
                  <button
                    type="button"
                    className="agp-link"
                    onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'whiteboards', id: b })}
                  >
                    {b}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {usage.tasks.length > 0 && (
          <div className="agp-usage">
            <h4 className="agp-h4">{t('agents.profile.usage.tasks')}</h4>
            <ul className="agp-list">
              {usage.tasks.map((task) => (
                <li key={task.slug} className="agp-list-row">
                  <button
                    type="button"
                    className="agp-link"
                    onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'tasks', id: task.slug })}
                  >
                    {task.name}
                  </button>
                  <span className="agp-muted">{task.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Approval: two verdicts, two rows, never one. */}
      <section
        ref={approvalRef}
        className="agp-section"
        aria-label={t('agents.approval.title')}
        data-approval-section
        data-section="approval"
      >
        <h3 className="agp-h">{t('agents.approval.title')}</h3>
        {approvalChips(agent).map((chip) => (
          <div key={chip.kind} className="agp-approval-row" data-approval={chip.kind} data-approved={chip.ok}>
            <span className={`agr-chip agr-chip--${chip.ok ? 'ok' : 'no'}`}>
              <span className="agr-chip-mark" aria-hidden="true">{chip.ok ? '✓' : '!'}</span>
              {t(chip.labelKey)}
            </span>
            <span className="agp-muted">
              {chip.kind === 'chat'
                ? t('agents.approval.chatHint')
                : chip.ok ? t('agents.approval.runHint') : tx(t, approvalReasonKey(agent.approvalReason), t('agents.approval.runNo'))}
            </span>
          </div>
        ))}

        {!fullyApproved && !reviewing && (
          <button type="button" className="agp-btn" onClick={openReview}>{t('agents.approval.review')}</button>
        )}

        {reviewing && (
          <div className="agp-review" data-approval-review>
            <p className="agp-muted">{t('agents.approval.reviewLead')}</p>
            <pre className="agp-review-text">{detail.isFetching && !detail.data ? t('agents.page.loading') : detail.data?.review ?? ''}</pre>
            {approveError && <p className="agp-error" role="alert">{approveError}</p>}
            <div className="agp-review-foot">
              <button type="button" className="agp-btn" onClick={() => setReviewing(false)} disabled={approve.isPending}>
                {t('agents.approval.cancel')}
              </button>
              <button
                type="button"
                className="agp-btn agp-btn--primary"
                onClick={doApprove}
                disabled={approve.isPending || detail.isFetching || !detail.data}
              >
                {approve.isPending ? t('agents.approval.approving') : t('agents.approval.approve')}
              </button>
            </div>
          </div>
        )}
      </section>

      {agent.hasCallSettings && (
        <section className="agp-section" aria-label={t('agents.profile.callSettings')} data-call-settings>
          <h3 className="agp-h">{t('agents.profile.callSettings')}</h3>
          <p className="agp-muted">{t('agents.profile.callSettingsHint')}</p>
          {detail.data && (
            <dl className="agp-facts">
              {callSettingRows(detail.data.review).map((row) => (
                <CallSettingFact key={row.key} row={row} t={t} />
              ))}
            </dl>
          )}
        </section>
      )}

      <section className="agp-section agp-section--danger">
        <button
          type="button"
          className={`agp-btn agp-btn--danger${armed ? ' agp-btn--armed' : ''}`}
          onClick={doDelete}
          disabled={remove.isPending}
          data-delete-armed={armed}
        >
          {armed ? fill(t('agents.profile.deleteConfirm'), { name }) : t('agents.profile.delete')}
        </button>
        {deleteError && <p className="agp-error" role="alert">{deleteError}</p>}
      </section>
    </aside>
  );
}

/** Free text as paragraphs and bulleted lists (`textBlocks`). */
function TextBlocks({ text }: { text: string }) {
  return (
    <>
      {textBlocks(text).map((b, i) => (b.kind === 'ul'
        ? <ul key={i} className="agp-bullets">{b.items.map((item, j) => <li key={j}>{item}</li>)}</ul>
        : <p key={i} className="agp-para">{b.text}</p>))}
    </>
  );
}

/** One call setting as a definition pair. A flow is named as set or not, never dumped as data. */
function CallSettingFact({ row, t }: { row: CallSettingRow; t: (k: string) => string }) {
  const none = tx(t, 'agents.profile.callSettingNone', 'None');
  let label: string;
  let value: string;
  switch (row.key) {
    case 'timeout':
      label = t('agents.profile.timeout');
      value = row.value ? fill(t('agents.profile.timeoutValue'), { n: row.value }) : none;
      break;
    case 'outputDir':
      label = t('agents.profile.outputDir');
      value = row.value ?? none;
      break;
    case 'review':
      label = t('agents.profile.review');
      value = row.value ?? none;
      break;
    default:
      label = t('agents.profile.flow');
      value = row.value ? tx(t, 'agents.profile.flowSet', 'Set') : none;
  }
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
