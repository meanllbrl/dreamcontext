import type { CardCloseReason } from '../../../lib/cardRecords';

/**
 * What a chat's run card SAYS, decided in one place (plan J2, K1; review r2, 2026-11-08).
 *
 * The card mixes three sources that can disagree: the server's record (open, closed and why,
 * the last exit code), a run going right now (here, on the phone, from Telegram), and what the
 * owner's own last press in THIS card led to (refused, or exited with a code). Spread over the
 * component, a refusal of "Run again" on a finished card was hidden behind the record's old
 * "finished" text and exit chip. So the precedence is one pure function:
 *
 *   1. not loaded / no record / cannot run here: say so;
 *   2. a run is going: running (and whether this terminal takes keys or only watches);
 *   3. the outcome of this card's own last terminal: refused, or exited with its code;
 *   4. the record's close reason: only `done` says it finished, `interrupted` says cut off,
 *      the rest say it did not run here;
 *   5. otherwise idle.
 *
 * Run again is offered only on a card that ran (done or cut off), on the Mac; a card that was
 * replaced, withdrawn or answered has nothing to run again.
 */

export type RunCardPhase = 'idle' | 'running' | 'done' | 'closed';

/** What this card's own last terminal led to (cleared by the next ▶). */
export type RunOutcome = { kind: 'refused' } | { kind: 'exited'; code: number | null };

export interface RunCardFacts {
  loaded: boolean;
  hasRecord: boolean;
  /** This surface can run commands at all (desktop or the phone page, with a vault). */
  canStart: boolean;
  phone: boolean;
  desktop: boolean;
  state?: 'open' | 'closed';
  closedBy?: CardCloseReason;
  recordExit?: number | null;
  /** The record's run going right now, by who started it. */
  liveOwner: 'mac' | 'phone' | 'telegram' | null;
  /** A terminal in this card is connected. */
  connected: boolean;
  /** That terminal is the owner's own ▶ (it takes keys); false = it only watches. */
  connectedIsOwn: boolean;
  outcome: RunOutcome | null;
}

export interface RunCardView {
  phase: RunCardPhase;
  title: string;
  note: string | null;
  /** The exit chip: undefined = no chip. */
  chip: number | null | undefined;
  /** The ▶ label, or null for no button. */
  runLabel: 'Run' | 'Run again' | null;
  /** ▶ can be pressed now. */
  startable: boolean;
}

export const REFUSED_NOTE = 'This command did not start. Another command may be running in this chat, or this card can no longer run here.';

function closedWords(closedBy: CardCloseReason | undefined, phone: boolean): { title: string; note: string; ran: boolean } {
  const fromMac = phone ? ' Run it again from the Mac.' : '';
  switch (closedBy) {
    case 'done':
      return { title: 'Ran in chat', note: `Finished. The agent gets the result.${fromMac}`, ran: true };
    case 'interrupted':
      return { title: 'Cut off', note: `The app stopped before this finished, so it may have run only partly. Check before you run it again.${fromMac}`, ran: true };
    case 'superseded':
      return { title: 'Replaced', note: 'The agent posted a newer copy of this card further down.', ran: false };
    case 'dropped':
      return { title: 'Withdrawn', note: 'The agent no longer needs this.', ran: false };
    default:
      return { title: 'Answered', note: 'This was answered in the chat.', ran: false };
  }
}

export function runCardView(f: RunCardFacts): RunCardView {
  const closed = f.state === 'closed';
  const words = closed ? closedWords(f.closedBy, f.phone) : null;
  const ran = !!words?.ran || f.outcome?.kind === 'exited';
  // Open: Run. Closed: Run again on the Mac only, and only for a card that ran.
  const runLabel: RunCardView['runLabel'] = !f.hasRecord || !f.canStart
    ? null
    : !closed
      ? 'Run'
      : ran && f.desktop && !f.phone ? 'Run again' : null;
  const base = { chip: undefined, runLabel, startable: false };

  if (!f.loaded) return { ...base, phase: 'idle', title: 'Run this yourself', note: 'Checking this card…', runLabel: f.canStart ? 'Run' : null };
  if (!f.hasRecord) {
    return {
      ...base, phase: 'idle', title: 'Run this yourself',
      note: f.phone
        ? 'This card is older than the chat\'s newest cards, so it cannot run from here. Copy it, or run it on the Mac.'
        : 'This card is older than the chat\'s newest cards, so it cannot run here. Copy it and run it in your terminal.',
    };
  }
  if (!f.canStart) return { ...base, phase: closed ? (ran ? 'done' : 'closed') : 'idle', title: words?.title ?? 'Run this yourself', note: 'Running a command in the chat needs the desktop app. Copy it and run it in your terminal.' };

  if (f.liveOwner || f.connected) {
    const watching = !(f.connected && f.connectedIsOwn);
    const note = !watching
      ? 'Type here as you would in your own terminal.'
      : f.liveOwner === 'telegram'
        ? 'Started from Telegram. Click the terminal to type into it.'
        : f.liveOwner === 'phone' && !f.phone
          ? 'Started on the phone. Click the terminal to type into it.'
          : 'Running from another window. Click the terminal to type into it.';
    return { phase: 'running', title: 'Running in chat', note, chip: undefined, runLabel: null, startable: false };
  }

  const startable = runLabel !== null;
  if (f.outcome?.kind === 'refused') {
    return { phase: closed ? (words?.ran ? 'done' : 'closed') : 'idle', title: words?.title ?? 'Run this yourself', note: REFUSED_NOTE, chip: undefined, runLabel, startable };
  }
  if (f.outcome?.kind === 'exited') {
    return {
      phase: 'done', title: 'Ran in chat',
      note: f.phone ? 'Finished. The agent gets the result. Run it again from the Mac.' : 'Finished. The agent gets the result.',
      chip: f.outcome.code, runLabel: f.desktop && !f.phone ? 'Run again' : null, startable: f.desktop && !f.phone,
    };
  }
  if (words) {
    return { phase: words.ran ? 'done' : 'closed', title: words.title, note: words.note, chip: f.closedBy === 'done' ? f.recordExit : undefined, runLabel, startable };
  }
  return { phase: 'idle', title: 'Run this yourself', note: null, chip: undefined, runLabel, startable };
}
