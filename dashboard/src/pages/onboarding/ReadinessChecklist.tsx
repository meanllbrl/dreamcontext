import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  checkForFix,
  useFixRuns,
  useReadiness,
  useSetEverythingUp,
  type FixRunState,
} from '../../hooks/useOnboarding';
import {
  isBackgroundWait,
  type CheckScope,
  type FixId,
  type ReadinessCheck,
  type ReadinessReport,
} from '../../lib/onboardingTypes';
import { CheckRow, rowWait } from './CheckRow';
import './ReadinessChecklist.css';

/**
 * The readiness checklist: what this Mac (or, in a project, what Claude) still needs, and one
 * button that sets all of it up.
 *
 * `scope="machine"` is the Launcher's This Mac step: a Required group and a quiet Recommended
 * group, driven by the server's `report.plan` through `useSetEverythingUp`. `scope="agent"` is
 * the project window's setup panel: Claude, its sign-in and the built-in terminal, run in order
 * by this component so a project panel never starts machine-wide work it did not show.
 *
 * Contract (pinned for the flow container and the agent surface):
 *   <ReadinessChecklist scope onReady? showSkip? onBusyChange? />
 * `onReady` fires once each time the scope becomes ready with nothing left to wait for.
 * `onBusyChange(busy)` fires once on mount and then whenever `busy` changes. Busy means
 * "Set everything up" is running OR a sign-in card (browser or device code) is waiting on the
 * person. The background developer-tools install alone is not busy. The root carries the same
 * value as `aria-busy`.
 */

interface Props {
  scope: CheckScope;
  onReady?: () => void;
  /** Offer "Skip" on rows that are not required. Default true. */
  showSkip?: boolean;
  /** Busy changed (and once on mount): the sequence is running or a sign-in card waits. */
  onBusyChange?: (busy: boolean) => void;
}

/** The rows a scope shows. The network is a banner, and the package manager only when it fails. */
export function visibleChecks(checks: ReadinessCheck[]): ReadinessCheck[] {
  return checks.filter((c) => c.id !== 'network' && !(c.id === 'npm' && c.status === 'ok'));
}

function settled(c: ReadinessCheck): boolean {
  return c.status === 'ok' || c.status === 'unknown';
}

/** Fixes the agent panel runs, in plan order, then any optional in-scope fix still open. */
function agentFixes(report: ReadinessReport, checks: ReadinessCheck[], skipped: ReadonlySet<FixId>): FixId[] {
  const inScope = new Set(checks.map((c) => c.fix?.id).filter((f): f is FixId => !!f));
  const planned = report.plan.filter((f) => inScope.has(f));
  const extra = checks
    .filter((c) => !settled(c) && c.status !== 'blocked' && c.fix?.runnable && c.fix.kind !== 'manual')
    .map((c) => c.fix!.id)
    .filter((f) => !planned.includes(f));
  return [...planned, ...extra].filter((f) => !skipped.has(f));
}

/**
 * Plan entries for this scope that are still to run (not skipped, not a background wait).
 *
 * A background wait only lets the step move on when "Set everything up" started it. One the
 * person started from its own row (`byHand`) keeps the step open: they just clicked Install Git,
 * and the "A macOS window opened" card is the answer to that click, not something to whisk away.
 * Continue is on screen meanwhile, and the step still moves on by itself when Git lands.
 */
function openPlan(
  report: ReadinessReport,
  checks: ReadinessCheck[],
  skipped: ReadonlySet<FixId>,
  runs: Partial<Record<FixId, FixRunState>>,
  byHand: ReadonlySet<FixId>,
): FixId[] {
  const inScope = new Set(checks.map((c) => c.fix?.id).filter((f): f is FixId => !!f));
  return report.plan.filter((f) => {
    if (!inScope.has(f) || skipped.has(f)) return false;
    const plan = checkForFix(report, f)?.fix;
    if (plan && !plan.runnable) return false;
    if (isBackgroundWait(plan?.kind) && !byHand.has(f) && (report.activeFixes.includes(f) || rowWait(runs[f]) === 'dialog')) return false;
    return runs[f]?.phase !== 'error';
  });
}

