import { CommandModal } from '../search/CommandModal';
import { useI18n } from '../../context/I18nContext';
import type { PluginStatus } from '../../lib/plugins';
import './plugins.css';

/**
 * The in-app confirm before a plugin is removed (Mağaza D1 C7; never `window.confirm`, a silent
 * no-op in the desktop app). Says the data stays and lists every automation that runs the
 * plugin's commands, because after a remove such a run fails with `plugin_not_installed`.
 */
export function PluginRemoveConfirm({ name, status, busy, error, onConfirm, onCancel }: {
  name: string;
  status: PluginStatus | undefined;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const autos = status?.automations ?? [];
  return (
    <CommandModal id="plugin-remove-confirm" open onClose={onCancel} ariaLabel={t('plugin.confirm.title').replace('{name}', name)} className="plg-confirm">
      <div className="plg-confirm__body" data-testid="plugin-remove-confirm">
        <h2 className="plg-confirm__title">{t('plugin.confirm.title').replace('{name}', name)}</h2>
        <p className="plg-confirm__text">{t('plugin.confirm.body')}</p>
        {autos.length > 0 && (
          <>
            <p className="plg-confirm__text">{t('plugin.confirm.autos')}</p>
            <ul className="plg-confirm__autos">
              {autos.map((a) => (
                <li key={a.slug}>{a.title || a.slug}{!a.enabled && <span className="plg-muted"> · {t('plugin.confirm.paused')}</span>}</li>
              ))}
            </ul>
          </>
        )}
        {error && <p className="plg-error" role="alert">{error}</p>}
        <div className="plg-confirm__acts">
          <button type="button" className="plg-btn" onClick={onCancel}>{t('plugin.confirm.cancel')}</button>
          <button type="button" className="plg-btn plg-btn--danger" disabled={busy} onClick={onConfirm} data-testid="plugin-remove-ok">{t('plugin.confirm.ok')}</button>
        </div>
      </div>
    </CommandModal>
  );
}
