import { memo } from 'react';
import { summarizeToolRun, useToolRunCollapse } from './chatEntities';
import { AgentAvatar, Duration, MetaText } from './atoms';
import { CardHeader } from './molecules';
import { ToolCard } from './ToolCard';
import { actionText, toolAction, workBeatHeadline } from './toolAction';
import { AGENT_ROLES, type AgentRoleId } from '../../../lib/agentRoles';
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
 *
 * In the team log it is a WORK BEAT: the speaker's avatar on the header, "Working" with the
 * step in hand while it is live, and what the stretch amounted to once it landed ("Looked
 * around: 4 steps · 2 files read · 1 command"). Its rows all follow the header, so they keep
 * the avatar column and hide the face.
 */
function ToolRunCardInner({
  items, stillAccruing, onOpenFile, actor = 'lead', stretch, stretchRunning = false,
}: {
  items: ChatToolItem[];
  /** Is this run still the tail of a turn that hasn't spoken yet? See `toolRunPhase` —
   *  reading liveness off the items alone would collapse the group in the gap between two
   *  calls and re-open it a frame later, once per call. */
  stillAccruing: boolean;
  onOpenFile: (path: string) => void;
  /** Who did this stretch of work. Defaults to the lead. */
  actor?: AgentRoleId;
  /** Opens its stretch (the header avatar shows) or follows the line above it. */
  stretch?: 'lead' | 'follow';
  /** A step elsewhere in this beat's stretch is running. */
  stretchRunning?: boolean;
}) {
  const { open, onToggle } = useToolRunCollapse(items, stillAccruing);
  const summary = summarizeToolRun(items);
  const live = items.some((i) => i.status === 'running') || stillAccruing;

  return (
    <div
      className="chat-toolrun chat-step"
      data-actor={actor}
      data-stretch={stretch}
      data-open={open || undefined}
      data-live={live || undefined}
    >
      <CardHeader
        glyph={(
          <span className="chat-step-avatar">
            <AgentAvatar name={AGENT_ROLES[actor].label} size={16} role={actor} running={stretchRunning || live} />
          </span>
        )}
        title={live ? 'Working' : workBeatHeadline(items)}
        aside={(
          <>
            {/* While it runs, the step in hand is the live readout and the headline would be a
                sentence rewriting itself every second. Once it lands, the headline IS the
                content and the steps are already counted inside it. */}
            {live && <span className="chat-toolrun-now"><MetaText>{nowLine(items)}</MetaText></span>}
            {summary.durationMs != null && !live && <Duration ms={summary.durationMs} />}
          </>
        )}
        open={open}
        onToggle={onToggle}
      />
      {open && (
        <div className="chat-toolrun-rows">
          {items.map((item) => (
            <ToolCard key={item.id} item={item} onOpenFile={onOpenFile} actor={actor} stretch="follow" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The live header's readout: the latest step that is still running, in the present tense
 * ("Reading ChatPane.tsx…"), or failing that the latest one as it stands. Quest-map
 * bookkeeping is never the headline of anything, so it is skipped, and a prose subject (a raw
 * command, flags and all) stays on its row: the header says what is happening, in plain words.
 */
function nowLine(items: readonly ChatToolItem[]): string {
  const actions = items
    .map((i) => toolAction(i.name, i.input, i.status))
    .filter((a) => !a.quiet);
  const current = [...actions].reverse().find((a) => a.ellipsis) ?? actions[actions.length - 1];
  if (!current) return '';
  return actionText(current.subject?.kind === 'prose' ? { ...current, subject: null } : current);
}

/** MEMOIZED for the same reason `ToolCard` is. The `items` array identity changes whenever
 *  any row in the run changes — which is correct: this component only re-renders the header
 *  and the row LIST, while each row is its own memoized `ToolCard` that skips unless its own
 *  item changed. See `ItemView`'s note on callback stability; `onOpenFile` must stay stable. */
export const ToolRunCard = memo(ToolRunCardInner);
