/**
 * Builds the process's Telegram hub with its real neighbours (W2): the Mac banner, the
 * hands-free adapter, the member adapter, the manager. Desktop only (index.ts gates it).
 */
import { notifyViaBundle } from '../../lib/automations/notifier.js';
import { setTelegramHub, telegramHub, TelegramHub, type HubDeps } from './hub.js';
import { wireTelegramAsks } from './asks.js';
import { memberAdapter } from './member.js';
import { wireManager } from './manager.js';

export async function startTelegramHub(extra: Partial<HubDeps> = {}): Promise<TelegramHub> {
  const have = telegramHub();
  if (have) return have;
  const hub = new TelegramHub({
    banner: (title, body) => { try { notifyViaBundle(title, body); } catch { /* no banner */ } },
    member: memberAdapter(),
    ...extra,
  });
  setTelegramHub(hub);
  wireTelegramAsks(hub);
  wireManager(hub);
  await hub.start();
  return hub;
}
