import type { JobChip } from '../../lib/taskAgentJob';
import './JobChip.css';

/** A task job's chip (AI Team v2 C2): the board card, the drawer and the stage's Tasks strip
 *  show the same one. Tone carries meaning; the label always says it in words too. */
export function JobChipView({ chip }: { chip: JobChip }) {
  return (
    <span className={`job-chip job-chip--${chip.tone}`} data-job={chip.key}>
      <span className="job-chip-dot" aria-hidden />
      {chip.label}
    </span>
  );
}
