import { historyChatItem, type ChatToolItem, type HistoryEntry } from '../chatSession';

/**
 * A routine run still in flight, as a Super turn in flight looks (owner 2026-11-14, learned rule
 * h7tjatns3j): a member's chat draws its turns with the normal chat's components, never a reduced
 * copy in a box. A normal Super turn shows its steps only while it runs, as the one quiet live
 * line, and puts them away once the answer is written. A run is drawn the same way: these are the
 * steps that line carries, read from the run's own transcript.
 *
 * The live tail only: the tool calls after the last thing the run SAID. A run that has just
 * written words and not called a tool since has none (the line reads "Thinking"). The last call
 * with no result yet is the one in hand (`running`), as the live chat marks it. Pure.
 */
export function runLiveSteps(entries: readonly HistoryEntry[]): ChatToolItem[] {
  const tail: ChatToolItem[] = [];
  let pending: HistoryEntry | null = null;
  let seq = 0;
  for (const h of entries) {
    if (h.kind === 'text' && h.text?.trim()) { tail.length = 0; pending = null; continue; }
    if (h.kind !== 'tool') continue;
    const item = historyChatItem(h, `run-step-${++seq}`);
    if (item?.kind !== 'tool') continue;
    tail.push(item);
    pending = h;
  }
  const last = tail[tail.length - 1];
  if (last && pending && pending.result === undefined && pending.status !== 'error') {
    tail[tail.length - 1] = { ...last, status: 'running', endedAt: undefined };
  }
  return tail;
}