export function ReadinessChecklist({ scope, onReady, showSkip = true, onBusyChange }: Props) {
  const { t } = useI18n();
  const { report, checks, isLoading, error, refresh } = useReadiness(scope);
  const fixRuns = useFixRuns();
  const setup = useSetEverythingUp(fixRuns, refresh);
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentCurrent, setAgentCurrent] = useState<FixId | null>(null);
  const { runs, start, cancel } = fixRuns;

  const rows = useMemo(() => visibleChecks(checks), [checks]);
  const required = rows.filter((c) => c.tier === 'required');
  const recommended = rows.filter((c) => c.tier !== 'required');
  const surface = report?.surface ?? 'desktop';
  const running = scope === 'machine' ? setup.running : agentRunning;
  // The fix the sequence is on right now. While "Set everything up" runs, every other row's
  // buttons are locked so a click can never start a second, competing fix.
  const activeFix = scope === 'machine' ? setup.current : agentCurrent;

  const [byHand, setByHand] = useState<ReadonlySet<FixId>>(() => new Set());
  const startFix = useCallback(
    (fix: FixId) => {
      if (running && fix !== activeFix) return;
      const kind = checkForFix(report, fix)?.fix?.kind;
      if (!running) setByHand((prev) => (prev.has(fix) ? prev : new Set(prev).add(fix)));
      void start(fix, { settleOnBackgroundWait: kind === 'system-dialog' });
    },
    [report, start, running, activeFix],
  );

  // Set on unmount. The agent panel unmounts as soon as a chat opens or `onReady` switches the
  // surface to tabs, and the sequence must not go on starting fixes nobody can see.
  const agentStopRef = useRef(false);
  useEffect(() => {
    agentStopRef.current = false;
    return () => { agentStopRef.current = true; };
  }, []);

  const runAgentScope = useCallback(async () => {
    if (!report || agentRunning) return;
    setAgentRunning(true);
    const tried = new Set<FixId>();
    try {
      for (;;) {
        if (agentStopRef.current) break;
        const fresh = await refresh();
        if (agentStopRef.current) break;
        const next = agentFixes(fresh, checks, setup.skipped).find((f) => !tried.has(f));
        if (!next) break;
        tried.add(next);
        setAgentCurrent(next);
        const result = await start(next);
        // A run that did not settle (done or error) was abandoned, e.g. on unmount: stop here.
        if (agentStopRef.current || (result.phase !== 'done' && result.phase !== 'error')) break;
      }
    } catch {
      /* the report could not be read: each row shows its own state */
    } finally {
      if (!agentStopRef.current) {
        setAgentCurrent(null);
        setAgentRunning(false);
      }
    }
  }, [report, agentRunning, refresh, checks, setup.skipped, start]);

  // One browser or device-code card at a time: the first row (in list order) that waits on the
  // person owns it; any other waiting row says "Waiting for you" until its turn.
  const cardOwner = useMemo(() => {
    const owner = rows.find((c) => {
      const w = rowWait(c.fix ? runs[c.fix.id] : undefined);
      return w === 'browser' || w === 'device-code';
    });
    return owner?.id ?? null;
  }, [rows, runs]);

  const ghCheck = report?.checks.find((c) => c.id === 'gh');
  const ghInstalled = !!ghCheck && ghCheck.status !== 'missing' && ghCheck.status !== 'blocked';
  const ghSignedIn = ghCheck?.status === 'ok';

  // What "Set everything up" would still run here. The agent panel also offers its optional
  // built-in terminal, which the server plan leaves out; it never holds up `onReady`.
  const openFixes: FixId[] = !report
    ? []
    : scope === 'machine'
      ? openPlan(report, checks, setup.skipped, runs, byHand)
      : agentFixes(report, checks, setup.skipped).filter((f) => !runs[f]);
  const scopeReady = !!report && rows.filter((c) => c.tier === 'required').every(settled);
  const nothingOpen = scope === 'agent' || openFixes.length === 0;
  const readyNow = scopeReady && nothingOpen && !running && cardOwner === null;

  // Busy, for the container: never derived from markup or copy, which may change.
  const busy = running || cardOwner !== null;
  const lastBusy = useRef<boolean | null>(null);
  useEffect(() => {
    if (lastBusy.current === busy) return;
    lastBusy.current = busy;
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const firedReady = useRef(false);
  useEffect(() => {
    if (!readyNow) {
      firedReady.current = false;
      return;
    }
    if (firedReady.current) return;
    firedReady.current = true;
    onReady?.();
  }, [readyNow, onReady]);

  if (isLoading && !report) {
    return (
      <div className="ob-checklist" data-no-drag aria-busy={busy}>
        <p className="ob-status" role="status">
          <span className="ob-live-dot" aria-hidden="true" />
          {t('onboarding.checklist.loading')}
        </p>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="ob-checklist" data-no-drag aria-busy={busy}>
        <p className="ob-status ob-status--failed" role="alert">
          {error ? t('onboarding.checklist.loadFailed') : t('onboarding.checklist.loading')}
        </p>
        <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void refresh().catch(() => undefined)}>
          {t('onboarding.checklist.retry')}
        </button>
      </div>
    );
  }

  const openCount = openFixes.length;
  const canRunAll = surface === 'desktop' && report.online && !running && openCount > 0;

  function renderRow(c: ReadinessCheck) {
    const fix = c.fix?.id;
    return (
      <CheckRow
        key={c.id}
        check={c}
        run={fix ? runs[fix] : undefined}
        surface={surface}
        ownsWaitingCard={cardOwner === c.id}
        skipped={!!fix && setup.skipped.has(fix)}
        locked={running && fix !== activeFix}
        canSkip={showSkip && c.tier !== 'required' && !!fix && surface === 'desktop'}
        githubFromGh={c.id === 'github' && ghSignedIn}
        showScopesNote={c.id === 'gh' || (c.id === 'github' && ghInstalled && !ghSignedIn)}
        onFix={() => { if (fix) startFix(fix); }}
        onCancel={() => { if (fix) void cancel(fix); }}
        onSkip={() => { if (fix) setup.skip(fix, report); }}
      />
    );
  }

  return (
    <div className={`ob-checklist ob-checklist--${scope}`} data-no-drag aria-busy={busy}>
      {scope === 'agent' && (
        <header className="ob-checklist-head">
          <h2 className="ob-checklist-title">{t('onboarding.agent.title')}</h2>
          <p className="ob-checklist-subtitle">{t('onboarding.agent.subtitle')}</p>
        </header>
      )}

      {!report.online && (
        <p className="ob-banner" role="status">{t('onboarding.checklist.offlineBanner')}</p>
      )}

      {scope === 'machine' ? (
        <>
          <section className="ob-group" aria-label={t('onboarding.checklist.required')}>
            <h3 className="ob-group-label">{t('onboarding.checklist.required')}</h3>
            <ul className="ob-rows">{required.map(renderRow)}</ul>
          </section>
          {recommended.length > 0 && (
            <section className="ob-group ob-group--quiet" aria-label={t('onboarding.checklist.recommended')}>
              <h3 className="ob-group-label">{t('onboarding.checklist.recommended')}</h3>
              <ul className="ob-rows">{recommended.map(renderRow)}</ul>
            </section>
          )}
        </>
      ) : (
        <ul className="ob-rows">{rows.map(renderRow)}</ul>
      )}

      {surface === 'desktop' && (openCount > 0 || running) && (
        <div className="ob-checklist-actions">
          <button
            type="button"
            className="ob-btn ob-btn--primary"
            disabled={!canRunAll}
            onClick={() => { if (scope === 'machine') void setup.run(); else void runAgentScope(); }}
          >
            {running ? t('onboarding.checklist.settingUp') : t('onboarding.checklist.setEverythingUp')}
          </button>
          {openCount > 0 && !running && (
            <span className="ob-checklist-left">{t('onboarding.checklist.left').replace('{n}', String(openCount))}</span>
          )}
        </div>
      )}
    </div>
  );
}
