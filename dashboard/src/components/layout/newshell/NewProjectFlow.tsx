import { useState } from 'react';
import { useReadiness } from '../../../hooks/useOnboarding';
import { NewProjectLandContext, type NewProjectLanding } from '../../../lib/uxMode';
import { Onboarding } from '../../../pages/onboarding/Onboarding';
import { entryStage, type OnboardingStage } from '../../../pages/onboarding/handoffPlan';

type Stage = Exclude<OnboardingStage, 'handoff'>;

/**
 * The new shell's New project: the app's own Add Project flow (`Onboarding`, which creates a
 * project or takes an existing folder), started from the drawer or the picker. It lands in THIS
 * window (`NewProjectLandContext`), never a new one; closing it leaves the owner where they were.
 */
export function NewProjectFlow({ onClose, onLand }: {
  onClose: () => void;
  onLand: NewProjectLanding;
}) {
  const readiness = useReadiness('machine');
  const known = !!readiness.report || !!readiness.error;
  if (!known) return null;
  return <Flow stage={entryStage(readiness.report, !!readiness.error) === 'project' ? 'project' : 'machine'} onClose={onClose} onLand={onLand} />;
}

function Flow({ stage, onClose, onLand }: { stage: Stage; onClose: () => void; onLand: NewProjectLanding }) {
  // The step it opened on holds while readiness refreshes underneath.
  const [initial] = useState(stage);
  return (
    <NewProjectLandContext.Provider value={onLand}>
      <Onboarding initialStage={initial} purpose="new-project" onClose={onClose} onOpenProject={(name) => onLand(name, 'existing')} onFinished={onClose} />
    </NewProjectLandContext.Provider>
  );
}
