/** "Usage details" on the composer ring: a window event, like `requestOpenAgents`, because the
 *  composer holds no bus. The active project's `OpenStatsBridge` answers it. */
export const OPEN_STATS_EVENT = 'dreamcontext-open-stats';

export function requestOpenStats(): void {
  window.dispatchEvent(new Event(OPEN_STATS_EVENT));
}
