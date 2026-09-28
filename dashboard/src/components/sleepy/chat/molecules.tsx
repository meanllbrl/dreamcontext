import { useState, type ReactNode } from 'react';
import {
  StatusDot, StatusWord, ToolGlyph, ToolName, PathChip, SubjectChip, Caret, CopyButton,
  TokenBadge, AgentAvatar, type ToolStatus,
} from './atoms';
import {
  classifyOutputLine, clampLines, pathChipLabel, TERMINAL_HEAD_LINES, TERMINAL_TAIL_LINES,
  type EditDiff, type ToolSubject,
} from './chatEntities';
import { actionText, thinkingLabel, type ToolAction } from './toolAction';
import { AGENT_ROLES, type AgentRoleId } from '../../../lib/agentRoles';
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
 *   ● 📄 Read  [routes/agent-chat.ts]  · 142 lines ................... 0.3s ▸
 *   ● ◆  excalidraw  [dreamcontext skill] ........................... 5.4s ▸
 *
 * The row's SUBJECT (see `toolSubject`) is what identifies it — the file, the skill, the
 * pattern. When the subject is a text identity with a tool name that adds nothing over it
 * (`Skill excalidraw` reads as a stutter), the subject becomes the row's name outright and
 * the tool name is dropped; `title` keeps it for anyone who needs to know which tool ran.
 *
 * The whole row toggles: a single stretched hit-area button (one control, one
 * `aria-expanded`) sits under the row, and only the path chip re-enables pointer events
 * over it — so the row is clickable without ever nesting a button inside a button.
 *
 * Given an `action`, the same row is written as a team-log line instead (see
 * {@link ActionHeader}); every transcript row passes one, and the tool-row form above stays for
 * any caller that does not.
 */
export function ToolHeader({
  status, name, subject, brand = false, badge, subtitle, subtitleTitle, meta, open, onToggle, onOpenPath,
  action, actor, toolName, stretchRunning = false,
}: {
  status: ToolStatus;
  name: string;
  /** What the call acted on. A `path` chip opens; a `text` chip only names. */
  subject?: ToolSubject | null;
  /** Draw the dreamcontext mark instead of the tool glyph (our own skills). */
  brand?: boolean;
  /** A chip shown where the subject chip would be when the subject became the row's NAME —
   *  it says what kind of thing the name is (`dreamcontext skill`), which is the sentence the
   *  mark alone can't finish. */
  badge?: string;
  /** Left-side context after the chip — `· 142 lines`, a Bash command description. */
  subtitle?: ReactNode;
  /** Hover text for the subtitle — the UNcondensed command, for a Bash row labelled by its
   *  command rather than a description. */
  subtitleTitle?: string;
  /** Right-side readout before the caret — a duration or a diff stat. */
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  onOpenPath?: (path: string) => void;
  /** The step as a sentence (`toolAction`). Present, the row is a TEAM-LOG line: the speaker's
   *  avatar, then the sentence, its tense carrying the status. Absent, the row is drawn as the
   *  tool row it always was (the header below the `action` branch). */
  action?: ToolAction;
  /** Who took the step. Defaults to the lead. */
  actor?: AgentRoleId;
  /** The raw tool name, for the row's title and details label. Defaults to `action.raw`. */
  toolName?: string;
  /** A step in this row's stretch is running: the avatar works. Only the stretch's lead
   *  shows its avatar, so this only ever moves one face per stretch. */
  stretchRunning?: boolean;
}) {
  if (action) {
    return (
      <ActionHeader
        action={action}
        actor={actor ?? 'lead'}
        raw={toolName ?? action.raw}
        running={stretchRunning}
        brand={brand}
        badge={badge}
        subtitle={subtitle}
        subtitleTitle={subtitleTitle}
        meta={meta}
        open={open}
        onToggle={onToggle}
        onOpenPath={onOpenPath}
      />
    );
  }
  // A `Skill` whose subject is `excalidraw` should read "excalidraw", not "Skill excalidraw"
  // — the tool name is a category the subject already implies. Only for the tools whose name
  // is pure category (Skill/Agent/Task); `Grep "useGroupCollapse"` genuinely needs both,
  // because the pattern alone doesn't say it was a search.
  const nameIsRedundant = subject?.kind === 'text' && (name === 'Skill' || name === 'Agent' || name === 'Task');
  return (
    <div className="chat-m-toolhead" title={nameIsRedundant ? name : undefined}>
      <button
        type="button"
        className="chat-m-toolhead-hit"
        aria-expanded={open}
        aria-label={`${name || 'Tool'} details`}
        onClick={onToggle}
      />
      <StatusDot status={status} />
      <ToolGlyph name={name} brand={brand} />
      {nameIsRedundant
        ? (
          <>
            <ToolName>{(subject as { text: string }).text}</ToolName>
            {badge && <SubjectChip text={badge} title={`${name}: ${(subject as { text: string }).text}`} />}
          </>
        )
        : (
          <>
            <ToolName>{name || 'Tool'}</ToolName>
            {subject?.kind === 'path' && onOpenPath && <PathChip path={subject.path} label={subject.label} onOpen={onOpenPath} />}
            {subject?.kind === 'text' && <SubjectChip text={subject.text} />}
          </>
        )}
      {subtitle && <span className="chat-m-toolhead-sub" title={subtitleTitle}>{subtitle}</span>}
      <span className="chat-m-toolhead-meta">
        <StatusWord status={status} />
        {meta}
        <Caret open={open} />
      </span>
    </div>
  );
}

