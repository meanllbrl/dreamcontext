import { useState, type ReactNode } from 'react';
import { revealPath } from './chatEntities';

/**
 * What a surface showing ONE file owes the user besides the file itself: the two ways out to
 * the operating system, and a line saying so when one of them doesn't go.
 *
 * It exists because "open it in the app" and "I need the actual file" are different needs and
 * the app kept answering only the first. The slide-over offered "Reveal in Finder" for a
 * FOLDER and nothing at all for a file — so the moment the in-app preview wasn't enough (a
 * format nothing here renders, a PDF to print, a screenshot to drag into Slack, a source file
 * to open in an editor) the panel was a dead end with the path sitting right there in its
 * header. Now every surface that shows a file — the panel, the PDF viewer, the image
 * lightbox — carries the same two buttons in the same place.
 *
 * The two are deliberately separate rather than one smart button:
 *   • **Open on computer** hands it to the default app (`mode: 'auto'` — the route still
 *     refuses to LAUNCH an executable and shows it in the file manager instead, which is the
 *     unchanged safety story and not something this component may override);
 *   • **Reveal in Finder** asks for the file manager outright (`mode: 'reveal'`), because
 *     "where is this?" is a real question and answering it by opening the file is not an
 *     answer to it.
 *
 * A failure SAYS so, in the surface itself. Every one of these call sites used to swallow the
 * route's refusal, which made a click on an unreachable file indistinguishable from one that
 * opened behind the window (owner report 07-28).
 */
export function FileActions({
  path, extra, className, compact,
}: {
  /** The file, as the transcript named it. Resolved server-side — see `resolveChatReference`. */
  path: string;
  /** Surface-specific buttons placed BEFORE the OS ones (the panel's "Open in app ↗"). */
  extra?: ReactNode;
  className?: string;
  /** Icon-and-short-label form, for a viewer's chrome rather than a panel's toolbar. */
  compact?: boolean;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'open' | 'reveal' | null>(null);

  const handoff = (mode: 'auto' | 'reveal') => {
    setNote(null);
    setBusy(mode === 'auto' ? 'open' : 'reveal');
    void revealPath(path, mode).then((err) => {
      setBusy(null);
      setNote(err);
    });
  };

  const copyPath = () => {
    void navigator.clipboard?.writeText(path).then(
      () => setNote(null),
      () => setNote('couldn’t copy the path'),
    );
  };

  return (
    <div className={`chat-fileactions${compact ? ' compact' : ''}${className ? ` ${className}` : ''}`}>
      <div className="chat-fileactions-row">
        {extra}
        <button type="button" className="chat-btn" onClick={() => handoff('auto')} disabled={busy !== null}>
          <span aria-hidden>↗</span> {busy === 'open' ? 'Opening…' : 'Open on computer'}
        </button>
        <button type="button" className="chat-btn" onClick={() => handoff('reveal')} disabled={busy !== null}>
          <span aria-hidden>📁</span> {busy === 'reveal' ? 'Showing…' : 'Reveal in Finder'}
        </button>
        <button type="button" className="chat-btn" onClick={copyPath}>
          <span aria-hidden>⧉</span> Copy path
        </button>
      </div>
      {note && <p className="chat-fileactions-note">Couldn’t do that — {note}</p>}
    </div>
  );
}
