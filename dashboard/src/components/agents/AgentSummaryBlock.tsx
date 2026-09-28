import type { ThreadSummaryRow } from '../../hooks/useAutomations';

/**
 * THE FIGURES A RUN POSTED — `automations post --kv wau=12400 --kv delta=-4%`.
 *
 * A definition list, not a table: a table promises columns that mean something
 * across rows, and these rows share nothing but the run that posted them. The
 * key is the label, the value is the number, and the number is the thing the
 * eye is looking for — so the value carries the mono face and the full text
 * colour while the key stays secondary.
 *
 * NO BORDER AND NO FILL. This sits inside a message, and a message is a row in
 * a channel rather than a card (see `AgentMessage`'s own header) — boxing the
 * figures would make one post look like a different KIND of thing from the post
 * above it, which is exactly the reading the channel is trying not to produce.
 *
 * The 6-row ceiling is enforced at the WRITE end (`THREAD_SUMMARY_MAX_ROWS`, and
 * the CLI refuses a 7th), so this renders what it is given — a cap here would
 * silently hide a row the agent believes it posted.
 */
export function AgentSummaryBlock({ rows }: { rows: ThreadSummaryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <dl className="agent-msg-kv">
      {rows.map((row) => (
        <div className="agent-msg-kv-row" key={row.key}>
          <dt className="agent-msg-kv-key">{row.key}</dt>
          <dd className="agent-msg-kv-value">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
