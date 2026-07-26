import { memo, useState } from 'react';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { parseEditDiff, deriveDiffStartLine, GENERIC_RESULT_CHAR_CAP } from './chatEntities';
import { Duration, DiffStat, MetaText, CopyButton } from './atoms';
import { ToolHeader, TerminalBlock, DiffView } from './molecules';
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

function safeStringify(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/** The tool's primary path/file argument, if it has one — the header's clickable chip. */
function primaryPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

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

/** A short "N lines" meta label for a string result — omitted for anything else. */
function resultLineCount(result: unknown): number | null {
  return typeof result === 'string' && result.length ? result.split('\n').length : null;
}

/** Flatten a tool_result `content` value (string, or an array of `{type:'text',text}`
 *  blocks) into plain text for the terminal block / Copy button. */
function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
        ? (b as Record<string, unknown>).text as string
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return safeStringify(result);
}

/**
 * ExitPlanMode's body: the plan as markdown, not as a JSON dump. Its input is one long
 * markdown string, so the generic body rendered it with every newline escaped — a wall of
 * `\n`s that was, until the plan got a card of its own, the only place the plan could be
 * read at all (owner report 07-26). The decision itself lives in `PlanCard`; this is the
 * receipt you re-open afterwards.
 */
function PlanBody({ plan, result }: { plan: string; result: unknown }) {
  const text = result !== undefined ? resultText(result) : '';
  return (
    <div className="chat-toolcard-plan">
      <MarkdownPreview content={plan} />
      {text && <p className="chat-toolcard-planresult">{text}</p>}
    </div>
  );
}

function GenericBody({ item }: { item: ChatToolItem }) {
  const [showAll, setShowAll] = useState(false);
  const input = safeStringify(item.input);
  const result = item.result !== undefined ? safeStringify(item.result) : '';
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
  const plan = item.name === 'ExitPlanMode' ? inputString(item.input, 'plan') : undefined;
  const diff = isBash || plan ? null : parseEditDiff(item.input);
  const path = primaryPath(item.input);
  const lineCount = resultLineCount(item.result);
  const duration = item.endedAt != null ? item.endedAt - item.startedAt : null;

  // Bash names what it is doing; a file tool names how much it read. Either way the
  // header stays one line — the body is where the detail lives.
  const subtitle = isBash
    ? inputString(item.input, 'description')
    : (lineCount != null && !diff ? `· ${lineCount} lines` : undefined);

  const meta = diff
    ? <DiffStat added={diff.addedN} removed={diff.removedN} />
    : (duration != null ? <Duration ms={duration} /> : (item.status === 'running' ? <MetaText>running</MetaText> : null));

  const open = override ?? !!diff;

  return (
    <div className="chat-toolcard" data-status={item.status} data-open={open || undefined}>
      <ToolHeader
        status={item.status}
        name={item.name}
        path={path}
        subtitle={subtitle}
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
              output={item.result !== undefined ? resultText(item.result) : undefined}
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
