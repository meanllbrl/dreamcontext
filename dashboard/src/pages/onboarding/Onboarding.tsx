import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useReadiness } from '../../hooks/useOnboarding';
import { ReadinessChecklist } from './ReadinessChecklist';
import { StepDots } from './StepDots';
import { ProjectStep, type CreatedProject } from './ProjectStep';
import { Handoff } from './Handoff';
import { Welcome } from './Welcome';
import type { OnboardingStage } from './handoffPlan';
import './Onboarding.css';

interface Props {
  initialStage: Exclude<OnboardingStage, 'handoff'>;
  /** Open on the Welcome screen first (the Launcher's automatic takeover only). */
  welcome?: boolean;
  /**
   * What this is to the person. `first-run`: the app has no project, so there is nothing to skip
   * to and the one job is the first project. `new-project`: someone with projects adding one, a
   * task and not a setup: no steps, Cancel and Esc go back. `setup` (default): finishing the Mac's
   * setup, which can wait.
   */
  purpose?: OnboardingPurpose;
  /** Skip or Cancel: leave, nothing opened. */
  onClose: () => void;
  /** The picked folder is already a dreamcontext project: open its window. */
  onOpenProject: (vaultName: string) => void;
  /** The hand-off opened the new project (and asked Claude to start, when it could). */
  onFinished: (vaultName: string) => void;
}

export type OnboardingPurpose = 'first-run' | 'new-project' | 'setup';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * First-run onboarding as a full-window takeover of the Launcher, in three steps:
 * This Mac (the readiness checklist), Project (create, open or clone), Start (the hand-off).
 *
 * The Mac step moves on by itself: when the checklist reports this machine ready, the title
 * turns into "This Mac is ready", and once that moment has played the Project step slides in
 * (straight to the hand-off when a project already exists, the "Finish setup" path). Finishing
 * setup can always wait ("Skip for now"), a new project can always be cancelled, and the app's
 * first project is the only thing here that cannot be skipped: without it nothing else exists.
 */
export function Onboarding({ initialStage, welcome = false, purpose = 'setup', onClose, onOpenProject, onFinished }: Props) {
  const { t } = useI18n();
  const { report } = useReadiness('machine');
  const [stage, setStage] = useState<OnboardingStage>(initialStage);
  const [welcoming, setWelcoming] = useState(welcome);
  const [project, setProject] = useState<CreatedProject | null>(null);
  const [machineReady, setMachineReady] = useState(false);
  const advancedRef = useRef(false);
  /**
   * The checklist is busy: "Set everything up" is running, or a sign-in card waits on the person
   * (the background developer-tools install does not count). Leaving the step then would unmount
   * the checklist, so Continue stays hidden. Mirrored in a ref so a click in the same tick as a
   * sequence starting is still refused.
   */
  const [checklistIsBusy, setChecklistIsBusy] = useState(false);
  const busyRef = useRef(false);
  const handleBusyChange = useCallback((busy: boolean) => {
    busyRef.current = busy;
    setChecklistIsBusy(busy);
  }, []);

  const advanceFromMachine = useCallback(() => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    setMachineReady(false);
    setStage(project ? 'handoff' : 'project');
  }, [project]);

  const handleReady = useCallback(() => {
    advancedRef.current = false;
    setMachineReady(true);
    // No animation runs under reduced motion, so there is no `animationend` to wait for.
    if (prefersReducedMotion()) advanceFromMachine();
  }, [advanceFromMachine]);

  /** Leave Welcome for the first step that still needs the person, as the Launcher would pick it. */
  const startFromWelcome = useCallback(() => {
    setWelcoming(false);
    if (report?.ready) setStage('project');
  }, [report?.ready]);

  const task = purpose === 'new-project';
  /** The project is being made on the server: leaving now would strand it, unopened. */
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const handleCreating = useCallback((busy: boolean) => { creatingRef.current = busy; setCreating(busy); }, []);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!task) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || busyRef.current || creatingRef.current || stageRef.current === 'handoff') return;
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task]);

  function body() {
    if (welcoming) return <Welcome onStart={startFromWelcome} />;
    if (stage === 'machine') {
      return (
        <div className="ob-panel-body">
          <header className="ob-head">
            {machineReady ? (
              <div className="ob-ready-moment" onAnimationEnd={advanceFromMachine}>
                <h2 className="ob-title">{t('onboarding.machine.ready')}</h2>
                <p className="ob-subtitle">{t('onboarding.machine.readySubtitle')}</p>
              </div>
            ) : (
              <>
                <h2 className="ob-title">{t('onboarding.machine.title')}</h2>
                <p className="ob-subtitle">{t('onboarding.machine.subtitle')}</p>
              </>
            )}
          </header>
          <ReadinessChecklist scope="machine" onReady={handleReady} onBusyChange={handleBusyChange} />
          {/* Continue never interrupts "Set everything up" or a waiting sign-in: it is hidden
              until the checklist is idle, and the ready moment moves on by itself anyway. */}
          {report?.ready && !machineReady && !checklistIsBusy && (
            <div className="ob-actions">
              <button
                type="button"
                className="ob-btn ob-btn--secondary"
                onClick={() => {
                  if (busyRef.current) return;
                  advancedRef.current = false;
                  advanceFromMachine();
                }}
              >
                {t('onboarding.continue')}
              </button>
            </div>
          )}
        </div>
      );
    }
    if (stage === 'project' || !project) {
      return (
        <ProjectStep
          report={report}
          onBusyChange={handleCreating}
          title={task ? t('onboarding.project.newTitle') : purpose === 'first-run' ? t('onboarding.project.firstTitle') : undefined}
          subtitle={purpose === 'first-run' ? t('onboarding.project.firstSubtitle') : undefined}
          onCreated={(p) => { setProject(p); setStage('handoff'); }}
          onOpenExisting={onOpenProject}
        />
      );
    }
    return (
      <Handoff
        project={project}
        report={report}
        onDone={onFinished}
        onFinishSetup={() => { advancedRef.current = false; setStage('machine'); }}
      />
    );
  }

  return (
    <section className="ob" aria-label={t('onboarding.stepsLabel')}>
      <header className="ob-top">
        {/* Welcome is not a step: the dots appear with the first one. */}
        {welcoming || task ? <span aria-hidden="true" /> : <StepDots stage={stage} />}
        {/* The first project cannot be skipped, but the Mac's checks can wait: a check that cannot
            pass here must never keep someone from their first project. */}
        {purpose === 'first-run' && stage === 'machine' && !welcoming && (
          <button type="button" className="ob-btn ob-btn--ghost ob-skip" data-no-drag
            onClick={() => { if (!busyRef.current) setStage('project'); }}>
            {t('onboarding.machineLater')}
          </button>
        )}
        {/* Once the project exists there is nothing left to cancel: the hand-off is the way on. */}
        {purpose !== 'first-run' && !(task && stage === 'handoff') && (
          <button type="button" className="ob-btn ob-btn--ghost ob-skip" data-no-drag disabled={creating}
            onClick={() => { if (!creatingRef.current) onClose(); }}>
            {task ? t('onboarding.cancel') : t('onboarding.skip')}
          </button>
        )}
      </header>
      <div className="ob-panel" data-no-drag key={welcoming ? 'welcome' : stage}>
        {body()}
      </div>
    </section>
  );
}
