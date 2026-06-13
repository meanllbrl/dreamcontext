import { useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import {
  useVaults,
  useConnections,
  useAddConnection,
  useRemoveConnection,
  type Connection,
  type ConnectionDirection,
} from '../../hooks/useConnections';
import {
  useFederationInbox,
  useSyncPreview,
  type DigestEntry,
  type PeerDelta,
} from '../../hooks/useFederation';
import './ConnectionsManager.css';

const DIRECTIONS: ConnectionDirection[] = ['out', 'in', 'both'];

interface ConnectionsManagerProps {
  /** Current `shareable` value from the loaded config (default false). */
  shareable: boolean;
  /** Persist the shareable flag via PATCH /api/config. */
  onToggleShareable: (next: boolean) => void;
  /** True while the config PATCH is in flight (disables the switch). */
  shareablePending: boolean;
}

/**
 * Federation Connections control plane (P2.3). Lists registered vaults with the
 * current one highlighted, an add-connection form, and per-connection controls:
 * a 3-way direction toggle, an editable topic filter, and a remove button. The
 * `shareable` switch flips the cross-vault READ gate via PATCH /api/config.
 *
 * NOTE FOR PHASE 3: the inbox view (GET /api/federation/inbox) and the
 * "Preview sync" button (POST /api/federation/sync, dry-run) attach BELOW the
 * connections list — see the marked placeholder near the end of the render.
 */
export function ConnectionsManager({
  shareable,
  onToggleShareable,
  shareablePending,
}: ConnectionsManagerProps) {
  const { t } = useI18n();
  const { data: vaultsData } = useVaults();
  const { data: connections } = useConnections();
  const addConnection = useAddConnection();
  const removeConnection = useRemoveConnection();
  const { data: inbox } = useFederationInbox();
  const syncPreview = useSyncPreview();

  const [newVault, setNewVault] = useState('');
  const [newDirection, setNewDirection] = useState<ConnectionDirection>('both');
  const [formError, setFormError] = useState<string | null>(null);

  const vaults = vaultsData?.vaults ?? [];
  const current = vaultsData?.current ?? null;
  const conns = connections ?? [];
  const connectedNames = new Set(conns.map((c) => c.vault));

  // Peers eligible to add: every registered vault that is NOT the current one
  // and NOT already connected.
  const addableVaults = vaults.filter(
    (v) => v.name !== current && !connectedNames.has(v.name),
  );

  const handleAdd = () => {
    setFormError(null);
    if (!newVault) {
      setFormError(t('federation.error.pick_vault'));
      return;
    }
    addConnection.mutate(
      { vault: newVault, direction: newDirection },
      {
        onSuccess: () => {
          setNewVault('');
          setNewDirection('both');
        },
        onError: (err) => setFormError(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const handleChangeDirection = (conn: Connection, direction: ConnectionDirection) => {
    // Upsert preserves topics + watermark server-side.
    addConnection.mutate({ vault: conn.vault, direction, topics: conn.topics });
  };

  const handleEditTopics = (conn: Connection, raw: string) => {
    const topics = raw.split(',').map((s) => s.trim()).filter(Boolean);
    addConnection.mutate({
      vault: conn.vault,
      direction: conn.direction,
      topics: topics.length > 0 ? topics : null,
    });
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">{t('settings.federation')}</h2>

      {/* Shareable read gate */}
      <div className="settings-checkboxes">
        <label className="settings-checkbox-label">
          <input
            type="checkbox"
            className="settings-checkbox"
            checked={shareable}
            disabled={shareablePending}
            onChange={(e) => onToggleShareable(e.target.checked)}
          />
          <span>{t('federation.shareable.label')}</span>
        </label>
        <p className="settings-field-hint">{t('federation.shareable.hint')}</p>
      </div>

      {/* Registered vaults */}
      <div className="fed-vaults">
        <h3 className="fed-subtitle">{t('federation.vaults')}</h3>
        {vaults.length === 0 ? (
          <p className="settings-field-hint">{t('federation.vaults.empty')}</p>
        ) : (
          <ul className="fed-vault-list">
            {vaults.map((v) => (
              <li
                key={v.name}
                className={`fed-vault-item${v.name === current ? ' fed-vault-item--current' : ''}`}
              >
                <span className="fed-vault-name">{v.name}</span>
                {v.name === current && (
                  <span className="fed-badge">{t('federation.current')}</span>
                )}
                <span className="fed-vault-path">{v.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Existing connections */}
      <div className="fed-connections">
        <h3 className="fed-subtitle">{t('federation.connections')}</h3>
        {conns.length === 0 ? (
          <p className="settings-field-hint">{t('federation.connections.empty')}</p>
        ) : (
          <ul className="fed-conn-list">
            {conns.map((conn) => (
              <li key={conn.vault} className="fed-conn-item">
                <div className="fed-conn-head">
                  <span className="fed-conn-name">{conn.vault}</span>
                  {conn.status === 'stale' && (
                    <span className="fed-badge fed-badge--stale">{t('federation.stale')}</span>
                  )}
                  <button
                    className="btn fed-conn-remove"
                    onClick={() => removeConnection.mutate(conn.vault)}
                    disabled={removeConnection.isPending}
                  >
                    {t('federation.remove')}
                  </button>
                </div>
                <div className="fed-conn-controls">
                  <div className="fed-direction" role="group" aria-label={t('federation.direction')}>
                    {DIRECTIONS.map((dir) => (
                      <button
                        key={dir}
                        className={`fed-dir-btn${conn.direction === dir ? ' fed-dir-btn--active' : ''}`}
                        onClick={() => handleChangeDirection(conn, dir)}
                        disabled={addConnection.isPending}
                      >
                        {t(`federation.direction.${dir}`)}
                      </button>
                    ))}
                  </div>
                  <input
                    className="settings-text-input fed-topics-input"
                    defaultValue={conn.topics?.join(', ') ?? ''}
                    placeholder={t('federation.topics.placeholder')}
                    onBlur={(e) => {
                      const next = e.target.value.split(',').map((s) => s.trim()).filter(Boolean).join(', ');
                      const prev = (conn.topics ?? []).join(', ');
                      if (next !== prev) handleEditTopics(conn, e.target.value);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add connection */}
      <div className="fed-add">
        <h3 className="fed-subtitle">{t('federation.add')}</h3>
        {addableVaults.length === 0 ? (
          <p className="settings-field-hint">{t('federation.add.none')}</p>
        ) : (
          <div className="fed-add-row">
            <select
              className="settings-text-input"
              value={newVault}
              onChange={(e) => setNewVault(e.target.value)}
            >
              <option value="">{t('federation.add.pick')}</option>
              {addableVaults.map((v) => (
                <option key={v.name} value={v.name}>{v.name}</option>
              ))}
            </select>
            <div className="fed-direction" role="group" aria-label={t('federation.direction')}>
              {DIRECTIONS.map((dir) => (
                <button
                  key={dir}
                  className={`fed-dir-btn${newDirection === dir ? ' fed-dir-btn--active' : ''}`}
                  onClick={() => setNewDirection(dir)}
                >
                  {t(`federation.direction.${dir}`)}
                </button>
              ))}
            </div>
            <button
              className="btn btn--primary"
              onClick={handleAdd}
              disabled={addConnection.isPending || !newVault}
            >
              {t('federation.connect')}
            </button>
          </div>
        )}
        {formError && <p className="settings-test-err">{formError}</p>}
      </div>

      {/* Digest inbox — pending + consumed entries with origin provenance (P3.8) */}
      <div className="fed-inbox">
        <h3 className="fed-subtitle">{t('federation.inbox')}</h3>
        {(() => {
          const pending = inbox?.pending ?? [];
          const consumed = inbox?.consumed ?? [];
          const quarantined = inbox?.quarantined ?? [];
          if (
            pending.length === 0 &&
            consumed.length === 0 &&
            quarantined.length === 0
          ) {
            return <p className="settings-field-hint">{t('federation.inbox.empty')}</p>;
          }
          return (
            <>
              {pending.length > 0 && (
                <div className="fed-inbox-group">
                  <h4 className="fed-inbox-group-title">
                    {t('federation.inbox.pending')} ({pending.length})
                  </h4>
                  <ul className="fed-entry-list">
                    {pending.map((e) => (
                      <InboxEntry key={`p-${e.id}`} entry={e} fromLabel={t('federation.inbox.from')} />
                    ))}
                  </ul>
                </div>
              )}
              {consumed.length > 0 && (
                <div className="fed-inbox-group">
                  <h4 className="fed-inbox-group-title">
                    {t('federation.inbox.consumed')} ({consumed.length})
                  </h4>
                  <ul className="fed-entry-list fed-entry-list--consumed">
                    {consumed.map((e) => (
                      <InboxEntry key={`c-${e.id}`} entry={e} fromLabel={t('federation.inbox.from')} />
                    ))}
                  </ul>
                </div>
              )}
              {quarantined.length > 0 && (
                <div className="fed-inbox-group">
                  <h4 className="fed-inbox-group-title fed-inbox-group-title--warn">
                    {t('federation.inbox.quarantined')} ({quarantined.length})
                  </h4>
                  <ul className="fed-entry-list">
                    {quarantined.map((q) => (
                      <li key={`q-${q.file}`} className="fed-entry fed-entry--quarantined">
                        <code className="fed-entry-file">{q.file}</code>
                        <span className="fed-entry-meta">v{q.version}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Preview sync — dry-run preview of the outbound deltas (P3.8) */}
      <div className="fed-preview">
        <div className="fed-preview-head">
          <button
            className="btn"
            onClick={() => syncPreview.mutate()}
            disabled={syncPreview.isPending}
          >
            {syncPreview.isPending ? t('federation.preview.running') : t('federation.preview')}
          </button>
          <p className="settings-field-hint">{t('federation.preview.hint')}</p>
        </div>
        {syncPreview.isError && (
          <p className="settings-test-err">
            {syncPreview.error instanceof Error
              ? syncPreview.error.message
              : String(syncPreview.error)}
          </p>
        )}
        {syncPreview.data && (
          <SyncPreview
            deltas={syncPreview.data.deltas}
            t={t}
          />
        )}
      </div>
    </section>
  );
}

/** One inbox entry row, showing its title, kind and origin provenance. */
function InboxEntry({ entry, fromLabel }: { entry: DigestEntry; fromLabel: string }) {
  return (
    <li className="fed-entry">
      <div className="fed-entry-head">
        <span className="fed-entry-title">{entry.title}</span>
        <span className={`fed-entry-kind fed-entry-kind--${entry.kind}`}>{entry.kind}</span>
      </div>
      <span className="fed-entry-meta">
        {fromLabel} <strong>{entry.origin.vault}</strong>
        {entry.origin.sourceTimestamp ? ` · ${entry.origin.sourceTimestamp}` : ''}
      </span>
    </li>
  );
}

/** Render the dry-run sync preview deltas per peer. */
function SyncPreview({
  deltas,
  t,
}: {
  deltas: PeerDelta[];
  t: (key: string) => string;
}) {
  if (deltas.length === 0) {
    return <p className="settings-field-hint">{t('federation.preview.none')}</p>;
  }
  return (
    <ul className="fed-delta-list">
      {deltas.map((d) => {
        let status: string;
        if (d.stale) status = t('federation.preview.stale');
        else if (!d.consented) status = t('federation.preview.noconsent');
        else if (d.entries.length === 0) status = t('federation.preview.nodelta');
        else status = `${d.entries.length} ${t('federation.preview.entries')}`;
        return (
          <li key={d.vault} className="fed-delta">
            <div className="fed-delta-head">
              <span className="fed-delta-vault">{d.vault}</span>
              <span className="fed-delta-status">{status}</span>
            </div>
            {d.entries.length > 0 && (
              <ul className="fed-entry-list">
                {d.entries.map((e, i) => (
                  <li key={`${d.vault}-${i}`} className="fed-entry">
                    <div className="fed-entry-head">
                      <span className="fed-entry-title">{e.title}</span>
                      <span className={`fed-entry-kind fed-entry-kind--${e.kind}`}>{e.kind}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
