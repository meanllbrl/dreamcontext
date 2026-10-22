import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TaskAssetEntry } from '../../../hooks/useTasks';
import { useVault } from '../../../context/VaultContext';
import { useAgentCapabilities } from '../../../hooks/useAgentCapabilities';
import { taskAssetUrl } from '../../../api/client';
import { ImageViewer } from '../../layout/ImageViewer';
import { MediaEmbed } from '../../sleepy/chat/MediaEmbed';
import { PdfViewer } from '../../sleepy/chat/PdfViewer';
import { FileActions } from '../../sleepy/chat/FileActions';

type FileEntry = Extract<TaskAssetEntry, { size: number }>;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The project-relative path of an attachment: what the OS hand-off and "Copy path" use. */
export function assetProjectPath(slug: string, path: string): string {
  return `_dream_context/state/assets/${slug}/${path}`;
}

/** Only media and PDFs may be OPENED on the computer; anything else is only revealed (never launched). */
export function openModeFor(kind: FileEntry['kind']): 'auto' | 'reveal' {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' ? 'auto' : 'reveal';
}

function CopyPath({ path }: { path: string }) {
  return (
    <button type="button" className="chat-btn" onClick={() => { void navigator.clipboard?.writeText(path).catch(() => {}); }}>
      <span aria-hidden>⧉</span> Copy path
    </button>
  );
}

/**
 * The full-screen viewer for a task's attachments, with prev/next across the task's files.
 * Images open in the shared ImageViewer (zoom to the pixel); video and audio play through
 * MediaEmbed; a PDF through PdfViewer (its bytes from the task assets route); any other file
 * shows its name and size. On the desktop the OS actions show (Open on computer only OPENS
 * media/PDF and reveals everything else); the browser dashboard shows Copy path only.
 */
export function MediaViewer({ slug, files, index, onIndex, onClose }: {
  slug: string;
  files: FileEntry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const { vault } = useVault();
  const { data: caps } = useAgentCapabilities();
  const desktop = !!caps?.desktop;
  const file = files[index];
  const n = files.length;
  const go = (d: number) => onIndex((index + d + n) % n);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && n > 1) { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft' && n > 1) { e.preventDefault(); go(-1); }
      else if (e.key === 'Escape' && file && file.kind !== 'image') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!file) return null;
  const projectPath = assetProjectPath(slug, file.path);
  const url = taskAssetUrl(vault, slug, file.path);
  const nav: ReactNode = n > 1 ? (
    <span className="mv-nav">
      <button type="button" className="chat-btn" onClick={() => go(-1)} aria-label="Previous file">‹</button>
      <span className="mv-count">{index + 1} / {n}</span>
      <button type="button" className="chat-btn" onClick={() => go(1)} aria-label="Next file">›</button>
    </span>
  ) : null;
  const actions: ReactNode = (
    <span className="mv-actions">
      {nav}
      {desktop ? <FileActions path={projectPath} compact openMode={openModeFor(file.kind)} /> : <CopyPath path={projectPath} />}
    </span>
  );

  if (file.kind === 'image') {
    return <ImageViewer src={url} alt={file.name} caption={`${file.path} · ${formatBytes(file.size)}`} actions={actions} onClose={onClose} />;
  }

  return createPortal(
    <div className="mv-root" role="dialog" aria-modal="true" aria-label={file.name} data-testid="media-viewer">
      <div className="mv-head">
        <span className="mv-name">{file.name}</span>
        <span className="mv-path">{projectPath} · {formatBytes(file.size)}</span>
        <span className="mv-spacer" />
        {actions}
        <button type="button" className="chat-btn mv-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="mv-stage">
        {n > 1 && <button type="button" className="mv-arrow mv-arrow--prev" onClick={() => go(-1)} aria-label="Previous file">‹</button>}
        {file.kind === 'video' && <MediaEmbed key={url} src={url} kind="video" className="mv-video" />}
        {file.kind === 'audio' && <MediaEmbed key={url} src={url} kind="audio" className="mv-audio" />}
        {file.kind === 'pdf' && (
          <div className="mv-pdf" data-testid="media-pdf"><PdfViewer key={url} path={projectPath} label={file.name} src={url} embedded /></div>
        )}
        {file.kind === 'file' && (
          <div className="mv-file">
            <div className="mv-file-ext">{(file.name.split('.').pop() || 'file').toUpperCase().slice(0, 5)}</div>
            <div className="mv-file-name">{file.name}</div>
            <div className="mv-file-size">{formatBytes(file.size)}</div>
          </div>
        )}
        {n > 1 && <button type="button" className="mv-arrow mv-arrow--next" onClick={() => go(1)} aria-label="Next file">›</button>}
      </div>
    </div>,
    document.body,
  );
}