/** The transcript-step avatar (lib/agentRoles.ts size table): the lead's face, no badge. */
const STEP_AVATAR_PX = 16;

/** Take a trailing "…" or "..." off, so a description the agent already ended in dots never
 *  reads "Deploying the preview build……" once the row adds its own. */
function trimEllipsis(text: string): string {
  return text.replace(/\s*(?:…|\.\.\.)\s*$/, '');
}

/**
 * The team-log line (`ToolHeader` with an `action`):
 *
 *   (◡) Reading  [chat/ChatPane.tsx]…  · 142 lines ....................... 0.3s ▸
 *   (◡) ◆ Creating task  [Quest demo]… ................................... running ▸
 *       Couldn't edit  [chat/ChatPane.tsx] ............................... 0.2s ▸
 *
 * The verb's TENSE is the status, and its ink says it again (the `.chat-step` root's
 * `data-status` picks it in molecules.css), so the dot and the "failed" word the tool row
 * needed are gone. The avatar column is always laid out; a row that follows its stretch's
 * lead hides the face with `visibility`, so every line of a stretch starts at the same x.
 * Same hit button, same 32px row as `ToolHeader`: only what is written in it changed.
 */
function ActionHeader({
  action, actor, raw, running, brand, badge, subtitle, subtitleTitle, meta, open, onToggle, onOpenPath,
}: {
  action: ToolAction;
  actor: AgentRoleId;
  raw: string;
  running: boolean;
  brand: boolean;
  badge?: string;
  subtitle?: ReactNode;
  subtitleTitle?: string;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  onOpenPath?: (path: string) => void;
}) {
  const { subject, tail } = action;
  // A path or a name is the step's object and reads as a chip; prose (a command, a description)
  // is context and reads as the muted subtitle, unless the caller has a better one.
  const chip = subject?.kind === 'path'
    ? (onOpenPath
      ? <PathChip path={subject.path} label={subject.label} onOpen={onOpenPath} />
      : <SubjectChip text={subject.label ?? pathChipLabel(subject.path).name} title={subject.path} />)
    : subject?.kind === 'text' ? <SubjectChip text={subject.text} /> : null;
  const sub = subtitle ?? (subject?.kind === 'prose' ? subject.text : undefined);
  // Only the LAST written piece can carry the agent's own dots, and the running "…" is glued
  // to whichever piece that is, text or chip.
  const verb = tail || chip ? action.verb : trimEllipsis(action.verb);
  const ellipsis = action.ellipsis ? <span className="chat-m-toolhead-ellipsis">…</span> : null;
  return (
    <div className="chat-m-toolhead" data-kind={action.kind} title={raw}>
      <button
        type="button"
        className="chat-m-toolhead-hit"
        aria-expanded={open}
        aria-label={`${actionText(action)}, ${raw} details`}
        onClick={onToggle}
      />
      <span className="chat-step-avatar">
        <AgentAvatar name={AGENT_ROLES[actor].label} size={STEP_AVATAR_PX} role={actor} running={running} />
      </span>
      {brand && <ToolGlyph name={raw} brand />}
      <span className="chat-m-toolhead-action">{verb}{!chip && !tail && ellipsis}</span>
      {chip}
      {badge && <SubjectChip text={badge} />}
      {tail
        ? <span className="chat-m-toolhead-tail">{trimEllipsis(tail)}{ellipsis}</span>
        : chip && ellipsis}
      {sub &&<span className="chat-m-toolhead-sub" title={subtitleTitle}>{sub}</span>}
      <span className="chat-m-toolhead-meta">
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
 *
 * Passing `onToggle` turns the header into the card's DISCLOSURE control, borrowing
 * `ToolHeader`'s idiom byte for byte — one stretched hit-area button under the row, one
 * `aria-expanded`, a `Caret` closing the aside — so a collapsed tool card and a collapsed
 * group card read (and are announced) as the same control. A card that passes neither is
 * untouched: no button, no caret, nothing to tab through.
 */
export function CardHeader({
  glyph, title, aside, tone = 'neutral', open, onToggle,
}: {
  glyph?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  tone?: 'neutral' | 'caution';
  open?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="chat-m-cardhead" data-tone={tone} data-interactive={onToggle ? '' : undefined}>
      {onToggle && (
        <button
          type="button"
          className="chat-m-cardhead-hit"
          aria-expanded={!!open}
          aria-label={typeof title === 'string' ? title : 'Details'}
          onClick={onToggle}
        />
      )}
      {glyph && <span className="chat-m-cardhead-glyph" aria-hidden>{glyph}</span>}
      <span className="chat-m-cardhead-title">{title}</span>
      {(aside || onToggle) && (
        <span className="chat-m-cardhead-aside">
          {aside}
          {onToggle && <Caret open={!!open} />}
        </span>
      )}
    </div>
  );
}

// ─── Terminal block (always-dark shell surface) ────────────────────────────────────

/** One run of output rows. Extracted only so the clamped block can render its head and its
 *  tail with the same code; `offset` keeps the positional keys unique across the two. */
function OutputLines({ lines, offset }: { lines: string[]; offset: number }) {
  return (
    <>
      {lines.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key -- output lines have no id; the array is replaced wholesale on every result
        <div key={offset + i} className="chat-m-terminal-line" data-tone={classifyOutputLine(line)}>
          {line || ' '}
        </div>
      ))}
    </>
  );
}

