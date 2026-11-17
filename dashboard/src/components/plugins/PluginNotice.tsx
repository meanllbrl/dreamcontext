import { useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { useVault } from '../../context/VaultContext';
import type { ShellNavigation } from '../layout/Shell';
import { PLUGIN_REFUSED_EVENT, isPluginId, type PluginRefusedDetail } from '../../lib/plugins';
import './plugins.css';

/**
 * The one notice a refused write gets (Mağaza D1 C4/C7): "<plugin> kurulu değil" with a way to
 * its Mağaza page, or the conflicted entry's file. `ApiClient` announces each refusal once on
 * `window`, keyed by vault; only this project's instance shows it, and only while on screen.
 * The surface that made the request stays quiet (`isAnnouncedPluginRefusal`).
 */
export function PluginNotice({ nav }: { nav: ShellNavigation }) {
  const { t } = useI18n();
  const { vault, isActive } = useVault();
  const [notice, setNotice] = useState<PluginRefusedDetail | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<PluginRefusedDetail>).detail;
      if (!d || d.vault !== vault || !isActive) return;
      setNotice(d);
    };
    window.addEventListener(PLUGIN_REFUSED_EVENT, on);
    return () => window.removeEventListener(PLUGIN_REFUSED_EVENT, on);
  }, [vault, isActive]);

  useEffect(() => {
    if (!notice) return undefined;
    const id = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(id);
  }, [notice]);

  if (!notice) return null;
  const known = isPluginId(notice.plugin);
  const name = known ? t(`plugin.${notice.plugin}.name`) : notice.plugin;
  const text = notice.code === 'plugin_entry_conflict'
    ? t('plugin.notice.conflict').replace('{name}', name).replace('{file}', notice.file ?? '')
    : t('plugin.notice.notInstalled').replace('{name}', name);
  return (
    <div className="plg-notice" role="status" data-testid="plugin-notice">
      <span className="plg-notice__text">{text}</span>
      {known && (
        <button
          type="button"
          className="plg-notice__open"
          onClick={() => { setNotice(null); nav.navigate('store', `plugin:${notice.plugin}`); }}
        >
          {t('plugin.notice.open')}
        </button>
      )}
      <button type="button" className="plg-notice__x" aria-label={t('plugin.notice.dismiss')} onClick={() => setNotice(null)}>×</button>
    </div>
  );
}
