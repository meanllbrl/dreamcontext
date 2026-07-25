import { useState, type ReactNode } from 'react';
import {
  StatusDot, StatusWord, ToolGlyph, ToolName, PathChip, Caret, CopyButton, TokenBadge,
  PillDivider, type ToolStatus,
} from './atoms';
import { classifyOutputLine, type EditDiff } from './chatEntities';
import './molecules.css';

/**
 * MOLECULES — atoms composed into the transcript's repeating structures.
 *
 * Atomic-design layer 2: still purely presentational (primitive props + callbacks, no
 * `ChatSession`, no fetching), but each one owns a small piece of local UI state where
 * the shape demands it (a diff's "show all", nothing else). Organisms (`ToolCard.tsx`,
 * `TranscriptItem.tsx`) map transcript data onto these; the layout, spacing, and states
 * live here so every card in the view is laid out by the SAME code.
 */

// ─── Tool card header ──────────────────────────────────────────────────────────────

/**
 * The one-line header every tool card shares:
 *
 *   ● 📄 Read  [src/server/routes/agent-chat.ts]  · 142 lines .......... 0.3s ▸
 *
 * The whole row toggles: a single stretched hit-area button (one control, one
 * `aria-expanded`) sits under the row, and only the path chip re-enables pointer events
 * over it — so the row is clickable without ever nesting a button inside a button.
 */
export function ToolHeader({
  status, name, path, subtitle, meta, open, onToggle, onOpenPath,
}: {
  status: ToolStatus;
  name: string;
  path?: string | null;
  /** Left-side context after the chip — `· 142 lines`, a Bash command description. */
  subtitle?: ReactNode;
  /** Right-side readout before the caret — a duration or a diff stat. */
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  onOpenPath?: (path: string) => void;
}) {
  return (
    <div className="chat-m-toolhead">
      <button
        type="button"
        className="chat-m-toolhead-hit"
        aria-expanded={open}
        aria-label={`${name || 'Tool'} details`}
        onClick={onToggle}
      />
      <StatusDot status={status} />
      <ToolGlyph name={name} />
      <ToolName>{name || 'Tool'}</ToolName>
      {path && onOpenPath && <PathChip path={path} onOpen={onOpenPath} />}
      {subtitle && <span className="chat-m-toolhead-sub">{subtitle}</span>}
      <span className="chat-m-toolhead-meta">
        <StatusWord status={status} />
        {meta}
        <Caret open={open} />
      </span>
    </div>
  );
}

// ─── Card header ───────────────────────────────────────────────────────────────────

/**
 * The header every interactive card wears — glyph, title, and a right-hand slot
 * (tool badge, elapsed clock, spinner), closed by a hairline. `tone="caution"` is the
 * amber identity the bypass notice and any other "you weren't asked" surface uses.
 */
export function CardHeader({
  glyph, title, aside, tone = 'neutral',
}: {
  glyph?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  tone?: 'neutral' | 'caution';
}) {
  return (
    <div className="chat-m-cardhead" data-tone={tone}>
      {glyph && <span className="chat-m-cardhead-glyph" aria-hidden>{glyph}</span>}
      <span className="chat-m-cardhead-title">{title}</span>
      {aside && <span className="chat-m-cardhead-aside">{aside}</span>}
    </div>
  );
}

// ─── Terminal block (always-dark shell surface) ────────────────────────────────────

/**
 * A shell command and its output on a dark surface — the one place in chat that keeps a
 * fixed palette in both themes (documented exception, same rationale as the embedded
 * terminal: a shell should read as a shell). Line tones come from
 * {@link classifyOutputLine}, so a passing test run is legible at a glance.
 */
