import { emitInstance } from '../../context/VaultContext';
import { openAgentSurface } from '../../lib/agentSettings';
import { COMPOSER_PREFILL_EVENT } from '../sleepy/chat/Composer';

/**
 * Open Chat with `text` in the composer, ready to send (the Apps page's one way to ask for an app,
 * an icon or a README part, a publish). The surface mounts its composer a beat after it opens: ask a
 * few times until one takes it. Only an empty composer takes it: `missed` says none did.
 */
export function askAgent(bus: EventTarget, text: string, on: { taken?: () => void; missed?: () => void } = {}): void {
  openAgentSurface(bus);
  let tries = 0;
  const ask = () => {
    const detail: { text: string; accepted?: boolean } = { text };
    emitInstance(bus, COMPOSER_PREFILL_EVENT, detail);
    if (detail.accepted) on.taken?.();
    else if (++tries < 10) window.setTimeout(ask, 150);
    else on.missed?.();
  };
  window.setTimeout(ask, 60);
}
