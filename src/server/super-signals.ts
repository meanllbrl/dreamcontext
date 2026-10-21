import { signalsOf, type SuperSignal } from '../lib/super/signals.js';
import { applySignal } from '../lib/super/proactive.js';
import { readSuperState, superRootOfChild } from '../lib/super/store.js';
import { noteChildBrowserCall, superSanitizeOpts, writeSuper } from '../lib/super/inbox.js';
import { validateSuperWebUrl } from '../lib/super/web-url.js';
import { ownedLoopbackPorts } from './owned-ports.js';

/**
 * The server's eye on a chat's output for the Super Agent's stage (jarvis plan r9, §3 S1-S2).
 * Installed on EVERY chat process that is not the super chat itself: a delegated child is not
 * registered as one when its process starts (the window confirms the delegation after), and an
 * adopted child ran long before the hand-over. So each frame first asks, from memory, whether
 * this chat is a super child right now; a chat that is not returns at once.
 *
 * A signal becomes a card edit (`applySignal`, the noise rules live there) written only when it
 * changes the record. Browser calls come in bursts: one look per child per BROWSER_LOOK_MS.
 */

const BROWSER_LOOK_MS = 2_000;

export interface SuperSignalObserver {
  observe(frame: Record<string, unknown>): void;
}

export function createSuperSignalObserver(chatRegistryId: string, browserServer: string | null): SuperSignalObserver {
  let lastBrowserLook = 0;
  let chain: Promise<void> = Promise.resolve();
  const apply = (root: string, signals: SuperSignal[]): void => {
    chain = chain.then(async () => {
      const cur = await readSuperState(root, superSanitizeOpts());
      const probe = JSON.parse(JSON.stringify(cur));
      const now = Date.now();
      if (!signals.map((sig) => applySignal(probe, chatRegistryId, sig, now)).some(Boolean)) return;
      await writeSuper(root, (s) => { for (const sig of signals) applySignal(s, chatRegistryId, sig, Date.now()); });
    }).catch(() => { /* the next frame tries again */ });
  };
  return {
    observe(frame) {
      const root = superRootOfChild(chatRegistryId);
      if (!root) return;
      const raw = signalsOf(frame, browserServer);
      if (!raw.length) return;
      const signals: SuperSignal[] = [];
      for (const sig of raw) {
        if (sig.kind === 'browser') {
          noteChildBrowserCall(chatRegistryId);
          const now = Date.now();
          if (now - lastBrowserLook < BROWSER_LOOK_MS) continue;
          lastBrowserLook = now;
          signals.push(sig);
        } else if (sig.kind === 'devserver') {
          // The super `web` rule, with this process's own ports refused at this moment.
          const w = validateSuperWebUrl(sig.url, ownedLoopbackPorts());
          if (w.ok && w.kind === 'url') signals.push({ kind: 'devserver', url: w.href });
        } else {
          signals.push(sig);
        }
      }
      if (signals.length) apply(root, signals);
    },
  };
}
