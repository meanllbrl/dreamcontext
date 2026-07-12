import { useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { openFolderPicker } from '../../lib/desktop';
import {
  useLinkedRepos,
  useLinkRepo,
  useCloneLinkedRepo,
  useUnlinkRepo,
} from '../../hooks/useLinkedRepos';
import './LinkedRepos.css';

/**
 * "Linked repos" panel (Settings → Cloud sync, after OriginSetup). One shared
 * brain governs bare CODE repos (products) with no `_dream_context/` of their
 * own. Shows each governed repo present/missing on THIS machine:
 *  - present → its resolved local path.
 *  - missing → "Link local folder" (bind an EXISTING checkout via the folder
 *    picker — the server refuses a folder whose origin doesn't match the entry's
 *    URL) or a trust-gated Clone (the URL is team-writable — a confirm precedes
 *    the POST /clone confirmed=true).
 * Add binds a local checkout picked via the native folder picker.
 */
export function LinkedRepos() {
  const { t } = useI18n();
  const { data: repos } = useLinkedRepos();
  const linkRepo = useLinkRepo();
  const cloneRepo = useCloneLinkedRepo();
  const unlinkRepo = useUnlinkRepo();

  // The name to bind the picked folder to. Empty until the user types one.
  const [addName, setAddName] = useState('');
  // The repo the user is confirming a clone for (trust gate).
  const [confirmClone, setConfirmClone] = useState<string | null>(null);
  // The missing repo currently being bound to a picked local folder.
  const [locating, setLocating] = useState<string | null>(null);
  // Synchronous latch guarding the folder-picker window: both handlers `await`
  // openFolderPicker() BEFORE their mutation starts, so `busy` (isPending) stays
  // false across that gap — a rapid double-click would otherwise open two native
  // pickers. A ref flips immediately so the second call bails on the same tick.
  const pickerBusyRef = useRef(false);

  const busy = linkRepo.isPending || cloneRepo.isPending || unlinkRepo.isPending;
  const error =
    (linkRepo.error as Error | null)?.message ??
    (cloneRepo.error as Error | null)?.message ??
    (unlinkRepo.error as Error | null)?.message ??
    null;

  const handleAdd = async () => {
    const name = addName.trim();
    if (!name || pickerBusyRef.current) return;
    pickerBusyRef.current = true;
    try {
      linkRepo.reset();
      const path = await openFolderPicker();
      if (!path) return;
      linkRepo.mutate({ name, path }, { onSuccess: () => setAddName('') });
    } finally {
      pickerBusyRef.current = false;
    }
  };

  // Bind an EXISTING local checkout to a missing entry. Passing the entry's URL
  // makes the server refuse a folder whose origin points at a different repo.
  const handleLocate = async (name: string, url: string) => {
    if (pickerBusyRef.current) return;
    pickerBusyRef.current = true;
    try {
      linkRepo.reset();
      const path = await openFolderPicker();
      if (!path) return;
      setLocating(name);
      linkRepo.mutate({ name, path, url }, { onSettled: () => setLocating(null) });
    } finally {
      pickerBusyRef.current = false;
    }
  };

  return (
    <div className="linked-repos">
      <p className="linked-repos-title">{t('linkedRepos.title')}</p>
      <p className="settings-field-hint">{t('linkedRepos.desc')}</p>

      {repos && repos.length > 0 ? (
        <ul className="linked-repos-list">
          {repos.map((r) => (
            <li key={r.gitRemoteUrl} className="linked-repos-item">
              <div className="linked-repos-item-main">
                <span className="linked-repos-name">{r.name}</span>
                <span className="linked-repos-url">{r.gitRemoteUrl}</span>
                {r.present ? (
                  <span className="linked-repos-path">{r.path}</span>
                ) : (
                  <span className="linked-repos-missing">{t('linkedRepos.missing')}</span>
                )}
              </div>
              <div className="linked-repos-item-actions">
                {!r.present && confirmClone !== r.name && (
                  <button
                    className="btn btn--primary btn--sm"
                    disabled={busy}
                    title={t('linkedRepos.locateTip')}
                    onClick={() => handleLocate(r.name, r.gitRemoteUrl)}
                  >
                    {locating === r.name && linkRepo.isPending ? t('linkedRepos.locating') : t('linkedRepos.locate')}
                  </button>
                )}
                {!r.present &&
                  (confirmClone === r.name ? (
                    <>
                      <span className="linked-repos-trust-warn">{t('linkedRepos.trustWarn')}</span>
                      <button
                        className="btn btn--primary btn--sm"
                        disabled={busy}
                        onClick={() =>
                          cloneRepo.mutate(r.name, { onSuccess: () => setConfirmClone(null) })
                        }
                      >
                        {cloneRepo.isPending ? t('linkedRepos.cloning') : t('linkedRepos.cloneConfirm')}
                      </button>
                      <button className="btn btn--sm" disabled={busy} onClick={() => setConfirmClone(null)}>
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn btn--sm"
                      disabled={busy}
                      onClick={() => { cloneRepo.reset(); setConfirmClone(r.name); }}
                    >
                      {t('linkedRepos.clone')}
                    </button>
                  ))}
                <button className="btn btn--sm" disabled={busy} onClick={() => unlinkRepo.mutate(r.name)}>
                  {t('linkedRepos.unlink')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-field-hint">{t('linkedRepos.empty')}</p>
      )}

      <div className="linked-repos-add">
        <input
          className="settings-text-input"
          type="text"
          value={addName}
          placeholder={t('linkedRepos.namePlaceholder')}
          onChange={(e) => setAddName(e.target.value)}
          disabled={busy}
        />
        <button className="btn btn--primary btn--sm" disabled={busy || !addName.trim()} onClick={handleAdd}>
          {linkRepo.isPending ? t('linkedRepos.adding') : t('linkedRepos.add')}
        </button>
      </div>

      {error && <p className="linked-repos-error">{error}</p>}
    </div>
  );
}
