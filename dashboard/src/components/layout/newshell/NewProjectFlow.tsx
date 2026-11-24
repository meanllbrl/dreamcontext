import { NewProjectLandContext, type NewProjectLanding } from '../../../lib/uxMode';
import { Onboarding } from '../../../pages/onboarding/Onboarding';

/**
 * The new shell's New project: the app's own Add Project flow (`Onboarding`, which creates a
 * project or takes an existing folder), started from the drawer or the picker. It lands in THIS
 * window (`NewProjectLandContext`), never a new one; closing it leaves the owner where they were.
 */
export function NewProjectFlow({ onClose, onLand }: {
  onClose: () => void;
  onLand: NewProjectLanding;
}) {
  return (
    <NewProjectLandContext.Provider value={onLand}>
      <Onboarding purpose="new-project" onClose={onClose} onLanded={onClose} />
    </NewProjectLandContext.Provider>
  );
}
