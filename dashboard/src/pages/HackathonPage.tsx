import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi, useVault } from '../context/VaultContext';
import { useI18n } from '../context/I18nContext';
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
  clock, fill, minutesLeft, pct, useFrames, useResult, useRounds, useRun, useRuns,
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
      {open ? <RunScreen id={open} onBack={() => setOpen(null)} /> : <RunList onOpen={setOpen} />}
    </div>
  );
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
    return <TeamRoom run={id} team={teamOf(view.team)!} frame={frameOf(view.team)} round={run.round} rounds={run.rounds} onBack={() => setView({ kind: 'main' })} />;
  }
  if (view.kind === 'peek') {
    const rec = rounds?.rounds.find((r) => r.round === view.round);
    if (rec) return <Peek rec={rec} teams={run.teams} controlTeam={run.controlTeam} onBack={() => setView({ kind: 'main' })} />;
  }
  if (view.kind === 'present' && teamOf(view.team)) {
    const order = result?.jury?.ranking.length ? result.jury.ranking : run.teams.map((x) => x.id);
    const at = order.indexOf(view.team);
    const next = order.length > 1 ? teamOf(order[(at + 1) % order.length]!) ?? null : null;
    return (
      <Presentation
        key={view.team} run={id} team={teamOf(view.team)!} error={err}
        place={result?.jury?.ranking.length ? at + 1 : null} score={result?.jury?.scores[view.team] ?? null}
        nextTeam={next} canPick={canPick} picking={picking === view.team}
        onPick={() => void pick(view.team)} onNext={() => next && setView({ kind: 'present', team: next.id })}
        onBack={() => setView({ kind: 'main' })}
      />
    );
  }

  return (
    <div className="hk-run-screen">
      <RunHeader run={run} onBack={onBack} busy={busy} onStop={() => void act('stop', false)} />
      {run.conductor === 'gone' && (
        <div className="hk-paused hk-paused--conductor" role="status">
          <span>{t('hk.conductor.gone')}</span>
          <button type="button" className="hk-btn hk-btn--primary" disabled={busy === 'relaunch'} onClick={() => void act('relaunch', true)}>{t('hk.conductor.relaunch')}</button>
        </div>
      )}
      <Timeline run={run} rounds={rounds?.rounds ?? []} onPeek={(round) => setView({ kind: 'peek', round })} />
      {run.paused && run.state === 'running' && run.conductor !== 'gone' && (
        <div className="hk-paused" role="status">
          <span>{fill(t('hk.paused'), { reason: run.paused })}</span>
          <button type="button" className="hk-btn hk-btn--primary" disabled={busy === 'resume'} onClick={() => void act('resume', true)}>{t('hk.resume')}</button>
        </div>
      )}
      {err && <p className="hk-error" role="alert">{err}</p>}

      {(run.state === 'awaiting-owner' || run.state === 'draft') && <StartCard run={id} onStarted={() => void refresh()} />}

      {(run.state === 'running' || run.state === 'presenting') && (
        <div className="hk-live">
          <div className="hk-live__tables">
            {run.state === 'presenting' && <p className="hk-note hk-live__wide">{t('hk.presenting')}</p>}
            {run.teams.map((tm) => (
              <TeamTable key={tm.id} run={id} team={tm} frame={frameOf(tm.id)} control={tm.id === run.controlTeam} onOpen={() => setView({ kind: 'room', team: tm.id })} />
            ))}
          </div>
          <aside className="hk-live__side">
            <Distance run={run} rounds={rounds?.rounds ?? []} />
            <section className="hk-panel">
              <h3 className="hk-section">{t('hk.moments')}</h3>
              {run.strip.moments.length ? (
                <ul className="hk-moments">
                  {[...run.strip.moments].reverse().map((m, i) => (
                    <li key={`${m.at}-${i}`}><span className="hk-muted hk-mono">{clock(m.at)}</span><span>{m.text}</span></li>
                  ))}
                </ul>
              ) : <p className="hk-muted">{t('hk.noMoments')}</p>}
            </section>
          </aside>
        </div>
      )}

      {ended && view.kind === 'pr' && <PrConfirm run={id} team={teamOf(result?.result?.pick ?? '')} onClose={() => setView({ kind: 'main' })} />}
      {ended && view.kind !== 'pr' && (
        <Results
          run={id} teams={run.teams} controlTeam={run.controlTeam} data={result}
          canPick={canPick} picking={picking} pickError={null}
          onOpen={(team) => setView({ kind: 'present', team })} onPick={(team) => void pick(team)} onApply={() => setView({ kind: 'pr' })}
        />
      )}
    </div>
  );
}

