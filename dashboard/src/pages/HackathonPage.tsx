import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { ScopedLocale, useI18n } from '../context/I18nContext';
import { sendFromPage } from '../lib/superPageBridge';
import { askAgent } from '../components/apps/askAgent';
import { StartCard } from '../components/hackathon/StartCard';
import { TeamTable } from '../components/hackathon/TeamTable';
import { TeamRoom } from '../components/hackathon/TeamRoom';
import { Peek } from '../components/hackathon/Peek';
import { Presentation } from '../components/hackathon/Presentation';
import { Results } from '../components/hackathon/Results';
import { PrConfirm } from '../components/hackathon/PrConfirm';
import {
  clock, fill, minutesLeft, momentText, pct, textLocale, useFrames, useResult, useRounds, useRun, useRuns,
  type RoundRecord, type RunState, type RunView,
} from '../components/hackathon/data';
import '../components/hackathon/hackathon.css';

/**
 * The Hackathon page (plan W2, approved r3 mockups): the run list with Yeni hackathon (the
 * request goes to the Super, who sets the run up by asking; no form), and one run's screens by
 * its state: the start card, Canlı (a grid of team tables and the strip), the team room, the
 * peek, the presentations and the result with the pick and the PR confirm.
 */
type View = { kind: 'main' } | { kind: 'room'; team: string } | { kind: 'peek'; round: number } | { kind: 'present'; team: string } | { kind: 'pr' };

export function HackathonPage({ focus }: { focus?: { id: string | null; nonce: number } }) {
  const [open, setOpen] = useState<string | null>(focus?.id ?? null);
  useEffect(() => { if (focus?.id) setOpen(focus.id); }, [focus?.id, focus?.nonce]);
  return (
    <div className="hk-page">
      <PageLocale run={open}>
        {open ? <RunScreen id={open} onBack={() => setOpen(null)} /> : <RunList onOpen={setOpen} />}
      </PageLocale>
    </div>
  );
}

/** The page speaks its content's language (a Turkish problem → Turkish labels), like a Lab card. */
function PageLocale({ run, children }: { run: string | null; children: ReactNode }) {
  const { locale } = useI18n();
  const { data: list } = useRuns();
  const { data: one } = useRun(run);
  const texts = run ? [one?.problem] : (list?.runs ?? []).map((r) => r.problem);
  return <ScopedLocale locale={textLocale(texts, locale)}>{children}</ScopedLocale>;
}

