import './AutomationsEmptyState.css';

/**
 * Zero-state: no automations exist yet. Kept deliberately plain — a short
 * explainer plus the exact CLI command to scaffold one. No brand mark, no
 * animation: density over theatricality, and there is nothing here that
 * encodes a state change worth animating.
 */
export function AutomationsEmptyState() {
  return (
    <div className="auto-empty">
      <h2 className="auto-empty-title">No automations yet</h2>
      <p className="auto-empty-lead">
        Automations run headless <code>claude -p</code> sessions on a schedule — an end-of-day digest, a
        weekly report, a research prompt on a chosen day. Ships fully disabled: nothing runs until you
        install the dispatcher and approve each one on this machine.
      </p>
      <p className="auto-empty-scaffold">Scaffold one from the CLI:</p>
      <code className="auto-empty-cmd">
        dreamcontext automations create &lt;slug&gt; --title "…" --days daily --at 18:00
      </code>
    </div>
  );
}
