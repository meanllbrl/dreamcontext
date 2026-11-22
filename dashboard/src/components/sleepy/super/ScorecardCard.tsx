import { useMemo, useState, type FormEvent, type SyntheticEvent } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { phoneAllows } from '../../../lib/phoneSurface';
import { useScorecard, useScorecardWrite, type ScorecardWrite } from '../../../hooks/useScorecard';
import {
  barTone, checksMet, formatValue, goalChange, goalMoveForRun, latestRateable, localDay, lowerIsBetter,
  nextVerdict, trendWord, unratedCount, type ScoreGoal, type ScoreLesson, type ScoreRun, type ScorecardData,
} from '../../../lib/scorecardModel';
import './ScorecardCard.css';

/**
 * A member's Scorecard (plan uye-karnesi D1, approved drawings maket-birlesik + bos-jakob):
 * the stage tile (average, ten bars, "N to rate"; empty: the latest run with grey stars to rate in
 * one tap) and the full card (optional goal band, his lines of good work, the lessons his notes
 * became, the rating trend and the recent runs with stars, notes, checks and lessons). A phone
 * gets one column and only the writes the phone may make (rating, lesson Undo).
 *
 * W3 hook point (the rating request after every run, owner 22 Nov, drawings awaiting his yes):
 * `unratedCount` / `latestRateable` in scorecardModel and the `scorecard.request.*` i18n slot.
 */

