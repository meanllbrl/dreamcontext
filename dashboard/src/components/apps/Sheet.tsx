import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../context/I18nContext';

/**
 * Shared apps on the Apps page (paylasilan-app-ler plan r3): Share, Install, Settings, Update,
 * My own copy, Uninstall. Every decision is the owner's click (`ownerPost`); the server re-checks
 * everything the screen showed (the gate, the sha).
 */

export interface GateFinding { id: string; rule: string; file: string; line?: number; label: string; term?: string }
export interface ConfigField { key: string; type: string; label: string; required: boolean; help?: string; choices?: string[]; value?: string | number | null; set?: boolean }

export const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/** `t` with `{name}` slots filled. */
export function useShareT(): (key: string, vars?: Record<string, string>) => string {
  const { t } = useI18n();
  return (key, vars) => (vars ? Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(v), t(key)) : t(key));
}

/** A counted phrase: `<key>.one` for 1, `<key>.other` (with `{n}`) for everything else. */
export function useShareN(): (key: string, n: number) => string {
  const t = useShareT();
  return (key, n) => t(`${key}.${n === 1 ? 'one' : 'other'}`, { n: String(n) });
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The open sheets, oldest first: the last one is on top and owns the keyboard. */
const OPEN_SHEETS: object[] = [];

export function Sheet({ title, onClose, children, foot, page }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; page?: boolean }) {
  const t = useShareT();
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus moves in on open and back to the opener on close (the ObjectionDialog pattern).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('.share-sheet__body ' + FOCUSABLE.split(', ').join(', .share-sheet__body ')) ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => { opener?.focus?.(); };
  }, []);
  // Esc and Tab belong to the sheet: capture phase, so a drawer's own Esc does not fire too. A
  // sheet opened from an app's page sits on top of it: only the topmost one answers the keys.
  useEffect(() => {
    const token = {};
    OPEN_SHEETS.push(token);
    const onKey = (e: KeyboardEvent) => {
      if (OPEN_SHEETS[OPEN_SHEETS.length - 1] !== token) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close.current(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const all = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!all.length) return;
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && ref.current.contains(active);
      if (e.shiftKey && (!inside || active === all[0])) { e.preventDefault(); all[all.length - 1].focus(); }
      else if (!e.shiftKey && (!inside || active === all[all.length - 1])) { e.preventDefault(); all[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const at = OPEN_SHEETS.indexOf(token);
      if (at >= 0) OPEN_SHEETS.splice(at, 1);
    };
  }, []);
  // On body: a page frame with a transform would otherwise hold the fixed backdrop inside it.
  return createPortal(
    <div className="share-sheet__backdrop" onClick={onClose}>
      <div className={`share-sheet${page ? ' share-sheet--page' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="share-sheet__head">
          {/* A store page names the app in its own top block (the dialog keeps its label): the bar only closes. */}
          {!page && <h2>{title}</h2>}
          <button type="button" className="share-sheet__x" aria-label={t('share.close')} onClick={onClose}>×</button>
        </header>
        <div className="share-sheet__body">{children}</div>
        {foot && <footer className="share-sheet__foot">{foot}</footer>}
      </div>
    </div>,
    document.body,
  );
}

