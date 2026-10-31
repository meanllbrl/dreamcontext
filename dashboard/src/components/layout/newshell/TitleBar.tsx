import { useRef } from 'react';
import { useI18n } from '../../../context/I18nContext';
import { startTitleBarDrag, toggleMaximizeWindow } from '../../../lib/desktop';
import { BrandMark } from '../../brand/BrandMark';
import { HandsfreeButton } from '../../handsfree/HandsfreeButton';
import { VaultLogo } from '../VaultLogo';
import { ProjectPicker, type PickerRow } from './ProjectPicker';
import { ZoomMenu } from './ZoomMenu';

interface TitleBarProps {
  activeVault: string;
  rows: readonly PickerRow[];
  pickerOpen: boolean;
  /** The picker's last row: the app's Add Project flow. */
  onNewProject: () => void;
  onPickerOpen: (open: boolean) => void;
  onPick: (name: string) => void;
  /** The chrome's notice (the ceiling's eviction or refusal), in the new wording. */
  notice: string | null;
  onToggleDrawer: () => void;
  zoom: number;
  zoomLevels: readonly number[];
  onZoom: (level: number) => void;
  onCycleTheme: () => void;
  themeLabel: string;
  dark: boolean;
  /** The active project's own controls portal into these (`chromeSlots.tsx`): search and
   *  back/forward on the left, the sleep tracker and update badge on the right. */
  setLeftSlot: (el: HTMLElement | null) => void;
  setRightSlot: (el: HTMLElement | null) => void;
}

/**
 * The new shell's title bar (owner-approved prototype r27): the drawer button, the project
 * picker, the active project's search and back/forward, the logo centred on the WINDOW,
 * Hands-free, zoom and theme. It is the window's drag handle (every control carries
 * `data-no-drag`), keeps the macOS traffic-light inset, and sits at z-index 40 like today's bar:
 * above the page, below every full-screen view.
 */
export function TitleBar({
  activeVault, rows, pickerOpen, onNewProject, onPickerOpen, onPick, notice, onToggleDrawer,
  zoom, zoomLevels, onZoom, onCycleTheme, themeLabel, dark, setLeftSlot, setRightSlot,
}: TitleBarProps) {
  const { t } = useI18n();
  const pickerRef = useRef<HTMLButtonElement>(null);
  const active = rows.find((r) => r.name === activeVault);
  return (
    <div
      className="ns-titlebar"
      data-testid="ns-titlebar"
      onMouseDown={startTitleBarDrag}
      onDoubleClick={(e) => void toggleMaximizeWindow(e.target)}
    >
      <div className="ns-tb-left">
        <div className="window-chrome-inset" aria-hidden="true" />
        <button
          type="button"
          className="ns-tb-btn"
          data-no-drag
          aria-label={t('shell.drawer.toggle')}
          title={t('shell.drawer.toggle')}
          data-testid="ns-drawer-toggle"
          onClick={onToggleDrawer}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.4" y="2.4" width="13.2" height="11.2" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
            <line x1="6.1" y1="2.8" x2="6.1" y2="13.2" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          ref={pickerRef}
          type="button"
          className="ns-tb-picker"
          data-no-drag
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          title={t('shell.picker.open')}
          data-testid="ns-picker-btn"
          onClick={() => onPickerOpen(!pickerOpen)}
        >
          <VaultLogo name={activeVault} hasLogo={!!active?.logo} stamp={active?.logoStamp ?? null} size={16} />
          <span className="ns-tb-picker-name">{activeVault}</span>
          <svg className="ns-tb-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 3 4 5.5 6.5 3" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
        </button>
        <div className="chrome-slot ns-tb-slot" ref={setLeftSlot} />
      </div>

      <div className="ns-tb-brand" aria-hidden="true">
        <BrandMark size={22} />
        <span className="ns-tb-word">dream<span>context</span></span>
      </div>

      {notice && <div className="ns-tb-notice" role="status" data-testid="ns-notice">{notice}</div>}

      <div className="ns-tb-right">
        <div className="chrome-slot ns-tb-slot" ref={setRightSlot} />
        <div className="ns-tb-hf" data-no-drag><HandsfreeButton vault={activeVault} /></div>
        <ZoomMenu zoom={zoom} levels={zoomLevels} onZoom={onZoom} />
        <button type="button" className="ns-tb-btn" data-no-drag onClick={onCycleTheme} title={`${t('shell.theme')}: ${themeLabel}`} aria-label={`${t('shell.theme')}: ${themeLabel}`}>
          {dark ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 1zm0 10a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 11zm7-3a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 15 8zM5 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 5 8zm7.07-4.07a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 1 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zM6.05 10.66a.5.5 0 0 1 0 .71l-1.41 1.41a.5.5 0 0 1-.71-.71l1.41-1.41a.5.5 0 0 1 .71 0zm7.72 3.12a.5.5 0 0 1-.71 0l-1.41-1.41a.5.5 0 1 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM5.34 6.05a.5.5 0 0 1-.71 0L3.22 4.64a.5.5 0 0 1 .71-.71l1.41 1.41a.5.5 0 0 1 0 .71zM8 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" /></svg>
          )}
        </button>
      </div>

      {pickerOpen && (
        <ProjectPicker
          onNewProject={onNewProject}
          anchor={pickerRef.current}
          rows={rows}
          onPick={(name) => { onPickerOpen(false); onPick(name); }}
          onClose={() => onPickerOpen(false)}
        />
      )}
    </div>
  );
}
