import type { StatusHistoryRow } from '../../../hooks/useTasks';
import { findAgent, useAgents } from '../../../hooks/useAgents';
import { useStatusModel } from '../../../hooks/useTasks';
import { useI18n } from '../../../context/I18nContext';
import { tr } from '../../../lib/assignToAgent';
import { authorText } from '../../../lib/taskAgentJob';
import { Section } from './BodySections';

/** Who moved the task's status and when (AI Team v2 C2, provenance from C1-13), newest first. */
export function HistorySection({ history }: { history: readonly StatusHistoryRow[] }) {
  const { t } = useI18n();
  const { data: agents } = useAgents();
  const sm = useStatusModel();
  if (history.length === 0) return null;
  const nameOf = (slug: string) => findAgent(agents, slug)?.title ?? slug;
  return (
    <Section k="history" title={tr(t, 'tasks.history', 'History')} count={history.length}>
      <ol className="dlog-list">
        {history.slice(0, 30).map((h, i) => (
          <li key={`${h.date}-${i}`} className="dlog-row dhist-row">
            <span className="dlog-date">{h.date}</span>
            <span className="dhist-text">
              <span className="dhist-to">{sm.labelOf(h.to)}</span>
              {h.by && <span className="dhist-by">{tr(t, 'tasks.history.by', 'by {who}', { who: authorText(h.by, t, nameOf) })}</span>}
              {h.reason && <span className="dhist-reason">{h.reason}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}
