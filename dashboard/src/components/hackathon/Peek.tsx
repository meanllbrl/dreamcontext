import { useI18n } from '../../context/I18nContext';
import { badge, clock, fill, type RoundRecord, type RunTeam, pct } from './data';

/**
 * The peek screen (approved mockup `hackathon-goz-atma.png`): after a round, every team's thesis
 * card, whose cards it saw, the questions that crossed and the similarity gate. Teams saw the cards
 * without names; the owner sees everything.
 */
export function Peek({ rec, teams, controlTeam, onBack }: {
  rec: RoundRecord;
  teams: RunTeam[];
  controlTeam: string | null;
  onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const name = (id: string) => teams.find((x) => x.id === id)?.name ?? id;
  const opened = Object.keys(rec.seen).length > 0;
  return (
    <div className="hk-peek">
      <header className="hk-head">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.room.back')}</button>
        <h2 className="hk-head__title">{fill(t('hk.peek.title'), { n: rec.round })}</h2>
        <span className="hk-chip">{fill(t('hk.peek.at'), { n: rec.round, at: clock(rec.at) })}</span>
        <span className="hk-muted hk-head__sub">{opened ? t('hk.peek.rule') : t('hk.peek.closed')}</span>
      </header>

      <div className="hk-peek__cards">
        {teams.map((tm) => {
          const c = rec.cards[tm.id];
          const saw = rec.seen[tm.id] ?? [];
          return (
            <article key={tm.id} className="hk-panel hk-thesis">
              <header className="hk-table__head">
                <span className="hk-badge" data-tool={tm.tool}>{badge(tm.name)}</span>
                <span className="hk-table__name">{tm.name}</span>
                {tm.id === controlTeam && <span className="hk-chip">{t('hk.control')}</span>}
              </header>
              {c ? (
                <>
                  <span className="hk-eyebrow">{t('hk.peek.thesis')}</span>
                  <h3 className="hk-thesis__title">{c.thesis}</h3>
                  <ol className="hk-thesis__claims">{c.claims.map((x, i) => <li key={i}>{x}</li>)}</ol>
                  <dl className="hk-thesis__facts">
                    <dt>{t('hk.peek.status')}</dt><dd>{c.status}</dd>
                    {c.stuck && (<><dt>{t('hk.peek.stuck')}</dt><dd>{c.stuck}</dd></>)}
                  </dl>
                </>
              ) : <p className="hk-muted">{t('hk.peek.noCard')}</p>}
              <p className="hk-muted hk-thesis__saw">
                {tm.id === controlTeam ? t('hk.peek.sawNone') : saw.length ? fill(t('hk.peek.saw'), { teams: saw.map(name).join(', ') }) : t('hk.peek.sawClosed')}
              </p>
            </article>
          );
        })}
      </div>

      <div className="hk-peek__below">
        <section className="hk-panel">
          <h3 className="hk-section">{t('hk.peek.questions')}</h3>
          {rec.questions.length ? (
            <ul className="hk-qa">
              {rec.questions.map((q, i) => (
                <li key={i} className="hk-balloon" data-kind="objection">
                  <span className="hk-balloon__who">{name(q.from)} → {name(q.to)}</span>
                  <span>{q.text}</span>
                </li>
              ))}
            </ul>
          ) : <p className="hk-muted">{t('hk.peek.noQuestions')}</p>}
        </section>
        <section className="hk-panel">
          <h3 className="hk-section">{t('hk.peek.gate')}</h3>
          {rec.pairs.length ? (
            <ul className="hk-bars">
              {rec.pairs.map((p) => (
                <li key={`${p.a}-${p.b}`} className="hk-bar" data-over={p.score > rec.gate ? 'true' : undefined}>
                  <span>{name(p.a)} · {name(p.b)}</span>
                  <span className="hk-bar__track"><span className="hk-bar__fill" style={{ width: `${Math.round(p.score * 100)}%` }} /></span>
                  <span className="hk-bar__num">{pct(p.score, locale)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="hk-muted">{t('hk.peek.noPairs')}</p>}
          <p className="hk-muted">{fill(t('hk.peek.gateRule'), { gate: Math.round(rec.gate * 100) })}</p>
        </section>
      </div>
    </div>
  );
}
