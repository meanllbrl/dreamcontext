import type { AutomationRunRef } from '../../../lib/automationRunChat';
import './AutomationRunHeader.css';

/**
 * The card that sits above a reopened automation run's transcript and says whose
 * conversation this is.
 *
 * It exists because of the first bubble. Every other chat in this app opens with something
 * the user typed; this one opens with the approved automation brief ("You are scheduled
 * dreamcontext automation …"), addressed to a machine, by a scheduler, at 11:00, while
 * nobody was here. Rendered without provenance that brief reads as the user's own message,
 * and every turn under it reads as a conversation they had and forgot.
 *
 * So the header is not decoration — it is the difference between a transcript and a
 * transcript you can trust. It carries the four things a reader needs before reading a word
 * of the run: which automation, which run, how it ended, and what it cost.
 *
 * Deliberately NOT here: the report itself. `--output-format json`'s `result` — what the
 * runner writes to the output document — IS the final assistant message, so on a healthy run
 * the file and the last bubble are the same text; rendering it up here would put a long
 * report immediately above an identical copy of itself. The document gets a chip instead,
 * which is what matters for the case where the two DIVERGE (a failed run's file holds the
 * raw stdout tail) and because the file, not the bubble, is the artifact of record.
 */

/** Statuses whose runs can even reach a transcript, mapped to how the card should read.
 *  `blocked`/`deferred`/`orphaned` never started a session, so they cannot appear here —
 *  they are absent by construction, not by omission.
 *
 *  `awaiting-review` is NOT a fault and must never paint the error tint: it means the run
 *  reached a human gate and stopped, which is the feature working. It arrives here when the
 *  chat was opened from the automation's open QUESTION rather than from a history row. */
const STATUS_TONE: Record<string, 'ok' | 'bad' | 'wait'> = {
  ok: 'ok', failed: 'bad', timeout: 'bad', 'awaiting-review': 'wait',
};

/** The word the status chip shows. `awaiting-review` is engine vocabulary; on a chat header
 *  the reader needs the sentence's subject to be THEM. */
const STATUS_WORD: Record<string, string> = { 'awaiting-review': 'waiting for your verdict' };

function formatFired(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Whole seconds under a minute, then `m s` — a run's duration is read for its order of
 *  magnitude ("did that take four seconds or four minutes"), never for its milliseconds. */
function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** The output document's own name — the full path is a chip's tooltip, not its label:
 *  these paths are absolute and long enough to push everything else off the row. */
function outputLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function AutomationRunHeader({
  run, permissionMode, onOpenFile,
}: {
  run: AutomationRunRef;
  /** The mode THIS resumed session spawned under — see the note it renders. */
  permissionMode: 'auto' | 'bypass';
  onOpenFile: (path: string) => void;
}) {
  const tone = STATUS_TONE[run.status] ?? 'bad';
  const duration = formatDuration(run.durationMs);

  return (
    <div className="automation-run-header" data-tone={tone}>
      <div className="arh-top">
        <span className="arh-kicker">Scheduled automation</span>
        <span className="arh-status" data-tone={tone}>{STATUS_WORD[run.status] ?? run.status}</span>
      </div>
      <div className="arh-title">{run.automationTitle}</div>
      <div className="arh-meta">
        {/* Omitted, never faked, when the conversation was reached from its open question:
            the asking run may be off the end of the bounded history, so no row index
            describes it. The fire time below still says WHICH run this is. */}
        {run.runNumber !== null && (<><span>Run #{run.runNumber}</span><span className="arh-dot" aria-hidden>·</span></>)}
        <span>{formatFired(run.firedAt)}</span>
        {run.numTurns !== null && (<><span className="arh-dot" aria-hidden>·</span><span>{run.numTurns} turns</span></>)}
        {duration && (<><span className="arh-dot" aria-hidden>·</span><span>{duration}</span></>)}
        {run.costUsd !== null && (<><span className="arh-dot" aria-hidden>·</span><span>${run.costUsd.toFixed(4)}</span></>)}
      </div>
      {run.outputPath && (
        <button
          type="button"
          className="arh-output"
          title={run.outputPath}
          onClick={() => onOpenFile(run.outputPath!)}
        >
          {outputLabel(run.outputPath)}
        </button>
      )}
      {/* The one thing a reader cannot infer from the transcript, and the one thing that
          would matter most if they got it wrong. The RUN ran under `bypassPermissions` —
          that is what an unattended scheduled job is — but the session they are now typing
          into is a NEW process spawned under the app's own current mode. Neither fact
          implies the other, and a transcript full of un-prompted tool calls invites exactly
          the wrong inference about what the next one will do. */}
      <div className="arh-note">
        This run executed unattended under <code>bypassPermissions</code>. Your continuation
        runs under this app’s current mode
        {permissionMode === 'bypass' ? ', which is also bypass.' : ' (auto), which asks before acting.'}
      </div>
    </div>
  );
}
