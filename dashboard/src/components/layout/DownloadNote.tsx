import { useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { revealPath } from '../../lib/reveal';
import type { ExportNote } from '../../lib/exportDownload';
import './DownloadNote.css';

/**
 * The line an export leaves behind: what happened, and — when a file landed somewhere we
 * know about — a way to go look at it.
 *
 * WHY IT IS SHARED (owner report, 2026-09-02). Three surfaces export a file: the chat
 * block's fullscreen bar, the Saved-blocks report composer, and a Lab report. All three
 * downloaded in silence, and the report was the same each time — "no toast, nothing that
 * says it landed", plus the follow-up ask, "let me open Finder on it". Fixing that per
 * surface would have written the same two controls three times and drifted the wording, so
 * the answer is one component: every export bar reports the same way.
 *
 * Note the asymmetry it encodes. A FAILURE is just words — there is nothing to go and look
 * at. A SUCCESS with a path gets the button, and only the desktop app has a path to give
 * (see `deliverDownload`); in a browser the note names the file and stops, because the
 * browser's own download shelf is already the better answer there.
 */
export function DownloadNote({ note }: { note: ExportNote }) {
  const api = useApi();
  const [revealing, setRevealing] = useState(false);
  /** Replaces the note's own text once we've tried and failed to open the file manager. */
  const [failed, setFailed] = useState<string | null>(null);

  const reveal = () => {
    if (!note.path) return;
    setRevealing(true);
    setFailed(null);
    // `mode: 'reveal'` and not `'auto'`: the ask is "show me where it went", and for a PNG
    // `'auto'` would open Preview instead — the right answer to a different question.
    void revealPath(api, note.path, 'reveal').then((err) => {
      setRevealing(false);
      setFailed(err);
    });
  };

  return (
    <span className="dl-note">
      <span className="dl-note-text" role="status">{failed ?? note.text}</span>
      {note.path && (
        <button
          type="button"
          className="dl-note-btn"
          onClick={reveal}
          disabled={revealing}
          title={`Show ${note.path} in the file manager`}
        >
          <span aria-hidden>📁</span> {revealing ? 'Showing…' : 'Show'}
        </button>
      )}
    </span>
  );
}
