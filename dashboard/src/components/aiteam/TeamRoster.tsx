import { useState } from 'react';
import { AgentAvatar } from '../agents/AgentAvatar';
import { AutomationsDispatcherBar } from '../automations/AutomationsDispatcherBar';
import { runDuration, useNow } from '../agents/agentRunState';
import { useI18n } from '../../context/I18nContext';
import { filterRoster, rosterTime, type TeamRow } from './teamModel';
import { TeamIcon } from './TeamIcons';

/**
 * THE LIST ON THE LEFT: every teammate, one row each, "Needs you" first.
 *
 * A row is a conversation, like a messenger's: face (with a status dot), name, the last thing
 * said, when, how many unread, and one tag for the state that stops it (a question, a paused
 * routine, an approval). A draft row stands at the top while a new teammate is being written.
 */
export function TeamRoster({
  rows,
  selected,
  draft,
  onSelect,
  onNew,
  onToast,
  nextRun,
}: {
  rows: TeamRow[];
  selected: string | null;
  /** The new teammate being written, or null. */
  draft: { title: string } | null;
  onSelect: (slug: string) => void;
  onNew: () => void;
  onToast: (msg: string) => void;
  /** The scheduler's next fire, said under the list. */
  nextRun: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const shown = filterRoster(rows, query);
  const needs = shown.filter((r) => r.section === 'needs');
  const team = shown.filter((r) => r.section === 'team');
  const empty = rows.length === 0 && !draft;
  const now = new Date(useNow(rows.some((r) => r.status === 'working')));

  return (
    <aside className="aiteam-roster" aria-label={t('aiteam.title')}>
      <div className="aiteam-roster-head">
        <h1 className="aiteam-roster-title">{t('aiteam.title')}</h1>
        {!empty && (
          <span className="aiteam-roster-count">
            {(rows.length === 1 ? t('aiteam.count.one') : t('aiteam.count.many')).replace('{n}', String(rows.length))}
          </span>
        )}
        <span className="aiteam-spacer" />
        <button type="button" className="aiteam-newbtn" onClick={onNew}>
          <TeamIcon name="plus" size={12} /> {t('aiteam.new')}
        </button>
      </div>
      {!empty && (
        <label className="aiteam-search">
          <TeamIcon name="search" size={14} />
          <input
            className="aiteam-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('aiteam.search')}
            aria-label={t('aiteam.search')}
          />
        </label>
      )}
      <div className="aiteam-list">
        {empty && <p className="aiteam-roster-empty">{t('aiteam.roster.empty')}</p>}
        {draft && (
          <button type="button" className="aiteam-row aiteam-row--on aiteam-row--draft" aria-current="true">
            <span className="aiteam-face"><span className="aiteam-draft-av" aria-hidden="true">+</span></span>
            <span className="aiteam-row-main">
              <span className="aiteam-row-top"><span className="aiteam-row-name">{t('aiteam.newTeammate')}</span></span>
              <span className="aiteam-row-preview">
                {draft.title.trim()
                  ? t('aiteam.draft.named').replace('{name}', draft.title.trim())
                  : t('aiteam.draft.blank')}
              </span>
            </span>
            <span className="aiteam-row-end" />
          </button>
        )}
        {needs.length > 0 && <div className="aiteam-section">{t('aiteam.section.needs')}</div>}
        {needs.map((r) => (
          <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} now={now} />
        ))}
        {team.length > 0 && <div className="aiteam-section">{t('aiteam.section.team')}</div>}
        {team.map((r) => (
          <Row key={r.slug} row={r} on={!draft && selected === r.slug} onSelect={onSelect} now={now} />
        ))}
        {!empty && shown.length === 0 && <p className="aiteam-roster-empty">{t('aiteam.search.none')}</p>}
      </div>
      <div className="aiteam-roster-foot">
        <AutomationsDispatcherBar variant="inline" onToast={onToast} />
        <span className="aiteam-roster-next">{nextRun}</span>
      </div>
    </aside>
  );
}

function Row({ row, on, onSelect, now }: { row: TeamRow; on: boolean; onSelect: (slug: string) => void; now: Date }) {
  const { t } = useI18n();
  const working = row.status === 'working';
  const elapsed = working && row.workingSince ? runDuration(now.getTime() - row.workingSince) : null;
  const dot = working ? 'working' : row.status === 'needs' ? 'needs' : row.status === 'idle' && row.lastAt ? 'idle' : null;
  return (
    <button
      type="button"
      className={`aiteam-row${on ? ' aiteam-row--on' : ''}`}
      onClick={() => onSelect(row.slug)}
      aria-current={on ? 'true' : undefined}
      data-team-row={row.slug}
    >
      <span className="aiteam-face">
        <AgentAvatar of="agent" slug={row.slug} title={row.title} hasPhoto={row.hasPhoto} size={40} />
        {dot && <span className={`aiteam-face-dot aiteam-face-dot--${dot}`} aria-hidden="true" />}
      </span>
      <span className="aiteam-row-main">
        <span className="aiteam-row-top">
          <span className="aiteam-row-name">{row.title}</span>
          <span className="aiteam-row-time">{working ? t('aiteam.time.now') : rosterTime(row.lastAt, now, t)}</span>
        </span>
        <span className={`aiteam-row-preview${working ? ' aiteam-row-preview--live' : ''}`}>
          {working
            ? t('aiteam.working').replace('{time}', elapsed ?? '')
            : row.preview ?? t('aiteam.row.noMessages')}
        </span>
        {(row.status === 'needs' || row.status === 'paused' || row.status === 'approval') && (
          <span className="aiteam-row-tags">
            {row.status === 'needs' && <span className="aiteam-tag aiteam-tag--warn">{t('aiteam.tag.needs')}</span>}
            {row.status === 'paused' && (
              <span className="aiteam-tag aiteam-tag--muted"><TeamIcon name="pause" size={10} />{t('aiteam.tag.paused')}</span>
            )}
            {row.status === 'approval' && (
              <span className="aiteam-tag"><TeamIcon name="lock" size={10} />{t('aiteam.tag.approval')}</span>
            )}
          </span>
        )}
      </span>
      <span className="aiteam-row-end">
        {row.unread > 0 && <span className="sidebar-badge">{row.unread}</span>}
      </span>
    </button>
  );
}
