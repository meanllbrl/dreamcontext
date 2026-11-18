import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import { badge, fill, mediaUrl, usePresentation, type JuryView, type ResultView, type RunTeam } from './data';

/**
 * The result screen (approved mockup `hackathon-sonuc.png`): the jury's line on top (its pick, how
 * many pairwise matches it won, and that the owner decides), then one column per team in the
 * jury's order: its screen or thesis, score, originality, what it borrowed, and its buttons.
 */
export function Results({ run, teams, controlTeam, data, canPick, picking, pickError, onOpen, onPick, onApply }: {
  run: string;
  teams: RunTeam[];
  controlTeam: string | null;
  data: ResultView | undefined;
  canPick: boolean;
  picking: string | null;
  pickError: string | null;
  onOpen: (team: string) => void;
  onPick: (team: string) => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const jury = data?.jury ?? null;
  const pick = data?.result?.pick ?? null;
  const order = jury?.ranking.length ? [...jury.ranking, ...teams.map((x) => x.id).filter((id) => !jury.ranking.includes(id))] : teams.map((x) => x.id);
  const first = jury?.ranking[0] ? teams.find((x) => x.id === jury.ranking[0]) : undefined;
  const w = first && jury ? wins(jury, first.id) : null;

  return (
    <div className="hk-results">
      {data?.result?.stoppedReason && !pick && <p className="hk-note">{fill(t('hk.result.stopped'), { reason: data.result.stoppedReason })}</p>}
      {first && w && (
        <p className="hk-jury">
          {fill(t('hk.result.jury'), { team: first.name, won: w.won, of: w.of })}
          {jury?.sameVendor && <span className="hk-chip">{t('hk.result.sameVendor')}</span>}
        </p>
      )}
      {!jury && data?.state === 'judging' && <p className="hk-muted">{t('hk.result.judging')}</p>}
      {pickError && <p className="hk-error" role="alert">{pickError}</p>}

      <div className="hk-results__cols">
        {order.map((id, i) => {
          const tm = teams.find((x) => x.id === id);
          if (!tm) return null;
          return (
            <TeamResult
              key={id} run={run} team={tm} place={jury?.ranking.length ? i + 1 : null}
              score={jury?.scores[id] ?? null} originality={jury?.originality[id] ?? null}
              control={id === controlTeam} picked={pick === id}
              canPick={canPick} picking={picking === id} anyPicking={!!picking}
              onOpen={() => onOpen(id)} onPick={() => onPick(id)} onApply={onApply}
            />
          );
        })}
      </div>
    </div>
  );
}

function TeamResult({ run, team, place, score, originality, control, picked, canPick, picking, anyPicking, onOpen, onPick, onApply }: {
  run: string; team: RunTeam; place: number | null; score: number | null; originality: number | null; control: boolean; picked: boolean;
  canPick: boolean; picking: boolean; anyPicking: boolean; onOpen: () => void; onPick: () => void; onApply: () => void;
}) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  const { data: p } = usePresentation(run, team.id);
  const shot = p?.screens.find((s) => s.width === 1440) ?? p?.screens[0];
  return (
    <article className="hk-panel hk-result" data-picked={picked ? 'true' : undefined}>
      <div className="hk-result__thumb">
        {shot ? <img alt={fill(t('hk.result.shotAlt'), { team: team.name })} src={mediaUrl(vault, run, team.id, shot.media)} />
          : p?.thesis ? <p className="hk-result__thesis">{p.thesis.thesis}</p>
          : <p className="hk-muted">{t('hk.result.noThumb')}</p>}
      </div>
      <header className="hk-result__head">
        {score != null && <strong className="hk-score">{score.toFixed(1)}</strong>}
        <span className="hk-badge hk-badge--sm" data-tool={team.tool}>{badge(team.name)}</span>
        <span className="hk-table__name">{team.name}</span>
        <span className="hk-muted">{team.tool === 'codex' ? 'Codex' : 'Claude'}</span>
        {place != null && <span className="hk-place" data-first={place === 1 ? 'true' : undefined}>{place}.</span>}
      </header>
      {originality != null && (
        <div className="hk-bar">
          <span>{t('hk.result.originality')}</span>
          <span className="hk-bar__track"><span className="hk-bar__fill" style={{ width: `${Math.round(Math.min(10, originality) * 10)}%` }} /></span>
          <span className="hk-bar__num">{originality.toFixed(1)}</span>
        </div>
      )}
      {control && <p className="hk-muted">{t('hk.result.control')}</p>}
      {p?.borrowed.map((b, i) => <p key={i} className="hk-muted">{fill(t('hk.result.borrowed'), { idea: b.idea })}</p>)}
      {p?.flags.map((f, i) => <p key={i} className="hk-warn-ink">{f}</p>)}
      <footer className="hk-result__foot">
        <button type="button" className={`hk-btn${picked ? ' hk-btn--primary' : ''}`} onClick={onOpen}>{t('hk.result.open')}</button>
        {canPick && <button type="button" className="hk-btn" disabled={anyPicking} onClick={onPick}>{picking ? t('hk.result.picking') : t('hk.result.pick')}</button>}
        {picked && <button type="button" className="hk-btn" onClick={onApply}>{t('hk.result.apply')}</button>}
        {picked && <span className="hk-chip">{t('hk.result.yourPick')}</span>}
      </footer>
    </article>
  );
}

/** Pairwise matches a team won, out of those it played (both orders count). */
export function wins(jury: JuryView, team: string): { won: number; of: number } {
  const mine = jury.verdicts.filter((v) => v.a === team || v.b === team);
  return { won: mine.filter((v) => v.winner === team).length, of: mine.length };
}
