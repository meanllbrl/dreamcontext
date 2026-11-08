/**
 * Builds the process's Telegram hub with its real neighbours (W2): the Mac banner, the
 * hands-free adapter, the member adapter, the manager. Desktop only (index.ts gates it).
 */
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { setTelegramHub, telegramHub, TelegramHub, type HubDeps } from './hub.js';
import { wireTelegramAsks } from './asks.js';
import { memberAdapter } from './member.js';
import { wireManager } from './manager.js';
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
    member: memberAdapter({ transcribeVoice: (p) => transcribeVoiceNote(p) }),
    handsfree,
    transcribeVoice: (p) => transcribeVoiceNote(p),
    // Binding a bot makes sure the launchd tick exists (it answers while the app is quit).
    ensureDispatcher: () => { void installDispatcher().catch(() => { /* the bind sheet names it */ }); },
    ...extra,
  });
  setTelegramHub(hub);
  wireTelegramAsks(hub);
  wireManager(hub);
  handsfree.wire(hub);
  await hub.start();
  return hub;
}
