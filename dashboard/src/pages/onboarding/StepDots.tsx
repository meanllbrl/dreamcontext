import { useI18n } from '../../context/I18nContext';
import type { OnboardingStage } from './handoffPlan';

const STAGES: { stage: OnboardingStage; key: string }[] = [
  { stage: 'machine', key: 'onboarding.stage.machine' },
  { stage: 'project', key: 'onboarding.stage.project' },
  { stage: 'handoff', key: 'onboarding.stage.start' },
];

/** "This Mac · Project · Start": where the person is, always visible. */
export function StepDots({ stage }: { stage: OnboardingStage }) {
  const { t } = useI18n();
  const current = STAGES.findIndex((s) => s.stage === stage);
  return (
    <ol className="ob-steps" aria-label={t('onboarding.stepsLabel')}>
      {STAGES.map((s, i) => (
        <li
          key={s.stage}
          className={`ob-step${i === current ? ' ob-step--current' : ''}${i < current ? ' ob-step--done' : ''}`}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="ob-step-dot" aria-hidden="true" />
          <span className="ob-step-label">{t(s.key)}</span>
        </li>
      ))}
    </ol>
  );
}
