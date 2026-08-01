import { toolResultText, toolResultLineCount, type ToolSubject } from './chatEntities';
import { Duration, MetaText } from './atoms';
import { ToolHeader, TerminalBlock } from './molecules';
import { describeDreamAction, dreamOutcome, type DreamAction } from './dreamCommand';
import type { ChatToolItem } from '../chatSession';
import './dreamaction.css';

/**
 * ORGANISM — a shell call that ran dreamcontext's OWN CLI, rendered as the ACTION it performed.
 *
 * Owner report 08-01: the agent does most of its work on this project through this project, and
 * every one of those calls arrived as an anonymous `▶ Bash` row wearing whatever sentence the
 * agent wrote in `description` ("Create the task", "Insert remaining acceptance criteria").
 * Which task? What went in? The row never said, while the command line it was hiding said all
 * of it. This card is the same tool row with its subject read out of the command instead of
 * out of a hand-written label:
 *
 *   ● ◆ Task created   [Chat tool rows name their object]   ......... 9.5s ▸
 *   ● ◆ Task status    [chat-tool-rows-…]  → in_progress    ......... 1.2s ▸
 *   ● ◆ Memory recall  [context root resolution]  · 24 lines ........ 0.8s ▸
 *
 * It is a `ToolHeader` — deliberately, not a bespoke row. Geometry, hit area, caret, aria
 * state, and the 40px density the transcript was tuned to all come from the shared molecule, so
 * a dreamcontext row sits in a column of ordinary tool rows without disturbing it. What marks
 * it as ours is the brand mark in the glyph slot and a tinted left edge (a tinted SURFACE, per
 * this project's own pattern — never a filled swatch), which is what makes it recognisable at a
 * glance even in the middle of a group.
 */
export function DreamActionCard({
  item, actions, open, onToggle, onOpenFile,
}: {
  item: ChatToolItem;
  /** Every dreamcontext invocation in this one command, in order — an agent routinely chains
   *  several with `&&`, and a card that reported only the first would be wrong about the row. */
  actions: DreamAction[];
  open: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
}) {
  const command = commandOf(item);
  const result = item.result !== undefined ? toolResultText(item.result) : undefined;

  // The card is titled by the FIRST action (the one the agent set out to do); the rest are
  // counted on the row and listed in full when it opens.
  const primary = actions[0];
  const view = describeDreamAction(primary);
  const outcome = dreamOutcome(result, primary.domain);

  // A CLI that printed `✗` FAILED, whatever the exit code was — `error()` writes the glyph and
  // several commands still exit 0 after it. Reporting that row as a clean green dot would be
  // the card telling a more comfortable story than the output it is showing.
  const status = outcome?.tone === 'error' ? 'error' : item.status;

  const subject: ToolSubject | null = view.subject
    // Openable only when the CLI itself named a file — see `dreamOutcome`. The chip still reads
    // as the thing the agent named ("Chat tool rows name their object"), so the click is a
    // bonus on top of the identity rather than a different label.
    ? (outcome?.path
      ? { kind: 'path', path: outcome.path, label: view.subject }
      : { kind: 'text', text: view.subject })
    : null;

  const subtitle = subtitleFor({
    view, outcome, status: item.status, extra: actions.length - 1, lines: toolResultLineCount(item.result),
  });

  const duration = item.endedAt != null ? item.endedAt - item.startedAt : null;

  return (
    <div
      className="chat-toolcard chat-dreamcard"
      data-status={status}
      data-open={open || undefined}
      data-tone={view.tone}
    >
      <ToolHeader
        status={status}
        name={actions.length > 1 && sameAction(actions) ? `${view.label} ×${actions.length}` : view.label}
        subject={subject}
        brand
        subtitle={subtitle}
        subtitleTitle={view.desc ?? command}
        meta={duration != null ? <Duration ms={duration} /> : (item.status === 'running' ? <MetaText>running</MetaText> : null)}
        open={open}
        onToggle={onToggle}
        onOpenPath={onOpenFile}
      />
      {open && (
        <div className="chat-toolcard-body">
          {/* Only when the row is summarising more than it can say — one action is already
              fully described by the header, and repeating it under itself is chrome. */}
          {actions.length > 1 && <ActionList actions={actions} />}
          <TerminalBlock command={command} output={result} />
        </div>
      )}
    </div>
  );
}

/** Every action in the chain, as the header would have said each one. */
function ActionList({ actions }: { actions: DreamAction[] }) {
  return (
    <ol className="chat-dreamcard-list">
      {actions.map((action, i) => {
        const view = describeDreamAction(action);
        return (
          // eslint-disable-next-line react/no-array-index-key -- a chain is positional; two identical calls are legitimately two rows
          <li key={i} className="chat-dreamcard-listrow" data-tone={view.tone}>
            <span className="chat-dreamcard-listlabel">{view.label}</span>
            {view.subject && <span className="chat-dreamcard-listsubject" title={action.raw}>{view.subject}</span>}
            {view.detail && <span className="chat-dreamcard-listdetail">→ {view.detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function commandOf(item: ChatToolItem): string | undefined {
  if (!item.input || typeof item.input !== 'object') return undefined;
  const v = (item.input as Record<string, unknown>).command;
  return typeof v === 'string' && v ? v : undefined;
}

/** Do all the chained calls hit the same endpoint? Then the row can say `Task inserted ×5`
 *  instead of naming one of five identical actions and hiding the rest behind a count. */
function sameAction(actions: DreamAction[]): boolean {
  return actions.every((a) => a.path === actions[0].path);
}

/**
 * The one line of context after the chip — at most one fact, chosen by what the row cannot
 * already be read to say.
 *
 * Order matters and is the whole design: a FAILURE outranks everything (it is the reason to
 * look at the row at all), then the second positional argument (`→ in_progress` is the actual
 * content of a status change), then — only while it is still running — the endpoint's own
 * description, because a finished `Task created` explaining "Create a new task" spends a line
 * on nothing. A read that returned output says how much.
 */
function subtitleFor({ view, outcome, status, extra, lines }: {
  view: ReturnType<typeof describeDreamAction>;
  outcome: ReturnType<typeof dreamOutcome>;
  status: ChatToolItem['status'];
  extra: number;
  lines: number | null;
}): React.ReactNode {
  const more = extra > 0 ? `+${extra} more` : null;
  let note: React.ReactNode = null;

  if (outcome && outcome.tone !== 'ok') {
    note = <span className="chat-dreamcard-note" data-tone={outcome.tone}>{outcome.text}</span>;
  } else if (view.detail) {
    note = `→ ${view.detail}`;
  } else if (!view.subject && outcome) {
    // Nothing was named on the row, so the CLI's own sentence is the only identity it has.
    note = outcome.text;
  } else if (status === 'running') {
    note = view.desc;
  } else if (view.tone === 'read' && lines != null) {
    note = `· ${lines} lines`;
  }

  if (note && more) return <>{note} · {more}</>;
  return note ?? more;
}
