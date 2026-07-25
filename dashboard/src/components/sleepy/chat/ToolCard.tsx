import { useState } from 'react';
import { parseEditDiff, deriveDiffStartLine } from './chatEntities';
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

function GenericBody({ item }: { item: ChatToolItem }) {
  const input = safeStringify(item.input);
  const result = item.result !== undefined ? safeStringify(item.result) : '';
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
          <pre>{result}</pre>
        </div>
      )}
    </div>
  );
}

export function ToolCard({ item, onOpenFile }: { item: ChatToolItem; onOpenFile: (path: string) => void }) {
  // A card whose body carries the signal (a command's output, an edit's diff) opens on
  // its own; a plain read stays a one-line receipt. `null` means "no explicit choice
  // yet" so the default can still resolve as the tool's input streams in — an early
  // `useState(defaultOpen)` would freeze on the pre-input value.
  const [override, setOverride] = useState<boolean | null>(null);

  const isBash = item.name === 'Bash';
  const diff = isBash ? null : parseEditDiff(item.input);
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

  const open = override ?? (isBash || !!diff);

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
