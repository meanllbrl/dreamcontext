import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAgentSettings } from '../../hooks/useOnboarding';
import { emitStartIntent, openVaultWindow } from '../../lib/desktop';
import type { ReadinessReport } from '../../lib/onboardingTypes';
import { GemConverge } from './GemConverge';
import { canStartClaude, handoffAction } from './handoffPlan';
import type { CreatedProject } from './ProjectStep';

interface Props {
  project: CreatedProject;
  report: ReadinessReport | undefined;
  /** The project window is open (or the start request reached it): close onboarding. */
  onDone: (vaultName: string) => void;
  /** Claude is not ready yet: go back to the This Mac step. */
  onFinishSetup: () => void;
}

/**
 * The last moment: the gem assembles, the project is named, and one filled button starts
 * Claude in it with the initializer. "Start with Claude" is offered only when the project
 * window's agent surface will actually take the request (`canStartClaude`); otherwise the
 * primary is "Open project" and a line points back at the checklist. A request that cannot be
 * delivered says so on screen, never a silent no-op.
 */
export function Handoff({ project, report, onDone, onFinishSetup }: Props) {
  const { t } = useI18n();
  const { settings } = useAgentSettings();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canStart = canStartClaude(report, settings);

  async function open(start: boolean) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await openVaultWindow(project.name, undefined, start ? { start: 'initializer' } : {});
      if (start && handoffAction(result) === 'emit-start-intent') {
        const delivered = await emitStartIntent(project.name, 'initializer');
        if (!delivered) {
          setNotice(t('onboarding.startIntent.refused'));
          return;
        }
      }
      onDone(project.name);
    } catch {
      setNotice(t('onboarding.handoff.openFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ob-panel-body ob-handoff">
      <GemConverge />
      <h2 className="ob-title">{t('onboarding.handoff.title').replace('{name}', project.name)}</h2>
      <p className="ob-subtitle">{t('onboarding.handoff.subtitle')}</p>
      {project.cli?.status === 'failed' && <p className="ob-hint">{t('onboarding.project.cliFailed')}</p>}
      {!canStart && (
        <p className="ob-hint">
          {t('onboarding.handoff.notReady')}{' '}
          <button type="button" className="ob-link" onClick={onFinishSetup}>
            {t('onboarding.handoff.finishSetup')}
          </button>
        </p>
      )}
      {notice && (
        <p className="ob-notice" role="status">
          {notice}{' '}
          <button type="button" className="ob-link" onClick={() => void open(false)}>
            {t('onboarding.handoff.open')}
          </button>
        </p>
      )}
      <div className="ob-actions ob-actions--center">
        {canStart ? (
          <>
            <button type="button" className="ob-btn ob-btn--secondary" onClick={() => void open(false)} disabled={busy}>
              {t('onboarding.handoff.open')}
            </button>
            <button type="button" className="ob-btn ob-btn--primary" onClick={() => void open(true)} disabled={busy}>
              {busy ? t('onboarding.handoff.opening') : t('onboarding.handoff.start')}
            </button>
          </>
        ) : (
          <button type="button" className="ob-btn ob-btn--primary" onClick={() => void open(false)} disabled={busy}>
            {busy ? t('onboarding.handoff.opening') : t('onboarding.handoff.open')}
          </button>
        )}
      </div>
    </div>
  );
}
