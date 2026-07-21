import { computeStepRows, worstDropIndex, type StepRow } from './funnelModel';
import './FunnelStepTable.css';

/**
 * The step-table TWIN (A8) — every number the lane encodes, as a real table:
 * steps × [users, % of top, % of prev, drop], worst drop marked. This is the
 * screen-reader / keyboard path AND the copy-source for Markdown export, so it
 * must always carry exactly what the lane shows (callers pass the same
 * filtered steps they hand to the lane).
 */
export function FunnelStepTable({ steps, caption, prevUsers }: {
  steps: { key: string; label: string; users: number }[];
  caption: string;
  /** Optional previous-period users per step key (renders a Prev column). */
  prevUsers?: Record<string, number | null>;
}) {
  const rows = computeStepRows(steps);
  const worst = worstDropIndex(rows);
  const hasPrev = prevUsers && rows.some((r) => prevUsers[r.key] !== null && prevUsers[r.key] !== undefined);

  return (
    <table className="funnel-steptable">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Step</th>
          <th scope="col" className="funnel-steptable-num">Users</th>
          {hasPrev && <th scope="col" className="funnel-steptable-num">Prev period</th>}
          <th scope="col" className="funnel-steptable-num">% of top</th>
          <th scope="col" className="funnel-steptable-num">% of prev</th>
          <th scope="col" className="funnel-steptable-num">Drop</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={row.key} className={i === worst ? 'funnel-steptable-row--worst' : undefined}>
            <th scope="row">{row.label}</th>
            <td className="funnel-steptable-num">{row.users.toLocaleString('en-US')}</td>
            {hasPrev && (
              <td className="funnel-steptable-num">
                {prevUsers![row.key] !== null && prevUsers![row.key] !== undefined
                  ? prevUsers![row.key]!.toLocaleString('en-US') : '—'}
              </td>
            )}
            <td className="funnel-steptable-num">{fmtPct(row.ofTop)}</td>
            <td className="funnel-steptable-num">{fmtPct(row.ofPrev)}</td>
            <td className="funnel-steptable-num">
              <DropText row={row} />
              {i === worst && <span className="funnel-steptable-worst"> ◄ worst drop</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

function DropText({ row }: { row: StepRow }) {
  if (row.drop === null) return <>—</>;
  if (row.drop < 0) return <span className="funnel-steptable-up">↑{(-row.drop).toLocaleString('en-US')}</span>;
  return <>−{row.drop.toLocaleString('en-US')}</>;
}
