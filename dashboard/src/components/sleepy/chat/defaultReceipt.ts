import type { AgentSettingsWrite } from '../../../lib/agentSettings';

/** The model + effort a "Set as default" click captured. */
export interface ModelPick { model: string; effort: string }

/**
 * Should the composer show "Saved as default" for this write? Only once the write LANDED
 * (`ok`), and only if the model and effort on screen are still the ones the click captured:
 * a receipt next to a value changed since is a false one (Composer.tsx, owner decision 6).
 * Never rejects.
 */
export async function savedDefaultReceipt(
  write: Promise<AgentSettingsWrite>,
  at: ModelPick,
  current: () => ModelPick,
): Promise<boolean> {
  try {
    const { ok } = await write;
    const now = current();
    return ok && now.model === at.model && now.effort === at.effort;
  } catch {
    return false;
  }
}
