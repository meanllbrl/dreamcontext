import { useCallback, useState } from 'react';
import { parseEditDiff } from './chatEntities';
import { ToolBadge, CodeSentence } from './atoms';
import { CardHeader, TerminalBlock } from './molecules';
import { InlineTerminal } from './InlineTerminal';
import { buildRunReport } from './runReport';
import { useVaultId } from '../../../context/VaultContext';
import { isDesktop } from '../../../lib/desktop';
import { useEmbed } from '../../embed/embedMode';
import { useI18n } from '../../../context/I18nContext';
import { allowAlertText, allowOffered, cleanAlertText } from './permissionAlert';
import type { ChatSession, PendingPermission } from '../chatSession';
import { looksInteractive, permissionReasonLine } from './permissionReason';
import { PermissionDetails } from './PermissionDetails';
import { noteOwnerWrote } from '../../../lib/ownerAtMac';

/**
 * ORGANISM — permission request, state 6. Header (🔓 + tool badge), a human sentence
 * (backticked spans render as inline code via `CodeSentence`), ONE short line saying why it
 * asks (the CLI's own `decision_reason`, in plain words: permissionReason.ts), the command or
 * diff folded behind "Show command" (owner 2026-11-05: the card was a code dump), then the
 * decision row: "Always allow this session" (→ `session.alwaysAllow`; hidden when the CLI
 * suppresses it for this request) and Deny/Allow (→ `session.answer`).
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
  const { vault } = useVaultId();
  const embed = useEmbed();
  const { t } = useI18n();
  const command = commandPreview(item.toolName, item.input);
  const diff = !command ? parseEditDiff(item.input) : null;
  const toolLabel = item.displayName ?? item.toolName;
  // Same gate the RUN card carries, for the same reason: the PTY bridge is desktop-only.
  const canRunHere = !!command && isDesktop() && !!vault && !embed;
  // An app's frame: the page around it can dress up the card, and it cannot cover a native alert,
  // so the alert is where the yes happens. A text too long to read there is not offered at all.
  const alertText = embed ? allowAlertText(item.toolName, item.input) : '';
  const tooLong = !!embed && !allowOffered(item.toolName, item.input);

  const allow = () => {
    if (embed && !window.confirm(cleanAlertText(alertText))) return;
    if (alwaysAllow && !embed && !item.suppressAlwaysAllow) session.alwaysAllow(item.toolName);
    // His click on this card (lib/ownerAtMac.ts); an agent's decision never passes a card.
    if (session.answer(item.requestId, { behavior: 'allow', updatedInput: item.input })) noteOwnerWrote();
  };
  const deny = () => {
    if (session.answer(item.requestId, { behavior: 'deny', message: 'Denied by user.' })) noteOwnerWrote();
  };

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
        <CardHeader glyph="▸" title={t('perm.running')} aside={<ToolBadge name={toolLabel} />} />
        <div className="chat-permcard-body">
          <TerminalBlock command={command} />
          <InlineTerminal vault={vault} command={command} onExit={handleExit} />
          <p className="chat-permcard-explainer">{t('perm.runningHint')}</p>
        </div>
      </div>
    );
  }

  const reasonLine = permissionReasonLine({ reason: item.decisionReason, reasonType: item.decisionReasonType, mode: permissionMode });
  const reason = !reasonLine ? '' : 'key' in reasonLine ? t(reasonLine.key) : reasonLine.text;
  // "Run here" answers a command that asks at the keyboard; for any other it waits beside the
  // command inside "Show command" (owner 2026-11-05: three buttons for a screenshot script).
  const runUpFront = canRunHere && !!command && looksInteractive(command);
  const runButton = (
    <button
      type="button"
      className="chat-btn pill"
      title={t('perm.runHereTitle')}
      onClick={() => { setStartedAt(Date.now()); setRunning(true); }}
    >
      <span aria-hidden>▶</span> {t('perm.runHere')}
    </button>
  );
  // The CLI will not take an "always allow" for this request: the box would promise nothing.
  const offerAlways = !embed && !item.suppressAlwaysAllow;

  return (
    <div className="chat-permcard" data-mode={permissionMode}>
      <CardHeader glyph="🔓" title={t('perm.title')} aside={<ToolBadge name={toolLabel} />} />

      <div className="chat-permcard-body">
        <div className="chat-permcard-lead">
          <p className="chat-permcard-desc">
            <CodeSentence text={item.description ?? `Claude wants to run \`${toolLabel}\`.`} />
          </p>
          {reason && <p className="chat-permcard-why" data-testid="permission-why">{reason}</p>}
        </div>

        <PermissionDetails
          command={command}
          diff={diff}
          input={item.input}
          extra={canRunHere && !runUpFront ? runButton : null}
        />

        <div className="chat-permcard-decide">
          {offerAlways && (
            <label className="chat-permcard-always">
              <input type="checkbox" checked={alwaysAllow} onChange={(e) => setAlwaysAllow(e.target.checked)} />
              {t('perm.always')}
            </label>
          )}
          <div className="chat-permcard-actions">
            <button type="button" className="chat-btn pill" onClick={deny}>{t('perm.deny')}</button>
            {runUpFront && runButton}
            {!tooLong && <button type="button" className="chat-btn pill primary" onClick={allow}>{t('perm.allow')}</button>}
          </div>
        </div>

        {tooLong && <p className="chat-permcard-explainer">{t('embed.commandTooLong')}</p>}
        {embed && <p className="chat-permcard-explainer">{t('embed.permissionHere')}</p>}
      </div>
    </div>
  );
}
