import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import { RequestError } from '../../api/client';
import {
  probeFolder,
  useLauncherDefaults,
  useRegisterVault,
  useScaffoldProject,
  type ScaffoldPayload,
} from '../../hooks/useLauncher';
import { nativeDropWindow, onNativeDrop, openFolderPicker, pickerError } from '../../lib/desktop';
import type { ReadinessReport } from '../../lib/onboardingTypes';
import { GitHubMark } from '../../components/brain/GitHubLogin';
import { CloneFlow, type BareFolder } from './CloneFlow';
import { homeShort } from './handoffPlan';

interface Props {
  report: ReadinessReport | undefined;
  /** A project is being made or registered right now (leaving is refused meanwhile). */
  onBusyChange?: (busy: boolean) => void;
  /** The project exists and is registered: land in it (C8). */
  onLand: (vaultName: string) => void;
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}


/**
 * Screen 2 of the first open, "Open a project" (plan ilk-acilis v2-02, C6, C7), one screen:
 * a drop zone with "Open folder… ⌘O", then New project (a name and Enter) and Clone from GitHub.
 * Any folder goes straight in: a brain is registered as is, a folder without one gets its brain
 * (`scaffold` mode `existing`), and the project lands on its Super screen. No form, no "is ready".
 */
export function ProjectStep({ report: _report, onBusyChange, onLand }: Props) {
  const { t } = useI18n();
  const defaults = useLauncherDefaults();
  const scaffold = useScaffoldProject();
  const register = useRegisterVault();
  const [opening, setOpening] = useState(false);
  const busy = scaffold.isPending || register.isPending || opening;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [dragName, setDragName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const home = defaults.data?.home;
  const defaultParent = defaults.data?.defaultParent ?? '';
  useEffect(() => {
    if (!parentDir && defaultParent) setParentDir(defaultParent);
  }, [defaultParent, parentDir]);

  const showError = useCallback((err: unknown) => {
    if (err instanceof RequestError && err.code === 'symlink_refused') setError(t('onboarding.project.symlinkRefused'));
    else setError(err instanceof Error ? err.message : String(err));
  }, [t]);

  /** Any folder in: register a brain, give a bare folder its brain, then land. */
  const openPath = useCallback(async (path: string, prefill?: Partial<BareFolder>) => {
    if (busyRef.current) return;
    setError(null);
    setOpening(true);
    try {
      const probe = await probeFolder(path.normalize('NFC'));
      const at = probe.path ?? path;
      if (probe.hasContext) {
        try {
          await register.mutateAsync({ name: probe.name, path: at });
        } catch (regErr) {
          const msg = regErr instanceof Error ? regErr.message : String(regErr);
          if (!/already registered/i.test(msg)) throw regErr;
        }
        onLand(probe.name);
        return;
      }
      const payload: ScaffoldPayload = {
        mode: 'existing',
        name: (prefill?.name ?? probe.name).normalize('NFC'),
        projectPath: at,
        description: prefill?.description?.trim() || undefined,
        stack: (prefill?.stack || probe.stack || '').trim() || undefined,
      };
      const res = await scaffold.mutateAsync(payload);
      onLand(res.vault.name);
    } catch (err) {
      // A dropped file (not a folder) answers "does not exist" or "not a folder" from detect.
      if (err instanceof RequestError && /not a (folder|directory)|does not exist/i.test(err.message)) setError(t('onboarding.open.dropFolderOnly'));
      else showError(err);
    } finally {
      setOpening(false);
    }
  }, [onLand, register, scaffold, showError, t]);

  const chooseFolder = useCallback(async () => {
    if (busyRef.current) return;
    setError(null);
    const picked = await openFolderPicker();
    if (!picked) {
      const failure = pickerError();
      if (failure) setError(failure);
      return;
    }
    await openPath(picked);
  }, [openPath]);

  // ⌘O (Ctrl+O off macOS), only while this step is on screen and no text field has the focus.
  useEffect(() => {
    if (cloning) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'o' || e.shiftKey || e.altKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      void chooseFolder();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chooseFolder, cloning]);

  // C7: a folder dropped from Finder, with its real path, in the first-run window only.
  useEffect(() => {
    if (cloning || !nativeDropWindow()) return undefined;
    let off: (() => void) | null = null;
    let gone = false;
    void onNativeDrop((e) => {
      if (e.type === 'over') setDragName(e.paths[0] ? basename(e.paths[0]) : '');
      else if (e.type === 'leave') setDragName(null);
      else {
        setDragName(null);
        if (e.paths.length === 1) void openPath(e.paths[0]);
        else if (e.paths.length > 1) setError(t('onboarding.open.dropFolderOnly'));
      }
    }).then((fn) => { if (gone) fn(); else off = fn; });
    return () => { gone = true; off?.(); };
  }, [cloning, openPath, t]);

  async function createNew() {
    const n = name.trim().normalize('NFC');
    const parent = parentDir.trim().normalize('NFC');
    if (!n || !parent || busyRef.current) return;
    setError(null);
    try {
      const res = await scaffold.mutateAsync({ mode: 'new', name: n, parentDir: parent });
      onLand(res.vault.name);
    } catch (err) {
      showError(err);
    }
  }

  if (cloning) {
    return (
      <CloneFlow
        defaultParent={defaultParent}
        home={home}
        onBack={() => setCloning(false)}
        onExistingProject={onLand}
        onBareFolder={(bare) => void openPath(bare.path, bare)}
      />
    );
  }

  const over = dragName !== null || dragging;
  const target = name.trim() && parentDir.trim() ? `${parentDir.trim().replace(/\/+$/, '')}/${name.trim()}` : `${parentDir.replace(/\/+$/, '')}/…`;

  return (
    <div className="ob-panel-body ob-open">
      <h2 className="ob-title">{t('onboarding.open.title')}</h2>
      <p className="ob-subtitle">{t('onboarding.open.subtitle')}</p>
      <div
        className={`ob-drop${over ? ' ob-drop--over' : ''}`}
        data-testid="ob-drop"
        // In a window without the OS drop handler a dropped folder has no path: say so.
        onDragOver={(e) => { if (!nativeDropWindow()) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (!nativeDropWindow()) { e.preventDefault(); setDragging(false); setError(t('onboarding.open.dropUnavailable')); } }}
      >
        <svg className="ob-drop-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
        </svg>
        {over ? (
          <p className="ob-drop-text">{dragName ? t('onboarding.open.dropTo').replace('{name}', dragName) : t('onboarding.open.dropFolderOnly')}</p>
        ) : (
          <>
            <p className="ob-drop-text">{t('onboarding.open.drop')}</p>
            <button type="button" className="ob-btn ob-btn--primary" onClick={() => void chooseFolder()} disabled={busy} data-testid="ob-open-folder" autoFocus>
              {opening ? t('onboarding.open.opening') : t('onboarding.open.button')}
              <kbd className="ob-kbd">{isMac ? '⌘O' : 'Ctrl+O'}</kbd>
            </button>
          </>
        )}
      </div>
      {error && <p className="ob-error" role="alert">{error}</p>}
      <div className="ob-rows">
        <div className={`ob-row${newOpen ? ' ob-row--open' : ''}`}>
          <button type="button" className="ob-row-head" onClick={() => setNewOpen((o) => !o)} aria-expanded={newOpen} data-testid="ob-new-project">
            <span className="ob-row-icon" aria-hidden="true">+</span>
            <span className="ob-row-text">
              <span className="ob-row-title">{t('onboarding.open.newTitle')}</span>
              <span className="ob-row-body">{t('onboarding.open.newBody')}</span>
            </span>
            <span className="ob-row-chev" aria-hidden="true">›</span>
          </button>
          {newOpen && (
            <div className="ob-row-new">
              <div className="ob-inline">
                <input
                  className="ob-input"
                  type="text"
                  value={name}
                  placeholder={t('onboarding.open.newPlaceholder')}
                  aria-label={t('onboarding.open.newPlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void createNew(); }}
                  autoFocus
                  data-testid="ob-new-name"
                />
                <button type="button" className="ob-btn ob-btn--primary" onClick={() => void createNew()} disabled={!name.trim() || !parentDir.trim() || busy}>
                  {scaffold.isPending ? t('onboarding.project.working') : t('onboarding.open.create')} <span aria-hidden="true">↵</span>
                </button>
              </div>
              <p className="ob-hint ob-path">
                {t('onboarding.open.creates').replace('{path}', homeShort(target, home))}{' '}
                <button
                  type="button"
                  className="ob-link"
                  onClick={async () => {
                    const picked = await openFolderPicker();
                    if (picked) setParentDir(picked.normalize('NFC'));
                    else if (pickerError()) setError(pickerError());
                  }}
                >
                  {t('onboarding.open.change')}
                </button>
              </p>
            </div>
          )}
        </div>
        <div className="ob-row">
          <button type="button" className="ob-row-head" onClick={() => { setError(null); setCloning(true); }} data-testid="ob-clone">
            <span className="ob-row-icon" aria-hidden="true"><GitHubMark size={14} /></span>
            <span className="ob-row-text">
              <span className="ob-row-title">{t('onboarding.open.cloneTitle')}</span>
              <span className="ob-row-body">{t('onboarding.open.cloneBody')}</span>
            </span>
            <span className="ob-row-chev" aria-hidden="true">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}
