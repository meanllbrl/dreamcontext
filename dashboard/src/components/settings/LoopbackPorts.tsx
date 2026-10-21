import { useApi, useVault } from '../../context/VaultContext';
import { useI18n } from '../../context/I18nContext';
import { setLoopbackGrant, useLoopbackGrants } from '../../lib/loopbackGrants';

/**
 * Settings → Chat → Super Agent: the local ports this project's web cards load without asking
 * (the "Always allow localhost:PORT" the owner gave in a card), each removable with one click
 * (jarvis plan r9, T6). The grants live on this machine, outside the vault.
 */
export function LoopbackPorts() {
  const { t } = useI18n();
  const api = useApi();
  const { vault } = useVault();
  const view = useLoopbackGrants(api, vault, { fresh: false });
  const ports = view?.grants ?? [];
  if (!vault) return null;
  return (
    <div className="settings-loopback-ports" data-testid="settings-loopback-ports">
      {ports.length === 0 ? (
        <span className="settings-field-hint">{t('settings.super.ports.none')}</span>
      ) : (
        <ul className="settings-loopback-list">
          {ports.map((port) => (
            <li key={port} className="settings-loopback-row">
              <code>localhost:{port}</code>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => { void setLoopbackGrant(api, vault, port, 'revoke'); }}>
                {t('settings.super.ports.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
