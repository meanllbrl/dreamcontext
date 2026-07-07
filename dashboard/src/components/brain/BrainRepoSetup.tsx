import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useAuthStatus,
  useBrainStatus,
  useDiscoverBrainRepos,
  useCreateBrainRepo,
  useAttachPreview,
  useAttachBrainRepo,
  useDisconnectBrainRepo,
  type ScrubBlock,
} from '../../hooks/useBrainStatus';
import './BrainRepoSetup.css';

type SetupTab = 'create' | 'discover' | 'attach';

function ScrubBlockList({ blocks }: { blocks: ScrubBlock[] }) {
  return (
    <ul className="brain-scrub-list">
      {blocks.map((b, i) => (
        <li key={i} className="brain-scrub-item">
          <code>{b.file}:{b.line}</code> — {b.excerpt}
        </li>
      ))}
    </ul>
  );
}

/**
 * Create / Discover / Attach — the three ways to give this project a brain
 * repo. `disabled` greys out every sub-control (the SW2 Cloud sync master
 * toggle is off, or the user hasn't signed in with GitHub yet).
 */
export function BrainRepoSetup({ disabled }: { disabled?: boolean }) {
  const { t } = useI18n();
  const { data: authStatus } = useAuthStatus();
  const { data: brainStatus } = useBrainStatus();
  const signedIn = !!authStatus?.connected;
  const controlsDisabled = !!disabled || !signedIn;

  const [tab, setTab] = useState<SetupTab>('create');

  // ─── Disconnect ───────────────────────────────────────────────────────────
  const disconnect = useDisconnectBrainRepo();
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const handleDisconnect = async () => {
    setDisconnectError(null);
    try {
      await disconnect.mutateAsync();
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : String(err));
    }
  };

  // ─── Create ───────────────────────────────────────────────────────────────
  const createRepo = useCreateBrainRepo();
  const [name, setName] = useState('');
  const [makePublic, setMakePublic] = useState(false);
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBlocked, setCreateBlocked] = useState<ScrubBlock[] | null>(null);

  const handleCreate = async () => {
    setCreateError(null);
    setCreateBlocked(null);
    // Validate on click so the button never sits silently disabled — the
    // placeholder in the name field reads like a value, and a dead button with
    // no message is exactly the trap this replaces.
    if (!name.trim()) {
      setCreateError(t('brain.create.nameRequired'));
      return;
    }
    if (makePublic && !publicConfirmed) {
      setCreateError(t('brain.create.confirmPublicFirst'));
      return;
    }
    try {
      const result = await createRepo.mutateAsync({
        name: name.trim(),
        public: makePublic,
        confirmed: makePublic ? publicConfirmed : undefined,
      });
      if (result.blocked) {
        setCreateBlocked(result.scrub?.blocks ?? []);
        return;
      }
      setName('');
      setMakePublic(false);
      setPublicConfirmed(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  };

  // ─── Discover ─────────────────────────────────────────────────────────────
  const [discoverEnabled, setDiscoverEnabled] = useState(false);
  const { data: repos, isFetching: discovering, isError: discoverError } = useDiscoverBrainRepos(discoverEnabled);

  // ─── Attach ───────────────────────────────────────────────────────────────
  const attachPreview = useAttachPreview();
  const attachRepo = useAttachBrainRepo();
  const [attachUrl, setAttachUrl] = useState('');
  const [trustConfirmed, setTrustConfirmed] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const handlePreview = async () => {
    setAttachError(null);
    setTrustConfirmed(false);
    try {
      await attachPreview.mutateAsync(attachUrl.trim());
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAttach = async () => {
    setAttachError(null);
    try {
      const result = await attachRepo.mutateAsync({ url: attachUrl.trim(), confirmed: true });
      if (!result.ok) {
        setAttachError(result.reason ?? t('brain.attach.refused'));
        return;
      }
      // Attach succeeded; surface a blocked first push so the user knows their
      // memory has NOT reached the cloud yet.
      if (result.bootstrap === 'blocked-scrub') {
        setAttachError(t('brain.attach.bootstrapBlocked'));
      }
      setAttachUrl('');
      setTrustConfirmed(false);
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const preview = attachPreview.data;

  return (
    <div className={`brain-setup${controlsDisabled ? ' brain-setup--disabled' : ''}`}>
      {!signedIn && (
        <p className="settings-field-hint">{t('brain.setup.signInFirst')}</p>
      )}
      {brainStatus?.hasRemote ? (
        <div className="brain-setup-connected">
          <p className="brain-setup-already">
            ✓ {t('brain.setup.alreadyConnected')} <code>{brainStatus.remote}</code>
          </p>
          <p className="settings-field-hint">{t('brain.setup.switchHint')}</p>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleDisconnect}
            disabled={controlsDisabled || disconnect.isPending}
          >
            {disconnect.isPending ? t('brain.setup.disconnecting') : t('brain.setup.disconnect')}
          </button>
          {disconnectError && <p className="settings-test-err">✗ {disconnectError}</p>}
        </div>
      ) : brainStatus ? (
        <p className="settings-field-hint">
          {brainStatus.codeOrigin
            ? t('brain.setup.inTree').replace('{origin}', brainStatus.codeOrigin)
            : t('brain.setup.notConnected')}
        </p>
      ) : null}

      <div className="brain-setup-tabs" role="tablist">
        {(['create', 'discover', 'attach'] as SetupTab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`brain-setup-tab${tab === id ? ' brain-setup-tab--active' : ''}`}
            onClick={() => setTab(id)}
            disabled={controlsDisabled}
          >
            {t(`brain.setup.tab.${id}`)}
          </button>
        ))}
      </div>

      {tab === 'create' && (
        <div className="brain-setup-panel">
          <div className="settings-field-row">
            <label>{t('brain.create.name')}</label>
            <input
              className="settings-text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('brain.create.namePlaceholder')}
              disabled={controlsDisabled}
            />
          </div>
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              className="settings-checkbox"
              checked={makePublic}
              onChange={(e) => { setMakePublic(e.target.checked); setPublicConfirmed(false); }}
              disabled={controlsDisabled}
            />
            <span>{t('brain.create.makePublic')}</span>
          </label>
          {makePublic && (
            <div className="brain-setup-public-warning">
              <p>{t('brain.create.publicWarning')}</p>
              <label className="settings-checkbox-label">
                <input
                  type="checkbox"
                  className="settings-checkbox"
                  checked={publicConfirmed}
                  onChange={(e) => setPublicConfirmed(e.target.checked)}
                  disabled={controlsDisabled}
                />
                <span>{t('brain.create.publicConfirm')}</span>
              </label>
            </div>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleCreate}
            disabled={controlsDisabled || createRepo.isPending}
          >
            {createRepo.isPending ? t('brain.create.creating') : t('brain.create.submit')}
          </button>
          {createError && <p className="settings-test-err">✗ {createError}</p>}
          {createBlocked && (
            <div className="brain-scrub-block">
              <p className="settings-test-err">✗ {t('brain.create.scrubBlocked')}</p>
              <ScrubBlockList blocks={createBlocked} />
            </div>
          )}
        </div>
      )}

      {tab === 'discover' && (
        <div className="brain-setup-panel">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setDiscoverEnabled(true)}
            disabled={controlsDisabled || discovering}
          >
            {discovering ? t('brain.discover.loading') : t('brain.discover.find')}
          </button>
          {discoverError && <p className="settings-test-err">✗ {t('brain.discover.error')}</p>}
          {discoverEnabled && !discovering && (repos ?? []).length === 0 && !discoverError && (
            <p className="settings-field-hint">{t('brain.discover.empty')}</p>
          )}
          {(repos ?? []).length > 0 && (
            <ul className="brain-discover-list">
              {repos!.map((r) => (
                <li key={r.fullName} className="brain-discover-item">
                  <span className="brain-discover-name">
                    {r.fullName}
                    {r.private && <span className="brain-discover-private">{t('brain.discover.private')}</span>}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => { setAttachUrl(r.htmlUrl); setTab('attach'); }}
                  >
                    {t('brain.discover.select')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'attach' && (
        <div className="brain-setup-panel">
          <div className="settings-field-row">
            <label>{t('brain.attach.url')}</label>
            <input
              className="settings-text-input"
              value={attachUrl}
              onChange={(e) => { setAttachUrl(e.target.value); setTrustConfirmed(false); }}
              placeholder="https://github.com/owner/brain-repo"
              disabled={controlsDisabled}
            />
          </div>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={handlePreview}
            disabled={controlsDisabled || attachPreview.isPending || !attachUrl.trim()}
          >
            {attachPreview.isPending ? t('brain.attach.previewing') : t('brain.attach.preview')}
          </button>

          {preview && (
            <div className="brain-attach-preview">
              {preview.reachable ? (
                <>
                  <div className="brain-trust-warning">
                    <p className="brain-trust-warning-title">{t('brain.attach.trustTitle')}</p>
                    <p>{t('brain.attach.trustBody')}</p>
                  </div>
                  <dl className="brain-attach-meta">
                    <dt>{t('brain.attach.repo')}</dt>
                    <dd>{preview.fullName}</dd>
                    <dt>{t('brain.attach.visibility')}</dt>
                    <dd>{preview.private ? t('brain.attach.private') : t('brain.attach.publicVisibility')}</dd>
                    <dt>{t('brain.attach.isBrainRepo')}</dt>
                    <dd>{preview.isBrainRepo ? '✓' : `✗ ${t('brain.attach.notBrainRepo')}`}</dd>
                    <dt>{t('brain.attach.branch')}</dt>
                    <dd>{preview.defaultBranch}</dd>
                  </dl>
                  <label className="settings-checkbox-label">
                    <input
                      type="checkbox"
                      className="settings-checkbox"
                      checked={trustConfirmed}
                      onChange={(e) => setTrustConfirmed(e.target.checked)}
                      disabled={controlsDisabled}
                    />
                    <span>{t('brain.attach.iTrust')}</span>
                  </label>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleAttach}
                    disabled={controlsDisabled || attachRepo.isPending || !trustConfirmed}
                  >
                    {attachRepo.isPending ? t('brain.attach.attaching') : t('brain.attach.submit')}
                  </button>
                </>
              ) : (
                <p className="settings-test-err">✗ {preview.reason ?? t('brain.attach.unreachable')}</p>
              )}
            </div>
          )}
          {attachError && <p className="settings-test-err">✗ {attachError}</p>}
        </div>
      )}
    </div>
  );
}
