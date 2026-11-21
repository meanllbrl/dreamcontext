import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './ShareViewer.css';
import { GONE_AFTER_MS, initialViewer, kindLabel, onBoard, onPoll, POLL_MS, type PollAnswer, type ViewerState } from './viewerModel';

/**
 * A live link's board, for the guest (tunel-paylasim C7, D5): live and read-only. It reads only
 * the share's own `/__share/*` routes; it never imports the dashboard (no VaultContext, no
 * dashboard API), and its widget cards show a kind and a title, nothing else.
 */

interface GuestWidget { kind?: string; title?: string; markdown?: string; items?: Array<{ text: string; done: boolean }> }
interface BoardBody { name?: string; rev?: string; elements?: unknown[] }

type Api = {
  updateScene: (s: { elements?: readonly unknown[] }) => void;
  addFiles: (files: Array<{ id: string; mimeType: string; dataURL: string; created: number }>) => void;
  scrollToContent: (target?: unknown, opts?: unknown) => void;
};

async function ask(path: string): Promise<PollAnswer> {
  try {
    const r = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* an edge error page */ }
    return { status: r.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

const prefersDark = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

function WidgetCard({ dc }: { dc: GuestWidget }): ReactNode {
  return (
    <div className="sv-card">
      <b>{kindLabel(dc.kind)}</b>
      {dc.title ? <span className="sv-card-title">{dc.title}</span> : null}
      {dc.kind === 'note' && dc.markdown ? <p className="sv-card-text">{dc.markdown}</p> : null}
      {dc.kind === 'todo' && dc.items?.length ? (
        <ul className="sv-card-list">
          {dc.items.map((it, i) => <li key={i} className={it.done ? 'done' : undefined}>{it.text}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export function ClosedPage(): ReactNode {
  return (
    <main className="sv-closed">
      <h1>Bu paylaşım kapandı</h1>
      <p>Linki gönderen kişi paylaşımı kapattı ya da link hiç geçerli değildi. Yeniden görmek için ondan yeni bir link iste.</p>
      <p lang="en" className="sv-en">This share is closed, or the link was never valid. Ask the person who sent it for a new link.</p>
      <footer>dreamcontext canlı link</footer>
    </main>
  );
}

export default function ShareViewer(): ReactNode {
  const [state, setState] = useState<ViewerState>(initialViewer);
  const [first, setFirst] = useState<BoardBody | null>(null);
  const [dark, setDark] = useState(prefersDark);
  const stateRef = useRef(state);
  const apiRef = useRef<Api | null>(null);
  const loaded = useRef(new Set<string>());
  stateRef.current = state;

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const loadPictures = useCallback(async (elements: readonly unknown[]) => {
    const ids: string[] = [];
    for (const el of elements) {
      const e = el as { type?: unknown; fileId?: unknown };
      if (e?.type === 'image' && typeof e.fileId === 'string' && !loaded.current.has(e.fileId)) ids.push(e.fileId);
    }
    for (const id of ids) {
      loaded.current.add(id);
      try {
        const r = await fetch(`/__share/files/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
        if (!r.ok) { loaded.current.delete(id); continue; }
        const blob = await r.blob();
        apiRef.current?.addFiles([{ id, mimeType: blob.type, dataURL: await dataUrlOf(blob), created: Date.now() }]);
      } catch { loaded.current.delete(id); }
    }
  }, []);

  const fetchBoard = useCallback(async () => {
    const a = await ask('/__share/board');
    const body = a.body as BoardBody | null;
    if (a.status === 200 && body && Array.isArray(body.elements) && typeof body.rev === 'string') {
      setState((s) => onBoard(s, body.rev as string));
      if (!apiRef.current) setFirst(body);
      else apiRef.current.updateScene({ elements: body.elements });
      void loadPictures(body.elements);
      return;
    }
    setState((s) => onPoll(s, a, Date.now()).state);
  }, [loadPictures]);

  useEffect(() => { void fetchBoard(); }, [fetchBoard]);

  useEffect(() => {
    let stop = false;
    let t = 0;
    const tick = async () => {
      if (stop) return;
      const cur = stateRef.current;
      if (cur.phase === 'closed' || cur.phase === 'gone') return;
      const a = await ask('/__share/rev');
      if (stop) return;
      const step = onPoll(stateRef.current, a, Date.now());
      setState(step.state);
      if (step.refetch) await fetchBoard();
      // A miss is checked again sooner, so a gone board reads as gone within the rule's window.
      t = window.setTimeout(tick, step.state.missSince !== null ? Math.min(POLL_MS, GONE_AFTER_MS) : POLL_MS);
    };
    t = window.setTimeout(tick, POLL_MS);
    return () => { stop = true; window.clearTimeout(t); };
  }, [fetchBoard]);

  useEffect(() => {
    if (first?.name) document.title = first.name;
  }, [first?.name]);

  if (state.phase === 'closed' || state.phase === 'gone') return <ClosedPage />;

  return (
    <div className={`sv-root${dark ? ' sv-dark' : ''}`}>
      <header className="sv-head">
        <span className="sv-name">{first?.name ?? ''}</span>
        <span className="sv-chip">yalnız görüntüleme</span>
      </header>
      <div className="sv-canvas">
        {first ? (
          <Excalidraw
            excalidrawAPI={(api) => {
              apiRef.current = api as unknown as Api;
              try { apiRef.current.scrollToContent(undefined, { fitToContent: true, animate: false }); } catch { /* not ready */ }
            }}
            initialData={{ elements: first.elements ?? [], appState: { viewBackgroundColor: 'transparent' }, scrollToContent: true } as never}
            viewModeEnabled
            theme={dark ? 'dark' : 'light'}
            validateEmbeddable={(link: string) => typeof link === 'string' && link.startsWith('dreamcontext://')}
            renderEmbeddable={((el: { customData?: { dc?: GuestWidget } }) => <WidgetCard dc={el.customData?.dc ?? {}} />) as never}
            UIOptions={{ canvasActions: { changeViewBackgroundColor: false, clearCanvas: false, export: false, loadScene: false, saveToActiveFile: false, saveAsImage: false, toggleTheme: false } }}
          />
        ) : <div className="sv-loading">Pano açılıyor…</div>}
      </div>
    </div>
  );
}
