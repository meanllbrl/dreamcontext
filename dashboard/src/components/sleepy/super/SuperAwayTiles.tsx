import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { useVaultId } from '../../../context/VaultContext';
import type { ChatSession } from '../chatSession';
import { readVaultSuperRecords, subscribeSuperRecords } from './superRecordStore';
import { elapsedLabel, needsOwner } from './superHandover';
import { openJobRow } from './superJobsStore';
import { revealQuestion } from './superQuestions';
import { awayHasAny, awaySummary, finishedOthersText, rememberAwaySpan } from './awaySummary';
import { JobsView } from '../chat/JobsView';
import { BrandMark } from '../../brand/BrandMark';
import './SuperAwayTiles.css';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * The empty Super screen when there is work to tell him about (plan super-v3 D10, frame E):
 * "While you were away", the span and how many things he answered from Telegram, three tiles
 * (finished / wait for you / running) and three chips that each do what they say. Drawn from the
 * live record (`awaySummary`); with no job, `fallback` (the ordinary empty state).
 */
export function SuperAwayTiles({ session, fallback = null }: { session: ChatSession; fallback?: ReactNode }) {
  const { t } = useI18n();
  const vault = useVaultId().vault ?? null;
  const superSession = session.claudeId || null;
  const records = useSyncExternalStore(subscribeSuperRecords, () => readVaultSuperRecords(vault), () => readVaultSuperRecords(vault));
  const record = useMemo(() => records.find((r) => superSession && r.record.session === superSession)?.record ?? null, [records, superSession]);
  const span = superSession && record ? rememberAwaySpan(superSession, record.away) : null;
  const sum = useMemo(() => (record ? awaySummary(record, needsOwner as (q: unknown) => boolean, span) : null), [record, span]);
  const [showDone, setShowDone] = useState(false);
  if (!sum || !awayHasAny(sum)) return <>{fallback}</>;

  const sub = sum.span
    ? [
      t('super.away.span').replace('{from}', clock(sum.span.since)).replace('{to}', clock(sum.span.until)),
      ...(sum.span.viaTelegram > 0 ? [t(sum.span.viaTelegram === 1 ? 'super.away.telegramOne' : 'super.away.telegram').replace('{n}', String(sum.span.viaTelegram))] : []),
    ].join(' · ')
    : '';
  const waitingSub = sum.waiting.commands > 0
    ? t(sum.waiting.commands === 1 ? 'super.away.commandOne' : 'super.away.commands').replace('{n}', String(sum.waiting.commands))
      + (sum.waiting.more > 0 ? ` ${t('super.away.more').replace('{n}', String(sum.waiting.more))}` : '')
    : sum.waiting.more > 0 ? t('super.away.andMore').replace('{n}', String(sum.waiting.more)) : '';
  const answer = () => {
    if (sum.waiting.itemId) revealQuestion(sum.waiting.itemId);
    if (sum.waiting.firstJob) openJobRow(`c:${sum.waiting.firstJob}`);
  };

  return (
    <section className="super-away" data-testid="super-away" aria-label={t(sum.span ? 'super.away.title' : 'super.away.titleNow')}>
      {/* Frame E: the Super's gem with its glow, never the terminal glyph. */}
      <BrandMark size={48} glow className="super-away-gem" />
      <h3 className="super-away-title">{t(sum.span ? 'super.away.title' : 'super.away.titleNow')}</h3>
      {sub && <p className="super-away-sub" data-testid="super-away-span">{sub}</p>}
      <div className="super-away-tiles">
        {sum.finished.n > 0 && (
          <div className="super-away-tile" data-state="done" data-testid="super-away-finished">
            <span className="super-away-head"><span className="super-away-dot" aria-hidden />{t('super.away.finished').replace('{n}', String(sum.finished.n))}</span>
            <span className="super-away-lead">{sum.finished.lead}</span>
            <span className="super-away-line">{finishedOthersText(sum.finished.others, { too: t('super.away.too'), more: t('super.away.andMore') })}</span>
          </div>
        )}
        {sum.waiting.n > 0 && (
          <div className="super-away-tile" data-state="waiting" data-testid="super-away-waiting">
            <span className="super-away-head"><span className="super-away-dot" aria-hidden />{t('super.away.waiting').replace('{n}', String(sum.waiting.n))}</span>
            <span className="super-away-lead">{sum.waiting.lead}</span>
            <span className="super-away-line">{waitingSub}</span>
          </div>
        )}
        {sum.running.n > 0 && (
          <div className="super-away-tile" data-state="running" data-testid="super-away-running">
            <span className="super-away-head"><span className="super-away-dot" aria-hidden />{t('super.away.running').replace('{n}', String(sum.running.n))}</span>
            <span className="super-away-lead">{sum.running.lead}</span>
            <span className="super-away-line">{t('super.away.lastStep').replace('{when}', elapsedLabel(Date.now() - sum.running.at))}</span>
          </div>
        )}
      </div>
      <div className="super-away-chips">
        {sum.waiting.n > 0 && <button type="button" className="super-away-chip" data-testid="super-away-answer" onClick={answer}>{t('super.away.answer').replace('{n}', String(sum.waiting.n))}</button>}
        {sum.finished.n > 0 && (
          <button type="button" className="super-away-chip" data-testid="super-away-show-done" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            {t('super.away.showDone')}
          </button>
        )}
        <button type="button" className="super-away-chip" data-testid="super-away-stage" onClick={() => openJobRow('stage')}>{t('super.away.stage')}</button>
      </div>
      {showDone && <div className="super-away-done"><JobsView spec={{ type: 'jobs', ids: sum.finishedIds }} session={session} /></div>}
    </section>
  );
}