function RunList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useI18n();
  const { vault, bus } = useVault();
  const { data, isLoading, isError, error } = useRuns();
  const [note, setNote] = useState<string | null>(null);
  const runs = data?.runs ?? [];

  const startNew = () => {
    setNote(null);
    const text = t('hk.new.prompt');
    const r = sendFromPage(bus, text);
    if (r.accepted) { setNote(t('hk.new.sent')); return; }
    askAgent(bus, text, { fallback: { vault: vault ?? '', title: t('hk.new.tab') } });
  };

  return (
    <div className="hk-list">
      <header className="hk-head">
        <h2 className="hk-head__title">{t('nav.hackathon')}</h2>
        <span className="hk-head__grow" />
        <button type="button" className="hk-btn hk-btn--primary" onClick={startNew}>{t('hk.new')}</button>
      </header>
      {note && <p className="hk-note" role="status">{note}</p>}
      {isLoading && <p className="hk-muted">{t('common.loading')}</p>}
      {isError && <p className="hk-error">{t('hk.list.failed')} {(error as Error | null)?.message ?? ''}</p>}
      {data && !runs.length && (
        <div className="hk-empty">
          <p className="hk-empty__lead">{t('hk.empty.lead')}</p>
          <p className="hk-muted">{t('hk.empty.how')}</p>
        </div>
      )}
      {!!runs.length && (
        <ul className="hk-runs">
          {runs.map((r) => (
            <li key={r.id}>
              <button type="button" className="hk-run" onClick={() => onOpen(r.id)}>
                <span className="hk-run__problem">{r.problem}</span>
                <span className="hk-muted">{fill(t('hk.list.meta'), { teams: r.teams, kind: t(`hk.kind.${r.kind}`), date: new Date(r.createdAt).toLocaleDateString() })}</span>
                <span className="hk-chip" data-state={r.state}>{t(`hk.state.${r.state}`)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const LIVE_STATES: ReadonlySet<RunState> = new Set<RunState>(['running', 'presenting', 'judging']);

function RunScreen({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useI18n();
  const api = useApi();
  const qc = useQueryClient();
  const { data: run, isLoading, isError, error } = useRun(id);
  const live = !!run && LIVE_STATES.has(run.state);
  const { data: frames } = useFrames(id, live && run?.state !== 'judging');
  const { data: rounds } = useRounds(id, live);
  const ended = !!run && (run.state === 'judging' || run.state === 'picked' || run.state === 'stopped');
  const { data: result } = useResult(id, !!run && run.state === 'judging');
  const [view, setView] = useState<View>({ kind: 'main' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // A new screen (room, peek, presentation, back) opens at its top, not where the last one was scrolled.
  const viewKey = `${view.kind}:${'team' in view ? view.team : 'round' in view ? view.round : ''}`;
  useEffect(() => {
    for (let el = document.querySelector('.hk-page') as HTMLElement | null; el; el = el.parentElement) {
      if (el.scrollTop > 0) el.scrollTop = 0;
    }
    // An action's failure belongs to the screen it was pressed on.
    setErr(null);
  }, [viewKey]);

  if (isLoading) return <p className="hk-muted">{t('common.loading')}</p>;
  if (isError || !run) return <p className="hk-error">{t('hk.run.failed')} {(error as Error | null)?.message ?? ''}</p>;

  const refresh = () => qc.invalidateQueries({ queryKey: ['hackathon'] });
  const act = async (what: 'stop' | 'resume' | 'relaunch', owner: boolean) => {
    setBusy(what); setErr(null);
    try {
      const path = `/hackathon/${encodeURIComponent(id)}/${what === 'relaunch' ? 'resume' : what}`;
      const body = what === 'relaunch' ? { conductor: true } : {};
      if (owner) await api.ownerPost(path, body); else await api.post(path, body);
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const pick = async (team: string) => {
    setBusy(`pick:${team}`); setErr(null);
    try {
      await api.ownerPost(`/hackathon/${encodeURIComponent(id)}/pick`, { team });
      await refresh();
      setView({ kind: 'main' });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const teamOf = (tid: string) => run.teams.find((x) => x.id === tid);
  const frameOf = (tid: string) => frames?.frames.find((f) => f.team === tid);
  const canPick = run.state === 'judging' && !!result?.jury;
  const picking = busy?.startsWith('pick:') ? busy.slice(5) : null;

  if (view.kind === 'room' && teamOf(view.team)) {
    return <TeamRoom run={id} teams={run.teams} team={teamOf(view.team)!} frame={frameOf(view.team)} round={run.round} rounds={run.rounds} onBack={() => setView({ kind: 'main' })} />;
  }
  if (view.kind === 'peek') {
    const rec = rounds?.rounds.find((r) => r.round === view.round);
    if (rec) return <Peek rec={rec} teams={run.teams} controlTeam={run.controlTeam} onBack={() => setView({ kind: 'main' })} />;
  }
  if (view.kind === 'present' && teamOf(view.team)) {
    const order = result?.jury?.ranking.length ? [...result.jury.ranking, ...run.teams.map((x) => x.id).filter((x) => !result.jury!.ranking.includes(x))] : run.teams.map((x) => x.id);
    return (
      <Presentation
        key={view.team} run={id} teams={run.teams} order={order} team={teamOf(view.team)!} error={err}
        jury={result?.jury ?? null} pick={result?.result?.pick ?? null} canPick={canPick} picking={picking === view.team}
        onPick={() => void pick(view.team)} onApply={() => setView({ kind: 'pr' })} onTeam={(team) => setView({ kind: 'present', team })}
        onBack={() => setView({ kind: 'main' })}
      />
    );
  }

  const onBoard = run.state === 'running' || run.state === 'presenting';
  return (
    <div className="hk-run-screen">
      <RunHeader run={run} onBack={onBack} busy={busy} onStop={() => void act('stop', false)} />
      <Timeline run={run} rounds={rounds?.rounds ?? []} onPeek={(round) => setView({ kind: 'peek', round })} />
      {run.conductor === 'gone' && (
        <div className="hk-banner" role="status">
          <span>{t('hk.conductor.gone')}</span>
          <button type="button" className="hk-btn" disabled={busy === 'relaunch'} onClick={() => void act('relaunch', true)}>{t('hk.conductor.relaunch')}</button>
        </div>
      )}
      {run.paused && run.state === 'running' && run.conductor !== 'gone' && (
        <div className="hk-banner" role="status">
          <span>{fill(t('hk.paused'), { reason: run.paused })}</span>
          <button type="button" className="hk-btn" disabled={busy === 'resume'} onClick={() => void act('resume', true)}>{t('hk.resume')}</button>
        </div>
      )}
      {err && <p className="hk-error" role="alert">{err}</p>}

      {(run.state === 'awaiting-owner' || run.state === 'draft') && (
        <StartCard run={id} inPage onStarted={() => void refresh()} onCancel={() => void act('stop', false)} cancelling={busy === 'stop'} />
      )}

      {onBoard && (
        <div className="hk-live">
          <div className="hk-live__tables">
            {run.state === 'presenting' && <p className="hk-lede hk-live__wide">{t('hk.presenting')}</p>}
            {run.teams.map((tm) => (
              <TeamTable key={tm.id} run={id} teams={run.teams} team={tm} frame={frameOf(tm.id)} control={tm.id === run.controlTeam} onOpen={() => setView({ kind: 'room', team: tm.id })} />
            ))}
          </div>
          <aside className="hk-live__side">
            <Distance run={run} rounds={rounds?.rounds ?? []} />
            <section className="hk-box">
              <h3 className="hk-label">{t('hk.moments')}</h3>
              {run.strip.moments.length ? (
                <ul className="hk-feed">
                  {[...run.strip.moments].reverse().slice(0, 12).map((m, i) => (
                    <li key={`${m.at}-${i}`}><time>{clock(m.at)}</time><span>{momentText(m.text, t)}</span></li>
                  ))}
                </ul>
              ) : <p className="hk-quiet">{t('hk.noMoments')}</p>}
            </section>
          </aside>
        </div>
      )}

      {ended && view.kind === 'pr' && <PrConfirm run={id} team={teamOf(result?.result?.pick ?? '')} onClose={() => setView({ kind: 'main' })} />}
      {ended && view.kind !== 'pr' && (
        <Results
          run={id} teams={run.teams} controlTeam={run.controlTeam} data={result}
          canPick={canPick} picking={picking}
          onOpen={(team) => setView({ kind: 'present', team })} onPick={(team) => void pick(team)} onApply={() => setView({ kind: 'pr' })}
        />
      )}
    </div>
  );
}

/** Every screen's head (design B): ‹ Hackathonlar, the problem, then the state or the clock. */
function RunHeader({ run, onBack, busy, onStop }: { run: RunView; onBack: () => void; busy: string | null; onStop: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const s = run.strip;
  // Judging spends nothing and waits for the pick: no clock, and no Stop beside the pick.
  const running = run.state === 'running' || run.state === 'presenting';
  return (
    <header className="hk-top">
      <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.back')}</button>
      <h1 className="hk-title">{run.problem}</h1>
      {running ? (
        <span className="hk-top__meta">
          <span>{fill(t('hk.meter.left'), { end: clock(s.endsAt), left: minutesLeft(s.endsAt) })}</span>
          {s.used != null && <span>{s.reading}</span>}
          {!confirming && <button type="button" className="hk-btn" disabled={busy === 'stop'} onClick={() => setConfirming(true)}>{t('hk.stop')}</button>}
        </span>
      ) : (
        <span className="hk-chip" data-state={run.state}>{t(`hk.state.${run.state}`)}</span>
      )}
      {running && confirming && (
        <span className="hk-confirm" role="group" aria-label={t('hk.stop')}>
          <span>{t('hk.stop.confirmRunning')}</span>
          <button type="button" className="hk-btn hk-btn--danger" disabled={busy === 'stop'} onClick={() => { setConfirming(false); onStop(); }}>{t('hk.stop.yes')}</button>
          <button type="button" className="hk-btn" onClick={() => setConfirming(false)}>{t('hk.stop.no')}</button>
        </span>
      )}
    </header>
  );
}

/**
 * The run's steps (design B): Tur 1, Tur 2, Sunumlar, Jüri, Seçim; done ones ticked, the current
 * one with a dot. A finished round with a peek record opens that peek.
 */
function Timeline({ run, rounds, onPeek }: { run: RunView; rounds: RoundRecord[]; onPeek: (round: number) => void }) {
  const { t } = useI18n();
  if (run.state === 'draft' || run.state === 'awaiting-owner') return null;
  const order: RunState[] = ['running', 'presenting', 'judging', 'picked'];
  const at = run.state === 'stopped' ? -1 : order.indexOf(run.state);
  const steps: { key: string; label: string; done: boolean; now: boolean; peek?: number }[] = [];
  for (let r = 1; r <= run.rounds; r++) {
    const rec = rounds.find((x) => x.round === r);
    const now = run.state === 'running' && run.round === r;
    const done = at > 0 || (run.round ?? 0) > r || (!!rec && !now);
    steps.push({ key: `r${r}`, label: fill(t(now ? 'hk.step.roundNow' : 'hk.step.round'), { n: r }), done, now, peek: rec && Object.keys(rec.cards).length ? r : undefined });
  }
  steps.push({ key: 'present', label: t('hk.step.present'), done: at > 1, now: at === 1 });
  steps.push({ key: 'jury', label: t('hk.step.jury'), done: at > 2 || at === 2, now: false });
  steps.push({ key: 'pick', label: t('hk.step.pick'), done: at === 3, now: at === 2 });
  return (
    <ol className="hk-steps">
      {steps.map((s) => (
        <li key={s.key} className="hk-step" data-done={s.done ? 'true' : undefined} data-now={s.now ? 'true' : undefined} data-live={s.now && run.state === 'running' ? 'true' : undefined}>
          {s.peek != null
            ? <button type="button" className="hk-step__btn" title={fill(t('hk.step.peekHint'), { n: s.peek })} onClick={() => onPeek(s.peek!)}>{s.label}</button>
            : <span>{s.label}</span>}
        </li>
      ))}
    </ol>
  );
}

/** "Ekipler ne kadar benzer": the latest round's pairs; a pair over the gate says so in orange. */
function Distance({ run, rounds }: { run: RunView; rounds: RoundRecord[] }) {
  const { t, locale } = useI18n();
  const last = [...rounds].reverse().find((r) => r.pairs.length);
  const name = (id: string) => run.teams.find((x) => x.id === id)?.name ?? id;
  const gate = Math.round((last?.gate ?? 0.6) * 100);
  const pairs = last ? [...last.pairs].sort((a, b) => b.score - a.score) : [];
  return (
    <section className="hk-box">
      <h3 className="hk-label">{t('hk.distance')}</h3>
      {pairs.length ? (
        <ul className="hk-sims">
          {pairs.map((p) => {
            const over = p.score > (last?.gate ?? 1);
            return (
              <li key={`${p.a}-${p.b}`} className="hk-sim" data-over={over ? 'true' : undefined}>
                {run.teams.length > 2 && <span className="hk-quiet">{fill(t('hk.distance.pair'), { a: name(p.a), b: name(p.b) })}</span>}
                <strong>{fill(t(over ? 'hk.distance.close' : 'hk.distance.apart'), { pct: pct(p.score, locale) })}</strong>
              </li>
            );
          })}
        </ul>
      ) : <p className="hk-quiet">{t('hk.distance.none')}</p>}
      <p className="hk-small">{fill(t('hk.distance.rule'), { gate: pct(gate / 100, locale) })}</p>
    </section>
  );
}
