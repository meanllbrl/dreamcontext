import { ToolBadge, CodeSentence } from './atoms';
import { CardHeader } from './molecules';

/**
 * ORGANISM — "Auto-approved · Bypass mode", the informational counterpart to
 * {@link PermissionCard}: the card for a guarded action that ran WITHOUT ever asking.
 *
 * Why it can exist at all, given that the CLI emits no permission request under bypass:
 * every fact on this card is already in hand — the session's mode is ours (we spawned it
 * with it), and the command is the tool call's own `input.command`, streamed like any
 * other. Nothing is inferred about approval; the card states what happened. It is raised
 * only for the commands `isGuardedCommand` recognizes as the kind a human would have
 * wanted to be asked about (delete, force-push, elevate, pipe-to-shell, publish, wipe) —
 * every Bash call getting one would be noise, and noise is how a real one gets missed.
 */
export function BypassNoticeCard({ command, toolName = 'Bash' }: { command: string; toolName?: string }) {
  return (
    <div className="chat-bypasscard" role="note">
      <CardHeader
        glyph="⚡"
        title="Auto-approved · Bypass mode"
        tone="caution"
        aside={<ToolBadge name={toolName} tone="caution" />}
      />
      <div className="chat-bypasscard-body">
        <p className="chat-bypasscard-desc">
          <CodeSentence text={`Ran \`${command}\` without asking.`} />
        </p>
        <p className="chat-bypasscard-note">
          <span aria-hidden>⚠</span> Everything is auto-approved in Bypass mode. Switch back to Auto for guarded commands.
        </p>
      </div>
    </div>
  );
}
