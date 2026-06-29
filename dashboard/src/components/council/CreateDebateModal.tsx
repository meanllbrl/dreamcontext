import { useEffect, useState } from 'react';

interface Props {
  onClose: () => void;
}

/** The command users run in Claude today to convene a council. */
const COUNCIL_COMMAND = '/council';

/**
 * Council is a Lab feature: debates are still convened from Claude, not the
 * dashboard. This dialog is the "New debate" affordance — it sets the
 * expectation (one day this button will open Sleepy pre-filled with your
 * question) and hands the user the path that works today: run the `/council`
 * skill inside Claude. It deliberately does NOT create anything yet.
 */
export function CreateDebateModal({ onClose }: Props) {
  const [copied, setCopied] = useState(false);

  // Esc closes — match the FullscreenOverlay / SaveScopeDialog convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copyCommand = () => {
    navigator.clipboard
      ?.writeText(COUNCIL_COMMAND)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {});
  };

  return (
    <>
      <div className="council-modal-scrim" onClick={onClose} />
      <div
        className="council-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Start a new debate"
      >
        <header className="council-modal-head">
          <h2 className="council-modal-title">
            Start a debate
            <span className="council-lab-badge">Lab</span>
          </h2>
          <button type="button" className="council-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="council-modal-lede">
          Council convenes a panel of AI personas to debate a hard decision across
          several rounds, exposes each one to the others' reasoning, then synthesizes a
          final verdict you can trace back to who argued what.
        </p>

        <div className="council-modal-soon">
          <span className="council-modal-soon-tag">Coming soon</span>
          <p>
            Soon this button will open <strong>Sleepy</strong> pre-filled with a debate
            prompt so you can convene a council without leaving the dashboard. That flow
            isn't wired up yet.
          </p>
        </div>

        <div className="council-modal-now">
          <span className="council-ov-label">Right now</span>
          <p className="council-modal-now-body">
            Open Claude in your project and run the Council skill:
          </p>
          <div className="council-modal-cmd">
            <code>{COUNCIL_COMMAND}</code>
            <button type="button" className="council-modal-cmd-copy" onClick={copyCommand}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="council-modal-hint">
            Tip: phrases like <em>"debate this"</em> or <em>"help me decide"</em> also
            prompt Council automatically. Finished debates show up here, where you can read
            every round, the agent matrix, and the final report.
          </p>
        </div>

        <footer className="council-modal-foot">
          <button type="button" className="council-modal-btn" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </>
  );
}
