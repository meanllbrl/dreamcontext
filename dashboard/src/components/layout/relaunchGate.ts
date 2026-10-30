/**
 * What a click on "Relaunch" does. A relaunch quits the WHOLE app, so every chat and
 * terminal process dies with it — a turn half-written, a background shell, a sub-agent
 * fan-out. The banner never relaunches on its own (the owner decides, 2026-10-29); when the
 * owner clicks while the server reports a live tab at work (`agentsWorking` on GET
 * /api/health, read from each process: chat-park.ts), it asks first, inline — confirm()
 * is a silent no-op in the desktop app's WKWebView.
 *
 * Unknown (an older server that does not report it) relaunches directly: the click is the
 * owner's own call and there is nothing to warn about.
 */
export type RelaunchClick = 'relaunch' | 'confirm';

export function relaunchClick(agentsWorking: number | null | undefined): RelaunchClick {
  return typeof agentsWorking === 'number' && agentsWorking > 0 ? 'confirm' : 'relaunch';
}
