import { openAgentSurface } from './agentSettings';

/**
 * Bring a project's chat surface up as it stands (the project switch's carry and the window's
 * Chat landing share it, navigation B C5). A freshly mounted surface is not listening yet and
 * drops `OPEN_AGENT_SURFACE_EVENT` until it has loaded, so this asks again until the chat is
 * open, its instance leaves the screen, it is cancelled, or `untilMs` has passed. It only ever
 * expands the surface: it never switches its view and never starts a chat.
 */
export const CHAT_LADDER_STEPS_MS: readonly number[] = [150, 500, 1200, 2500];
/** After the steps, one ask per this long until the bound. */
export const CHAT_LADDER_EVERY_MS = 1500;

export interface ChatLadderDeps {
  isOpen: () => boolean;
  /** False once the instance is no longer on screen. */
  stillActive: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Tests: what an ask does (default: `openAgentSurface(bus)`). */
  ask?: () => void;
}

export function runChatLadder(bus: EventTarget, untilMs: number, deps: ChatLadderDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => window.clearTimeout(h as number));
  const ask = deps.ask ?? (() => openAgentSurface(bus));
  const timers: unknown[] = [];
  let stopped = false;
  const stop = () => { stopped = true; for (const t of timers) clearTimer(t); timers.length = 0; };
  ask();
  if (deps.isOpen()) return stop;
  const at: number[] = [...CHAT_LADDER_STEPS_MS];
  for (let t = (at[at.length - 1] ?? 0) + CHAT_LADDER_EVERY_MS; t <= untilMs; t += CHAT_LADDER_EVERY_MS) at.push(t);
  for (const ms of at) {
    if (ms > untilMs) break;
    timers.push(setTimer(() => {
      if (stopped) return;
      if (deps.isOpen() || !deps.stillActive()) { stop(); return; }
      ask();
    }, ms));
  }
  return stop;
}
