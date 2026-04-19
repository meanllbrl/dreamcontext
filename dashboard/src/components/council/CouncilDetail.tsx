import { useEffect, useState } from 'react';
import type { DebateDetail } from '../../hooks/useCouncil';
import { useI18n } from '../../context/I18nContext';
import { StatusBadge } from './StatusBadge';
import { OverviewTab } from './OverviewTab';
import { TranscriptView } from './TranscriptView';
import { ArenaMatrix } from './ArenaMatrix';

type TabKey = 'overview' | 'agents' | 'matrix';

interface Props {
  debate: DebateDetail;
  onBack: () => void;
}

function defaultTab(status: string): TabKey {
  if (status === 'complete') return 'overview';
  if (status === 'synthesizing') return 'overview';
  return 'matrix';
}

export function CouncilDetail({ debate, onBack }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabKey>(() => defaultTab(debate.frontmatter.status));
  const [matrixQuery, setMatrixQuery] = useState('');
  const [selectedCell, setSelectedCell] = useState<{ slug: string; round: number } | null>(null);
  const [focusAgent, setFocusAgent] = useState<string | null>(null);

  // Reset state when debate changes
  useEffect(() => {
    setTab(defaultTab(debate.frontmatter.status));
    setMatrixQuery('');
    setSelectedCell(null);
    setFocusAgent(null);
  }, [debate.frontmatter.id]);

  const handleCiteJump = (slug: string, round: number) => {
    setTab('matrix');
    setSelectedCell({ slug, round });
  };

  const handleAgentJump = (slug: string) => {
    setTab('agents');
    setFocusAgent(slug);
  };

  const copyId = () => navigator.clipboard?.writeText(debate.frontmatter.id).catch(() => {});

  return (
    <div className="council-detail">
      <header className="council-detail-head">
        <button type="button" className="council-detail-back" onClick={onBack}>
          ← {t('council.title')}
        </button>
        <div className="council-detail-meta">
          <StatusBadge status={debate.frontmatter.status} />
          <span className="council-detail-rounds">R{debate.frontmatter.current_round}/{debate.frontmatter.rounds_planned}</span>
          <span className="council-session-dot">·</span>
          <span className="council-detail-date">{debate.frontmatter.created_at}</span>
          <span className="council-session-dot">·</span>
          <button type="button" className="council-session-id" onClick={copyId} title="Copy debate id">
            {debate.frontmatter.id}
          </button>
        </div>
      </header>

      <nav className="council-tabs" role="tablist">
        <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} label="Overview" />
        <TabButton active={tab === 'agents'} onClick={() => setTab('agents')} label="Agents" />
        <TabButton active={tab === 'matrix'} onClick={() => setTab('matrix')} label="Matrix" />
      </nav>

      <div className="council-detail-body">
        {tab === 'overview' && (
          <OverviewTab debate={debate} onCiteJump={handleCiteJump} onAgentJump={handleAgentJump} />
        )}
        {tab === 'agents' && (
          <TranscriptView debate={debate} focusSlug={focusAgent} />
        )}
        {tab === 'matrix' && (
          <ArenaMatrix
            debate={debate}
            query={matrixQuery}
            onQueryChange={setMatrixQuery}
            selected={selectedCell}
            onSelectCell={(slug, round) => setSelectedCell({ slug, round })}
            onClearSelection={() => setSelectedCell(null)}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`council-tab ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
