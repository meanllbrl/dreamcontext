import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import {
  accusative, countOf, criteria, fill, juryWhy, mediaUrl, modelLabel, teamHue, useFiles, usePresentation, wins,
  type JuryView, type PresentationCard, type RunTeam,
} from './data';
import { Browser, Criteria, Score, TeamMark, fillNodes, people } from './parts';
import { roleLabel } from './WindowFrame';

/**
 * A team's presentation (design B, `sunum-b-1440`): one screen, no slides. The team switcher on
 * top and the only filled button ("seç"); the team's identity; on the left the screen it made at
 * desktop or phone width and what it changed; on the right its main idea with its claims and open
 * point, the jury's card (score, rank, the four criteria, the reason in one sentence, who judged)
 * and how the team decided. Media is drawn only as images and video from the media route (bytes
 * checked by magic, no-script CSP); team markup is never rendered.
 */
export function Presentation({ run, teams, order, team, jury, pick, canPick, picking, onPick, onApply, onTeam, onBack, error }: {
  run: string;
  teams: RunTeam[];
  /** The switcher's order: the jury's ranking, else the design's. */
  order: string[];
  team: RunTeam;
  jury: JuryView | null;
  pick: string | null;
  canPick: boolean;
  picking: boolean;
  onPick: () => void;
  onApply: () => void;
  onTeam: (team: string) => void;
  onBack: () => void;
  /** The last owner action's failure (a refused pick): shown where he pressed it. */
  error?: string | null;
}) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  const { data: p, isLoading, isError } = usePresentation(run, team.id);
  const { data: files } = useFiles(run, team.id, null);
  const [width, setWidth] = useState<number | null>(null);
  const [card, setCard] = useState<number | null>(null);
  const [allDecisions, setAllDecisions] = useState(false);
  const hue = teamHue(teams, team.id);
  const ranked = !!jury?.ranking.length;
  const place = ranked ? jury!.ranking.indexOf(team.id) + 1 : 0;
  const score = ranked ? jury!.scores[team.id] ?? null : null;
  const crit = ranked ? criteria(jury, team.id) : null;
  const w = ranked ? wins(jury!, team.id) : null;
  const why = juryWhy(jury, team.id);
  const thesis = p?.thesis ?? null;
  const screens = [...(p?.screens ?? [])].sort((a, b) => b.width - a.width);
  const shown = screens.find((s) => s.width === width) ?? screens[0];
  const media = (p?.cards ?? []).filter((c) => c.kind !== 'thesis' && c.kind !== 'screen');
  const open = card != null ? media[card] : undefined;
  const decisions = (files?.decisions ?? []).slice().reverse();
  const isPicked = pick === team.id;

  const primary = canPick && !pick
    ? <button type="button" className="hk-btn hk-btn--primary hk-btn--lg" disabled={picking} onClick={onPick}>{picking ? t('hk.result.picking') : fill(t('hk.result.pickTeam'), { teamAcc: accusative(team.name), team: team.name })}</button>
    : isPicked ? <button type="button" className="hk-btn hk-btn--primary hk-btn--lg" onClick={onApply}>{t('hk.result.apply')}</button>
    : null;

  return (
    <div className="hk-present" data-hue={hue}>
      <div className="hk-present__top">
        <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.present.back')}</button>
        {order.length > 1 && (
          <span className="hk-seg" role="tablist" aria-label={t('hk.present.teams')}>
            {order.map((id) => {
              const tm = teams.find((x) => x.id === id);
              if (!tm) return null;
              return (
                <button key={id} type="button" role="tab" aria-selected={id === team.id} className="hk-seg__btn" onClick={() => id !== team.id && onTeam(id)}>
                  <TeamMark teams={teams} team={tm} size="sm" />{tm.name}
                </button>
              );
            })}
          </span>
        )}
        <span className="hk-grow" />
        {primary && <span className="hk-present__cta">{primary}</span>}
      </div>

      <div className="hk-ident">
        <TeamMark teams={teams} team={team} size="lg" />
        <div>
          <h2 className="hk-ident__name">{team.name}</h2>
          <p>{[team.persona, people(t, team.inner, true), modelLabel(team.tool, team.model)].filter(Boolean).join(' · ')}</p>
        </div>
      </div>

      {error && <p className="hk-error" role="alert">{error}</p>}
      {isLoading && <p className="hk-quiet">{t('common.loading')}</p>}
      {isError && <p className="hk-error">{t('hk.present.failed')}</p>}

      {p && (
        <div className="hk-present__body">
          <div className="hk-present__left">
            <div className="hk-present__lhead">
              <span className="hk-label">{open ? open.title : shown ? t('hk.result.made') : t('hk.present.noScreen')}</span>
              {!open && screens.length > 1 && (
                <span className="hk-miniseg" role="group" aria-label={t('hk.result.made')}>
                  {screens.map((s) => (
                    <button key={s.width} type="button" aria-pressed={s === shown} onClick={() => setWidth(s.width)}>
                      {s.width >= 768 ? t('hk.present.desk') : t('hk.present.phone')}
                    </button>
                  ))}
                </span>
              )}
            </div>
            {open ? (
              <Browser caption={open.title}><Stage run={run} team={team.id} card={open} /></Browser>
            ) : shown ? (
              <Browser className="hk-present__screen" caption={t('hk.result.made')}>
                <img alt={fill(t('hk.result.shotAlt'), { team: team.name })} src={mediaUrl(vault, run, team.id, shown.media)} />
              </Browser>
            ) : (
              <p className="hk-quiet">{p.reason ? fill(t('hk.present.none'), { reason: p.reason }) : t('hk.present.empty')}</p>
            )}
            {!!files?.edited.length && (
              <p className="hk-note-line"><b>{t('hk.present.changed')}</b> {files.edited.map((x) => x.split('/').pop()).filter((x, i, a) => a.indexOf(x) === i).join(', ')}</p>
            )}
            {!!media.length && (
              <div className="hk-present__media">
                <span className="hk-label">{t('hk.present.attachments')}</span>
                {open && <button type="button" className="hk-link" onClick={() => setCard(null)}>{t('hk.result.made')}</button>}
                {media.map((c, i) => (
                  <button key={i} type="button" className="hk-link" aria-pressed={card === i} onClick={() => setCard(i)}>{c.title}</button>
                ))}
              </div>
            )}
          </div>

          <aside className="hk-present__side">
            {thesis && (
              <section>
                <h3 className="hk-label">{t('hk.present.idea')}</h3>
                <p className="hk-thesis">{thesis.thesis}</p>
                <ul className="hk-claims">
                  {thesis.claims.map((c, i) => <li key={i}>{c}</li>)}
                  {thesis.stuck && <li className="hk-claims__risk"><span><b>{t('hk.present.open')}</b> {thesis.stuck}</span></li>}
                </ul>
              </section>
            )}

            <section className="hk-jurycard">
              <h3 className="hk-label">{t('hk.step.jury')}</h3>
              {score != null ? (
                <>
                  <div className="hk-jurycard__row">
                    <Score value={score} big />
                    <span className="hk-jurycard__rank">
                      <b>{fill(t('hk.present.place'), { n: place })}</b>
                      {w?.of ? <> · {fill(t('hk.present.wins'), { of: w.of, won: countOf(w.won), wonN: w.won })}</> : null}
                    </span>
                  </div>
                  {crit && <Criteria scores={crit} hue={hue} grid />}
                  {why && (
                    <p className="hk-why">
                      "{why.why}"
                      <small>{fillNodes(t(jury?.sameVendor ? 'hk.present.judgeSame' : 'hk.present.judge'), { judge: why.judge ? modelLabel(why.judge.tool, why.judge.model) : 'Claude' })}</small>
                    </p>
                  )}
                </>
              ) : <p className="hk-quiet">{jury && !ranked ? t('hk.present.juryNone') : t('hk.present.noScore')}</p>}
            </section>

            {!!p.borrowed.length && (
              <section>
                <h3 className="hk-label">{t('hk.present.borrowed')}</h3>
                {p.borrowed.map((b, i) => <p key={i} className="hk-small">{fill(t('hk.present.borrowLine'), { side: t(`hk.side.${b.from}`), round: b.round, idea: b.idea })}</p>)}
              </section>
            )}
            {!!p.flags.length && (
              <section>{p.flags.map((f, i) => <p key={i} className="hk-small hk-warn">{f}</p>)}</section>
            )}

            {!!decisions.length && (
              <section>
                <h3 className="hk-label">{t('hk.present.how')}</h3>
                <ul className="hk-tl">
                  {(allDecisions ? decisions : decisions.slice(0, 2)).map((d, i) => (
                    <li key={`${d.at}-${i}`} data-role={d.role}>
                      <span><b>{fill(t(`hk.present.did.${d.kind}`), { role: roleLabel(t, d.role) })}</b> {d.text}</span>
                    </li>
                  ))}
                </ul>
                {decisions.length > 2 && (
                  <button type="button" className="hk-link" onClick={() => setAllDecisions((x) => !x)}>
                    {allDecisions ? t('hk.present.fewer') : fill(t('hk.present.all'), { n: decisions.length })}
                  </button>
                )}
              </section>
            )}
          </aside>
        </div>
      )}
      {primary && <div className="hk-pickbar">{primary}</div>}
    </div>
  );
}

function Stage({ run, team, card }: { run: string; team: string; card: PresentationCard }) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  if (!card.media) return <p className="hk-quiet hk-stage">{card.reason ?? t('hk.present.noMedia')}</p>;
  const src = mediaUrl(vault, run, team, card.media);
  if (card.kind === 'video') return <video className="hk-stage__media" src={src} controls preload="metadata" />;
  return <img className="hk-stage__media" alt={card.title} src={src} />;
}
