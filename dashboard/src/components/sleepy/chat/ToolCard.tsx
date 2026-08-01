import { memo, useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import {
  parseEditDiff, deriveDiffStartLine, GENERIC_RESULT_CHAR_CAP, toolSubject, isDreamcontextSkill,
  stringifyToolValue, toolResultText, toolResultLineCount,
} from './chatEntities';
import { Duration, DiffStat, MetaText, CopyButton } from './atoms';
import { ToolHeader, TerminalBlock, DiffView } from './molecules';
import { DreamActionCard } from './DreamActionCard';
import { parseDreamActions } from './dreamCommand';
import type { ChatToolItem } from '../chatSession';

/**
 * ORGANISM — one tool-call card (state 2's collapsible tool cards, state 9's drill-in
 * reuse). Binds a {@link ChatToolItem} to the shared header + one of three bodies:
 *
 *   Bash          → `TerminalBlock`  (dark shell surface, tone-classified output)
 *   Edit/Write    → `DiffView`       (numeric gutter when the start line is provable)
 *   anything else → raw input/result
 *
 * All layout, spacing, and state colors come from `molecules.tsx` / `atoms.tsx` — this
 * file only decides WHICH molecule a tool renders as, and what its header reads. Reused
 * byte-for-byte in the sub-agent drill-in (`SlideOver`'s `mode:'subagent'`) via
 * `TranscriptItem`.
 */

function inputString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** How big the untruncated result is, for the expander's label. */
function formatByteCount(chars: number): string {
  if (chars < 1024) return `${chars} characters`;
  if (chars < 1024 * 1024) return `${Math.round(chars / 1024)} KB`;
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * ExitPlanMode's body: the plan as markdown, not as a JSON dump. Its input is one long
 * markdown string, so the generic body rendered it with every newline escaped — a wall of
 * `\n`s that was, until the plan got a card of its own, the only place the plan could be
 * read at all (owner report 07-26). The decision itself lives in `PlanCard`; this is the
 * receipt you re-open afterwards.
 */
function PlanBody({ plan, result }: { plan: string; result: unknown }) {
  const text = result !== undefined ? toolResultText(result) : '';
  return (
    <div className="chat-toolcard-plan">
      <MarkdownPreview content={plan} />
      {text && <p className="chat-toolcard-planresult">{text}</p>}
    </div>
  );
}

function GenericBody({ item }: { item: ChatToolItem }) {
  const [showAll, setShowAll] = useState(false);
  const input = stringifyToolValue(item.input);
  const result = item.result !== undefined ? stringifyToolValue(item.result) : '';
  // A `Read` comes back WHOLE — a large generated file is megabytes of text, and dropping
  // all of it into a `<pre>` costs the string, the text node, and a layout pass over it
  // every time the card renders. Truncated to a budget with the rest one click away; Copy
  // still hands over the complete result.
  const overBudget = !showAll && result.length > GENERIC_RESULT_CHAR_CAP;
  const shownResult = overBudget ? result.slice(0, GENERIC_RESULT_CHAR_CAP) : result;
  return (
    <div className="chat-toolcard-generic">
      <div className="chat-toolcard-section">
        <span className="chat-toolcard-label">Input</span>
        <pre>{input}</pre>
      </div>
      {result && (
        <div className="chat-toolcard-section">
          <div className="chat-toolcard-section-head">
            <span className="chat-toolcard-label">Result</span>
            <CopyButton text={result} />
          </div>
          <pre>{shownResult}</pre>
          {overBudget && (
            <button type="button" className="chat-toolcard-more" onClick={() => setShowAll(true)}>
              ⋯ show all {formatByteCount(result.length)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCardInner({ item, onOpenFile }: { item: ChatToolItem; onOpenFile: (path: string) => void }) {
  // Only an EDIT opens on its own: what changed in your files is the one tool body you
  // always want to see. Everything else — Bash above all — stays a one-line receipt you
  // can open (owner call 07-25: an agent turn is mostly shell calls, and their expanded
  // terminal blocks pushed the actual answer off the screen). `null` means "no explicit
  // choice yet" so the default can still resolve as the tool's input streams in — an early
  // `useState(defaultOpen)` would freeze on the pre-input value.
  const [override, setOverride] = useState<boolean | null>(null);

  const isBash = item.name === 'Bash';
  // A shell call that runs OUR CLI is not a shell call the reader cares about as shell — it is
  // the app acting on itself, and it gets a row that says which action on which object (owner
  // report 08-01). Decided here rather than in `ChatPane` so the drill-in transcript and the
  // run-card rows inherit it for free — this component is the one place a tool row is drawn.
  const dreamActions = isBash ? parseDreamActions(inputString(item.input, 'command')) : [];

  const plan = item.name === 'ExitPlanMode' ? inputString(item.input, 'plan') : undefined;
  const diff = isBash || plan ? null : parseEditDiff(item.input);
  const subject = toolSubject(item.name, item.input);
  const skill = item.name === 'Skill' ? inputString(item.input, 'skill') : undefined;
  const brand = !!skill && isDreamcontextSkill(skill);
  const lineCount = toolResultLineCount(item.result);
  const duration = item.endedAt != null ? item.endedAt - item.startedAt : null;

  // A `prose` subject IS the subtitle (Bash: its description, or failing that its command —
  // a Bash row is never left as the bare word "Bash"). A FILE row instead says how much it
  // read. A line count is only meaningful when the subject is a file: `Skill · 1 lines`
  // (owner report 08-01) measured the length of a skill invocation's ack and called it
  // information.
  const subtitle = subject?.kind === 'prose'
    ? subject.text
    : (subject?.kind === 'path' && lineCount != null && !diff ? `· ${lineCount} lines` : undefined);

  const meta = diff
    ? <DiffStat added={diff.addedN} removed={diff.removedN} />
    : (duration != null ? <Duration ms={duration} /> : (item.status === 'running' ? <MetaText>running</MetaText> : null));

  const open = override ?? !!diff;

  if (dreamActions.length) {
    return (
      <DreamActionCard
        item={item}
        actions={dreamActions}
        open={open}
        onToggle={() => setOverride(!open)}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div className="chat-toolcard" data-status={item.status} data-open={open || undefined}>
      <ToolHeader
        status={item.status}
        name={item.name}
        subject={subject}
        brand={brand}
        badge={brand ? 'dreamcontext skill' : undefined}
        subtitle={subtitle}
        subtitleTitle={isBash ? inputString(item.input, 'command') : undefined}
        meta={meta}
        open={open}
        onToggle={() => setOverride(!open)}
        onOpenPath={onOpenFile}
      />
      {open && (
        <div className="chat-toolcard-body">
          {isBash ? (
            <TerminalBlock
              command={inputString(item.input, 'command')}
              output={item.result !== undefined ? toolResultText(item.result) : undefined}
            />
          ) : plan ? (
            <PlanBody plan={plan} result={item.result} />
          ) : diff ? (
            <DiffView diff={diff} startLine={deriveDiffStartLine(item.result, diff.added[0])} />
          ) : (
            <GenericBody item={item} />
          )}
        </div>
      )}
    </div>
  );
}

/** MEMOIZED for the same reason `ItemView` is — a finished tool card is the single most
 *  expensive thing in the transcript (a diff, a terminal block, a JSON dump) and it never
 *  changes again once its result lands. See `ItemView`'s note on callback stability. */
export const ToolCard = memo(ToolCardInner);
