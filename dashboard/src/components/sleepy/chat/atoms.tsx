import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  toolGlyph, formatTokenCount, formatDuration, avatarHue, splitInlineCode, pathChipLabel,
} from './chatEntities';
import './atoms.css';

/**
 * ATOMS — the indivisible presentational units of the Agent Chat transcript.
 *
 * Atomic-design layer 1: every export here renders ONE thing, takes only primitive
 * props, holds no session/business state, and never reaches for `ChatSession`. Molecules
 * (`molecules.tsx`) compose these into headers/blocks; organisms (`ToolCard.tsx`,
 * `TranscriptItem.tsx`) bind transcript data to those molecules. Adding a visual to the
 * chat means composing atoms, not writing new one-off markup in an organism.
 *
 * Styling lives in `atoms.css` and reads design tokens only (`--color-*`, `--space-*`,
 * `--radius-*`, `--font-size-*`), so light/dark is automatic. The single documented
 * exception (always-dark shell surfaces) is owned by `molecules.css`'s terminal block.
 */

// ─── Status ────────────────────────────────────────────────────────────────────────

export type ToolStatus = 'running' | 'done' | 'error';

/** Tool-call state. The dot carries an `aria-label` and errors ALSO print a "failed"
 *  word (see {@link StatusWord}) — state is never signalled by color alone. */
export function StatusDot({ status }: { status: ToolStatus }) {
  return <span className="chat-a-dot" data-status={status} role="img" aria-label={`Status: ${status}`} />;
}

/** The non-color half of the error signal — rendered next to the dot's meta slot. */
export function StatusWord({ status }: { status: ToolStatus }) {
  if (status !== 'error') return null;
  return <span className="chat-a-statusword">failed</span>;
}

// ─── Tool identity ─────────────────────────────────────────────────────────────────

/**
 * The tool's icon. `brand` swaps the generic glyph for the dreamcontext mark — used when a
 * `Skill` row is one of dreamcontext's OWN skills (see `isDreamcontextSkill`), so the app
 * visibly recognises itself at work. Drawn as a CSS mark rather than the logo bitmap:
 * `logo.png` carries a gradient backdrop that reads as a grey smudge at glyph size.
 */
export function ToolGlyph({ name, brand = false }: { name: string; brand?: boolean }) {
  if (brand) return <span className="chat-a-glyph chat-a-glyph-brand" aria-hidden />;
  return <span className="chat-a-glyph" aria-hidden>{toolGlyph(name)}</span>;
}

export function ToolName({ children }: { children: ReactNode }) {
  return <span className="chat-a-toolname">{children}</span>;
}

/**
 * A clickable file reference — opens the slide-over or lightbox for that path.
 *
 * Shows `parent/**filename**`, not the raw path. The chip used to render the whole absolute
 * path and let CSS ellipsis trim it, which trims from the RIGHT: the shared `/Users/<me>/…`
 * prefix survived on every row and the filename — the only part that differed — was thrown
 * away (owner report 08-01). Now the FOLDER is the half that yields under pressure
 * (`flex-shrink` in atoms.css) and the name is pinned, so a narrow pane loses context
 * instead of losing identity. The exact path stays in `title`.
 */
export function PathChip({ path, label, onOpen }: {
  path: string;
  /** Read this instead of `parent/filename`, while still opening `path`. For a row that knows a
   *  better name for the file than the file does — a dreamcontext action names the task the way
   *  the agent typed it, and opens the slug the CLI reported. The parent folder is dropped with
   *  it: a custom label is already the identity, and `title` still carries the exact path. */
  label?: string;
  onOpen: (path: string) => void;
}) {
  const { dir, name } = pathChipLabel(path);
  return (
    <button type="button" className="chat-a-pathchip" title={path} onClick={() => onOpen(path)}>
      {!label && dir && <span className="chat-a-pathchip-dir">{dir}/</span>}
      <span className="chat-a-pathchip-name">{label ?? name}</span>
    </button>
  );
}

/**
 * The same chip shape for a subject with nothing to open behind it — a skill name, a grep
 * pattern, a fetched host. A `<span>`, not a `<button>`: it carries identity, not an action,
 * and a control that does nothing when clicked is worse than no control.
 */
export function SubjectChip({ text, title }: { text: string; title?: string }) {
  return <span className="chat-a-pathchip" data-static="" title={title ?? text}>{text}</span>;
}

// ─── Meta readouts ─────────────────────────────────────────────────────────────────

