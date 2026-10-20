import { useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { copyPreservingUnicode } from '../../lib/clipboard';
import type { FixRunState } from '../../hooks/useOnboarding';
import type { ReadinessCheck, Surface } from '../../lib/onboardingTypes';
import { StatusGlyph, type GlyphMode } from './StatusGlyph';
import { WaitingCard, type WaitingVariant } from './WaitingCard';

/**
 * One row of the readiness checklist: glyph, title, why, then EITHER a state line OR one
 * secondary action, an optional progress rail, an inline waiting card, and "Show details" for
 * the run's output tail. The row never names a tool in its copy; the command a person could run
 * instead only appears as the manual line.
 */

/** What the person is being waited on for, if anything. `dialog` never blocks other rows. */
export type RowWait = 'browser' | 'device-code' | 'dialog' | null;

const BYTES_PER_MB = 1024 * 1024;
const TAIL_LINES = 12;

export function rowWait(run: FixRunState | undefined): RowWait {
  const s = run?.status;
  if (!run || run.phase !== 'running' || !s) return null;
  if (s.deviceCode) return 'device-code';
  if (s.awaiting === 'browser') return 'browser';
  if (s.awaiting === 'system-dialog') return 'dialog';
  return null;
}

export function rowMode(check: ReadinessCheck, run: FixRunState | undefined): GlyphMode {
  if (check.status === 'ok') return 'done';
  if (run?.phase === 'starting' || run?.phase === 'running') {
    const wait = rowWait(run);
    return wait === 'browser' || wait === 'device-code' ? 'needs-you' : 'working';
  }
  if (run?.phase === 'error') return 'failed';
  if (check.status === 'blocked') return 'blocked';
  return 'todo';
}

function mb(bytes: number): string {
  return (bytes / BYTES_PER_MB).toFixed(1);
}

interface Props {
  check: ReadinessCheck;
  run: FixRunState | undefined;
  surface: Surface;
  /** This row holds the one browser or device-code card on screen. */
  ownsWaitingCard: boolean;
  skipped: boolean;
  /** "Set everything up" is running on another row: this row's buttons are disabled. */
  locked: boolean;
  canSkip: boolean;
  /** Use the GitHub command line tool's existing sign-in wording for the GitHub row. */
  githubFromGh: boolean;
  /** Show the GitHub scopes note under the action. */
  showScopesNote: boolean;
  onFix: () => void;
  onCancel: () => void;
  onSkip: () => void;
}

export function CheckRow({
  check, run, surface, ownsWaitingCard, skipped, locked, canSkip, githubFromGh, showScopesNote, onFix, onCancel, onSkip,
}: Props) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const mode = rowMode(check, run);
  // The drawn check plays only for a row that resolves while it is on screen, never for one
  // that was already done when the list appeared.
  const doneAtMount = useRef(mode === 'done');
  const fix = check.fix;
  const wait = rowWait(run);
  const fixKey = fix ? `onboarding.fix.${fix.id}` : '';

  const title = t(`onboarding.check.${check.id}.title`);
  const why = t(`onboarding.check.${check.id}.why`);
  const details = run?.status?.output?.trim() || run?.startError?.message || '';
  const tail = details.split('\n').slice(-TAIL_LINES).join('\n');
  const progress = run?.status?.progress;
  const working = mode === 'working' || mode === 'needs-you';

  async function copyManual(command: string) {
    if (await copyPreservingUnicode(command)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  function stateLine(): string {
    if (mode === 'done') return check.account ?? check.version ?? t('onboarding.checklist.ready');
    if (skipped) return t('onboarding.checklist.skippedRow');
    if (wait === 'dialog') return t('onboarding.fix.git-install.waiting');
    if (wait === 'browser' || wait === 'device-code') return t('onboarding.wait.waiting');
    if (working && fix) return t(`${fixKey}.working`);
    if (mode === 'failed') return t('onboarding.checklist.failed');
    if (mode === 'blocked') {
      const deps = (check.blockedBy ?? []).map((d) => t(`onboarding.check.${d}.title`)).join(', ');
      return t('onboarding.checklist.blocked').replace('{deps}', deps);
    }
    return check.reason ? t(`onboarding.reason.${check.reason}`) : '';
  }

  const canRunHere = surface === 'desktop' && !!fix && fix.runnable && fix.kind !== 'manual';
  const showAction = canRunHere && !skipped && (mode === 'todo' || mode === 'failed');
  const manual = fix?.manual;
  const showManual = surface === 'desktop' && mode !== 'done' && !!manual && !canRunHere;
  const actionLabel = mode === 'failed'
    ? t('onboarding.checklist.retry')
    : check.id === 'github' && githubFromGh
      ? t('onboarding.fix.github-signin.actionFromGh')
      : t(`${fixKey}.action`);

  let waitingVariant: WaitingVariant | null = null;
  if (wait === 'dialog') waitingVariant = { kind: 'dialog' };
  else if (ownsWaitingCard && wait === 'device-code' && run?.status?.deviceCode) {
    waitingVariant = { kind: 'device-code', code: run.status.deviceCode };
  } else if (ownsWaitingCard && wait === 'browser') waitingVariant = { kind: 'browser' };

  return (
    <li className={`ob-row ob-row--${mode}${skipped ? ' ob-row--skipped' : ''}`}>
      <div className="ob-row-main">
        <StatusGlyph mode={mode} animate={mode === 'done' && !doneAtMount.current} />
        <div className="ob-row-text">
          <span className="ob-row-title">{title}</span>
          {mode !== 'done' && <span className="ob-row-why">{why}</span>}
        </div>
        <div className="ob-row-side">
          {showAction ? (
            <button type="button" className="ob-btn ob-btn--secondary" disabled={locked} onClick={onFix}>{actionLabel}</button>
          ) : (
            <span className={`ob-row-state${mode === 'failed' ? ' ob-row-state--failed' : ''}`}>{stateLine()}</span>
          )}
          {canSkip && !skipped && mode !== 'done' && (
            <button type="button" className="ob-btn ob-btn--ghost" disabled={locked} onClick={onSkip}>{t('onboarding.checklist.skipRow')}</button>
          )}
        </div>
      </div>

      {showAction && mode === 'failed' && <p className="ob-row-note ob-row-note--failed">{t('onboarding.checklist.failed')}</p>}
      {showAction && showScopesNote && fix && (fix.id === 'github-signin' || fix.id === 'gh-signin') && (
        <p className="ob-row-note">{t(`${fixKey}.scopesNote`)}</p>
      )}

      {working && progress && progress.total ? (
        <div className="ob-rail" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.received}>
          <span className="ob-rail-fill" style={{ transform: `scaleX(${Math.min(1, progress.received / progress.total)})` }} />
          <span className="ob-rail-label">
            {t('onboarding.checklist.progress').replace('{received}', mb(progress.received)).replace('{total}', mb(progress.total))}
          </span>
        </div>
      ) : working && wait === null ? (
        <div className="ob-rail ob-rail--indeterminate" aria-hidden="true"><span className="ob-rail-fill" /></div>
      ) : null}

      {waitingVariant && (
        <div className="ob-row-expand">
          <WaitingCard
            variant={waitingVariant}
            onCancel={waitingVariant.kind === 'dialog' ? undefined : onCancel}
            onOpenAgain={waitingVariant.kind === 'browser' ? onFix : undefined}
          />
        </div>
      )}

      {surface === 'browser' && mode !== 'done' && fix && (
        <p className="ob-row-note">{t('onboarding.checklist.browserMode')}</p>
      )}

      {showManual && manual && (
        <div className="ob-manual">
          <span className="ob-manual-hint">{t('onboarding.checklist.manualHint')}</span>
          <code className="ob-manual-code">{manual}</code>
          <button type="button" className="ob-btn ob-btn--ghost" onClick={() => void copyManual(manual)}>
            {copied ? t('onboarding.checklist.copied') : t('onboarding.checklist.copy')}
          </button>
        </div>
      )}

      {mode === 'failed' && tail && (
        <div className="ob-details">
          <button
            type="button"
            className="ob-link"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? t('onboarding.checklist.hideDetails') : t('onboarding.checklist.showDetails')}
          </button>
          {showDetails && <pre className="ob-details-tail">{tail}</pre>}
        </div>
      )}
    </li>
  );
}
