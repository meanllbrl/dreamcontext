import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { GitHubMark } from './GitHubLogin';
import {
  useAuthStatus,
  useBrainStatus,
  useCreateOrigin,
  useAttachOrigin,
  useUpdateOrigin,
  useDetachOrigin,
  type OriginSetupResult,
} from '../../hooks/useBrainStatus';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import { useSystemInstall } from '../settings/SystemDependencies';
import './OriginSetup.css';

/**
 * Collapse a git remote URL to a display slug + a GitHub web URL. Mirrors the
 * server's `parseRepoSlug` (letters/ssh/https, `.git` + trailing-slash tolerant)
 * so the connected card can link straight to the repo page. Falls back to the raw
 * remote (no web link) for a non-GitHub remote.
 */
function describeOrigin(remote: string): { name: string; web: string | null } {
  const m = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (m) {
    const slug = `${m[1]}/${m[2]}`;
    return { name: slug, web: `https://github.com/${slug}` };
  }
  return { name: remote, web: null };
}

/**
 * The origin surface for whole-project cloud sync (`full-repo` pushes to the
 * project's OWN `origin`). Two states, one place:
 *  - NO origin  → the create/attach on-ramp (create a fresh private GitHub repo,
 *    or attach an existing repo URL), then enable sync + first push.
 *  - HAS origin → a connected-origin card that VIEWs the wired repo and lets the
 *    user CHANGE (re-point) or DISCONNECT (detach) it — so the origin is never
 *    invisible/unmanageable once set.
 *
 * Renders only when GitHub is connected.
 */
