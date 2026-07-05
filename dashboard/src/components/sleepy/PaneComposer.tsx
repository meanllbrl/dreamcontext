import { AgentComposerBar } from './AgentComposerBar';
import { useAgentSessionStats } from '../../hooks/useAgentCapabilities';
import type { ModelConfig } from '../../lib/agentComposer';

/**
 * One pane's composer strip. A thin wrapper around {@link AgentComposerBar} whose ONLY job
 * is to own the per-session stats poll (`useAgentSessionStats`) — a hook, so it can't live
 * in AgentSurface's `panes.map`. It polls the context-window + cost readout for THIS pane's
 * agent (disabled for a shell or a non-live agent), and forwards everything else through.
 */
export function PaneComposer({
  claudeId, isAgent, isLiveAgent, modelConfig, model, effort,
  onInsert, onPickFiles, onModelChange, onEffortChange,
}: {
  claudeId?: string;
  /** This pane's active session is a Claude agent (not a plain shell). */
  isAgent: boolean;
  /** A live agent backs this pane → model/effort pickers act, and stats poll. */
  isLiveAgent: boolean;
  modelConfig: ModelConfig;
  model: string;
  effort: string;
  onInsert: (snippet: string) => void;
  onPickFiles: () => void;
  onModelChange: (id: string) => void;
  onEffortChange: (level: string) => void;
}) {
  const stats = useAgentSessionStats(claudeId, isAgent && isLiveAgent).data;
  return (
    <AgentComposerBar
      onInsert={onInsert}
      onPickFiles={onPickFiles}
      models={modelConfig.models}
      efforts={modelConfig.efforts}
      model={model}
      effort={effort}
      onModelChange={onModelChange}
      onEffortChange={onEffortChange}
      disabled={!isLiveAgent}
      skillsDisabled={!isAgent}
      stats={isAgent ? stats : null}
    />
  );
}
