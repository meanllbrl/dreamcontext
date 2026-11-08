import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import { useRemoveVaultLogo } from '../../../hooks/useLauncher';
import { confirmAction } from '../../../lib/desktop';
import { VaultLogo, useVaultLogoPicker } from '../VaultLogo';

/**
 * Right click a project in the Mac drawer → Edit: its logo, chosen, changed or removed. Only the
 * logo. The file goes through the launcher's picker and route (`assets/logo.<ext>`), and the row's
 * `logoStamp` redraws it here and in every other surface.
 *
 * Portalled to the body: a floating drawer must not become this panel's containing block.
 */
export function ProjectLogoPanel({ name, logo, stamp, onClose }: {
  name: string;
  logo: boolean;
  stamp: number | null;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  /** Remove's confirmation is up: Esc belongs to it, not to this panel. */
  const [confirming, setConfirming] = useState(false);
  const remove = useRemoveVaultLogo();
  const picker = useVaultLogoPicker(
    (reason) => setError(t('shell.logo.failed').replace('{reason}', () => reason)),
    t('shell.logo.tooLarge'),
  );
  const busy = picker.busy || remove.isPending;
  const blocked = busy || confirming;
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Focus moves in, and goes back to the project row when the panel leaves.
  useEffect(() => {
    const back = document.querySelector<HTMLElement>(`[data-drawer-project="${CSS.escape(name)}"] [data-testid="drawer-project-row"]`);
    panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { if (back?.isConnected) back.focus(); };
  }, [name]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || blocked) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [blocked, onClose]);

  const choose = () => {
    setError(null);
    picker.pick(name);
  };

  const removeLogo = async () => {
    setError(null);
    setConfirming(true);
    let ok = false;
    try {
      ok = await confirmAction({
        title: t('shell.logo.removeConfirm').replace('{name}', () => name),
        body: t('shell.logo.removeBody'),
        confirmLabel: t('shell.logo.remove'),
        destructive: true,
      });
    } finally {
      setConfirming(false);
    }
    if (!ok) return;
    remove.mutate(name, {
      onError: (err) => setError(t('shell.logo.failed').replace('{reason}', () => (err as Error).message)),
    });
  };

  return createPortal(
    <div className="ns-logo-scrim" data-testid="project-logo-scrim" onClick={(e) => { if (e.target === e.currentTarget && !blocked) onClose(); }}>
      <div ref={panelRef} className="ns-logo-panel" role="dialog" aria-modal="true" aria-label={t('shell.logo.title').replace('{name}', () => name)} data-testid="project-logo-panel">
        <h2 className="ns-logo-title">{t('shell.logo.title').replace('{name}', () => name)}</h2>
        <div className="ns-logo-row">
          <span className="ns-logo-face">
            {logo
              ? <VaultLogo key={stamp} name={name} hasLogo stamp={stamp} size={48} />
              : <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
          </span>
          <div className="ns-logo-side">
            <span className="ns-logo-label">{t('shell.logo.label')}</span>
            <span className="ns-logo-hint">{t('shell.logo.hint')}</span>
          </div>
        </div>
        {error && <p className="ns-logo-error" role="alert" data-testid="project-logo-error">{error}</p>}
        <div className="ns-logo-foot">
          <button type="button" className="ns-logo-btn" disabled={blocked} data-testid="project-logo-choose" onClick={choose}>
            {t(logo ? 'shell.logo.change' : 'shell.logo.choose')}
          </button>
          {logo && (
            <button type="button" className="ns-logo-btn ns-logo-btn--danger" disabled={blocked} data-testid="project-logo-remove" onClick={() => { void removeLogo(); }}>
              {t('shell.logo.remove')}
            </button>
          )}
          <button type="button" className="ns-logo-btn ns-logo-done" disabled={blocked} data-testid="project-logo-done" onClick={onClose}>
            {t('shell.logo.done')}
          </button>
        </div>
        {picker.input}
      </div>
    </div>,
    document.body,
  );
}
