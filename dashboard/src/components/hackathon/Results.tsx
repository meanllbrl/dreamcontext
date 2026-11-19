import { useI18n } from '../../context/I18nContext';
import { useVaultId } from '../../context/VaultContext';
import {
  accusative, countOf, criteria, fill, mediaUrl, modelLabel, teamHue, usePresentation, wins,
  type JuryView, type ResultView, type RunTeam,
} from './data';
import { Browser, Criteria, Score, TeamMark, fillNodes, people } from './parts';


/**
 * The result screen (design B, "Karar masası", `sonuc-b-1440` and `secildi-1440`): the jury's
 * recommendation in one sentence with its caution, then one column per team in the jury's order,
 * side by side: rank, colour and letter, score on its scale, the screen it made at a readable
 * size, all four criteria, and its buttons. The only filled button is the jury's pick ("seç");
 * after the pick it is "PR olarak uygula" on the picked column, which gets a dark frame.
 */
export function Results({ run, teams, controlTeam, data, canPick, picking, onOpen, onPick, onApply }: {
  run: string;
  teams: RunTeam[];
  controlTeam: string | null;
  data: ResultView | undefined;
  canPick: boolean;
  picking: string | null;
  onOpen: (team: string) => void;
  onPick: (team: string) => void;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const jury = data?.jury ?? null;
  const pick = data?.result?.pick ?? null;
  const ranked = !!jury?.ranking.length;
  const order = ranked ? [...jury!.ranking, ...teams.map((x) => x.id).filter((id) => !jury!.ranking.includes(id))] : teams.map((x) => x.id);
  const first = ranked ? teams.find((x) => x.id === jury!.ranking[0]) : undefined;
  const picked = pick ? teams.find((x) => x.id === pick) : undefined;

  return (
    <div className="hk-results">
      <Verdict jury={jury} first={first} picked={picked} judging={!jury && data?.state === 'judging'} stopped={data?.result?.stoppedReason ?? null} />
      <div className="hk-cols" data-n={order.length}>
        {order.map((id, i) => {
          const tm = teams.find((x) => x.id === id);
          if (!tm) return null;
          return (
            <TeamResult
              key={id} run={run} teams={teams} team={tm} place={ranked ? i + 1 : null} jury={jury}
              recommended={first?.id === id} control={id === controlTeam} picked={pick === id} anyPicked={!!pick}
              canPick={canPick} picking={picking === id} anyPicking={!!picking}
              onOpen={() => onOpen(id)} onPick={() => onPick(id)} onApply={onApply}
            />
          );
        })}
      </div>
      {!order.length && <p className="hk-quiet">{t('hk.result.noTeams')}</p>}
    </div>
  );
}

function Verdict({ jury, first, picked, judging, stopped }: { jury: JuryView | null; first: RunTeam | undefined; picked: RunTeam | undefined; judging: boolean; stopped: string | null }) {
  const { t } = useI18n();
  const judge = jury?.judges?.[0] ? modelLabel(jury.judges[0].tool, '') : 'Claude';
  const caution = jury?.sameVendor ? <small>{fill(t('hk.result.caution'), { judge })}</small> : null;
  if (picked) {
    const agree = !first || first.id === picked.id;
    return (
      <p className="hk-verdict">
        {fillNodes(t(agree ? (first ? 'hk.result.pickedAgree' : 'hk.result.pickedNoJury') : 'hk.result.pickedDiffer'), {
          teamAcc: accusative(picked.name), team: picked.name, juryAcc: first ? accusative(first.name) : '', jury: first?.name ?? '',
        })}
      </p>
    );
  }
  if (stopped) return <p className="hk-verdict">{fill(t('hk.result.stopped'), { reason: stopped })}</p>;
  if (judging) return <p className="hk-verdict">{t('hk.result.judging')}</p>;
  if (!jury) return null;
  if (!first) return <p className="hk-verdict">{t('hk.result.juryNone')}{caution}</p>;
  const w = wins(jury, first.id);
  return (
    <p className="hk-verdict">
      {fillNodes(t(w.of ? 'hk.result.jury' : 'hk.result.juryShort'), {
        teamAcc: <b>{accusative(first.name)}</b>, team: <b>{first.name}</b>, won: countOf(w.won), wonN: w.won, of: w.of,
      })}
      {caution}
    </p>
  );
}

function TeamResult({ run, teams, team, place, jury, recommended, control, picked, anyPicked, canPick, picking, anyPicking, onOpen, onPick, onApply }: {
  run: string; teams: RunTeam[]; team: RunTeam; place: number | null; jury: JuryView | null;
  recommended: boolean; control: boolean; picked: boolean; anyPicked: boolean;
  canPick: boolean; picking: boolean; anyPicking: boolean; onOpen: () => void; onPick: () => void; onApply: () => void;
}) {
  const { t } = useI18n();
  const { vault } = useVaultId();
  const { data: p } = usePresentation(run, team.id);
  const shot = p?.screens.find((s) => s.width === 1440) ?? p?.screens[0];
  const score = place != null ? jury?.scores[team.id] ?? null : null;
  const crit = place != null ? criteria(jury, team.id) : null;
  const hue = teamHue(teams, team.id);
  return (
    <article className="hk-col" data-hue={hue} data-picked={picked ? 'true' : undefined}>
      <header className="hk-col__head">
        {place != null && <span className="hk-col__rank">{place}</span>}
        <TeamMark teams={teams} team={team} />
        <span className="hk-col__who">
          <span className="hk-col__name">{team.name}</span>
          {picked ? <span className="hk-chip">{t('hk.result.yourPick')}</span> : recommended && !anyPicked ? <span className="hk-chip">{t('hk.result.recommended')}</span> : null}
        </span>
        {score != null && <Score value={score} big />}
      </header>
      <p className="hk-col__persona">{[team.persona, people(t, team.inner)].filter(Boolean).join(' · ')}</p>
      <Browser className="hk-col__screen" caption={shot ? t('hk.result.made') : t('hk.result.idea')}>
        {shot ? <img alt={fill(t('hk.result.shotAlt'), { team: team.name })} src={mediaUrl(vault, run, team.id, shot.media)} />
          : p?.thesis ? <p className="hk-col__thesis">{p.thesis.thesis}</p>
          : <p className="hk-quiet hk-col__thesis">{t('hk.result.noThumb')}</p>}
      </Browser>
      {crit && <Criteria scores={crit} hue={hue} />}
      {control && <p className="hk-small">{t('hk.result.control')}</p>}
      {p?.borrowed.map((b, i) => <p key={i} className="hk-small">{fill(t('hk.result.borrowed'), { idea: b.idea })}</p>)}
      {p?.flags.map((f, i) => <p key={i} className="hk-small hk-warn">{f}</p>)}
      <footer className="hk-col__foot">
        {canPick && !anyPicked && (
          <button type="button" className={`hk-btn hk-btn--lg${recommended ? ' hk-btn--primary' : ''}`} disabled={anyPicking} onClick={onPick}>
            {picking ? t('hk.result.picking') : fill(t('hk.result.pickTeam'), { teamAcc: accusative(team.name), team: team.name })}
          </button>
        )}
        {picked && <button type="button" className="hk-btn hk-btn--lg hk-btn--primary" onClick={onApply}>{t('hk.result.apply')}</button>}
        <button type="button" className="hk-btn hk-btn--lg" onClick={onOpen}>{t('hk.result.open')}</button>
      </footer>
    </article>
  );
}
