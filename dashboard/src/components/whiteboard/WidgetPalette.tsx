import { useEffect, useRef, useState } from 'react';
import type { WidgetPayload } from '../../lib/whiteboardWidgets';
import { AgentPicker, InsightPicker, KnowledgePicker, LabCardPicker, TaskPicker, WebPicker } from './WidgetPickers';
import { useWbText } from './whiteboardHost';

type Stage = 'menu' | 'insight' | 'lab-card' | 'knowledge' | 'task' | 'web' | 'agent';

/**
 * The component library (D8): what a right-click on empty canvas, or the "+ Add" button, opens.
 *
 * Positioned in the canvas wrapper's own pixel space. The last item hands the same right-click
 * back to Excalidraw, so paste and select-all stay one step away.
 */
export function WidgetPalette({ left, top, onPick, onClose, onCanvasMenu, onNewAgent }: {
  left: number;
  top: number;
  onPick: (payload: WidgetPayload) => void;
  onClose: () => void;
  /** Present only when the palette came from a right-click (there is a menu to fall back to). */
  onCanvasMenu?: () => void;
  /** "New agent" in the agent stage: the canvas opens the create dialog for this board. */
  onNewAgent: () => void;
}) {
  const tx = useWbText();
  const [stage, setStage] = useState<Stage>('menu');
  const ref = useRef<HTMLDivElement | null>(null);

  // Dismiss on Escape and on a press outside. Capture phase, so Excalidraw's own handlers
  // (which would otherwise start a selection box) do not swallow the dismissing press first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (stage === 'menu') onClose(); else setStage('menu');
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [stage, onClose]);

  const item = (label: string, action: () => void) => (
    <button type="button" role="menuitem" className="wb-palette-item" onClick={action}>{label}</button>
  );

  return (
    <div
      ref={ref}
      className="wb-palette"
      style={{ left, top }}
      role="menu"
      aria-label={tx('whiteboard.palette.label', 'Add to board')}
      onContextMenu={(e) => e.preventDefault()}
    >
      {stage === 'menu' ? (
        <>
          <p className="wb-palette-heading">{tx('whiteboard.palette.label', 'Add to board')}</p>
          {item(tx('whiteboard.palette.insight', 'Insight…'), () => setStage('insight'))}
          {item(tx('whiteboard.palette.labCard', 'Lab card…'), () => setStage('lab-card'))}
          {item(tx('whiteboard.palette.page', 'Knowledge or file…'), () => setStage('knowledge'))}
          {item(tx('whiteboard.palette.task', 'Task…'), () => setStage('task'))}
          {item(tx('whiteboard.palette.todo', 'Todo list'), () => onPick({ v: 1, kind: 'todo', title: tx('whiteboard.kind.todo', 'Todo'), items: [] }))}
          {item(tx('whiteboard.palette.note', 'Note'), () => onPick({ v: 1, kind: 'note', title: tx('whiteboard.kind.note', 'Note'), markdown: '' }))}
          {item(tx('whiteboard.palette.html', 'HTML block'), () => onPick({ v: 1, kind: 'html', title: tx('whiteboard.kind.html', 'HTML block'), html: '' }))}
          {item(tx('whiteboard.palette.web', 'Web embed…'), () => setStage('web'))}
          {item(tx('whiteboard.palette.agent', 'Agent…'), () => setStage('agent'))}
          {/* A wiki card starts empty and is filled from inside it; each one keeps its own list. */}
          {item(tx('whiteboard.palette.wiki', 'Wiki'), () => onPick({ v: 1, kind: 'wiki', title: tx('whiteboard.kind.wiki', 'Wiki'), sections: [] }))}
          {onCanvasMenu && (
            <>
              <hr className="wb-palette-sep" />
              {item(tx('whiteboard.palette.canvasMenu', 'Canvas menu'), onCanvasMenu)}
            </>
          )}
        </>
      ) : (
        <>
          <button type="button" className="wb-palette-back" onClick={() => setStage('menu')}>
            ← {tx('whiteboard.palette.back', 'Back')}
          </button>
          {stage === 'insight' && <InsightPicker onPick={onPick} />}
          {stage === 'lab-card' && <LabCardPicker onPick={onPick} />}
          {stage === 'knowledge' && <KnowledgePicker onPick={onPick} />}
          {stage === 'task' && <TaskPicker onPick={onPick} />}
          {stage === 'web' && <WebPicker onPick={onPick} />}
          {stage === 'agent' && <AgentPicker onPick={onPick} onNew={onNewAgent} />}
        </>
      )}
    </div>
  );
}
