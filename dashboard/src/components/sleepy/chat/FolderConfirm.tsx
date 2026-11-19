import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useOwnerCardT } from '../../../context/I18nContext';

/**
 * MOLECULE — "Are you sure?" when a card's folder moved between the look and the press (owner,
 * 2026-11-17: the old "folder changed, look again, then press" line read as an error, and it was
 * not clear the button had to be pressed again). The gate stays: nothing ran. This sheet names the
 * folder it is NOW and asks once; its confirm presses with exactly that folder (the caller passes
 * it as the press root), so what he agrees to is what runs. If it moves again in between, the
 * server refuses again and the sheet asks again. Cancel does nothing.
 *
 * The app's own sheet, never `window.confirm` (a silent no-op in the desktop app's WKWebView).
 */
export function FolderConfirm({ message, confirmLabel, onConfirm, onCancel }: {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useOwnerCardT();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { btnRef.current?.focus(); }, []);
  // Esc cancels; captured so the key never reaches a terminal or composer underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  const sheet = (
    <div className="chat-folderconfirm-scrim" onMouseDown={onCancel}>
      <div
        className="chat-folderconfirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-folderconfirm-title"
        aria-describedby="chat-folderconfirm-msg"
        data-testid="folder-confirm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="chat-folderconfirm-title" id="chat-folderconfirm-title">{t('ownerCard.folderConfirmTitle')}</div>
        <div className="chat-folderconfirm-msg" id="chat-folderconfirm-msg">{message}</div>
        <div className="chat-folderconfirm-actions">
          <button type="button" className="chat-folderconfirm-btn ghost" data-testid="folder-confirm-cancel" onClick={onCancel}>
            {t('ownerCard.folderConfirmCancel')}
          </button>
          <button type="button" ref={btnRef} className="chat-folderconfirm-btn go" data-testid="folder-confirm-go" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body);
}
