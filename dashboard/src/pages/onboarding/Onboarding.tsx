import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { postFix, useReadiness, type GateAgent } from '../../hooks/useOnboarding';
import { emitStartIntent, isDesktop, openVaultWindow, type StartIntent } from '../../lib/desktop';
import { NewProjectLandContext } from '../../lib/uxMode';
import { BrandMark } from '../../components/brand/BrandMark';
import { ReadinessChecklist } from './ReadinessChecklist';
import { ProjectStep } from './ProjectStep';
import { Welcome } from './Welcome';
import { handoffAction, onboardingSteps, type OnboardingPurpose, type OnboardingStage } from './handoffPlan';
import './ReadinessChecklist.css';
import './Onboarding.css';

export type { OnboardingPurpose } from './handoffPlan';

interface Props {
  /**
   * What this is to the person (C1). `first-run`: the app has no project; Welcome, then the
   * project, then the landing. `new-project`: "+ Add Project"; the project, then the landing;
   * Cancel and Esc go back. `setup` (the "Finish setting up" bar): the Mac checklist.
   */
  purpose?: OnboardingPurpose;
  /** Skip or Cancel: leave, nothing opened. */
  onClose: () => void;
  /** A project was opened or made and its window is on its way: close onboarding. */
  onLanded: (vaultName: string) => void;
}

/** One silent Claude install per app run (C3), whichever onboarding mounted first. */
let silentInstallStarted = false;

/**
 * The first open as a full-window takeover (plan ilk-acilis): Welcome ("Continue with Claude"),
 * then "Open a project", then straight into the project's Super screen. The "This Mac" list is
 * only the "Finish setting up" bar's screen; nothing on the way to a first project shows it, a
 * step dot or an "is ready" screen.
 */
export function Onboarding({ purpose = 'setup', onClose, onLanded }: Props) {
  const { t } = useI18n();
  const { report } = useReadiness('machine');
  const steps = onboardingSteps(purpose);
  const [stage, setStage] = useState<OnboardingStage>(steps[0]);
  /** The agent the welcome got ready; Claude when the welcome was skipped (Add Project). */
  const [agent, setAgent] = useState<GateAgent>('claude');
  const [notice, setNotice] = useState<string | null>(null);
  const landHere = useContext(NewProjectLandContext);
  const claudeAccount = report?.checks.find((c) => c.id === 'claude-auth' && c.status === 'ok')?.account;

  // C3: the only required piece starts installing the moment the first-run screen opens
  // (desktop, macOS, Claude missing, online). Never another fix; the guarded route refuses a
  // second run and "Continue with Claude" attaches to this one.
  useEffect(() => {
    if (purpose !== 'first-run' || silentInstallStarted || !report || !isDesktop()) return;
    if (report.platform !== 'darwin' || report.online === false) return;
    const claude = report.checks.find((c) => c.id === 'claude');
    if (!claude || claude.status === 'ok' || claude.status === 'unknown') return;
    if (claude.status === 'needs-action' && claude.reason === 'not-on-path') return;
    if (report.activeFixes.includes('claude-install')) return;
    silentInstallStarted = true;
    void postFix('claude-install');
  }, [purpose, report]);

  const task = purpose === 'new-project';
  /** The project is being made on the server: leaving now would strand it, unopened. */
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const handleCreating = useCallback((busy: boolean) => { creatingRef.current = busy; setCreating(busy); }, []);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!task) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || creatingRef.current) return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task]);

  /**
   * C8: open the project on its Super stage. The `super-landing` intent rides on whichever path
   * opens it (this window, a new window's URL, or a broadcast to the window that already holds
   * it); the surface turns the Super on quietly. A Codex or Antigravity pick opens today's panes.
   */
  const land = useCallback(async (name: string) => {
    setNotice(null);
    const start: StartIntent | undefined = agent === 'claude' ? 'super-landing' : undefined;
    try {
      if (landHere) {
        landHere(name, start ?? 'existing');
        onLanded(name);
        return;
      }
      const result = await openVaultWindow(name, undefined, start ? { start } : {});
      if (start && handoffAction(result) === 'emit-start-intent' && !(await emitStartIntent(name, start))) {
        setNotice(t('onboarding.startIntent.refused'));
        return;
      }
      onLanded(name);
    } catch {
      setNotice(t('onboarding.startIntent.refused'));
    }
  }, [agent, landHere, onLanded, t]);

  function body() {
    if (stage === 'welcome') {
      return <Welcome report={report} onReady={(a) => { setAgent(a); setStage('project'); }} />;
    }
    if (stage === 'machine') {
      return (
        <div className="ob-panel-body">
          <header className="ob-head">
            <h2 className="ob-title">{t('onboarding.machine.title')}</h2>
            <p className="ob-subtitle">{t('onboarding.machine.subtitle')}</p>
          </header>
          <ReadinessChecklist scope="machine" />
        </div>
      );
    }
    return (
      <>
        <ProjectStep report={report} onBusyChange={handleCreating} onLand={(name) => void land(name)} />
        {notice && <p className="ob-notice" role="status">{notice}</p>}
      </>
    );
  }

  return (
    <section className="ob" aria-label={t('onboarding.stepsLabel')}>
      <header className="ob-top">
        {stage === 'project' ? (
          <span className="ob-top-brand"><BrandMark size={18} /><span className="ob-welcome-word ob-top-word">dream<span>context</span></span></span>
        ) : <span aria-hidden="true" />}
        {stage === 'project' && agent === 'claude' && claudeAccount && (
          <span className="ob-top-signed" data-testid="ob-signed-in">
            <span className="ob-top-signed-dot" aria-hidden="true">✓</span>
            {t('onboarding.open.signedIn')} · {claudeAccount}
          </span>
        )}
        {purpose !== 'first-run' && (
          <button type="button" className="ob-btn ob-btn--ghost ob-skip" data-no-drag disabled={creating}
            onClick={() => { if (!creatingRef.current) onClose(); }}>
            {task ? t('onboarding.cancel') : t('onboarding.skip')}
          </button>
        )}
      </header>
      <div className="ob-panel" data-no-drag key={stage}>
        {body()}
      </div>
    </section>
  );
}
