import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import type { CloneStatus } from '../../hooks/useLauncher';
import { sizeLabel } from './handoffPlan';

interface Props {
  name: string;
  /** Where it lands, home shortened. */
  into: string;
  status: CloneStatus | null;
  /** Apple's installer is running (the clone waits for it). */
  gitInstalling: boolean;
  /** How the Git install ended without Git, when it did. */
  gitMissing?: 'download-failed' | 'closed';
  onCancel: () => void;
  onRetry: (shallow: boolean) => void;
  onInstallGit: () => void;
  onPickAnother: () => void;
}

/**
 * One clone, start to end (plan ilk-acilis v2-02g 4-4h, C10): the real percent from git's own
 * lines (never a made-up number), the steps, and each way it can end with the one thing to do
 * next. A big repository and a clone that ran out of time offer "Get the latest version only".
 */
export function CloneProgress({ name, into, status, gitInstalling, gitMissing, onCancel, onRetry, onInstallGit, onPickAnother }: Props) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const phase = status?.progress.phase ?? 'receiving';
  const sizeBytes = status?.sizeKb !== undefined ? status.sizeKb * 1024 : null;
  const big = sizeBytes !== null && sizeBytes > 1e9;

  if (status?.state === 'error') {
    const reason = status.reason ?? 'unknown';
    let title = t('clone.fail.title').replace('{name}', name);
    let body = status.error ?? '';
    let extra: string | null = null;
    let primary: { label: string; act: () => void } = { label: t('onboarding.gate.tryAgain'), act: () => onRetry(false) };
    if (reason === 'network') { body = t('clone.fail.network'); extra = t('clone.fail.networkBody'); }
    else if (reason === 'no-space' && status.space) {
      body = t('clone.fail.space');
      extra = t('clone.fail.spaceBody').replace('{name}', name).replace('{need}', sizeLabel(status.space.neededBytes)).replace('{free}', sizeLabel(status.space.freeBytes));
    } else if (reason === 'timeout') {
      body = t('clone.fail.timeout');
      extra = t('clone.fail.timeoutBody');
      primary = { label: t('clone.fail.shallow'), act: () => onRetry(true) };
    } else if (reason === 'git-missing') {
      if (gitMissing === 'download-failed') { title = t('clone.git.downloadFailed'); body = t('clone.git.downloadFailedBody'); }
      else { title = t('clone.git.needed'); body = t('clone.git.closed'); primary = { label: t('clone.git.install'), act: onInstallGit }; }
    }
    return (
      <div className="ob-card ob-clone" data-testid={`clone-failed-${reason}`}>
        <p className="ob-clone-title">{title}</p>
        <p className="ob-gate-body">{body}</p>
        {extra && <p className="ob-hint">{extra}</p>}
        <div className="ob-gate-actions">
          <button type="button" className="ob-btn ob-btn--primary" onClick={primary.act}>{primary.label}</button>
          <button type="button" className="ob-btn ob-btn--secondary" onClick={onPickAnother}>{t('clone.fail.pickAnother')}</button>
          {status.tail && <button type="button" className="ob-link" onClick={() => setDetails((d) => !d)}>{t('onboarding.gate.details')}</button>}
        </div>
        {details && status.tail && <pre className="ob-gate-details">{status.tail}</pre>}
      </div>
    );
  }

  const waitingGit = phase === 'waiting-git';
  const percent = status?.progress.percent;
  const received = status?.progress.receivedBytes;
  const steps: { key: string; label: string; state: 'done' | 'now' | 'todo' }[] = [
    ...(waitingGit || gitInstalling ? [{ key: 'git', label: t('clone.step.git'), state: waitingGit ? 'now' as const : 'done' as const }] : []),
    { key: 'download', label: t('clone.step.download').replace('{name}', name), state: waitingGit ? 'todo' : phase === 'receiving' ? 'now' : 'done' },
    { key: 'unpack', label: t('clone.step.unpack'), state: phase === 'resolving' || phase === 'checkout' ? 'now' : phase === 'done' ? 'done' : 'todo' },
    { key: 'chat', label: t('clone.step.chat'), state: phase === 'done' ? 'now' : 'todo' },
  ];

  return (
    <div className="ob-card ob-clone" data-testid={waitingGit ? 'clone-waiting-git' : 'clone-running'}>
      <p className="ob-clone-title">{waitingGit ? t('clone.git.waiting') : t('clone.run.title').replace('{name}', name)}</p>
      <p className="ob-hint ob-path">{t('clone.run.into').replace('{path}', into)}</p>
      {waitingGit ? (
        <p className="ob-gitline"><span className="ob-live-dot" aria-hidden="true" /> {t('clone.git.installingWait')}</p>
      ) : (
        <>
          <div className={`ob-bar${percent === undefined ? ' ob-bar--ind' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <i style={percent !== undefined ? { width: `${percent}%` } : undefined} />
          </div>
          <p className="ob-clone-line">
            <span>{percent !== undefined ? t('clone.run.downloading').replace('{n}', String(percent)) : t('clone.run.starting')}</span>
            {received !== undefined && <span className="ob-hint">{t('clone.run.received').replace('{size}', sizeLabel(received))}</span>}
          </p>
        </>
      )}
      {sizeBytes !== null && <p className="ob-hint">{t('clone.run.size').replace('{size}', sizeLabel(sizeBytes))}</p>}
      {big && !waitingGit && <p className="ob-hint">{t('clone.run.big')}</p>}
      <ol className="ob-clone-steps">
        {steps.map((s) => <li key={s.key} className={`ob-clone-step ob-clone-step--${s.state}`}>{s.label}</li>)}
      </ol>
      <div className="ob-gate-actions">
        {status?.offerShallow && !waitingGit && (
          <button type="button" className="ob-btn ob-btn--secondary" onClick={() => { onCancel(); onRetry(true); }}>{t('clone.fail.shallow')}</button>
        )}
        <button type="button" className="ob-btn ob-btn--secondary" onClick={onCancel} data-testid="clone-cancel">
          {waitingGit ? t('clone.git.stopWaiting') : t('onboarding.gate.cancel')}
        </button>
      </div>
      {!waitingGit && <p className="ob-hint">{t('clone.run.cancelNote')}</p>}
    </div>
  );
}
