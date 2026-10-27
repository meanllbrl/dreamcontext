import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import { FrameViewer } from '../../layout/FrameViewer';
import { ImageViewer } from '../../layout/ImageViewer';
import { BoardFullscreen } from '../chat/BoardEmbed';
import type { CardFullscreen } from './SuperContainer';

/**
 * A stage card full screen (owner 2026-10-22: "let me look at these closely"): a picture in the
 * picture viewer (fit, actual size, pinch, wheel, drag), a web page in the page viewer, a board in
 * its own full screen. Each is portalled over the whole window and closes on Esc, giving focus
 * back to the button that opened it. A page keeps the card's phone / tablet / desktop width.
 */
export function CardFullscreenView({ subject, cardId, onClose }: { subject: CardFullscreen; cardId?: string; onClose: () => void }) {
  const { vault } = useVault();
  switch (subject.kind) {
    case 'image':
      return <ImageViewer src={agentFileUrl(vault, subject.path, { raw: true })} alt={subject.title} caption={subject.title} onClose={onClose} />;
    case 'html':
      return <FrameViewer subject={{ kind: 'html', path: subject.path }} deviceKey={cardId} onClose={onClose} />;
    case 'page':
      return <FrameViewer subject={{ kind: 'page', href: subject.href, title: subject.title }} deviceKey={cardId} onClose={onClose} />;
    case 'board':
      return <BoardFullscreen path={subject.path} onClose={onClose} />;
    default:
      return null;
  }
}