/**
 * A shell command and its output on a dark surface — the one place in chat that keeps a
 * fixed palette in both themes (documented exception, same rationale as the embedded
 * terminal: a shell should read as a shell). Line tones come from
 * {@link classifyOutputLine}, so a passing test run is legible at a glance.
 */
export function TerminalBlock({ command, output }: { command?: string; output?: string }) {
  const [showAll, setShowAll] = useState(false);
  const copyable = [command ? `$ ${command}` : '', output ?? ''].filter(Boolean).join('\n');
  // Clamped by default, keeping BOTH ends — see `clampLines`. A build log or a test run is
  // routinely thousands of lines, and every one of them used to become a DOM node that
  // stayed mounted for the life of the conversation and was re-laid-out on every render of
  // the card. Copy still copies the whole output; nothing is lost, only deferred.
  const all = output ? output.split('\n') : [];
  const clamped = clampLines(all, TERMINAL_HEAD_LINES, TERMINAL_TAIL_LINES);
  const hidden = showAll ? 0 : clamped.hidden;
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
        {hidden === 0 ? (
          <OutputLines lines={all} offset={0} />
        ) : (
          <>
            <OutputLines lines={clamped.head} offset={0} />
            <button type="button" className="chat-m-terminal-more" onClick={() => setShowAll(true)}>
              ⋯ {hidden} more {hidden === 1 ? 'line' : 'lines'}
            </button>
            <OutputLines lines={clamped.tail} offset={all.length - clamped.tail.length} />
          </>
        )}
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
 * The extended-thinking disclosure, as a step of the team log:
 *
 *   (◡) Thinking it through… ........................................ 2.4k tokens ▾
 *   (◡) Thought it through .......................................... 2.4k tokens ▾
 *
 * A line in the same grammar and the same avatar column as a tool step, so a stretch of
 * thinking and tool calls reads as one speaker's run of lines. The label shimmers while the
 * block streams and settles when it completes; the token count sits in the meta, where a
 * step keeps its duration.
 */
export function ThinkingPill({
  streaming, tokens, open, onToggle, body, actor = 'lead', stretch, stretchRunning = false,
}: {
  streaming: boolean;
  tokens: number;
  open: boolean;
  onToggle: () => void;
  body: string;
  /** Who was thinking. Defaults to the lead. */
  actor?: AgentRoleId;
  /** Opens its stretch (shows the avatar) or follows it (keeps the column, hides the face). */
  stretch?: 'lead' | 'follow';
  /** A step in this line's stretch is running. */
  stretchRunning?: boolean;
}) {
  return (
    <div
      className="chat-m-thinking chat-step"
      data-actor={actor}
      data-stretch={stretch}
      data-streaming={streaming || undefined}
    >
      <button type="button" className="chat-m-thinking-head" onClick={onToggle} aria-expanded={open}>
        <span className="chat-step-avatar">
          <AgentAvatar name={AGENT_ROLES[actor].label} size={STEP_AVATAR_PX} role={actor} running={stretchRunning} />
        </span>
        <span className="chat-m-thinking-label">{thinkingLabel(streaming)}</span>
        <span className="chat-m-thinking-meta">
          <TokenBadge tokens={tokens} />
          <Caret open={open} />
        </span>
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