export function TerminalBlock({ command, output }: { command?: string; output?: string }) {
  const copyable = [command ? `$ ${command}` : '', output ?? ''].filter(Boolean).join('\n');
  if (!copyable) return null;
  return (
    <div className="chat-m-terminal">
      {/* Only output is worth a Copy button — a bare command preview (a permission card's)
          is one short line, and a button there is chrome over nothing. */}
      {output && <CopyButton text={copyable} label="Copy output" tone="dark" className="chat-m-terminal-copy" />}
      <div className="chat-m-terminal-body">
        {command && (
          <div className="chat-m-terminal-line chat-m-terminal-cmd">
            <span className="chat-m-terminal-prompt" aria-hidden>$</span>
            {command}
          </div>
        )}
        {output?.split('\n').map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key -- output lines have no id; the array is replaced wholesale on every result
          <div key={i} className="chat-m-terminal-line" data-tone={classifyOutputLine(line)}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Diff ──────────────────────────────────────────────────────────────────────────

/** Rows rendered before the "+N more lines" cut — a whole-file `Write` would otherwise
 *  paint thousands of nodes into the transcript on every re-render. */
const DIFF_ROW_CAP = 24;

interface DiffRow { tone: 'rem' | 'add'; sign: string; n: number | null; text: string }

/**
 * A line-level diff with a numeric gutter. Line numbers are shown ONLY when the caller
 * could prove them (`startLine`, recovered from the tool result — see
 * `deriveDiffStartLine`); otherwise the gutter keeps the same geometry and shows the
 * −/+ sign instead. Removed and added rows both count from the hunk's first line.
 */
export function DiffView({ diff, startLine }: { diff: EditDiff; startLine?: number }) {
  const [showAll, setShowAll] = useState(false);
  const rows: DiffRow[] = [
    ...diff.removed.map((text, i) => ({
      tone: 'rem' as const, sign: '−', n: startLine != null ? startLine + i : null, text,
    })),
    ...diff.added.map((text, i) => ({
      tone: 'add' as const, sign: '+', n: startLine != null ? startLine + i : null, text,
    })),
  ];
  const hidden = showAll ? 0 : Math.max(0, rows.length - DIFF_ROW_CAP);
  const shown = hidden ? rows.slice(0, DIFF_ROW_CAP) : rows;

  return (
    <div className="chat-m-diff">
      {shown.map((row, i) => (
        // eslint-disable-next-line react/no-array-index-key -- diff rows are positional by nature
        <div key={i} className="chat-m-diff-row" data-tone={row.tone}>
          <span className="chat-m-diff-gutter" aria-hidden>{row.n ?? row.sign}</span>
          <span className="chat-m-diff-sign" aria-hidden>{row.n != null ? row.sign : ''}</span>
          <span className="chat-m-diff-text">{row.text || ' '}</span>
        </div>
      ))}
      {hidden > 0 && (
        <button type="button" className="chat-m-diff-more" onClick={() => setShowAll(true)}>
          +{hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
    </div>
  );
}

// ─── Thinking pill ─────────────────────────────────────────────────────────────────

/**
 * The extended-thinking disclosure:  ⟨ 💭 Thinking… │ 2.4k tokens ▾ ⟩ — a dashed pill
 * that reads as "in progress, not a message". Shimmers while the block is still
 * streaming, settles to a static label when it completes.
 */
export function ThinkingPill({
  streaming, tokens, open, onToggle, body,
}: {
  streaming: boolean;
  tokens: number;
  open: boolean;
  onToggle: () => void;
  body: string;
}) {
  return (
    <div className="chat-m-thinking" data-streaming={streaming || undefined}>
      <button type="button" className="chat-m-thinking-head" onClick={onToggle} aria-expanded={open}>
        <span className="chat-m-thinking-glyph" aria-hidden>💭</span>
        <span className="chat-m-thinking-label">Thinking{streaming ? '…' : ''}</span>
        <PillDivider />
        <TokenBadge tokens={tokens} />
        <Caret open={open} />
      </button>
      {open && <div className="chat-m-thinking-body">{body}</div>}
    </div>
  );
}

// ─── Message chrome ────────────────────────────────────────────────────────────────

/** The floating action bar that fades in on message hover / keyboard focus. */
export function HoverActions({ children }: { children: ReactNode }) {
  return (
    <div className="chat-m-hoverbar" role="toolbar" aria-label="Message actions">
      {children}
    </div>
  );
}

/** Inline confirmation for a destructive-ish message action (rewind, retry). */
export function ConfirmPrompt({
  note, confirmLabel, onConfirm, onCancel,
}: {
  note: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="chat-m-confirm">
      <p className="chat-m-confirm-note">{note}</p>
      <div className="chat-m-confirm-actions">
        <button type="button" className="chat-btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="chat-btn primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  );
}