export function OriginSetup() {
  const { t } = useI18n();
  const { data: auth } = useAuthStatus();
  const { data: status } = useBrainStatus();
  const { data: caps } = useAgentCapabilities();
  const createOrigin = useCreateOrigin();
  const attachOrigin = useAttachOrigin();

  const [tab, setTab] = useState<'create' | 'attach'>('create');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<OriginSetupResult | null>(null);

  // Needs a signed-in session. `status` may be briefly undefined on first load —
  // don't flash the panel then.
  if (!auth?.connected) return null;
  if (!status) return null;

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

  // A finished setup: show the wired repo + the first-sync outcome as a banner,
  // AND the connected-origin card as soon as the refetched status carries the
  // origin — the banner must never permanently mask the connected state (that
  // was the "repo created but not connected until app restart" bug).
  if (result) {
    const failed = result.sync?.action === 'error';
    const running = result.sync?.action === 'in-progress';
    return (
      <>
        <div className="origin-setup origin-setup--done">
          <p className="origin-setup-title">
            <span className="origin-setup-mark" aria-hidden="true"><GitHubMark size={14} /></span>
            {t('brain.origin.connected').replace('{repo}', result.fullName ?? result.remote)}
          </p>
          <p className={`origin-setup-outcome${failed ? ' origin-setup-outcome--warn' : ''}`}>
            {failed
              ? (result.sync?.failure?.message ?? t('brain.origin.firstSyncFailed'))
              : running
                ? t('brain.origin.firstSyncRunning')
                : t('brain.origin.firstSyncOk')}
          </p>
        </div>
        {status.codeOrigin && <ConnectedOriginCard origin={status.codeOrigin} />}
      </>
    );
  }

  // An origin is already wired → show the connected-origin card (view / change /
  // disconnect) instead of nothing, so the origin is never invisible once set.
  if (status.codeOrigin) return <ConnectedOriginCard origin={status.codeOrigin} />;

  // Cloud sync shells out to git — without it, create/connect would only fail
  // downstream. Name the missing dependency and offer the fix instead of the form.
  if (caps && !caps.git) return <GitMissingPanel />;

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

/**
 * git-missing blocker for the origin on-ramp: names the dependency, one-click
 * installs it where possible (desktop macOS → Apple's CLT installer via the
 * shared system installer), and shows the copyable command otherwise. The
 * capabilities poll flips `git` to true when the install lands, and the parent
 * swaps this panel for the real create/connect form automatically.
 */
function GitMissingPanel() {
  const { t } = useI18n();
  const { data: caps } = useAgentCapabilities();
  const { install, running, error } = useSystemInstall();
  const oneClick = !!caps && caps.desktop && caps.platform === 'darwin';
  const manualCmd = caps?.platform === 'darwin' ? 'xcode-select --install' : 'sudo apt install git';

  return (
    <div className="origin-setup">
      <p className="origin-setup-title">{t('brain.origin.gitMissing')}</p>
      <p className="settings-field-hint">{t('brain.origin.gitMissingHint')}</p>
      {oneClick ? (
        <button className="btn btn--primary" onClick={() => install('git')} disabled={running !== null}>
          {running ? t('system.dep.installing') : t('system.dep.install')}
        </button>
      ) : (
        <p className="settings-field-hint">
          {t('system.dep.manualHint')} <code>{manualCmd}</code>
        </p>
      )}
      {error && <p className="origin-setup-error">{error}</p>}
    </div>
  );
}

/**
 * The connected-origin card — shown once the project HAS an `origin`. Surfaces the
 * wired repo (name links to GitHub, full URL below) and the two management actions:
 *  - Change    → an inline URL field re-points `origin` at a different reachable repo
 *                (server previews it; NO auto-sync — the user syncs when ready).
 *  - Disconnect → a confirm gate, then detach the origin + turn cloud sync off.
 * Symmetric with the LinkedRepos add/list/remove UX.
 */
function ConnectedOriginCard({ origin }: { origin: string }) {
  const { t } = useI18n();
  const updateOrigin = useUpdateOrigin();
  const detachOrigin = useDetachOrigin();

  const [changing, setChanging] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const [url, setUrl] = useState('');

  const { name, web } = describeOrigin(origin);
  const busy = updateOrigin.isPending || detachOrigin.isPending;
  const error = (updateOrigin.error as Error | null)?.message ?? (detachOrigin.error as Error | null)?.message ?? null;

  const closeChange = () => { setChanging(false); setUrl(''); updateOrigin.reset(); };

  const handleUpdate = () => {
    if (!url.trim()) return;
    updateOrigin.mutate(url.trim(), { onSuccess: closeChange });
  };

  const handleDetach = () => {
    detachOrigin.mutate(undefined, { onSuccess: () => setConfirmDetach(false) });
  };

  return (
    <div className="origin-setup origin-setup--connected">
      <p className="origin-setup-title">
        <span className="origin-setup-mark" aria-hidden="true"><GitHubMark size={14} /></span>
        {t('brain.origin.connectedTitle')}
      </p>
      <div className="origin-connected-repo">
        {web ? (
          <a className="origin-connected-name" href={web} target="_blank" rel="noreferrer">{name}</a>
        ) : (
          <span className="origin-connected-name">{name}</span>
        )}
        <span className="origin-connected-url">{origin}</span>
      </div>

      {changing ? (
        <div className="origin-setup-form">
          <input
            className="settings-text-input"
            type="text"
            value={url}
            placeholder={t('brain.origin.urlPlaceholder')}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
            onKeyDown={(e) => { if (e.key === 'Enter') handleUpdate(); }}
            autoFocus
          />
          <p className="settings-field-hint">{t('brain.origin.changeHint')}</p>
          <div className="origin-connected-actions">
            <button className="btn btn--primary btn--sm" onClick={handleUpdate} disabled={busy || !url.trim()}>
              {updateOrigin.isPending ? t('brain.origin.updating') : t('brain.origin.updateBtn')}
            </button>
            <button className="btn btn--sm" onClick={closeChange} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : confirmDetach ? (
        <div className="origin-connected-actions">
          <span className="origin-connected-detach-warn">{t('brain.origin.detachWarn')}</span>
          <button className="btn btn--danger btn--sm" onClick={handleDetach} disabled={busy}>
            {detachOrigin.isPending ? t('brain.origin.detaching') : t('brain.origin.detachConfirm')}
          </button>
          <button className="btn btn--sm" onClick={() => { detachOrigin.reset(); setConfirmDetach(false); }} disabled={busy}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="origin-connected-actions">
          <button className="btn btn--sm" onClick={() => { detachOrigin.reset(); setChanging(true); }} disabled={busy}>
            {t('brain.origin.changeBtn')}
          </button>
          <button className="btn btn--sm" onClick={() => { updateOrigin.reset(); setConfirmDetach(true); }} disabled={busy}>
            {t('brain.origin.detachBtn')}
          </button>
        </div>
      )}

      {error && <p className="origin-setup-error">{error}</p>}
    </div>
  );
}
