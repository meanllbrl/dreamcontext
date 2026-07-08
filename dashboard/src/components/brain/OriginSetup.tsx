import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { GitHubMark } from './GitHubLogin';
import {
  useAuthStatus,
  useBrainStatus,
  useCreateOrigin,
  useAttachOrigin,
  type OriginSetupResult,
} from '../../hooks/useBrainStatus';
import './OriginSetup.css';

/**
 * The "this project has no GitHub origin yet" on-ramp for whole-project cloud
 * sync. Whole-project (`full-repo`) sync pushes to the project's OWN `origin`, so
 * with no origin the master toggle can only 400 `no_origin`. This panel replaces
 * that dead-end: create a fresh private GitHub repo as the origin, or attach an
 * existing repo URL — then it enables sync and runs the first push.
 *
 * Renders ONLY when GitHub is connected AND the project has no origin. Once an
 * origin exists the master Cloud sync toggle owns the on/off, so this hides.
 */
export function OriginSetup() {
  const { t } = useI18n();
  const { data: auth } = useAuthStatus();
  const { data: status } = useBrainStatus();
  const createOrigin = useCreateOrigin();
  const attachOrigin = useAttachOrigin();

  const [tab, setTab] = useState<'create' | 'attach'>('create');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<OriginSetupResult | null>(null);

  // Only meaningful when signed in and the project has no origin yet. `status`
  // may be briefly undefined on first load — don't flash the panel then.
  if (!auth?.connected) return null;
  if (!status || status.codeOrigin) return null;

  const busy = createOrigin.isPending || attachOrigin.isPending;
  const error = (createOrigin.error as Error | null)?.message ?? (attachOrigin.error as Error | null)?.message ?? null;

  const reset = () => { setResult(null); createOrigin.reset(); attachOrigin.reset(); };

  const handleCreate = () => {
    reset();
    // A public repo requires an explicit confirm (S5) — the checkbox IS that confirm.
    createOrigin.mutate(
      { name: name.trim() || undefined, private: isPrivate, confirmed: !isPrivate },
      { onSuccess: (r) => setResult(r) },
    );
  };

  const handleAttach = () => {
    if (!url.trim()) return;
    reset();
    attachOrigin.mutate(url.trim(), { onSuccess: (r) => setResult(r) });
  };

  // A finished setup: show the wired repo + the first-sync outcome, nothing else.
  if (result) {
    const failed = result.sync?.action === 'error';
    return (
      <div className="origin-setup origin-setup--done">
        <p className="origin-setup-title">
          <span className="origin-setup-mark" aria-hidden="true"><GitHubMark size={14} /></span>
          {t('brain.origin.connected').replace('{repo}', result.fullName ?? result.remote)}
        </p>
        <p className={`origin-setup-outcome${failed ? ' origin-setup-outcome--warn' : ''}`}>
          {failed
            ? (result.sync?.failure?.message ?? t('brain.origin.firstSyncFailed'))
            : t('brain.origin.firstSyncOk')}
        </p>
      </div>
    );
  }

  return (
    <div className="origin-setup">
      <p className="origin-setup-title">{t('brain.origin.title')}</p>
      <p className="settings-field-hint">{t('brain.origin.desc')}</p>

      <div className="origin-setup-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'create'}
          className={`origin-setup-tab${tab === 'create' ? ' origin-setup-tab--active' : ''}`}
          onClick={() => { setTab('create'); reset(); }}
        >
          {t('brain.origin.tab.create')}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'attach'}
          className={`origin-setup-tab${tab === 'attach' ? ' origin-setup-tab--active' : ''}`}
          onClick={() => { setTab('attach'); reset(); }}
        >
          {t('brain.origin.tab.attach')}
        </button>
      </div>

      {tab === 'create' ? (
        <div className="origin-setup-form">
          <input
            className="settings-text-input"
            type="text"
            value={name}
            placeholder={t('brain.origin.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <label className="settings-checkbox-label origin-setup-private">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={isPrivate}
              disabled={busy}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <span>{t('brain.origin.private')}</span>
          </label>
          {!isPrivate && <p className="origin-setup-warn">{t('brain.origin.publicWarn')}</p>}
          <button className="btn btn--primary" onClick={handleCreate} disabled={busy}>
            {createOrigin.isPending ? t('brain.origin.creating') : t('brain.origin.createBtn')}
          </button>
        </div>
      ) : (
        <div className="origin-setup-form">
          <input
            className="settings-text-input"
            type="text"
            value={url}
            placeholder={t('brain.origin.urlPlaceholder')}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAttach(); }}
          />
          <p className="settings-field-hint">{t('brain.origin.attachHint')}</p>
          <button className="btn btn--primary" onClick={handleAttach} disabled={busy || !url.trim()}>
            {attachOrigin.isPending ? t('brain.origin.attaching') : t('brain.origin.attachBtn')}
          </button>
        </div>
      )}

      {error && <p className="origin-setup-error">{error}</p>}
    </div>
  );
}
