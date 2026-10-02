import { useState } from 'react';
import { ToolBadge } from './atoms';
import { CardHeader, TerminalBlock } from './molecules';

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
 *
 * Collapsed by default to ONE line: the command's first line, clipped. A guarded command
 * is often a heredoc script hundreds of characters long, and printed whole it buried the
 * transcript under a caution-tinted wall. The header is the disclosure; opened, the full
 * command reads on the terminal surface (verbatim — a command's own backticks used to
 * break the inline-code sentence it was spliced into).
 */
export function BypassNoticeCard({ command, toolName = 'Bash' }: { command: string; toolName?: string }) {
  const [open, setOpen] = useState(false);
  const firstLine = command.split('\n', 1)[0];
  const multiline = firstLine.length < command.length;
  return (
    <div className="chat-bypasscard" role="note" data-open={open || undefined}>
      <CardHeader
        glyph="⚡"
        title="Auto-approved · Bypass mode"
        tone="caution"
        aside={<ToolBadge name={toolName} tone="caution" />}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
      <div className="chat-bypasscard-body">
        {open ? (
          <>
            <div className="chat-bypasscard-cmd"><TerminalBlock command={command} /></div>
            <p className="chat-bypasscard-note">
              <span aria-hidden>⚠</span> Everything is auto-approved in Bypass mode. Switch back to Auto for guarded commands.
            </p>
          </>
        ) : (
          <p className="chat-bypasscard-desc chat-bypasscard-desc--clip" title={command}>
            Ran <code className="chat-a-inlinecode">{firstLine}{multiline ? ' …' : ''}</code> without asking.
          </p>
        )}
      </div>
    </div>
  );
}
