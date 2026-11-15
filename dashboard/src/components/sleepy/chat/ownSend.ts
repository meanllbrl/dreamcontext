import type { ChatUserItem } from '../chatSession';
import { superEventOf } from '../super/superHandover';

/**
 * His own send from this pane: the only message that stops the view at its answer (owner
 * 2026-11-15, as Claude Desktop does). Never a server-submitted opening prompt (sleep, a delegate
 * run), an event turn, a message typed on another surface, a queue drain or a stage strip.
 */
export function isOwnSend(it: ChatUserItem): boolean {
  return !it.stageMedia && !it.echo && !it.queued && !it.serverPrompt
    && !it.superEvent && !superEventOf(it.text);
}
