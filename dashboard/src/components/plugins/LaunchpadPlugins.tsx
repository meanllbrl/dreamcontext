import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { RequestError } from '../../api/client';
import { usePluginActions, usePlugins } from '../../hooks/usePlugins';
import { PLUGINS, type PluginId, type PluginMirror } from '../../lib/plugins';
import type { Page } from '../layout/Sidebar';
import { PluginIcon } from './PluginIcon';
import { PluginRemoveConfirm } from './PluginRemoveConfirm';
import './plugins.css';

/**
 * Launchpad's "Eklentiler" grid (Mağaza D1 C7, approved drawing magaza-v3-launchpad): only the
 * installed plugins, so it never offers Kur. A click opens the plugin's page (or its Mağaza page
 * when it has none); right-click opens Menüde göster / Aç / Kaldır, Kaldır behind the in-app confirm.
 */
export function LaunchpadPlugins({ onNavigate }: { onNavigate: (page: Page, id?: string | null) => void }) {
  const { t } = useI18n();
  const { set } = usePlugins();
  const { remove, pins } = usePluginActions();
  const [menu, setMenu] = useState<{ id: PluginId; x: number; y: number } | null>(null);
  const [confirm, setConfirm] = useState<PluginId | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!set) return null;
  const rows = PLUGINS.flatMap((p) => {
    const s = set.plugins.find((r) => r.id === p.id);
    return s?.installed ? [{ p, s }] : [];
  });
  if (rows.length === 0) return null;

  const open = (p: PluginMirror) => (p.page ? onNavigate(p.page) : onNavigate('store', `plugin:${p.id}`));
  // Every pin this Mac holds, removed plugins included: the PUT replaces the whole list, and a pin
  // must survive a teammate's remove and re-install (Decision 7).
  const pinnedIds = set.plugins.filter((r) => r.pinned).map((r) => r.id);
  const togglePin = (id: PluginId) => {
    const next = pinnedIds.includes(id) ? pinnedIds.filter((x) => x !== id) : [...pinnedIds, id];
    pins.mutate(next);
  };
  const confirmRow = confirm ? rows.find((r) => r.p.id === confirm) : undefined;

  return (
    <section className="plg-launch" aria-label={t('plugin.launch.plugins')} data-testid="launchpad-plugins">
      <h2 className="plg-launch__h">{t('plugin.launch.plugins')}</h2>
      <div className="plg-launch__grid">
        {rows.map(({ p, s }) => {
          const name = t(`plugin.${p.id}.name`);
          return (
            <button
              key={p.id}
              type="button"
              className="plg-tile"
              data-testid={`launchpad-plugin-${p.id}`}
              onClick={() => open(p)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ id: p.id, x: e.clientX, y: e.clientY }); }}
              aria-label={s.pinned ? `${name} (${t('plugin.launch.pinned')})` : name}
            >
              <PluginIcon id={p.id} size={64} />
              {s.pinned && p.page && (
                <span className="plg-tile__pin" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round"><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" /></svg>
                </span>
              )}
              <span className="plg-tile__name">{name}</span>
              {s.conflict && <span className="plg-tile__warn">{t('plugin.conflict').replace('{file}', s.file ?? '')}</span>}
            </button>
          );
        })}
      </div>
      {menu && (
        <TileMenu
          x={menu.x}
          y={menu.y}
          canPin={!!PLUGINS.find((p) => p.id === menu.id)?.page}
          pinned={pinnedIds.includes(menu.id)}
          conflict={!!set.plugins.find((r) => r.id === menu.id)?.conflict}
          onPin={() => { togglePin(menu.id); setMenu(null); }}
          onOpen={() => { const p = PLUGINS.find((x) => x.id === menu.id); setMenu(null); if (p) open(p); }}
          onRemove={() => { setError(null); setConfirm(menu.id); setMenu(null); }}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmRow && (
        <PluginRemoveConfirm
          name={t(`plugin.${confirmRow.p.id}.name`)}
          status={confirmRow.s}
          busy={remove.isPending}
          error={error}
          onCancel={() => setConfirm(null)}
          onConfirm={() => remove.mutate(confirmRow.p.id, {
            onSuccess: () => setConfirm(null),
            onError: (e) => setError(e instanceof RequestError && e.code === 'plugin_entry_conflict'
              ? t('plugin.conflict').replace('{file}', e.file ?? e.message)
              : t('plugin.failed').replace('{error}', (e as Error).message)),
          })}
        />
      )}
    </section>
  );
}

function TileMenu({ x, y, canPin, pinned, conflict, onPin, onOpen, onRemove, onClose }: {
  x: number; y: number; canPin: boolean; pinned: boolean; conflict: boolean;
  onPin: () => void; onOpen: () => void; onRemove: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const m = ref.current?.getBoundingClientRect();
    if (!m) return;
    const gap = 8;
    setPos({
      left: Math.max(gap, Math.min(x, window.innerWidth - m.width - gap)),
      top: Math.max(gap, Math.min(y, window.innerHeight - m.height - gap)),
    });
  }, [x, y]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div ref={ref} className="plg-menu plg-ctx" role="menu" style={{ left: pos.left, top: pos.top }} data-testid="launchpad-plugin-menu">
      {canPin && (
        <button type="button" role="menuitemcheckbox" aria-checked={pinned} className="plg-menu__row" onClick={onPin} data-testid="launchpad-pin">
          <span className="plg-menu__lead">{t('plugin.launch.pin')}</span>
          {pinned && <span aria-hidden="true">✓</span>}
        </button>
      )}
      <button type="button" role="menuitem" className="plg-menu__row" onClick={onOpen}>{t('plugin.open')}</button>
      <button type="button" role="menuitem" className="plg-menu__row plg-menu__row--danger" disabled={conflict} onClick={onRemove} data-testid="launchpad-remove">
        {t('plugin.remove')}<span className="plg-muted">{t('plugin.dataStays')}</span>
      </button>
    </div>
  );
}
