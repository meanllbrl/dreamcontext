import type { AutomationSummary, RunStatus } from '../../hooks/useAutomations';
import { useSetAutomationEnabled } from '../../hooks/useAutomations';
import { summarize } from '../../lib/markdownToText';
import { AgentAvatar } from './AgentAvatar';
import { useI18n } from '../../context/I18nContext';
import './AgentMemberCard.css';

/** The word for a run's outcome. K26/K40: a status is a WORD, not a coloured
 *  badge — it reads at a glance and survives being read aloud. */
function statusWord(status: RunStatus | null): string {
  if (!status) return 'has not run yet';
  switch (status) {
    case 'ok': return 'ok';
    case 'failed': return 'failed';
    case 'timeout': return 'timed out';
    case 'blocked': return 'blocked';
    case 'deferred': return 'deferred';
    case 'orphaned': return 'orphaned';
    case 'awaiting-review': return 'waiting on you';
    case 'awaiting-approval': return 'needs approval';
    default: return status;
  }
}

/** Which of four tones the footer takes. Only `bad` and `attention` are
 *  coloured at all — a healthy agent's footer is plain text, because a status
 *  that is the same on every card is texture, not information (K26). */
function statusTone(summary: AutomationSummary): 'idle' | 'ok' | 'bad' | 'attention' {
  if (summary.pendingQuestion) return 'attention';
  if (!summary.approved && summary.approvalReason === 'never-approved') return 'attention';
  const s = summary.cache?.status;
  if (s === 'failed' || s === 'timeout' || s === 'orphaned') return 'bad';
  if (s === 'ok') return 'ok';
  return 'idle';
}

/** "2 hours ago" / "Sep 19, 09:15" — relative while it is recent enough for
 *  relative to mean something, absolute once it isn't. A card's question is
 *  "is this thing alive", and "3 days ago" answers it faster than a date. */
function fmtWhen(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 6) return `${days}d ago`;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * One agent, as a member of the list.
 *
 * THE HIERARCHY IS THE POINT, and it is what the first version got wrong: name,
 * cadence, description, last run and the buttons all sat at the same weight on
 * one flat surface, so the card read as grey soup and the one string that
 * identifies it — the name — was clipped to a single line. Now:
 *
 *   1. NAME, largest and strongest, up to two lines, never truncated to one.
 *   2. cadence · model, one muted meta line under it.
 *   3. what it does, as PROSE (`summarize`) — the prompt is markdown, and a
 *      card showing `> **BOLD**` is the defect the owner reported. The real
 *      markdown is rendered in the profile popover, which has room to be a
 *      document.
 *   4. a hairline, then the footer ON THE CARD'S OWN SURFACE, carrying the
 *      status word and the actions. It used to be a recessed grey slab, which
 *      made "has not run yet" the loudest thing on a card that had done nothing.
 *
 * WHAT IS DELIBERATELY NOT HERE: the open question. An "Approval needed" /
 * "Waiting for your verdict" block used to sit between the description and the
 * footer, with Approve/Reject in it. The owner's model is that an unanswered
 * question is a MESSAGE — it belongs in the channel as an unread, not stapled
 * to an identity card (2026-09-20). A card says who an agent is; the footer's
 * status word still says it is waiting on you, and the question itself now
 * lives on the details screen until the channel that owns it ships in step 2.
 */
export function AgentMemberCard({
  summary,
  onOpenProfile,
  onEdit,
  onOpenDetail,
  onToast,
}: {
  summary: AutomationSummary;
  /** Opens the profile popover, anchored on whatever was clicked (the photo or
   *  the name). */
  onOpenProfile: (slug: string, anchor: DOMRect) => void;
  onEdit: (slug: string) => void;
  /** Run history, the approval review and Open chat still live in the existing
   *  detail panel — this card is the member list, not a replacement for it. */
  onOpenDetail: (slug: string) => void;
  onToast: (msg: string) => void;
}) {
  const { t } = useI18n();
  const setEnabled = useSetAutomationEnabled();
  const scheduled = summary.mode === 'sched';
  const lastWhen = fmtWhen(summary.cache?.lastFireAt ?? summary.cache?.lastRunAt ?? null);
  const tone = statusTone(summary);
  const description = summarize(summary.description, 150);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !summary.enabled;
    setEnabled.mutate({ slug: summary.slug, enabled: next }, {
      onSuccess: () => onToast(`${summary.title}: ${next ? 'resumed' : 'paused'}.`),
      onError: (err) => onToast(
        t(next ? 'agents.card.resumeFailed' : 'agents.card.pauseFailed')
          .replace('{name}', summary.title)
          .replace('{reason}', (err as Error).message),
      ),
    });
  };

  const openProfile = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenProfile(summary.slug, (e.currentTarget as HTMLElement).getBoundingClientRect());
  };

  return (
    <article className="agent-card" data-tone={tone}>
      <header className="agent-card-head">
        <button type="button" className="agent-card-face" onClick={openProfile} aria-label={`${summary.title} profile`}>
          <AgentAvatar
            slug={summary.slug}
            title={summary.title}
            hasPhoto={summary.hasPhoto}
            size={44}
            /* The last run time, not `Date.now()`: a per-render buster would
               re-download every photo on every poll. */
            version={summary.cache?.lastRunAt ?? undefined}
          />
        </button>
        <div className="agent-card-id">
          {/* Two lines, and the full name in the tooltip — this is the one
              string that says which agent you are looking at. */}
          <button type="button" className="agent-card-name" onClick={openProfile} title={summary.title}>
            {summary.title}
          </button>
          <p className="agent-card-meta">
            <span className={scheduled ? '' : 'agent-card-oncall'}>{summary.cadenceLabel}</span>
            {summary.model && <> · {summary.model}</>}
          </p>
        </div>
        {scheduled && (
          /* One of the three places the accent is allowed (K8): an ON switch. */
          <button
            type="button"
            className={`agent-switch${summary.enabled ? ' agent-switch--on' : ''}`}
            role="switch"
            aria-checked={summary.enabled}
            aria-label={t('agents.card.scheduledAria').replace('{name}', summary.title)}
            onClick={toggle}
            disabled={setEnabled.isPending}
            title={t(summary.enabled ? 'agents.card.pause' : 'agents.card.resume')}
          >
            <span className="agent-switch-knob" aria-hidden="true" />
          </button>
        )}
      </header>

      <p className="agent-card-desc" title={description}>
        {description || 'No description yet.'}
      </p>

      <footer className="agent-card-foot">
        <p className="agent-card-status">
          {/* "has not run yet" is a fact, not news: regular weight, secondary ink. */}
          <span className={`agent-card-status-word${summary.cache?.status ? '' : ' agent-card-status-word--none'}`}>
            {statusWord(summary.cache?.status ?? null)}
          </span>
          {lastWhen && <span className="agent-card-status-when">{lastWhen}</span>}
          {!summary.approved && summary.approvalReason === 'never-approved' && (
            <span className="agent-card-status-note">needs approval</span>
          )}
        </p>
        <div className="agent-card-actions">
          <button type="button" className="agent-card-btn" onClick={() => onEdit(summary.slug)}>Edit</button>
          <button type="button" className="agent-card-btn" onClick={() => onOpenDetail(summary.slug)}>Runs</button>
        </div>
      </footer>
    </article>
  );
}
