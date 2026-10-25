import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import { FrameViewer } from '../../layout/FrameViewer';
import { ImageViewer } from '../../layout/ImageViewer';
import { BoardFullscreen } from '../chat/BoardEmbed';
import { PdfViewer } from '../chat/PdfViewer';
import type { CardFullscreen } from './SuperContainer';

/**
 * A stage card full screen (owner 2026-10-22: "let me look at these closely"): a picture in the
 * picture viewer (fit, actual size, pinch, wheel, drag), a web page in the page viewer, a board in
 * its own full screen, a PDF in the chat's full-window PdfViewer. A clip never comes here: its
 * player goes full screen itself (SuperContainer). Each is portalled over the whole window and closes on Esc, giving focus
 * back to the button that opened it.
 */
export function CardFullscreenView({ subject, onClose }: { subject: CardFullscreen; onClose: () => void }) {
  const { vault } = useVault();
  switch (subject.kind) {
    case 'image':
      return <ImageViewer src={agentFileUrl(vault, subject.path, { raw: true })} alt={subject.title} caption={subject.title} onClose={onClose} />;
    case 'html':
      return <FrameViewer subject={{ kind: 'html', path: subject.path }} onClose={onClose} />;
    case 'page':
      return <FrameViewer subject={{ kind: 'page', href: subject.href, title: subject.title }} onClose={onClose} />;
    case 'board':
      return <BoardFullscreen path={subject.path} onClose={onClose} />;
    case 'pdf':
      return <PdfViewer path={subject.path} label={subject.title} onClose={onClose} />;
    default:
      return null;
  }
}
