import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import { badge, fill, mediaUrl, usePresentation, type PresentationCard, type RunTeam } from './data';
import { WindowFrame } from './WindowFrame';

/**
 * A team's presentation (approved mockup `hackathon-sunum.png`): its stage cards as numbered tabs,
 * the open card large in a window frame, the rest summarised beside it, the jury's score and, while
 * the owner is choosing, "Bu ekibi seç". Media is drawn only as images and video from the media
 * route (bytes checked by magic, no-script CSP); team markup is never rendered.
 */
export function Presentation({ run, team, place, score, nextTeam, canPick, picking, onPick, onNext, onBack, error }: {
  run: string;
  /** The last owner action's failure (a refused pick): shown where he pressed it. */
  error?: string | null;
  team: RunTeam;
  place: number | null;
  score: number | null;
  nextTeam: RunTeam | null;
  canPick: boolean;
  picking: boolean;
  onPick: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { data: p, isLoading, isError } = usePresentation(run, team.id);
  const [open, setOpen] = useState(0);
  const cards = p?.cards ?? [];
  const card = cards[Math.min(open, Math.max(0, cards.length - 1))];

  return (
    <div className="hk-present">
      <header className="hk-head hk-head--wrap">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.present.back')}</button>
        <span className="hk-badge" data-tool={team.tool}>{badge(team.name)}</span>
        <h2 className="hk-head__title">{fill(t('hk.present.title'), { team: team.name })}</h2>
        <span className="hk-present__tabs" role="tablist">
          {cards.map((c, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === open} className="hk-tab" onClick={() => setOpen(i)}>
              <span className="hk-tab__n">{i + 1}</span>{c.title}
            </button>
          ))}
        </span>
        {nextTeam && <button type="button" className="hk-btn" onClick={onNext}>{fill(t('hk.present.next'), { team: nextTeam.name })} ›</button>}
      </header>

      {error && <p className="hk-error" role="alert">{error}</p>}
      {isLoading && <p className="hk-muted">{t('common.loading')}</p>}
      {isError && <p className="hk-error">{t('hk.present.failed')}</p>}
      {p && !cards.length && <p className="hk-muted">{p.reason ? fill(t('hk.present.none'), { reason: p.reason }) : t('hk.present.empty')}</p>}

      {card && (
        <div className="hk-present__grid">
          <WindowFrame className="hk-win--stage" title={<span className="hk-mono">{card.title}</span>}>
            <Stage run={run} team={team.id} card={card} />
          </WindowFrame>
          <aside className="hk-present__side">
            {cards.map((c, i) => i !== open && (
              <button key={i} type="button" className="hk-panel hk-mini" onClick={() => setOpen(i)}>
                <span className="hk-eyebrow">{t(`hk.card.${c.kind}`)}</span>
                <strong>{c.title}</strong>
                {c.kind === 'thesis' && c.thesis && <span className="hk-muted">{c.thesis.thesis}</span>}
                {c.reason && <span className="hk-muted">{c.reason}</span>}
              </button>
            ))}
            {!!p?.borrowed.length && (
              <div className="hk-panel hk-mini">
                <span className="hk-eyebrow">{t('hk.present.borrowed')}</span>
                {p.borrowed.map((b, i) => <span key={i}>{fill(t('hk.present.borrowLine'), { side: t(`hk.side.${b.from}`), round: b.round, idea: b.idea })}</span>)}
              </div>
            )}
            {!!p?.flags.length && (
              <div className="hk-panel hk-mini">
                {p.flags.map((f, i) => <span key={i} className="hk-warn-ink">{f}</span>)}
              </div>
            )}
            <div className="hk-panel hk-present__score">
              {score != null ? (
                <span><strong className="hk-score">{score.toFixed(1)}</strong> <span className="hk-muted">{place != null ? fill(t('hk.present.jury'), { n: place }) : ''}</span></span>
              ) : <span className="hk-muted">{t('hk.present.noScore')}</span>}
              {canPick && <button type="button" className="hk-btn hk-btn--primary" disabled={picking} onClick={onPick}>{picking ? t('hk.result.picking') : t('hk.present.pick')}</button>}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Stage({ run, team, card }: { run: string; team: string; card: PresentationCard }) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  if (card.kind === 'thesis' && card.thesis) {
    return (
      <div className="hk-stage hk-stage--text">
        <span className="hk-eyebrow">{t('hk.card.thesis')}</span>
        <h3 className="hk-thesis__title">{card.thesis.thesis}</h3>
        <ol className="hk-thesis__claims">{card.thesis.claims.map((c, i) => <li key={i}>{c}</li>)}</ol>
        <p className="hk-muted">{t('hk.peek.status')}: {card.thesis.status}</p>
      </div>
    );
  }
  if (!card.media) return <p className="hk-stage hk-muted">{card.reason ?? t('hk.present.noMedia')}</p>;
  const src = mediaUrl(vault, run, team, card.media);
  if (card.kind === 'video') return <video className="hk-stage__media" src={src} controls preload="metadata" />;
  return <img className="hk-stage__media" alt={card.title} src={src} />;
}
