import { memo } from 'react';
import { summarizeToolRun, toolRunHeadline, useToolRunCollapse } from './chatEntities';
import { Duration, MetaText } from './atoms';
import { CardHeader } from './molecules';
import { ToolCard } from './ToolCard';
import type { ChatToolItem } from '../chatSession';

/**
 * ORGANISM — one contiguous run of tool calls as a single card (owner report 08-01).
 *
 * The sibling of {@link SubAgentCard}, one level down and driven by the same idiom: open
 * while the work is live, collapsed to a header the moment it lands, the user's own toggle
 * outranking both (`useToolRunCollapse` → the phase-stamped `isGroupOpen`). The argument is
 * the same one that card's header note makes — a finished stretch of work is a RECORD, and a
 * record that keeps N rows of the transcript forever is just cost.
 *
 * The rows are real {@link ToolCard}s, not a bespoke compact row, and that is deliberate:
 * every one of them stays individually expandable (a diff, a terminal block, a raw result),
 * stays individually MEMOIZED — so a streamed result re-renders one row rather than the
 * whole run — and stays byte-identical to how it renders outside a group. Only the card
 * chrome is dropped, in CSS, so inside the group they read as rows of one thing.
 */
function ToolRunCardInner({
  items, stillAccruing, onOpenFile,
}: {
  items: ChatToolItem[];
  /** Is this run still the tail of a turn that hasn't spoken yet? See `toolRunPhase` —
   *  reading liveness off the items alone would collapse the group in the gap between two
   *  calls and re-open it a frame later, once per call. */
  stillAccruing: boolean;
  onOpenFile: (path: string) => void;
}) {
  const { open, onToggle } = useToolRunCollapse(items, stillAccruing);
  const summary = summarizeToolRun(items);
  const live = items.some((i) => i.status === 'running') || stillAccruing;

  return (
    <div className="chat-toolrun" data-open={open || undefined} data-live={live || undefined}>
      <CardHeader
        glyph="⚙"
        title={live ? 'Working' : toolRunHeadline(summary)}
        aside={(
          <>
            {/* While it runs, the count is the live readout and the headline would be a
                sentence rewriting itself every second. Once it lands, the headline IS the
                content and the count is already inside it. */}
            {live && <MetaText>{toolRunHeadline(summary)}</MetaText>}
            {summary.durationMs != null && !live && <Duration ms={summary.durationMs} />}
          </>
        )}
        open={open}
        onToggle={onToggle}
      />
      {open && (
        <div className="chat-toolrun-rows">
          {items.map((item) => (
            <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

/** MEMOIZED for the same reason `ToolCard` is. The `items` array identity changes whenever
 *  any row in the run changes — which is correct: this component only re-renders the header
 *  and the row LIST, while each row is its own memoized `ToolCard` that skips unless its own
 *  item changed. See `ItemView`'s note on callback stability; `onOpenFile` must stay stable. */
export const ToolRunCard = memo(ToolRunCardInner);
