import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useAgentSync, useAnswerInbox, useConfirmAgentSync, useOwnerInbox, type OwnerInboxRow } from '../../hooks/useAgents';
import { TeamIcon } from './TeamIcons';
import { isPhoneSurface } from '../../lib/phoneSurface';
import { emitInstance, useVault } from '../../context/VaultContext';
import { tr } from '../../lib/assignToAgent';

/**
 * AGENT SYNC, ON THE TEAM LIST (AI Team v2, wave B1): what the brain sync asks of the owner here.
 *
 *  - The migration notice, while this machine's agents do not ride the sync yet: what it means,
 *    the one warning (every machine must run this version first), how many files would start to
 *    sync, and each secret-scan hit by path, since confirming is what lets those files push.
 *  - The owner inbox: rows only this machine raises (a held secret, a task assigned outside the
 *    app, a renamed agent, a learned pattern to adopt), each with its own buttons. A task job's
 *    row (AI Team v2 C2) opens its task instead: its answers (some take words or a time) live in
 *    the task's drawer.
 *
 * Folded to one line by default: the notice is a decision, not an alarm.
 */
export function TeamSyncStrip({ onToast }: { onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const sync = useAgentSync().data;
  const rows = useOwnerInbox().data ?? [];
  const confirm = useConfirmAgentSync();
  const answer = useAnswerInbox();
  const [open, setOpen] = useState(false);
  const { bus } = useVault();
  const notice = sync && !sync.active;
  if (!notice && rows.length === 0) return null;

  const act = (row: OwnerInboxRow, action: OwnerInboxRow['actions'][number]) =>
    answer.mutate({ id: row.id, action }, { onError: (err) => onToast((err as Error).message) });

  return (
    <div className="aiteam-syncstrip" data-sync-strip>
      {notice && (
        <section className="aiteam-syncnote" data-sync-notice={sync.switchOn ? 'unconfirmed' : 'off'} aria-label={t('aiteam.sync.title')}>
          <button type="button" className="aiteam-syncnote-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <TeamIcon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
            <span className="aiteam-syncnote-title">{t('aiteam.sync.title')}</span>
            {sync.hits.length > 0 && <span className="aiteam-tag aiteam-tag--warn">{sync.hits.length}</span>}
          </button>
          {open && (
            <div className="aiteam-syncnote-body">
              <p>{sync.switchOn ? t('aiteam.sync.unconfirmed') : t('aiteam.sync.off')}</p>
              <p className="aiteam-syncnote-warn">{t('aiteam.sync.warning')}</p>
              <p className="aiteam-syncnote-meta">{t('aiteam.sync.files').replace('{n}', String(sync.filesToSync))}</p>
              {sync.hits.length > 0 && (
                <ul className="aiteam-syncnote-hits" data-sync-hits>
                  {sync.hits.map((h) => (
                    <li key={`${h.file}:${h.line}:${h.rule}`}>
                      <code>{h.file}:{h.line}</code>
                      <span className={h.severity === 'block' ? 'aiteam-syncnote-held' : 'aiteam-syncnote-check'}>
                        {h.severity === 'block' ? t('aiteam.sync.held') : t('aiteam.sync.check')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {sync.unowned.length > 0 && (
                <p className="aiteam-syncnote-meta" data-sync-unowned>{t('aiteam.sync.unowned').replace('{list}', sync.unowned.join(', '))}</p>
              )}
              {/* Confirming publishes this machine's agents: decided at the machine, never from the phone. */}
              {!isPhoneSurface() && <button
                type="button"
                className="agp-btn agp-btn--primary"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate(undefined, {
                  onSuccess: () => onToast(t('aiteam.sync.done')),
                  onError: (err) => onToast((err as Error).message),
                })}
                data-sync-confirm
              >
                {sync.switchOn ? t('aiteam.sync.confirmHere') : t('aiteam.sync.confirm')}
              </button>}
            </div>
          )}
        </section>
      )}
      {rows.length > 0 && (
        <section className="aiteam-inbox" aria-label={t('aiteam.inbox.title')} data-owner-inbox>
          <p className="aiteam-section">{t('aiteam.inbox.title')} · {rows.length}</p>
          {rows.map((row) => (
            <div key={row.id} className="aiteam-inbox-row" data-inbox-row={row.kind}>
              <p className="aiteam-inbox-title">{row.title}</p>
              {row.detail && <p className="aiteam-inbox-detail">{row.detail}</p>}
              <div className="aiteam-inbox-actions">
                {row.kind.startsWith('task-') ? (
                  <button
                    type="button"
                    className="agp-btn agp-btn--primary"
                    onClick={() => emitInstance(bus, 'dreamcontext-agent-open-page', { page: 'tasks', id: row.ref })}
                  >
                    {tr(t, 'aiteam.stage.openTask', 'Open the task')}
                  </button>
                ) : row.actions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={a === 'start' || a === 'start-all' || a === 'adopt' ? 'agp-btn agp-btn--primary' : 'agp-btn'}
                    disabled={answer.isPending}
                    onClick={() => act(row, a)}
                  >
                    {t(`aiteam.inbox.${a}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
