import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task, TaskAssetEntry, TaskAssetUploadProgress } from '../../../hooks/useTasks';
import { useTaskAssets, useUploadTaskAsset } from '../../../hooks/useTasks';
import { useVault } from '../../../context/VaultContext';
import { taskAssetUrl } from '../../../api/client';
import { phoneAllows } from '../../../lib/phoneSurface';
import { MediaEmbed } from '../../sleepy/chat/MediaEmbed';
import { MediaViewer, formatBytes } from './MediaViewer';

type FileEntry = Extract<TaskAssetEntry, { size: number }>;
const GRID = 7;

/** `paste-YYYYMMDD-HHMMSS-mmm.png` — a pasted screenshot's file name (local time). */
export function pasteName(d = new Date(), ext = 'png'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `paste-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}.${ext}`;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

function Tile({ slug, entry, onOpen }: { slug: string; entry: TaskAssetEntry; onOpen: () => void }) {
  const { vault } = useVault();
  if (entry.kind === 'folder') {
    return (
      <div className="dmedia-tile dmedia-tile--folder" title={`${entry.name}/ · ${entry.count} files`}>
        <span className="dmedia-folder-glyph" aria-hidden />
        <span className="dmedia-tile-name">{entry.name}/</span>
        <span className="dmedia-tile-meta">{entry.count} file{entry.count === 1 ? '' : 's'}</span>
      </div>
    );
  }
  const url = taskAssetUrl(vault, slug, entry.path);
  return (
    <button type="button" className={`dmedia-tile dmedia-tile--${entry.kind}`} onClick={onOpen} title={entry.name} data-kind={entry.kind}>
      {entry.kind === 'image' && <img className="dmedia-cover" src={url} alt="" loading="lazy" />}
      {entry.kind === 'video' && (
        <>
          {/* The poster is the clip's first frame, through the one inline player (its controls hidden on a tile). */}
          <MediaEmbed src={`${url}#t=0.1`} kind="video" className="dmedia-cover dmedia-cover--video" />
          <span className="dmedia-play" aria-hidden>▶</span>
        </>
      )}
      {(entry.kind === 'image' || entry.kind === 'video') ? (
        <span className="dmedia-caption">{entry.name}</span>
      ) : (
        <>
          <span className="dmedia-ext">{entry.kind === 'audio' ? '♪' : (entry.name.split('.').pop() || 'file').toUpperCase().slice(0, 4)}</span>
          <span className="dmedia-tile-name">{entry.name}</span>
          <span className="dmedia-tile-meta">{formatBytes(entry.size)}</span>
        </>
      )}
    </button>
  );
}

/**
 * The drawer's Media section (approved v6): the first 7 entries of `state/assets/<slug>/` and
 * "All n", a drop zone over the section (dashed overlay while a file is dragged in), ⌘V of an
 * image while the drawer is open, and Browse. An upload shows as a progress tile, then the grid
 * and the card's clip refresh. Attachments stay on this machine (the assets folder is local).
 * Uploading is a desktop/laptop action: on the phone the drop, paste and Browse are absent.
 */
export function MediaSection({ task }: { task: Task }) {
  const slug = task.slug;
  const { data } = useTaskAssets(slug);
  const [progress, setProgress] = useState<TaskAssetUploadProgress | null>(null);
  const upload = useUploadTaskAsset(slug, setProgress);
  const [over, setOver] = useState(false);
  const [all, setAll] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const canUpload = phoneAllows('POST', `/api/tasks/${slug}/assets`);

  const entries = data?.entries ?? [];
  const files = entries.filter((e): e is FileEntry => e.kind !== 'folder');
  const folders = entries.filter((e) => e.kind === 'folder').length;
  const total = data?.total ?? 0;
  const shown = all ? entries : entries.slice(0, GRID);

  const send = useCallback(async (list: { file: Blob; name: string }[]) => {
    setError(null);
    for (const item of list) {
      try {
        await upload.mutateAsync(item);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed.');
        break;
      }
    }
    setProgress(null);
  }, [upload]);

  // ⌘V while this drawer is open: an image on the clipboard becomes paste-<time>.png.
  useEffect(() => {
    if (!canUpload) return;
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const items = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (!items.length) return;
      e.preventDefault();
      const named = items.map((f) => ({ file: f as Blob, name: pasteName(new Date(), (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')) }));
      setNote(`Screenshot pasted ⌘V → ${named[0].name}`);
      void send(named);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canUpload, send]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 3200); return () => clearTimeout(t); }, [note]);

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  // No attachments and no way to add one (the phone): nothing to show.
  if (!canUpload && entries.length === 0) return null;

  return (
    <section
      className="dsec dmedia"
      data-section="media"
      data-testid="media-section"
      onDragEnter={canUpload ? (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); } : undefined}
      onDragOver={canUpload ? (e) => { if (hasFiles(e)) e.preventDefault(); } : undefined}
      onDragLeave={canUpload ? () => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setOver(false); } : undefined}
      onDrop={canUpload ? (e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const list = Array.from(e.dataTransfer.files).map((f) => ({ file: f as Blob, name: f.name }));
        if (list.length) void send(list);
      } : undefined}
    >
      <div className="dsec-head">
        <h3 className="dsec-title">Media</h3>
        <span className="dsec-count">{total}</span>
        <span className="dsec-actions">
          {entries.length > GRID && (
            <button type="button" className="dsec-action" onClick={() => setAll((v) => !v)}>
              {all ? 'Fewer' : `All ${total}${folders ? ` · ${folders} folder${folders === 1 ? '' : 's'}` : ''}`}
            </button>
          )}
        </span>
      </div>
      <div className="dmedia-grid">
        {shown.map((e) => (
          <Tile key={e.path} slug={slug} entry={e} onOpen={() => setViewer(files.findIndex((f) => f.path === e.path))} />
        ))}
        {progress && (
          <div className="dmedia-tile dmedia-tile--progress" data-testid="media-progress">
            <span className="dmedia-tile-name">{progress.name}</span>
            <span className="dmedia-progress"><span style={{ width: `${progress.total ? Math.round((progress.loaded / progress.total) * 100) : 0}%` }} /></span>
            <span className="dmedia-tile-meta">Uploading…</span>
          </div>
        )}
        {canUpload && (
          <button type="button" className="dmedia-tile dmedia-tile--add" data-testid="media-browse" onClick={() => inputRef.current?.click()}>
            <span aria-hidden className="dmedia-add-plus">+</span>
            <span>Drop, paste or browse</span>
          </button>
        )}
      </div>
      {canUpload && (
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="media-input"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []).map((f) => ({ file: f as Blob, name: f.name }));
            e.target.value = '';
            if (list.length) void send(list);
          }}
        />
      )}
      {over && (
        <div className="dmedia-drop" data-testid="media-drop-overlay">
          <span className="dmedia-drop-title">Drop to attach</span>
          <span className="dmedia-drop-sub">Saved to this task's assets folder</span>
        </div>
      )}
      {error && <div className="prop-error" role="alert">{error}</div>}
      {note && <div className="dmedia-note" role="status">{note}</div>}
      {viewer !== null && viewer >= 0 && files.length > 0 && (
        <MediaViewer slug={slug} files={files} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
    </section>
  );
}
