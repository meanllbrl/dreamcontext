import { agentFileKind } from './AgentMessage';
import { SlideOver } from '../sleepy/chat/SlideOver';
import { Lightbox } from '../sleepy/chat/Lightbox';
import { PdfViewer } from '../sleepy/chat/PdfViewer';
import { BoardFullscreen } from '../sleepy/chat/BoardEmbed';
import { classifyReference } from '../sleepy/chat/chatEntities';
import { agentFileUrl, graphContentUrl } from '../../api/client';
import { useVault } from '../../context/VaultContext';
import { useAgentCapabilities } from '../../hooks/useAgentCapabilities';
import '../sleepy/chat/overlays.css';

/**
 * A brain file opened in the app, routed by type exactly as Chat routes a file it opens: a board
 * fullscreen, an image or SVG in the lightbox, a PDF in the viewer, anything else in the
 * slide-over. `path` is brain-relative. The AI Team stage and the task drawer's Deliveries share it.
 */
export function BrainFileViewer({ path, onClose, onOpenPath }: {
  path: string;
  onClose: () => void;
  /** Another brain file the slide-over links to (brain-relative). */
  onOpenPath: (path: string) => void;
}) {
  const { vault } = useVault();
  const desktop = useAgentCapabilities().data?.desktop === true;
  const projectPath = `_dream_context/${path}`;
  const label = path.split('/').pop();
  const kind = agentFileKind(path);
  if (kind === 'board') return <BoardFullscreen path={projectPath} onClose={onClose} />;
  if (path.toLowerCase().endsWith('.svg') && desktop) {
    return <Lightbox src={agentFileUrl(vault, projectPath, { raw: true })} caption={label} path={projectPath} onClose={onClose} />;
  }
  if (kind === 'image') return <Lightbox src={graphContentUrl(vault, path, { raw: true })} caption={label} path={projectPath} onClose={onClose} />;
  if (kind === 'pdf') return <PdfViewer path={projectPath} src={graphContentUrl(vault, path, { raw: true })} label={label} onClose={onClose} />;
  return (
    <SlideOver
      mode="file"
      path={projectPath}
      reference={classifyReference(projectPath)}
      onClose={onClose}
      onNavApp={onClose}
      onOpenPath={(p) => onOpenPath(p.replace(/^_dream_context\//, ''))}
    />
  );
}
