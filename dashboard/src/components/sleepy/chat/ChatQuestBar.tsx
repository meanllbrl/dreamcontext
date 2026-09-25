import { useEffect, useState } from 'react';
import type { QuestLineage, QuestView } from '../../../lib/quest';
import { QuestMap, QuestReceipt, QuestVictory, useJustWon } from '../quest/QuestMap';
import './questBar.css';

/**
 * A Plan or Develop chat's quest, on the chat's live rail: the map while the team works, the
 * one calm win beat once the run is won ("Plan sealed", "Quest cleared", or "Ready for your
 * sign-off"), and "How this was built" behind a Develop win.
 *
 * The chat twin of `GoalLivePanel`'s rail bar. The rail mounts one or the other, never both: a
 * goal-skill run's live file is the better record of the same work, so while it exists it wins.
 *
 * A leaf with its own one-second tick, so the elapsed clock and the beat's freshness move while
 * nothing streams, without re-rendering the transcript that owns the quest.
 */
export function ChatQuestBar({ quest, lineage }: { quest: QuestView; lineage: QuestLineage | null }) {
  const outcome = quest.outcome;
  const now = useTicker(outcome == null);

  // The stamp is news only to someone who watched the run finish. A chat reopened onto a win
  // shows it at rest.
  const [sawLive, setSawLive] = useState(false);
  if (!outcome && !sawLive) setSawLive(true);
  // Held here, not in QuestVictory: the bar swaps map for victory at the win, and this is the
  // component that stays mounted across that swap.
  const justWon = useJustWon(sawLive && outcome != null);
  const beat = useFreshBeat(quest.beat, now);
  const [receipt, setReceipt] = useState(false);
  const title = quest.title ?? 'This quest';

  return (
    <>
      <div className="chat-quest-bar" data-kind={quest.kind} data-won={outcome?.kind}>
        {outcome ? (
          <QuestVictory
            quest={quest}
            justWon={justWon}
            onReceipt={lineage ? () => setReceipt(true) : undefined}
          />
        ) : (
          <QuestMap quest={beat === quest.beat ? quest : { ...quest, beat }} variant="rail" />
        )}
      </div>
      {receipt && lineage && <QuestReceipt lineage={lineage} title={title} onClose={() => setReceipt(false)} />}
    </>
  );
}

/** How long a beat reads as news. Mirrors `questModel`'s own window (not exported there). */
const BEAT_FRESH_MS = 8000;

/**
 * The beat, going stale on the bar's own clock. The quest is derived when the transcript
 * renders, and a quiet stretch (a party working with nothing streaming) renders nothing, so
 * the model's `stale` would otherwise stay "news" until the next event arrived.
 */
function useFreshBeat(beat: QuestView['beat'], now: number): QuestView['beat'] {
  const [seen, setSeen] = useState<{ text: string; at: number } | null>(null);
  const text = beat && !beat.stale ? beat.text : null;
  if (text !== (seen?.text ?? null)) setSeen(text == null ? null : { text, at: Date.now() });
  if (!beat || beat.stale || !seen || now - seen.at <= BEAT_FRESH_MS) return beat;
  return { text: beat.text, stale: true };
}

/** Wall-clock now, re-read every second while `live`. */
function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live]);
  return now;
}
