import { useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { SuperRemoteQuestions } from './superJobsStore';
import type { PhonePermission } from './usePhoneSuperQuestions';
import { useI18n } from '../../../context/I18nContext';
import { CardHeader } from '../chat/molecules';
import { ToolBadge, CodeSentence } from '../chat/atoms';
import { PermissionDetails } from '../chat/PermissionDetails';
import { permissionReasonLine } from '../chat/permissionReason';

/** The phone's Allow / Deny for a child's permission: the chat's PermissionCard, read the same
 *  way (owner 2026-11-05). What happens in words, one line on why it asks, the command folded
 *  behind "Show command" (plain text, never HTML). A refusal that may land again re-enables the
 *  buttons and says why; a stale one waits for the next read to take the card away. */
export function RemotePermission({ item, perm, answer }: {
  item: SuperQueueItem;
  perm: PhonePermission;
  answer: NonNullable<SuperRemoteQuestions['answerPermission']>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (choice: 'allow' | 'deny') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void answer(item, choice).then((r) => {
      if (r.ok) return;
      setBusy(!r.retry);
      if (r.retry) setError(r.error ?? 'network');
    });
  };
  // The phone does not know the child's mode: without the CLI's reason, no line at all.
  const reasonLine = permissionReasonLine({ reason: perm.reason, reasonType: perm.reasonType });
  const reason = !reasonLine ? '' : 'key' in reasonLine ? t(reasonLine.key) : reasonLine.text;
  const lead = perm.description || t('super.queue.permissionRemote');
  return (
    <div data-testid="super-question-card" data-state="open" data-item={item.id} data-kind="permission">
      <div className="chat-permcard">
        <CardHeader glyph="🔓" title={t('perm.title')} aside={<ToolBadge name={perm.tool} />} />
        <div className="chat-permcard-body">
          <div className="chat-permcard-lead">
            <p className="chat-permcard-desc"><CodeSentence text={lead} /></p>
            {reason && <p className="chat-permcard-why" data-testid="permission-why">{reason}</p>}
          </div>
          {perm.text && (
            <div data-testid="super-permission-text">
              {perm.tool === 'Bash' ? <PermissionDetails command={perm.text} /> : <PermissionDetails command={null} input={perm.text} />}
            </div>
          )}
          <div className="chat-permcard-decide">
            <div className="chat-permcard-actions">
              <button type="button" className="chat-btn pill" disabled={busy} onClick={() => decide('deny')} data-testid="super-permission-deny">{t('perm.deny')}</button>
              <button type="button" className="chat-btn pill primary" disabled={busy} onClick={() => decide('allow')} data-testid="super-permission-allow">{t('perm.allow')}</button>
            </div>
          </div>
          {error && <p className="chat-permcard-explainer" role="alert">{t('super.queue.permissionFailed')} ({error})</p>}
        </div>
      </div>
    </div>
  );
}
