import { useState } from 'react';
import type { AgentJobDelivery } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { useI18n } from '../../../context/I18nContext';
import { tr } from '../../../lib/assignToAgent';
import { shortWhen } from '../../../lib/taskAgentJob';
import { BrainFileViewer } from '../../agents/BrainFileViewer';
import { Section } from './BodySections';

/**
 * What the agent delivered, newest round first (AI Team v2 C2): its note, the brain files it
 * named (opened in the app, routed by type as Chat opens them), and for code its branch with the
 * commits it carried, read-only (the agent never merges; the owner does).
 */
export function DeliveriesSection({ deliveries }: { deliveries: readonly AgentJobDelivery[] }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const [open, setOpen] = useState<string | null>(null);
  // Keyed by the delivery, not its index: a newer round re-sorts the list.
  const [commitsOf, setCommitsOf] = useState<string | null>(null);
  if (deliveries.length === 0) return null;
  const list = [...deliveries].sort((a, b) => b.round - a.round || b.at.localeCompare(a.at));
  return (
    <Section k="deliveries" title={tr(t, 'tasks.deliveries', 'Deliveries')} count={deliveries.length}>
      <ol className="ddel-list">
        {list.map((d) => (
          <li key={`${d.round}-${d.at}`} className="ddel-item">
            <div className="ddel-meta">
              <span className="ddel-round">{tr(t, 'tasks.deliveryRound', 'Round {round}', { round: String(d.round) })}</span>
              <span>{findAgent(agents, d.by)?.title ?? d.by}</span>
              <span className="ddel-when">{shortWhen(d.at)}</span>
            </div>
            {d.note && <p className="ddel-note">{d.note}</p>}
            {d.refs.filter((r) => r.kind !== 'branch').length > 0 && (
              <ul className="ddel-refs">
                {d.refs.filter((r) => r.kind !== 'branch').map((r) => (
                  <li key={r.path}>
                    <button type="button" className="ddel-ref" onClick={() => setOpen(r.path)} title={r.path}>
                      <span className="ddel-ref-kind">{r.kind === 'board' ? tr(t, 'tasks.deliveryBoard', 'Board') : r.kind === 'doc' ? tr(t, 'tasks.deliveryDoc', 'Doc') : tr(t, 'tasks.deliveryFile', 'File')}</span>
                      <span className="ddel-ref-name">{r.path.split('/').pop()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {d.branch && (
              <div className="ddel-branch">
                <button type="button" className="ddel-ref" onClick={() => setCommitsOf(commitsOf === `${d.round}-${d.at}` ? null : `${d.round}-${d.at}`)} aria-expanded={commitsOf === `${d.round}-${d.at}`}>
                  <span className="ddel-ref-kind">{tr(t, 'tasks.deliveryBranch', 'Branch')}</span>
                  <code className="ddel-ref-name">{d.branch}</code>
                  <span className="ddel-count">{tr(t, 'tasks.deliveryCommits', '{n} commits', { n: String(d.commits.length) })}</span>
                </button>
                {commitsOf === `${d.round}-${d.at}` && (
                  <ul className="ddel-commits" aria-label={tr(t, 'tasks.deliveryCommitList', 'Commits on the branch')}>
                    {d.commits.length === 0
                      ? <li className="ddel-empty">{tr(t, 'tasks.deliveryNoCommits', 'No commits over its base.')}</li>
                      : d.commits.map((c) => {
                        const [sha, ...rest] = c.split(' ');
                        return <li key={c}><code>{sha}</code> {rest.join(' ')}</li>;
                      })}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
      {open && <BrainFileViewer path={open} onClose={() => setOpen(null)} onOpenPath={setOpen} />}
    </Section>
  );
}
