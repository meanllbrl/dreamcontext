import { agentFileUrl } from '../../../api/client';
import { useVaultId } from '../../../context/VaultContext';
import { FrameViewer } from '../../layout/FrameViewer';
import { ImageViewer } from '../../layout/ImageViewer';
import { BoardFullscreen } from '../chat/BoardEmbed';
import { PdfViewer } from '../chat/PdfViewer';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../../../context/I18nContext';
import type { CardFullscreen } from './SuperContainer';

/**
 * A stage card full screen (owner 2026-10-22: "let me look at these closely"): a picture in the
 * picture viewer (fit, actual size, pinch, wheel, drag), a web page in the page viewer, a board in
 * its own full screen, a PDF in the chat's full-window PdfViewer. A clip never comes here: its
 * player goes full screen itself (SuperContainer). Each is portalled over the whole window and closes on Esc, giving focus
 * back to the button that opened it. A page keeps the card's phone / tablet / desktop width.
 */
export function CardFullscreenView({ subject, cardId, onClose, agenda }: { subject: CardFullscreen; cardId?: string; onClose: () => void; agenda?: () => ReactNode }) {
  const { vault } = useVaultId();
  switch (subject.kind) {
    case 'image':
      return <ImageViewer src={agentFileUrl(vault, subject.path, { raw: true })} alt={subject.title} caption={subject.title} onClose={onClose} />;
    case 'html':
      return <FrameViewer subject={{ kind: 'html', path: subject.path }} deviceKey={cardId} onClose={onClose} />;
    case 'page':
      return <FrameViewer subject={{ kind: 'page', href: subject.href, title: subject.title }} deviceKey={cardId} onClose={onClose} />;
    case 'board':
      return <BoardFullscreen path={subject.path} onClose={onClose} />;
    case 'pdf':
      return <PdfViewer path={subject.path} label={subject.title} onClose={onClose} />;
    case 'agenda':
      return agenda ? <AgendaFullscreen title={subject.title} onClose={onClose}>{agenda()}</AgendaFullscreen> : null;
    default:
      return null;
  }
}

/** The agenda over the whole window: its fullest size, live like the card. Esc or × closes and
 *  gives focus back to what opened it. */
function AgendaFullscreen({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A menu or detail open inside the agenda takes its own Esc first.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('.agenda-menu, .agenda-pop')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); back?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="agenda-fullscreen" role="dialog" aria-modal="true" aria-label={title} data-testid="super-agenda-fullscreen">
      <div className="agenda-fullscreen-head">
        <span className="agenda-fullscreen-title">{title}</span>
        <button ref={closeRef} type="button" className="agenda-fullscreen-x" data-testid="super-agenda-fullscreen-close" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="agenda-fullscreen-body">{children}</div>
    </div>,
    document.body,
  );
}
