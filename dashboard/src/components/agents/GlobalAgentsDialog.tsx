import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useGlobalAgents } from '../../hooks/useAgents';
import { AgentAvatar } from './AgentAvatar';
import { AgentIdentityDialog } from './AgentIdentityDialog';
import './AgentIdentityDialog.css';

/**
 * The launcher's global agents (AI Team v2 D1): this Mac's agents that every project lists. The
 * list, and the same identity form a project's "New teammate" uses, in its global mode (no photo,
 * no home board). No project is open here, so everything goes through the launcher's routes.
 */
export function GlobalAgentsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const list = useGlobalAgents();
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // A modal takes the focus when it opens and gives it back to what opened it when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    modalRef.current?.focus();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    // Esc in the form goes back to the list (what was typed is a draft of a new agent, nothing
    // more); Esc on the list closes it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (creating) { setCreating(false); modalRef.current?.focus(); } else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating, onClose]);

  const agents = list.data ?? [];
  return (
    <div className="aid-scrim" data-no-drag onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={modalRef} tabIndex={-1} className="aid-modal" role="dialog" aria-modal aria-label={t('launcher.globalAgents')} data-global-agents>
        <h2 className="aid-title">{creating ? t('agents.identity.createGlobalTitle') : t('launcher.globalAgents')}</h2>
        {/* Always mounted, so a screen reader announces the text when it arrives. */}
        <p className="aid-note" role="status" aria-live="polite" hidden={creating || !toast}>{creating ? '' : toast ?? ''}</p>
        {creating ? (
          <AgentIdentityDialog
            inline
            scope="global"
            slug={null}
            onClose={() => { setCreating(false); modalRef.current?.focus(); }}
            onSaved={(_slug, message) => { setCreating(false); setToast(message); modalRef.current?.focus(); }}
          />
        ) : (
          <>
            {list.isError && <p className="aid-error" role="alert">{t('agents.page.loadFailed')}</p>}
            {!list.isLoading && agents.length === 0 && <p className="aid-note">{t('launcher.globalAgents.empty')}</p>}
            <ul className="aid-global-list">
              {agents.map((a) => (
                <li key={a.slug} className="aid-global-row" data-global-agent={a.slug}>
                  <AgentAvatar of="agent" slug={a.slug} title={a.title} hasPhoto={false} size={32} face={a.face} />
                  <span className="aid-global-text">
                    <span className="aid-global-name">{a.title}</span>
                    {a.roleLine && <span className="aid-note">{a.roleLine}</span>}
                  </span>
                  <span className="aid-chip aid-chip--static">
                    {a.approvedToRun ? t('launcher.globalAgents.inEvery') : t('launcher.globalAgents.needsApproval')}
                  </span>
                </li>
              ))}
            </ul>
            <div className="aid-foot">
              <button type="button" className="aid-btn" onClick={onClose}>{t('launcher.globalAgents.close')}</button>
              <button type="button" className="aid-btn aid-btn--primary" onClick={() => { setToast(null); setCreating(true); }} data-new-global-agent>
                {t('launcher.globalAgents.new')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
