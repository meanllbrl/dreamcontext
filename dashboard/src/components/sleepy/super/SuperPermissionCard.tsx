import { useState } from 'react';
import type { SuperQueueItem } from '../../../lib/superTypes';
import type { SuperRemoteQuestions } from './superJobsStore';
import { useI18n } from '../../../context/I18nContext';

/** The phone's Allow / Deny for a child's permission (the same look as the chat's PermissionCard).
 *  The command is plain text, never HTML. A refusal that may land again re-enables the buttons and
 *  says why; a stale one waits for the next read to take the card away. */
export function RemotePermission({ item, perm, answer }: {
  item: SuperQueueItem;
  perm: { tool: string; text: string };
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
  return (
    <div data-testid="super-question-card" data-state="open" data-item={item.id} data-kind="permission">
      <div className="chat-permcard">
        <div className="chat-permcard-body">
          <p className="chat-permcard-desc">{t('super.queue.permissionRemote')}: <strong>{perm.tool}</strong></p>
          {perm.text && <pre className="chat-permcard-raw" data-testid="super-permission-text">{perm.text}</pre>}
          <div className="chat-permcard-decide">
            <div className="chat-permcard-actions">
              <button type="button" className="chat-btn pill" disabled={busy} onClick={() => decide('deny')} data-testid="super-permission-deny">Deny</button>
              <button type="button" className="chat-btn pill primary" disabled={busy} onClick={() => decide('allow')} data-testid="super-permission-allow">Allow</button>
            </div>
          </div>
          {error && <p className="chat-permcard-explainer" role="alert">{t('super.queue.permissionFailed')} ({error})</p>}
        </div>
      </div>
    </div>
  );
}
