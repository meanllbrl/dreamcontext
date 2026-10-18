import { useCallback } from 'react';
import { emitInstance, useVault } from '../context/VaultContext';

/**
 * The one "Give to an agent" door on the task surfaces (plan r3 § 5e). A task page, a board
 * card and the board's New-task button all open the same dialog, mounted once per project in
 * `ProjectInstance`, which offers Develop, a named agent, a custom prompt, or writing a new
 * task, and reaches the same backend call each old entry point made.
 *
 * On the instance bus, never `window`: the slug exists in one vault, and every mounted project
 * would otherwise open its own dialog for a task it does not have.
 */
export const GIVE_TO_AGENT_EVENT = 'dreamcontext-give-to-agent';

/** Which choice the dialog opens on. Without one it shows all of them. */
export type GiveToAgentPreset = 'develop' | 'agent' | 'custom' | 'author';

export interface GiveToAgentDetail {
  /** The task to hand over. Absent: only "Write a new task" applies. */
  slug?: string;
  preset?: GiveToAgentPreset;
}

/** Open the door on `bus` (the project's own, from `useVault().bus`). */
export function openGiveToAgent(bus: EventTarget, detail: GiveToAgentDetail = {}): void {
  emitInstance<GiveToAgentDetail>(bus, GIVE_TO_AGENT_EVENT, detail);
}

/** `openGiveToAgent` bound to this project's bus: `const give = useGiveToAgent(); give({ slug })`. */
export function useGiveToAgent(): (detail?: GiveToAgentDetail) => void {
  const { bus } = useVault();
  return useCallback((detail: GiveToAgentDetail = {}) => openGiveToAgent(bus, detail), [bus]);
}