export interface ScorecardCardProps {
  slug: string;
  variant: 'tile' | 'full';
  phone?: boolean;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** "Today", "Yesterday", else "Nov 15" in the window's language. */
export function runDay(iso: string, locale: string, t: (k: string) => string, now: Date = new Date()): string {
  const day = localDay(iso);
  if (!day) return '';
  if (day === localDay(now.toISOString())) return t('scorecard.today');
  if (day === localDay(new Date(now.getTime() - 86_400_000).toISOString())) return t('scorecard.yesterday');
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

function Stars({ value, big, label, onRate, disabled }: {
  value: number; big?: boolean; label: string; onRate?: (n: number) => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <span className={`sc-stars${big ? ' sc-stars--big' : ''}`} role={onRate ? 'radiogroup' : 'img'} aria-label={label}
      data-testid="sc-stars" data-value={value} onPointerDown={stop} onClick={stop}>
      {[1, 2, 3, 4, 5].map((n) => (onRate ? (
        <button key={n} type="button" className={`sc-star${n <= value ? ' is-on' : ''}`} role="radio" aria-checked={n === value}
          aria-label={t('scorecard.starN').replace('{n}', String(n))} disabled={disabled} data-testid={`sc-star-${n}`}
          onClick={() => onRate(n)}>★</button>
      ) : (
        <span key={n} className={`sc-star${n <= value ? ' is-on' : ''}`} aria-hidden="true">★</span>
      )))}
    </span>
  );
}

export function ScorecardCard({ slug, variant, phone }: ScorecardCardProps) {
  const { t } = useI18n();
  const q = useScorecard(slug);
  const data = q.data;
  if (variant === 'tile') return <ScoreTile slug={slug} data={data} />;
  if (q.isError && !data) {
    return (
      <div className="mcb-body" data-testid="sc-error">
        <p className="mcb-muted">{t('superStage.member.cards.readFailed')}</p>
        <button type="button" className="mcb-link" onClick={() => void q.refetch()}>{t('superStage.member.retry')}</button>
      </div>
    );
  }
  if (!data) return <div className="mcb-body" data-testid="sc-pending"><div className="mcb-ins-skeleton" aria-hidden="true"><span /><span /><span /></div></div>;
  return <ScoreFull slug={slug} data={data} phone={!!phone || data.phone} />;
}

// ─── Tile ────────────────────────────────────────────────────────────────────────

function ScoreTile({ slug, data }: { slug: string; data: ScorecardData | undefined }) {
  const { t, locale } = useI18n();
  const write = useScorecardWrite(slug);
  const avg = data?.trend.average ?? null;
  const toRate = data ? unratedCount(data.runs) : 0;
  if (!data || avg === null) {
    const latest = data ? latestRateable(data.runs) : null;
    return (
      <div className="mcb-tile sc-tile" data-testid="member-card-tile" data-ref="scorecard" data-empty="true">
        <span className="sc-tile-head">{t('scorecard.noRatings')}</span>
        {latest ? (
          <>
            <span className="sc-tile-run" title={latest.title}>
              <span className="sc-strong">{latest.title}</span> · {runDay(latest.lastAt, locale, t)}
            </span>
            <span className="sc-tile-rate">
              <Stars value={0} label={t('scorecard.rateRun')} disabled={write.isPending}
                onRate={(n) => write.mutate({ kind: 'rate', run: latest.key, stars: n })} />
              <span className="sc-accent">{t('scorecard.rateIt')}</span>
            </span>
          </>
        ) : (
          <span className="mcb-sub">{t('scorecard.rateInChat')}</span>
        )}
      </div>
    );
  }
  return (
    <div className="mcb-tile sc-tile" data-testid="member-card-tile" data-ref="scorecard">
      <span className="sc-tile-row">
        <span className="mcb-big" data-testid="sc-tile-avg">{avg.toFixed(1)} ★</span>
        <Bars bars={data.trend.bars} small />
      </span>
      {toRate > 0 && <span className="mcb-sub sc-accent">{t('scorecard.toRate').replace('{n}', String(toRate))}</span>}
    </div>
  );
}

function Bars({ bars, small }: { bars: number[]; small?: boolean }) {
  // Ten slots always: empty ones keep a 4px baseline, so the first rating never shifts the card.
  const slots = Array.from({ length: 10 }, (_, i) => bars[i - (10 - bars.length)] ?? null);
  return (
    <span className={`sc-bars${small ? ' sc-bars--small' : ''}`} aria-hidden="true" data-testid="sc-bars">
      {slots.map((s, i) => (
        <span key={i} className={`sc-bar${s === null ? ' is-empty' : ` is-${barTone(s)}`}`}
          style={s === null ? undefined : { height: `${(s / 5) * 100}%` }} />
      ))}
    </span>
  );
}

// ─── Full card ───────────────────────────────────────────────────────────────────

interface Ctx {
  slug: string;
  data: ScorecardData;
  phone: boolean;
  can: (what: string) => boolean;
  send: (w: ScorecardWrite) => void;
  busy: boolean;
  error: string | null;
}

function ScoreFull({ slug, data, phone }: { slug: string; data: ScorecardData; phone: boolean }) {
  const { t } = useI18n();
  const write = useScorecardWrite(slug);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/agents/${encodeURIComponent(slug)}/scorecard`;
  const ctx: Ctx = {
    slug, data, phone, busy: write.isPending, error,
    can: (what) => !phone && phoneAllows('POST', `${base}/${what}`),
    send: (w) => { setError(null); write.mutate(w, { onError: (e) => setError((e as Error).message) }); },
  };
  const damaged = !!data.damaged;
  return (
    <div className={`mcb-body sc-full${phone ? ' sc-full--phone' : ''}`} data-testid="sc-full" data-phone={phone ? 'true' : 'false'}>
      {damaged && (
        <div className="sc-damaged" role="alert" data-testid="sc-damaged">
          <span>{t('scorecard.damaged')}</span>
          {ctx.can('fresh') && <button type="button" className="mcb-link" onClick={() => ctx.send({ kind: 'fresh' })}>{t('scorecard.startFresh')}</button>}
        </div>
      )}
      {error && <p className="sc-error" role="status" data-testid="sc-write-error">{error}</p>}
      {!phone && <GoalBand ctx={ctx} />}
      {phone ? (
        <>
          <Trend ctx={ctx} />
          <Runs ctx={ctx} />
          <Criteria ctx={ctx} />
          <Learned ctx={ctx} />
        </>
      ) : (
        <div className="sc-cols">
          <div className="sc-col sc-col--left">
            <Criteria ctx={ctx} />
            <Learned ctx={ctx} />
          </div>
          <div className="sc-col sc-col--right">
            <Trend ctx={ctx} />
            <Runs ctx={ctx} />
          </div>
        </div>
      )}
    </div>
  );
}

// Goal band (D18) ───────────────────────────────────────────────────────────────

function GoalBand({ ctx }: { ctx: Ctx }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const g = ctx.data.goal;
  const canSet = ctx.can('goal');
  if (editing && canSet) return <GoalForm ctx={ctx} current={g} onDone={() => setEditing(false)} />;
  if (!g) {
    return canSet ? (
      <button type="button" className="sc-goal-add" data-testid="sc-goal-add" onClick={() => setEditing(true)}>
        <span className="sc-accent">+ {t('scorecard.addGoal')}</span>
        <span className="mcb-muted"> · {t('scorecard.optional')} · {t('scorecard.addGoalHint')}</span>
      </button>
    ) : null;
  }
  if (!g.here) {
    return <div className="sc-goal sc-goal--elsewhere" data-testid="sc-goal-elsewhere">{t('scorecard.goalElsewhere').replace('{name}', g.project.name)}</div>;
  }
  if (g.gone || typeof g.latest !== 'number') {
    return (
      <div className="sc-goal sc-goal--gone" data-testid="sc-goal-gone">
        <span>{t('scorecard.goalGone')}</span>
        {canSet && <button type="button" className="mcb-link" onClick={() => ctx.send({ kind: 'goalClear' })}>{t('scorecard.remove')}</button>}
      </div>
    );
  }
  const change = goalChange(g);
  const lower = lowerIsBetter(g);
  return (
    <div className="sc-goal" data-testid="sc-goal">
      <div className="sc-goal-num">
        <span className="sc-label">{t('scorecard.goal')} <span className="sc-label-soft">· {t('scorecard.optional')}</span></span>
        <span className="sc-goal-value">
          <span className="sc-goal-big">{formatValue(g.latest, g.unit)}</span>
          {change && (
            <span className={`sc-move ${change.good ? 'is-good' : 'is-bad'}`} data-testid="sc-goal-change">
              {change.abs < 0 ? '▼' : '▲'} {change.pct === null ? formatValue(Math.abs(change.abs), g.unit) : `${Math.abs(Math.round(change.pct))}%`}
            </span>
          )}
        </span>
        <span className="mcb-muted">{g.title} · {t('scorecard.target')} {formatValue(g.target ?? 0, g.unit)}</span>
      </div>
      <GoalLine points={g.points ?? []} runs={ctx.data.runs} target={g.target} lower={lower} />
      <div className="sc-goal-src">
        <span className="mcb-muted">{t('scorecard.fromLab')}</span>
        <span className="sc-strong">{g.title ?? g.insight}</span>
        {canSet && (
          <span>
            <button type="button" className="mcb-link" data-testid="sc-goal-change-btn" onClick={() => setEditing(true)}>{t('scorecard.change')}</button>
            {' · '}
            <button type="button" className="mcb-link" data-testid="sc-goal-remove" onClick={() => ctx.send({ kind: 'goalClear' })}>{t('scorecard.remove')}</button>
          </span>
        )}
      </div>
    </div>
  );
}

function GoalLine({ points, runs, target, lower }: { points: Array<{ t: string; v: number }>; runs: ScoreRun[]; target?: number; lower: boolean }) {
  const pts = useMemo(() => points.filter((p) => Number.isFinite(p.v)).slice().sort((a, b) => (a.t < b.t ? -1 : 1)), [points]);
  if (pts.length < 2) return <span className="sc-goal-line" aria-hidden="true" />;
  const W = 400;
  const H = 60;
  const vals = pts.map((p) => p.v).concat(typeof target === 'number' ? [target] : []);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const y = (v: number) => (max === min ? H / 2 : 4 + (1 - (v - min) / (max - min)) * (H - 8));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const dots = runs.flatMap((r) => {
    const day = localDay(r.lastAt);
    let idx = -1;
    pts.forEach((p, i) => { if (p.t.slice(0, 10) <= day) idx = i; });
    if (idx < 0) return [];
    const mv = goalMoveForRun(pts, r.lastAt, lower);
    return [{ key: r.key, cx: x(idx), cy: y(pts[idx].v), good: mv ? mv.good : null }];
  });
  return (
    <svg className="sc-goal-line" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" data-testid="sc-goal-line">
      {typeof target === 'number' && <line className="sc-goal-target" x1="0" x2={W} y1={y(target)} y2={y(target)} />}
      <polyline className="sc-goal-path" points={pts.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} />
      {dots.map((d) => <circle key={d.key} className={`sc-goal-dot${d.good === null ? '' : d.good ? ' is-good' : ' is-bad'}`} cx={d.cx} cy={d.cy} r="4" />)}
    </svg>
  );
}

function GoalForm({ ctx, current, onDone }: { ctx: Ctx; current: ScoreGoal | null; onDone: () => void }) {
  const { t } = useI18n();
  const cands = ctx.data.candidates;
  const [insight, setInsight] = useState(current?.insight ?? cands[0]?.slug ?? '');
  const pick = cands.find((c) => c.slug === insight);
  const [baseline, setBaseline] = useState(current?.baseline !== undefined ? String(current.baseline) : '');
  const [target, setTarget] = useState(current?.target !== undefined ? String(current.target) : '');
  const tNum = Number(target);
  const bNum = baseline.trim() === '' ? (pick?.latest ?? NaN) : Number(baseline);
  const valid = !!pick && target.trim() !== '' && Number.isFinite(tNum) && Number.isFinite(bNum) && bNum !== tNum;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    ctx.send({ kind: 'goal', insight, target: tNum, baseline: baseline.trim() === '' ? null : bNum });
    onDone();
  };
  return (
    <form className="sc-goal sc-goal-form" data-testid="sc-goal-form" onSubmit={submit}>
      {cands.length === 0 ? (
        <p className="mcb-muted">{t('scorecard.noCandidates')}</p>
      ) : (
        <>
          <label className="sc-field">
            <span className="sc-label">{t('scorecard.labCard')}</span>
            <select value={insight} onChange={(e) => setInsight(e.target.value)} data-testid="sc-goal-insight">
              {cands.map((c) => <option key={c.slug} value={c.slug}>{c.title} ({formatValue(c.latest, c.unit)})</option>)}
            </select>
          </label>
          <label className="sc-field">
            <span className="sc-label">{t('scorecard.baseline')}</span>
            <input inputMode="decimal" value={baseline} placeholder={pick ? String(pick.latest) : ''} onChange={(e) => setBaseline(e.target.value)} data-testid="sc-goal-baseline" />
          </label>
          <label className="sc-field">
            <span className="sc-label">{t('scorecard.target')}</span>
            <input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} data-testid="sc-goal-target" />
          </label>
        </>
      )}
      <span className="sc-form-actions">
        <button type="button" className="mcb-link" onClick={onDone}>{t('superStage.member.cards.cancel')}</button>
        {cands.length > 0 && <button type="submit" className="sc-btn" disabled={!valid} data-testid="sc-goal-save">{t('scorecard.save')}</button>}
      </span>
    </form>
  );
}

// Criteria ──────────────────────────────────────────────────────────────────────

function Criteria({ ctx }: { ctx: Ctx }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const active = ctx.data.card.criteria.filter((c) => !c.removedAt);
  const canEdit = ctx.can('criteria');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    ctx.send({ kind: 'criteria', op: 'add', text: v });
    setText('');
  };
  return (
    <section className="sc-section" data-testid="sc-criteria">
      <h4 className="sc-label">{t('scorecard.criteria')}</h4>
      <p className="mcb-muted sc-sub">{t('scorecard.criteriaSub')}</p>
      {active.map((c) => (
        <div key={c.id} className="sc-crit" data-testid="sc-crit">
          <span className="sc-crit-text">{c.text}</span>
          {canEdit && (
            <button type="button" className="sc-x" aria-label={t('scorecard.remove')} title={t('scorecard.remove')}
              onClick={() => ctx.send({ kind: 'criteria', op: 'remove', id: c.id })}>×</button>
          )}
        </div>
      ))}
      {canEdit && (adding ? (
        <form className="sc-crit-add" onSubmit={submit}>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input autoFocus maxLength={200} value={text} onChange={(e) => setText(e.target.value)} data-testid="sc-crit-input"
            placeholder={t('scorecard.criteriaPrompt')} onBlur={() => { if (!text.trim()) setAdding(false); }} />
        </form>
      ) : (
        <button type="button" className="mcb-new sc-crit-new" data-testid="sc-crit-new" onClick={() => setAdding(true)}>+ {t('scorecard.addCriterion')}</button>
      ))}
      {active.length === 0 && <p className="mcb-muted sc-example">{t('scorecard.criteriaExample')}</p>}
    </section>
  );
}

// Lessons ───────────────────────────────────────────────────────────────────────

function lessonSource(l: ScoreLesson, data: ScorecardData, locale: string, t: (k: string) => string): string {
  const r = data.card.ratings[l.run];
  const day = new Date(l.at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return r ? t('scorecard.fromStars').replace('{n}', String(r.stars)).replace('{date}', day) : t('scorecard.fromNote').replace('{date}', day);
}

function LessonActions({ ctx, l }: { ctx: Ctx; l: ScoreLesson }) {
  const { t } = useI18n();
  const canUndo = phoneAllows('POST', `/api/agents/${encodeURIComponent(ctx.slug)}/scorecard/lessons/${encodeURIComponent(l.id)}/undo`);
  return (
    <>
      {l.status === 'held' && ctx.can('lessons/x/use') && (
        <button type="button" className="mcb-link" data-testid="sc-lesson-use" onClick={() => ctx.send({ kind: 'use', id: l.id })}>{t('scorecard.useIt')}</button>
      )}
      {(l.status === 'active' || l.status === 'held') && canUndo && (
        <button type="button" className="mcb-link" data-testid="sc-lesson-undo" onClick={() => ctx.send({ kind: 'undo', id: l.id })}>{t('scorecard.undo')}</button>
      )}
    </>
  );
}

function Learned({ ctx }: { ctx: Ctx }) {
  const { t, locale } = useI18n();
  const lessons = ctx.data.card.lessons.filter((l) => l.status === 'active' || l.status === 'held').slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const chars = ctx.data.ownerBlockChars;
  return (
    <section className="sc-section" data-testid="sc-learned">
      <h4 className="sc-label">{t('scorecard.learned')}</h4>
      {lessons.length === 0 && <p className="mcb-muted sc-empty-line">{t('scorecard.learnedEmpty')}</p>}
      {lessons.map((l) => (
        <div key={l.id} className={`sc-lesson${l.status === 'held' ? ' is-held' : ''}`} data-testid="sc-lesson" data-status={l.status}>
          <span className="sc-lesson-text">{l.text}</span>
          <span className="sc-lesson-meta mcb-muted">
            {l.status === 'held'
              ? `${t('scorecard.held')}${l.flags?.length ? `: ${l.flags.join(', ')}` : ''}`
              : lessonSource(l, ctx.data, locale, t)}
            {' · '}
            <LessonActions ctx={ctx} l={l} />
          </span>
        </div>
      ))}
      {chars > ctx.data.blockWarnChars && (
        <p className="mcb-muted sc-length" data-testid="sc-length">{t('scorecard.length').replace('{n}', String(chars))}</p>
      )}
    </section>
  );
}

// Trend ─────────────────────────────────────────────────────────────────────────

function Trend({ ctx }: { ctx: Ctx }) {
  const { t } = useI18n();
  const { average, before, bars } = ctx.data.trend;
  const word = trendWord(average, before);
  return (
    <section className="sc-section sc-trend" data-testid="sc-trend">
      <h4 className="sc-label">{t('scorecard.yourRating')}</h4>
      <div className="sc-trend-row">
        <div className="sc-trend-num">
          {average === null ? (
            <>
              <span className="sc-strong sc-trend-empty">{t('scorecard.noRatings')}</span>
              <span className="mcb-muted">{t('scorecard.firstRating')}</span>
            </>
          ) : (
            <>
              <span className="sc-avg" data-testid="sc-avg">{average.toFixed(1)} ★</span>
              {word && before !== null && (
                <span className={`sc-trend-word is-${word}`} data-testid="sc-trend-word">
                  {t(`scorecard.trend.${word}`).replace('{x}', before.toFixed(1))}
                </span>
              )}
            </>
          )}
        </div>
        <Bars bars={bars} />
      </div>
    </section>
  );
}

// Runs ──────────────────────────────────────────────────────────────────────────

function Runs({ ctx }: { ctx: Ctx }) {
  const { t } = useI18n();
  const runs = ctx.data.runs.filter((r) => r.status !== 'running' && r.status !== 'waiting');
  const firstUnrated = runs.find((r) => !r.rating)?.key ?? null;
  return (
    <section className="sc-section" data-testid="sc-runs">
      <h4 className="sc-label">{t('scorecard.recentRuns')}</h4>
      {runs.length === 0 && <p className="mcb-muted">{t('scorecard.noRuns')}</p>}
      {runs.map((r) => <RunRow key={r.key} ctx={ctx} run={r} lead={r.key === firstUnrated} />)}
    </section>
  );
}

function RunRow({ ctx, run, lead }: { ctx: Ctx; run: ScoreRun; lead: boolean }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const r = run.rating;
  const stars = r?.stars ?? 0;
  const expanded = lead || open || !!r;
  const low = !!r && r.stars <= 2;
  const goal = ctx.data.goal;
  const move = goal?.here && goal.points && typeof goal.baseline === 'number'
    ? goalMoveForRun(goal.points, run.lastAt, lowerIsBetter(goal)) : null;
  const met = checksMet(run.check);
  const lessons = run.lessons.filter((l) => l.status === 'active' || l.status === 'held');
  const rate = (n: number) => ctx.send({ kind: 'rate', run: run.key, stars: n, ...(r?.note ? { note: r.note } : {}) });
  return (
    <div className={`sc-run${lead ? ' is-lead' : ''}${low ? ' is-low' : ''}`} data-testid="sc-run" data-run={run.key}
      data-rated={r ? 'true' : 'false'}>
      <div className="sc-run-top" onClick={() => { if (!expanded) setOpen(true); }}>
        <span className="sc-run-title">
          <span className="sc-strong">{run.title}</span>
          {(met || move) && (
            <span className="mcb-muted sc-run-sub">
              {met && t('scorecard.checksMet').replace('{n}', String(met.met)).replace('{total}', String(met.total))}
              {met && move && ' · '}
              {move && (
                <span className={move.good ? 'is-good' : 'is-bad'} data-testid="sc-run-goal">
                  {t('scorecard.goalMove')} {move.delta < 0 ? '▼' : '▲'} {formatValue(Math.abs(move.delta), goal?.unit)}
                </span>
              )}
            </span>
          )}
        </span>
        {(expanded || !ctx.phone) && (
          <Stars value={stars} big={lead && !r} label={t('scorecard.rateRun')} disabled={ctx.busy} onRate={rate} />
        )}
        <span className="mcb-muted sc-run-day">{runDay(run.lastAt, locale, t)}</span>
      </div>
      {lead && !r && <span className="sc-accent sc-run-cta">{t('scorecard.rateRun')} · {t('scorecard.addNote')}</span>}
      {r && <RatedDetail ctx={ctx} run={run} />}
      <CheckLine ctx={ctx} run={run} />
      {lessons.map((l) => (
        <div key={l.id} className="sc-run-lesson" data-testid="sc-run-lesson">
          <span className="sc-accent sc-strong">{l.status === 'held' ? t('scorecard.held') : t('scorecard.learnedShort')}</span>
          <span className="sc-lesson-text">{l.text}</span>
          <span className="sc-run-lesson-act"><LessonActions ctx={ctx} l={l} /></span>
        </div>
      ))}
    </div>
  );
}

function RatedDetail({ ctx, run }: { ctx: Ctx; run: ScoreRun }) {
  const { t } = useI18n();
  const r = run.rating!;
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(r.note ?? '');
  const draft = r.draft;
  const save = (e: FormEvent) => {
    e.preventDefault();
    ctx.send({ kind: 'rate', run: run.key, stars: r.stars, note: note.trim() });
    setEditing(false);
  };
  return (
    <div className="sc-rated" onPointerDown={stop}>
      {editing ? (
        <form className="sc-note-form" onSubmit={save}>
          <textarea maxLength={2000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} data-testid="sc-note-input"
            placeholder={t('scorecard.notePlaceholder')} />
          <span className="sc-form-actions">
            <button type="button" className="mcb-link" onClick={() => { setNote(r.note ?? ''); setEditing(false); }}>{t('superStage.member.cards.cancel')}</button>
            <button type="submit" className="sc-btn" data-testid="sc-note-save">{t('scorecard.save')}</button>
          </span>
        </form>
      ) : r.note ? (
        <div className="sc-note" data-testid="sc-note">
          <span><span className="sc-strong">{t('scorecard.yourNote')}</span> “{r.note}”</span>
          <button type="button" className="mcb-link" onClick={() => setEditing(true)}>{t('scorecard.edit')}</button>
        </div>
      ) : (
        <button type="button" className="mcb-link sc-add-note" data-testid="sc-add-note" onClick={() => setEditing(true)}>{t('scorecard.addNote')}</button>
      )}
      {r.quote && <p className="mcb-muted sc-quote" data-testid="sc-quote">{t('scorecard.fromWords')} «{r.quote}»</p>}
      {draft?.state === 'running' && <p className="mcb-muted" data-testid="sc-draft-running">{t('scorecard.drafting')}</p>}
      {draft?.state === 'failed' && (
        <p className="sc-failed" data-testid="sc-draft-failed">
          {t('scorecard.draftFailed')}
          {ctx.can('draft') && <> · <button type="button" className="mcb-link" onClick={() => ctx.send({ kind: 'draft', run: run.runKey })}>{t('scorecard.tryAgain')}</button></>}
        </p>
      )}
      <button type="button" className="sc-clear mcb-link" data-testid="sc-clear" onClick={() => ctx.send({ kind: 'rate', run: run.key, stars: null })}>
        {t('scorecard.clear')}
      </button>
    </div>
  );
}

function CheckLine({ ctx, run }: { ctx: Ctx; run: ScoreRun }) {
  const { t } = useI18n();
  const c = run.check;
  const hasCriteria = ctx.data.card.criteria.some((x) => !x.removedAt);
  const canCheck = ctx.can('check');
  const canFlip = ctx.can('verdict');
  if (!c) {
    if (!hasCriteria || !canCheck || run.status !== 'ok') return null;
    return (
      <p className="mcb-muted sc-check" data-testid="sc-check-none">
        {t('scorecard.notChecked')} · <button type="button" className="mcb-link" onClick={() => ctx.send({ kind: 'check', run: run.runKey })}>{t('scorecard.check')}</button>
      </p>
    );
  }
  if (c.state === 'running') return <p className="mcb-muted sc-check" data-testid="sc-check-running">{t('scorecard.checking')}</p>;
  if (c.state === 'no_text') return <p className="mcb-muted sc-check" data-testid="sc-check-notext">{t('scorecard.noText')}</p>;
  if (c.state === 'failed') {
    return (
      <p className="sc-failed sc-check" data-testid="sc-check-failed">
        {t('scorecard.checkFailed')}{c.lastError ? ` (${c.lastError})` : ''}
        {canCheck && <> · <button type="button" className="mcb-link" onClick={() => ctx.send({ kind: 'check', run: run.runKey })}>{t('scorecard.tryAgain')}</button></>}
      </p>
    );
  }
  return (
    <span className="sc-chips" data-testid="sc-chips">
      {c.verdicts.map((v) => {
        const cls = v.met === true ? 'is-met' : v.met === false ? 'is-miss' : 'is-unset';
        const mark = v.met === true ? '✓' : v.met === false ? '✗' : '?';
        return canFlip ? (
          <button key={v.id} type="button" className={`sc-chip ${cls}`} title={v.why ?? v.text} data-testid="sc-chip" data-by={v.by}
            onClick={() => ctx.send({ kind: 'verdict', run: run.runKey, id: v.id, met: nextVerdict(v.met) })}>{mark} {v.text}</button>
        ) : (
          <span key={v.id} className={`sc-chip ${cls}`} title={v.why ?? v.text} data-testid="sc-chip">{mark} {v.text}</span>
        );
      })}
    </span>
  );
}

// ─── Stars under a run in the member's chat (RunFoot) ────────────────────────────

/** Stars and a note under a finished run in the member's chat; reads the card's shared cache. */
export function RunStars({ member, sessionKey }: { member: string; sessionKey: string }) {
  const { t } = useI18n();
  const q = useScorecard(member);
  const write = useScorecardWrite(member);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  const run = q.data?.runs.find((r) => r.key === sessionKey);
  if (!run || !run.status || run.status === 'running' || run.status === 'waiting') return null;
  const r = run.rating;
  const lessons = run.lessons.filter((l) => l.status === 'active' || l.status === 'held');
  const canUndo = (id: string) => phoneAllows('POST', `/api/agents/${encodeURIComponent(member)}/scorecard/lessons/${encodeURIComponent(id)}/undo`);
  const send = (stars: number | null, n?: string) => write.mutate({ kind: 'rate', run: run.key, stars, ...(n !== undefined ? { note: n } : r?.note ? { note: r.note } : {}) });
  return (
    <div className="sc-runstars" data-testid="run-stars" data-run={run.key}>
      <span className="sc-runstars-row">
        <Stars value={r?.stars ?? 0} label={t('scorecard.rateRun')} disabled={write.isPending} onRate={(n) => send(n)} />
        {!r && <span className="mcb-muted">{t('scorecard.rateRun')}</span>}
        {r && !r.note && !noting && <button type="button" className="mcb-link" data-testid="run-stars-note" onClick={() => setNoting(true)}>{t('scorecard.addNote')}</button>}
        {r && <button type="button" className="mcb-link sc-clear" data-testid="run-stars-clear" onClick={() => send(null)}>{t('scorecard.clear')}</button>}
      </span>
      {r?.note && <span className="sc-runstars-note">“{r.note}”</span>}
      {noting && r && (
        <form className="sc-note-form" onSubmit={(e) => { e.preventDefault(); send(r.stars, note.trim()); setNoting(false); setNote(''); }}>
          <textarea maxLength={2000} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('scorecard.notePlaceholder')} data-testid="run-stars-note-input" />
          <span className="sc-form-actions">
            <button type="button" className="mcb-link" onClick={() => setNoting(false)}>{t('superStage.member.cards.cancel')}</button>
            <button type="submit" className="sc-btn">{t('scorecard.save')}</button>
          </span>
        </form>
      )}
      {lessons.map((l) => (
        <span key={l.id} className="sc-run-lesson" data-testid="run-stars-lesson">
          <span className="sc-accent sc-strong">{l.status === 'held' ? t('scorecard.held') : t('scorecard.learnedShort')}</span>
          <span className="sc-lesson-text">{l.text}</span>
          {canUndo(l.id) && <button type="button" className="mcb-link" onClick={() => write.mutate({ kind: 'undo', id: l.id })}>{t('scorecard.undo')}</button>}
        </span>
      ))}
    </div>
  );
}
