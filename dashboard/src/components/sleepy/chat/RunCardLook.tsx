import { useEffect, useState, type ReactNode } from 'react';

/**
 * The status look of a run card that ran or is running on this Mac (owner-approved mockup,
 * 2026-11-13): a tinted header (mark, what happened, who got it, time), the last error line on a
 * failure, and a footer row. Presentational only: `RunCard` decides the look and hands in the words.
 */
export type RunLook = 'ok' | 'bad' | 'run';

export function RunStatusHead({ look, title, sub, time }: { look: RunLook; title: string; sub: string; time?: ReactNode }) {
  return (
    <div className="chat-runhead" data-testid="run-card-head">
      <span className="chat-runhead-mark" aria-hidden>{look === 'ok' ? '✓' : look === 'bad' ? '✕' : ''}</span>
      <div className="chat-runhead-text">
        <div className="chat-runhead-title">{title}</div>
        <div className="chat-runhead-sub">{sub}</div>
      </div>
      {time}
    </div>
  );
}

export function RunTime({ at }: { at: number }) {
  return <span className="chat-runhead-time">{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>;
}

/** The running header's clock: m:ss since the card began showing the run. */
export function RunElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="chat-runhead-time" data-testid="run-card-elapsed">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, '0')}</span>;
}

export function RunErrLine({ line }: { line: string }) {
  return <div className="chat-runcard-errline" data-testid="run-card-errline">{line}</div>;
}

/** The collapsed footer: ▸ command, the Output link, and Run again. `command` is the card's own
 *  CommandText (it carries the unsafe-escape drawing); `again` is its button. */
export function RunFold({ open, onToggle, label, command, output, again }: {
  open: boolean; onToggle: () => void; label: string; command: ReactNode; output?: ReactNode; again?: ReactNode;
}) {
  return (
    <div className="chat-runfold" data-testid="run-card-fold">
      <button type="button" className="chat-runfold-chev" aria-expanded={open} aria-label={label} onClick={onToggle}>{open ? '▾' : '▸'}</button>
      {command}
      {output}
      {again}
    </div>
  );
}
