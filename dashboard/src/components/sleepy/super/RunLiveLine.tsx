import { useMemo } from 'react';
import { useChildHistory } from './ChildTranscript';
import { runLiveSteps } from './runLiveSteps';
import { SuperLiveLine, SuperStepsLine } from './SuperStepsLine';

/**
 * A routine run in flight in a member's chat: the SAME live line a Super turn in flight draws
 * (`SuperStepsLine`, or `SuperLiveLine` before its first step), never a pane of its own. Once the
 * run lands the line goes, like a landed turn's; only the answer stays (owner 2026-11-14).
 */
export function RunLiveLine({ claudeId, startedAt, onOpenFile }: {
  /** The run's session on this machine; none (it runs elsewhere, or has not started one yet):
   *  the quiet line alone, with its clock. */
  claudeId?: string;
  startedAt?: number;
  onOpenFile: (path: string) => void;
}) {
  if (!claudeId) return <SuperLiveLine startedAt={startedAt} />;
  return <RunLiveSteps claudeId={claudeId} startedAt={startedAt} onOpenFile={onOpenFile} />;
}

function RunLiveSteps({ claudeId, startedAt, onOpenFile }: { claudeId: string; startedAt?: number; onOpenFile: (path: string) => void }) {
  const history = useChildHistory(claudeId, true);
  const steps = useMemo(() => runLiveSteps(history.data ?? []), [history.data]);
  if (steps.length === 0) return <SuperLiveLine startedAt={startedAt} />;
  return <SuperStepsLine items={steps} stillAccruing startedAt={startedAt} onOpenFile={onOpenFile} />;
}
