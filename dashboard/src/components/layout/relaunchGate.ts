/**
 * When the update relaunch may fire on its own. A relaunch quits the WHOLE app, so every
 * chat and terminal process dies with it — a turn half-written, a background shell, a
 * sub-agent fan-out. The countdown therefore runs only while the server reports no live tab
 * at work (`agentsWorking` on GET /api/health, read from each process: chat-park.ts).
 *
 * Unknown (an older server that does not report it) keeps the old behaviour: the countdown
 * runs, as it did before this gate existed. "Relaunch now" is the owner's own call and is
 * never gated.
 */
export function relaunchHeld(agentsWorking: number | null | undefined): boolean {
  return typeof agentsWorking === 'number' && agentsWorking > 0;
}

/** How often the banner re-reads the server while an update waits (ms). */
export const RELAUNCH_POLL_MS = 3_000;
