/**
 * Builds the process's Telegram hub with its real neighbours (W2): the Mac banner, the
 * hands-free adapter, the manager. Every bot, a member's too, goes through the hub's one path. Desktop only (index.ts gates it).
 */
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { setTelegramHub, telegramHub, TelegramHub, type HubDeps } from './hub.js';
import { wireTelegramAsks } from './asks.js';
import { wireTelegramW5 } from './w5.js';
import { wireRunCards } from './runs.js';
import { wireManager } from './manager.js';
import { wireRating } from './rate.js';
import { handsfreeAdapter } from './handsfree.js';
import { macSession } from '../routes/handsfree-mac.js';
import { installDispatcher } from '../../lib/automations/launchd.js';
import { transcribeVoiceNote } from '../../lib/voice/transcribe.js';

/** Shutdown: stops every loop and releases the token locks synchronously. */
export function stopTelegramHub(): void {
  const hub = telegramHub();
  if (!hub) return;
  hub.releaseNow();
  void hub.stop();
}

export async function startTelegramHub(extra: Partial<HubDeps> = {}): Promise<TelegramHub> {
  const have = telegramHub();
  if (have) return have;
  const handsfree = handsfreeAdapter(() => macSession());
  const hub = new TelegramHub({
    banner: (title, body) => { try { notifyViaBundle(title, body); } catch { /* no banner */ } },
    handsfree,
    transcribeVoice: (p) => transcribeVoiceNote(p),
    // Binding a bot makes sure the launchd tick exists (it answers while the app is quit).
    ensureDispatcher: () => { void installDispatcher().catch(() => { /* the bind sheet names it */ }); },
    // A closed or slept Super (main's or a member's) is started by the server itself when his
    // message comes, never only through a window that may not open (owner 2026-11-16).
    wakeHeadless: async (o) => (await import('../headless-super.js')).wakeSuperHeadless(o),
    ...extra,
  });
  setTelegramHub(hub);
  wireTelegramAsks(hub);
  wireTelegramW5(hub, { session: () => macSession() });
  // Run and secret cards (W4): the phone link is the live hands-free tunnel's bare origin.
  wireRunCards(hub, {
    phoneOrigin: () => { const u = macSession().status().url; try { return u ? new URL(u).origin : null; } catch { return null; } },
    streams: (ab) => handsfree.streamsTo(ab.scope, ab.target),
  });
  wireManager(hub);
  // A run's stars and his note (W3): before start, so the journal's notes replay at activation.
  wireRating(hub);
  handsfree.wire(hub);
  await hub.start();
  return hub;
}