function RunHeader({ run, onBack, busy, onStop }: { run: RunView; onBack: () => void; busy: string | null; onStop: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const s = run.strip;
  // Judging spends nothing and waits for the pick: no clock, and no Stop beside the Pick buttons.
  const running = run.state === 'running' || run.state === 'presenting';
  const stoppable = running || run.state === 'awaiting-owner' || run.state === 'draft';
  const share = s.used != null ? Math.min(100, Math.round((s.used / Math.max(1, s.ceiling)) * 100)) : null;
  const stateChip = run.state === 'running' && run.round != null ? fill(t('hk.round'), { n: run.round, of: run.rounds }) : t(`hk.state.${run.state}`);
  return (
    <header className="hk-head hk-head--wrap">
      <button type="button" className="hk-back" onClick={onBack}>‹ {t('hk.back')}</button>
      <h2 className="hk-head__title">{run.problem}</h2>
      <span className="hk-chip" data-state={run.state}>{stateChip}</span>
      <span className="hk-head__grow" />
      {running && (
        <span className="hk-meters">
          <span className="hk-meter">
            <span>{fill(t('hk.meter.end'), { end: clock(s.endsAt), left: minutesLeft(s.endsAt) })}</span>
          </span>
          <span className="hk-meter">
            <span>{s.reading}</span>
            {share != null && <span className="hk-meter__track" aria-hidden="true"><span className="hk-meter__fill" style={{ width: `${share}%` }} /></span>}
          </span>
        </span>
      )}
      {stoppable && !confirming && (
        <button type="button" className="hk-btn" disabled={busy === 'stop'} onClick={() => setConfirming(true)}>{t('hk.stop')}</button>
      )}
      {stoppable && confirming && (
        <span className="hk-confirm" role="group" aria-label={t('hk.stop')}>
          <span>{running ? t('hk.stop.confirmRunning') : t('hk.stop.confirmDraft')}</span>
          <button type="button" className="hk-btn hk-btn--danger" disabled={busy === 'stop'} onClick={() => { setConfirming(false); onStop(); }}>{t('hk.stop.yes')}</button>
          <button type="button" className="hk-btn" onClick={() => setConfirming(false)}>{t('hk.stop.no')}</button>
        </span>
      )}
    </header>
  );
}

/** The run's path: started, each round (with its peek when it opens), presentations, jury. */
function Timeline({ run, rounds, onPeek }: { run: RunView; rounds: RoundRecord[]; onPeek: (round: number) => void }) {
  const { t } = useI18n();
  if (run.state === 'draft' || run.state === 'awaiting-owner') return null;
  const order: RunState[] = ['running', 'presenting', 'judging', 'picked'];
  const at = run.state === 'stopped' ? -1 : order.indexOf(run.state);
  const steps: { key: string; label: string; done: boolean; now: boolean; peek?: number }[] = [];
  for (let r = 1; r <= run.rounds; r++) {
    const done = at > 0 || (run.round ?? 0) > r || rounds.some((x) => x.round === r);
    steps.push({ key: `r${r}`, label: fill(t('hk.step.round'), { n: r }), done, now: run.state === 'running' && run.round === r });
    const rec = rounds.find((x) => x.round === r);
    if (r + 1 > 1 && r + 1 < run.rounds) steps.push({ key: `p${r}`, label: fill(t('hk.step.peek'), { n: r }), done: !!rec, now: false, peek: rec ? r : undefined });
  }
  steps.push({ key: 'present', label: t('hk.step.present'), done: at > 1, now: at === 1 });
  steps.push({ key: 'jury', label: t('hk.step.jury'), done: at > 2, now: at === 2 });
  return (
    <ol className="hk-steps">
      {steps.map((s) => (
        <li key={s.key} className="hk-step" data-done={s.done ? 'true' : undefined} data-now={s.now ? 'true' : undefined}>
          {s.peek != null
            ? <button type="button" className="hk-step__btn" onClick={() => onPeek(s.peek!)}>{s.label}</button>
            : <span>{s.label}</span>}
        </li>
      ))}
    </ol>
  );
}

/** "How similar the teams are": the latest round's pair scores (lower is better). */
function Distance({ run, rounds }: { run: RunView; rounds: RoundRecord[] }) {
  const { t, locale } = useI18n();
  const last = [...rounds].reverse().find((r) => r.pairs.length);
  const name = (id: string) => run.teams.find((x) => x.id === id)?.name ?? id;
  return (
    <section className="hk-panel">
      <h3 className="hk-section">{t('hk.distance')} <span className="hk-muted">{t('hk.distance.hint')}</span></h3>
      {last ? (
        <ul className="hk-bars">
          {last.pairs.map((p) => (
            <li key={`${p.a}-${p.b}`} className="hk-bar" data-over={p.score > last.gate ? 'true' : undefined}>
              <span>{name(p.a)} · {name(p.b)}</span>
              <span className="hk-bar__track"><span className="hk-bar__fill" style={{ width: `${Math.round(p.score * 100)}%` }} /></span>
              <span className="hk-bar__num">{pct(p.score, locale)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="hk-muted">{t('hk.distance.none')}</p>}
      <p className="hk-muted">{fill(t('hk.peek.gateRule'), { gate: Math.round((last?.gate ?? 0.6) * 100) })}</p>
    </section>
  );
}
