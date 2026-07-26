import { useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { CardHeader } from './molecules';
import type { ChatSession, PendingPlan } from '../chatSession';

/**
 * ORGANISM — plan approval (ExitPlanMode). Claude has finished planning and is asking to
 * start building: the plan renders as real markdown, and the two answers are "Approve &
 * build" (allow — the control-channel answer that actually leaves plan mode; the next tool
 * call writes to disk) and "Keep planning" (deny — the turn continues, still planning).
 *
 * WHY THIS IS A CARD OF ITS OWN. The CLI flags this request `requires_user_interaction`,
 * exactly like AskUserQuestion, but its payload is `{plan, planFilePath}` and not
 * `{questions}`. Chat used to hand every interactive request to the survey card, so exiting
 * plan mode produced a Survey with no question, no options and a dead Submit, and the only
 * way to see the plan at all was to expand the raw tool card and read escaped `\n`s (owner
 * report 07-26). See `chatProtocol.ts`'s `parsePlan` for the shape and the fallback that now
 * catches any third interactive shape.
 *
 * A plan is the one card in chat that legitimately TELLS at length before it ASKS, so the
 * plan body scrolls within a bounded height rather than growing the card past the pane —
 * the actions stay on screen, which is the same rule that made the survey card page.
 */
export function PlanCard({ item, session }: { item: PendingPlan; session: ChatSession }) {
  // Local, because the card unmounts the moment `pending` drops it — this only has to
  // outlive the click itself, and it stops a double-send while the frame is in flight.
  const [sent, setSent] = useState(false);

  const approve = () => {
    if (sent) return;
    setSent(true);
    // The ORIGINAL input echoed back, exactly as a permission allow does. Verified against
    // CLI 2.1.220: the file the plan describes is written on the very next tool call.
    session.answer(item.requestId, { behavior: 'allow', updatedInput: item.input });
  };

  const keepPlanning = () => {
    if (sent) return;
    setSent(true);
    // Phrased as what it IS. The default denial ("The user doesn't want to proceed…STOP what
    // you are doing") reads as an abort and stops the turn dead; this keeps Claude in plan
    // mode and pointed at the next message, which is where the user's feedback is about to go.
    session.answer(item.requestId, {
      behavior: 'deny',
      message: 'The user did not approve this plan. Stay in plan mode and wait for their notes on what to change.',
    });
  };

  return (
    <div className="chat-plancard">
      <CardHeader
        glyph="📋"
        title="Plan ready"
        aside={<span className="chat-plancard-tool">{item.toolName}</span>}
      />
      <div className="chat-plancard-body">
        <div className="chat-plancard-plan">
          <MarkdownPreview content={item.plan} />
        </div>
        <div className="chat-plancard-decide">
          <p className="chat-plancard-note">
            Approving leaves plan mode — Claude starts making changes.
          </p>
          <div className="chat-plancard-actions">
            <button type="button" className="chat-btn pill" disabled={sent} onClick={keepPlanning}>
              Keep planning
            </button>
            <button type="button" className="chat-btn pill primary" disabled={sent} onClick={approve}>
              Approve &amp; build <span aria-hidden>→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
