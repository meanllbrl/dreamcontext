import { useCallback, useState } from 'react';
import { parseEditDiff } from './chatEntities';
import { ToolBadge, DiffStat, CodeSentence } from './atoms';
import { CardHeader, TerminalBlock, DiffView } from './molecules';
import { InlineTerminal } from './InlineTerminal';
import { buildRunReport } from './runReport';
import { useVault } from '../../../context/VaultContext';
import { isDesktop } from '../../../lib/desktop';
import type { ChatSession, PendingPermission } from '../chatSession';

/**
 * ORGANISM — permission request, state 6. Header (🔓 + tool badge), a human sentence
 * (backticked spans render as inline code via `CodeSentence`), a command/diff preview
 * (`TerminalBlock` for Bash, `DiffView` for Edit-shaped input), then the decision row:
 * "Always allow this session" (→ `session.alwaysAllow`) and Deny/Allow (→
 * `session.answer`), closed by a line naming the mode that let this reach you.
 *
 * On the design brief's "bypass variant": every `PendingPermission` this engine ever
 * surfaces is a REAL request still awaiting `session.answer` over the control channel —
 * the CLI emits no request at all for what bypass auto-approves (see chatSession.ts's/
 * chatProtocol.ts's header notes). Rendering a no-button card for an item that still
 * needs an answer would strand that turn forever, so this component always renders
 * working Allow/Deny regardless of `permissionMode`. The informational counterpart —
 * what bypass swallowed — is its own card: {@link BypassNoticeCard}.
 *
 * ── The third button ──────────────────────────────────────────────────────────────────
 * "▶ Run here" (Bash only) is the answer to the case Allow cannot serve: a command that
 * ASKS something. Allowed, `sudo`, `firebase login`, `npm login` and every `y/n` prompt go
 * to a headless shell with no one at the keyboard — the agent waits on a password prompt
 * until the turn is killed, and the user's only real option was another terminal window,
 * which ends the session this surface exists to keep.
 *
 * So the command runs in a PTY inside the card, the user types into it, and when the
 * process exits the permission is answered `deny` — carrying the run's report as the tool
 * result. Deny, not allow, and that is the load-bearing choice: allowing would run the
 * command a SECOND time, headless, straight back into the prompt it just hung on. The
 * message says plainly that the user ran it, so "denied" never reads to the agent as
 * "refused".
 */

function commandPreview(toolName: string, input: unknown): string | null {
  if (toolName !== 'Bash') return null;
  const obj = input as Record<string, unknown> | undefined;
  return typeof obj?.command === 'string' ? obj.command : null;
}

export function PermissionCard({
  item, session, permissionMode,
}: {
  item: PendingPermission;
  session: ChatSession;
  permissionMode: 'auto' | 'bypass';
}) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const { vault } = useVault();
  const command = commandPreview(item.toolName, item.input);
  const diff = !command ? parseEditDiff(item.input) : null;
  const toolLabel = item.displayName ?? item.toolName;
  // Same gate the RUN card carries, for the same reason: the PTY bridge is desktop-only.
  const canRunHere = !!command && isDesktop() && !!vault;

  const allow = () => {
    if (alwaysAllow) session.alwaysAllow(item.toolName);
    session.answer(item.requestId, { behavior: 'allow', updatedInput: item.input });
  };
  const deny = () => session.answer(item.requestId, { behavior: 'deny', message: 'Denied by user.' });

  const handleExit = useCallback((result: { code: number | null; tail: string }) => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const report = buildRunReport(command ?? '', { ...result, seconds }, { includeOutput: true });
    session.answer(item.requestId, {
      behavior: 'deny',
      message: `The user ran this command themselves, in an interactive terminal inside the chat — do NOT run it again.\n\n${report}`,
    });
    setRunning(false);
  }, [command, item.requestId, session, startedAt]);

  if (running && command && vault) {
    return (
      <div className="chat-permcard" data-mode={permissionMode} data-running="">
        <CardHeader glyph="▸" title="Running here" aside={<ToolBadge name={toolLabel} />} />
        <div className="chat-permcard-body">
          <TerminalBlock command={command} />
          <InlineTerminal vault={vault} command={command} onExit={handleExit} />
          <p className="chat-permcard-explainer">
            Type here as you would in your own terminal. The agent is waiting and picks up the result when it exits.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-permcard" data-mode={permissionMode}>
      <CardHeader glyph="🔓" title="Permission needed" aside={<ToolBadge name={toolLabel} />} />

      <div className="chat-permcard-body">
        <p className="chat-permcard-desc">
          <CodeSentence text={item.description ?? `Claude wants to run \`${toolLabel}\`.`} />
        </p>

        {command && <TerminalBlock command={command} />}
        {diff && (
          <div className="chat-permcard-diff">
            <div className="chat-permcard-diff-head">
              <DiffStat added={diff.addedN} removed={diff.removedN} />
            </div>
            <DiffView diff={diff} />
          </div>
        )}
        {!command && !diff && item.input !== undefined && (
          <pre className="chat-permcard-raw">{(() => { try { return JSON.stringify(item.input, null, 2); } catch { return String(item.input); } })()}</pre>
        )}

        <div className="chat-permcard-decide">
          <label className="chat-permcard-always">
            <input type="checkbox" checked={alwaysAllow} onChange={(e) => setAlwaysAllow(e.target.checked)} />
            Always allow this session
          </label>
          <div className="chat-permcard-actions">
            <button type="button" className="chat-btn pill" onClick={deny}>Deny</button>
            {canRunHere && (
              <button
                type="button"
                className="chat-btn pill"
                title="Run it yourself in a terminal here — for anything that asks for a password or a y/n"
                onClick={() => { setStartedAt(Date.now()); setRunning(true); }}
              >
                <span aria-hidden>▶</span> Run here
              </button>
            )}
            <button type="button" className="chat-btn pill primary" onClick={allow}>Allow</button>
          </div>
        </div>

        <p className="chat-permcard-explainer">
          {permissionMode === 'bypass'
            ? <><span aria-hidden>⚡</span> Bypass mode — this session auto-approves most actions; this one still needs you.</>
            : <><span aria-hidden>🛡</span> Auto mode — edits auto-approved, risky commands still ask (like this one).</>}
        </p>
      </div>
    </div>
  );
}