export function MetaText({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className="chat-a-meta" data-mono={mono || undefined}>{children}</span>;
}

export function Duration({ ms }: { ms: number }) {
  return <span className="chat-a-duration">{formatDuration(ms)}</span>;
}

export function TokenBadge({ tokens }: { tokens: number }) {
  return <span className="chat-a-tokens">{formatTokenCount(tokens)}</span>;
}

/** `+12 −4` — an edit's line delta, sign-prefixed so it reads without the colors. */
export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="chat-a-diffstat">
      <span className="chat-a-diffstat-add">+{added}</span>
      <span className="chat-a-diffstat-rem">−{removed}</span>
    </span>
  );
}

/** Hairline separator inside a pill (label │ value). */
export function PillDivider() {
  return <span className="chat-a-pilldivider" aria-hidden />;
}

/** Disclosure indicator. Decorative — the control that owns it carries `aria-expanded`. */
export function Caret({ open }: { open: boolean }) {
  return <span className="chat-a-caret" data-open={open || undefined} aria-hidden>▸</span>;
}

// ─── Actions ───────────────────────────────────────────────────────────────────────

/**
 * Copy-to-clipboard with a confirmation beat (design: an action's response IS the
 * reward — never a silent state change). `tone="dark"` is the variant that sits on the
 * always-dark terminal surface.
 */
export function CopyButton({
  text, label = 'Copy', tone = 'ghost', className,
}: {
  text: string;
  label?: string;
  tone?: 'ghost' | 'dark';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      () => { /* clipboard unavailable — the label simply doesn't change */ },
    );
  };

  return (
    <button
      type="button"
      className={`chat-a-copy${className ? ` ${className}` : ''}`}
      data-tone={tone}
      data-copied={copied || undefined}
      onClick={copy}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

// ─── Identity & progress (permission / bypass / sub-agent cards) ───────────────────

/** The tool a card is about — `Bash`, `Edit`… Tone follows the card it sits in. */
export function ToolBadge({ name, tone = 'neutral' }: { name: string; tone?: 'neutral' | 'caution' }) {
  return <span className="chat-a-toolbadge" data-tone={tone}>{name}</span>;
}

/** Small mono label pinned to a sub-agent row — its `subagent_type`. */
export function TypeBadge({ children }: { children: ReactNode }) {
  return <span className="chat-a-typebadge">{children}</span>;
}

/**
 * A sub-agent's face: Sleepy, tinted by a hue derived from the agent's name
 * ({@link avatarHue}) so the same agent is the same color everywhere, with no palette to
 * keep in sync. Eyes closed, same character as the dock mascot.
 */
export function AgentAvatar({ name, size = 32 }: { name: string; size?: number }) {
  const hue = avatarHue(name);
  return (
    <span
      className="chat-a-avatar"
      style={{ width: size, height: size, '--avatar-hue': hue } as React.CSSProperties}
      aria-hidden
    >
      <svg viewBox="0 0 32 32" width={size} height={size}>
        <path d="M9 15 q2.5 -3 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M18 15 q2.5 -3 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M12 20 q4 3.5 8 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/**
 * A run's progress. `completed`/`error` fill the track (there is nothing left to do);
 * `running` sweeps INDETERMINATELY — the stream carries no percentage, and a made-up
 * one would be a lie the user reads as fact.
 */
export function ProgressTrack({ status }: { status: 'running' | 'completed' | 'error' | 'stopped' }) {
  return (
    <span
      className="chat-a-progress"
      data-status={status}
      role="progressbar"
      aria-label={`Run ${status}`}
      aria-valuetext={status === 'running' ? 'in progress' : status}
    >
      <span className="chat-a-progress-fill" />
    </span>
  );
}

/** Outline warning triangle — the stream-error banner's mark. */
export function AlertIcon() {
  return (
    <svg className="chat-a-alerticon" viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
      <path d="M12 4.5 21 20H3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 10v4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="17.4" r="0.9" fill="currentColor" />
    </svg>
  );
}

/**
 * A sentence whose backticked spans render as code — the CLI's own permission
 * description, styled without a markdown parser or raw HTML in the render path.
 */
export function CodeSentence({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((part, i) => (
        // eslint-disable-next-line react/no-array-index-key -- positional split of one string
        i % 2 ? <code className="chat-a-inlinecode" key={i}>{part}</code> : <span key={i}>{part}</span>
      ))}
    </>
  );
}

/** One button of a message's floating hover bar (copy / edit / quote / retry). */
export function IconButton({
  label, onClick, children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="chat-a-iconbtn" title={label} aria-label={label} onClick={onClick}>
      <span aria-hidden>{children}</span>
    </button>
  );
}
