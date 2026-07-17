import { useMemo } from 'react';
import { diffLines, diffStats } from '../../../lib/lineDiff';
import './SessionDiff.css';

/**
 * "Changes this session" — a git-style unified diff of the task document, from the
 * snapshot taken when the Task Manager opened to what the document says now.
 *
 * Pure view: the baseline lives in TaskDetailPanel (it owns the Task Manager's
 * open/close lifecycle) and the current text arrives as a prop, so this re-renders —
 * live — every time the polled task data changes under an editing agent.
 */
export function SessionDiff({ baseline, current }: { baseline: string; current: string }) {
  const hunks = useMemo(() => diffLines(baseline, current), [baseline, current]);
  const stats = useMemo(() => diffStats(hunks), [hunks]);

  if (hunks.length === 0) {
    return (
      <div className="session-diff session-diff--empty">
        No changes yet — the diff fills in as the Task Manager edits the document.
      </div>
    );
  }

  return (
    <div className="session-diff">
      <div className="session-diff-stats">
        <span className="session-diff-added">+{stats.added}</span>
        <span className="session-diff-removed">−{stats.removed}</span>
        <span className="session-diff-hint">since the Task Manager opened</span>
      </div>
      {hunks.map((h) => (
        <div key={h.header + (h.lines[0]?.text ?? '')} className="session-diff-hunk">
          <div className="session-diff-hunk-head">{h.header}</div>
          <table className="session-diff-table">
            <tbody>
              {h.lines.map((l, i) => (
                <tr key={i} className={`session-diff-line session-diff-line--${l.kind}`}>
                  <td className="session-diff-no">{l.oldNo ?? ''}</td>
                  <td className="session-diff-no">{l.newNo ?? ''}</td>
                  <td className="session-diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
                  <td className="session-diff-text">{l.text || ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
