import { useI18n } from '../../context/I18nContext';
import { GROUP_COLORS, type TabGroup } from './tabStripLogic';

/** The tab strip's menus and its group editor (BoardTabs.tsx). */

export function MenuItem({ label, onClick, disabled, swatch }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  swatch?: string;
}) {
  return (
    <button type="button" role="menuitem" className="wbt-menu-item" disabled={disabled} onClick={onClick}>
      {swatch && <span className="wbt-swatch wbt-swatch--sm" data-color={swatch} aria-hidden="true" />}
      {label}
    </button>
  );
}

/** Chrome's group editor: a name, a colour, Ungroup, Close group. A new group opens it. */
export function GroupEditor({ group, onChange, onUngroup, onClose, canClose, onDone }: {
  group: TabGroup;
  onChange: (patch: Partial<Pick<TabGroup, 'name' | 'color'>>) => void;
  onUngroup: () => void;
  onClose: () => void;
  canClose: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="wbt-editor">
      <input
        className="wbt-editor-name"
        autoFocus
        value={group.name}
        maxLength={80}
        placeholder={t('whiteboard.tabs.groupName')}
        aria-label={t('whiteboard.tabs.groupName')}
        onChange={(e) => onChange({ name: e.target.value })}
        onKeyDown={(e) => { if (e.key === 'Enter') onDone(); }}
      />
      <div className="wbt-colors" role="radiogroup" aria-label={t('whiteboard.tabs.color')}>
        {GROUP_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={group.color === c}
            className="wbt-swatch"
            data-color={c}
            aria-label={t(`whiteboard.tabs.color.${c}`)}
            title={t(`whiteboard.tabs.color.${c}`)}
            onClick={() => onChange({ color: c })}
          />
        ))}
      </div>
      <div className="wbt-menu-sep" role="separator" />
      <MenuItem label={t('whiteboard.tabs.ungroup')} onClick={onUngroup} />
      <MenuItem label={t('whiteboard.tabs.closeGroup')} disabled={!canClose} onClick={onClose} />
    </div>
  );
}

export function CloseGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" />
    </svg>
  );
}
