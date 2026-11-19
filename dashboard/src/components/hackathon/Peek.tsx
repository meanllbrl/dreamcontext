import { useI18n } from '../../context/I18nContext';
import { clock, fill, pct, type RoundRecord, type RunTeam } from './data';
import { TeamMark } from './parts';

const STATUS = new Set(['on-track', 'pivot', 'stuck', 'done']);

/**
 * The peek after a round (design B rules on the approved `hackathon-goz-atma` layout): every
 * team's main idea and claims, whose cards it saw, the questions that crossed and how similar
 * the teams are, said as a sentence. Teams saw the cards without names; the owner sees everything.
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
      <header className="hk-top hk-top--room">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.room.back')}</button>
        <h2 className="hk-title">{fill(t('hk.peek.title'), { n: rec.round })}</h2>
        <span className="hk-quiet hk-top__end">{fill(t('hk.peek.at'), { n: rec.round, at: clock(rec.at) })}</span>
      </header>
      <p className="hk-lede">{opened ? t('hk.peek.rule') : t('hk.peek.closed')}</p>

      <div className="hk-peek__cards">
        {teams.map((tm) => {
          const c = rec.cards[tm.id];
          const saw = rec.seen[tm.id] ?? [];
          return (
            <article key={tm.id} className="hk-box hk-peekcard">
              <header className="hk-tc__head">
                <TeamMark teams={teams} team={tm} />
                <b>{tm.name}</b>
                {tm.id === controlTeam && <span className="hk-chip">{t('hk.control')}</span>}
                {c && STATUS.has(c.status) && <span className="hk-quiet hk-top__end">{t(`hk.status.${c.status}`)}</span>}
              </header>
              {c ? (
                <>
                  <h3 className="hk-label">{t('hk.present.idea')}</h3>
                  <p className="hk-thesis">{c.thesis}</p>
                  <ul className="hk-claims">
                    {c.claims.map((x, i) => <li key={i}>{x}</li>)}
                    {c.stuck && <li className="hk-claims__risk"><span><b>{t('hk.present.open')}</b> {c.stuck}</span></li>}
                  </ul>
                </>
              ) : <p className="hk-quiet">{t('hk.peek.noCard')}</p>}
              <p className="hk-small">
                {tm.id === controlTeam ? t('hk.peek.sawNone') : saw.length ? fill(t('hk.peek.saw'), { teams: saw.map(name).join(', ') }) : t('hk.peek.sawClosed')}
              </p>
            </article>
          );
        })}
      </div>

      <div className="hk-peek__below">
        <section className="hk-box">
          <h3 className="hk-label">{t('hk.peek.questions')}</h3>
          {rec.questions.length ? (
            <ul className="hk-tl">
              {rec.questions.map((q, i) => (
                <li key={i} data-role="kaptan"><span><b>{fill(t('hk.peek.asked'), { from: name(q.from), to: name(q.to) })}</b> {q.text}</span></li>
              ))}
            </ul>
          ) : <p className="hk-quiet">{t('hk.peek.noQuestions')}</p>}
        </section>
        <section className="hk-box">
          <h3 className="hk-label">{t('hk.distance')}</h3>
          {rec.pairs.length ? (
            <ul className="hk-sims">
              {[...rec.pairs].sort((a, b) => b.score - a.score).map((p) => {
                const over = p.score > rec.gate;
                return (
                  <li key={`${p.a}-${p.b}`} className="hk-sim" data-over={over ? 'true' : undefined}>
                    <span className="hk-quiet">{fill(t('hk.distance.pair'), { a: name(p.a), b: name(p.b) })}</span>
                    <strong>{fill(t(over ? 'hk.distance.close' : 'hk.distance.apart'), { pct: pct(p.score, locale) })}</strong>
                  </li>
                );
              })}
            </ul>
          ) : <p className="hk-quiet">{t('hk.peek.noPairs')}</p>}
          <p className="hk-small">{fill(t('hk.distance.rule'), { gate: pct(rec.gate, locale) })}</p>
        </section>
      </div>
    </div>
  );
}
