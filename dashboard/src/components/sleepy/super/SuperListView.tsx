/**
 * The Super head's status pill and its Stage / List switch (plan super-v3 D13, frames v3 03 and
 * v2 05-sekiz-oturum). The pill counts from the record: "N working · N needs you"; working opens
 * the List view, needs you jumps to the first waiting item (`queueHead`, the same item the
 * agenda puts first, K13). The List view is the v2 list: the chat with Today beside it as a
 * page, drawn by the stage's own side-by-side plan (a view the window computes, never written
 * to the record), the Dock hidden. The choice is remembered per window (sessionStorage).
 */
import { useSyncExternalStore } from 'react';
import { useI18n } from '../../../context/I18nContext';

export type StageViewMode = 'stage' | 'list';
const KEY = 'super:view-mode';
let mode: StageViewMode = readStored();
const listeners = new Set<() => void>();

function readStored(): StageViewMode {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(KEY) === 'list' ? 'list' : 'stage'; } catch { return 'stage'; }
}

/** Stage or List, this window's choice (default Stage). */
export function useStageViewMode(): StageViewMode {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => mode,
    () => mode,
  );
}

export function setStageViewMode(next: StageViewMode): void {
  if (next === mode) return;
  mode = next;
  try { sessionStorage.setItem(KEY, next); } catch { /* a window without storage keeps it in memory */ }
  for (const fn of [...listeners]) fn();
}

/** "N working · N needs you": each half is a button; a zero half is not drawn, both zero = nothing. */
export function SuperStatusPill({ working, needs, onWorking, onNeeds }: {
  working: number; needs: number; onWorking: () => void; onNeeds: () => void;
}) {
  const { t } = useI18n();
  if (working <= 0 && needs <= 0) return null;
  return (
    <div className="super-status-pill" data-testid="super-status-pill">
      {working > 0 && (
        <button type="button" className="super-status-half" data-testid="super-status-working" onClick={onWorking}>
          <span className="super-status-dot" data-tone="working" aria-hidden /><b>{working}</b> {t('super.status.working')}
        </button>
      )}
      {working > 0 && needs > 0 && <span className="super-status-sep" aria-hidden />}
      {needs > 0 && (
        <button type="button" className="super-status-half" data-testid="super-status-needs" onClick={onNeeds}>
          <span className="super-status-dot" data-tone="asking" aria-hidden /><b>{needs}</b> {t('super.status.needsYou')}
        </button>
      )}
    </div>
  );
}

/** Finder's two-icon view switch: Stage (windows) and List. */
export function StageListSwitch({ value, onChange }: { value: StageViewMode; onChange: (v: StageViewMode) => void }) {
  const { t } = useI18n();
  return (
    <div className="super-view-switch" role="radiogroup" aria-label={t('super.view.label')} data-testid="super-view-switch">
      <button type="button" role="radio" aria-checked={value === 'stage'} title={t('super.view.stage')} aria-label={t('super.view.stage')}
        data-testid="super-view-stage" onClick={() => onChange('stage')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="2.5" y="4.5" width="8" height="9" rx="1.5" /><path d="M5.5 4.5V3a1.5 1.5 0 0 1 1.5-1.5h5.5A1.5 1.5 0 0 1 14 3v7a1.5 1.5 0 0 1-1.5 1.5h-2" />
        </svg>
      </button>
      <button type="button" role="radio" aria-checked={value === 'list'} title={t('super.view.list')} aria-label={t('super.view.list')}
        data-testid="super-view-list" onClick={() => onChange('list')}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
          <path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.6" cy="4" r=".6" fill="currentColor" /><circle cx="2.6" cy="8" r=".6" fill="currentColor" /><circle cx="2.6" cy="12" r=".6" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}
