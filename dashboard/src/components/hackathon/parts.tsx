import { Fragment, type ReactNode } from 'react';
import { useI18n } from '../../context/I18nContext';
import { badge, num, teamHue, type CriteriaScores, type RunTeam } from './data';

/**
 * Design B's shared pieces (approved 19 Kas, "Karar masası"): a team's colour + letter, the score
 * on its scale, the four criteria bars and a browser frame for the screen a team made.
 */

/** A team's letter on its own colour. `teams` fixes the colour by design order. */
export function TeamMark({ teams, team, size }: { teams: readonly { id: string }[]; team: RunTeam | { id: string; name: string }; size?: 'sm' | 'lg' }) {
  return (
    <span className={`hk-av${size ? ` hk-av--${size}` : ''}`} data-hue={teamHue(teams, team.id)} aria-hidden="true">
      {badge(team.name)}
    </span>
  );
}

/** "6,8 / 10". */
export function Score({ value, big }: { value: number; big?: boolean }) {
  const { locale } = useI18n();
  return (
    <span className={`hk-score${big ? ' hk-score--big' : ''}`}>
      {num(value, locale)}<small>/ 10</small>
    </span>
  );
}

const CRITS: (keyof CriteriaScores)[] = ['solves', 'evidence', 'feasible', 'original'];

/** The four criteria, each a bar in the team's colour. `grid` lays them two by two. */
export function Criteria({ scores, hue, grid }: { scores: CriteriaScores; hue: number; grid?: boolean }) {
  const { t, locale } = useI18n();
  return (
    <div className={`hk-crits${grid ? ' hk-crits--grid' : ''}`} data-hue={hue}>
      {CRITS.map((k) => (
        <div key={k} className="hk-crit">
          <span className="hk-crit__name">{t(`hk.crit.${k}`)}</span>
          <span className="hk-crit__track" aria-hidden="true"><span className="hk-crit__fill" style={{ width: `${Math.round(Math.min(10, Math.max(0, scores[k])) * 10)}%` }} /></span>
          <span className="hk-crit__v">{num(scores[k], locale)}</span>
        </div>
      ))}
    </div>
  );
}

/** A browser frame around what a team made: three dots and a caption, then the body. */
export function Browser({ caption, children, className }: { caption: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`hk-browser${className ? ` ${className}` : ''}`}>
      <div className="hk-browser__bar"><i /><i /><i /><span>{caption}</span></div>
      <div className="hk-browser__body">{children}</div>
    </div>
  );
}

/** `{name}` placeholders filled with nodes (a bold team name inside a sentence). */
export function fillNodes(line: string, vars: Record<string, ReactNode>): ReactNode {
  const parts = line.split(/(\{\w+\})/g);
  return parts.map((p, i) => {
    const m = /^\{(\w+)\}$/.exec(p);
    return <Fragment key={i}>{m && m[1]! in vars ? vars[m[1]!] : p}</Fragment>;
  });
}

/** "tek kişi" / "3 kişi: Kaptan, Yapıcı, Eleştirmen". */
export function people(t: (k: string) => string, inner: 'trio' | 'solo', long = false): string {
  if (inner === 'solo') return t('hk.people.solo');
  return long ? t('hk.people.trioLong') : t('hk.people.trio');
}
