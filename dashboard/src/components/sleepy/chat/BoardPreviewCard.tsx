/**
 * Excalidraw board reference, state 4 — a styled placeholder (no rasterizer; the
 * board's own filename + an "Open board ↗" action is the honest, simple version).
 */

function boardName(path: string): string {
  const clean = path.replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i === -1 ? clean : clean.slice(i + 1);
}

export function BoardPreviewCard({ path, onOpenBoard }: { path: string; onOpenBoard: (path: string) => void }) {
  return (
    <div className="chat-board">
      <div className="chat-board-thumb" aria-hidden>🗺️</div>
      <div className="chat-board-foot">
        <span className="chat-board-name"><span aria-hidden>✏️</span> {boardName(path)}</span>
        <button type="button" className="chat-board-open" onClick={() => onOpenBoard(path)}>
          Open board <span aria-hidden>↗</span>
        </button>
      </div>
    </div>
  );
}
