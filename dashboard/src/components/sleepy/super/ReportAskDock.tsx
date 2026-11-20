import type { ChatSession } from '../chatSession';
import type { Rect } from './superLayout';
import { SuperQuestionCard } from './SuperQuestionCard';

/**
 * The Super's question about the document the window shows, docked under its page (super-v3 K8,
 * D7; owner 2026-11-20: "o sağdaki raporda mı sorsa bunları"). The chat's own card, the one full
 * copy on this Mac: the chat holds one row for it meanwhile. It scrolls inside its dock, so a long
 * question never pushes the page away.
 */
export function ReportAskDock({ rect, item, session }: { rect: Rect; item: string; session: ChatSession }) {
  return (
    <div className="super-ask-dock" data-testid="super-ask-dock" data-item={item}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
      <SuperQuestionCard ask={{ item, kind: 'ask', toolItemId: '', live: true }} session={session} place="dock" />
    </div>
  );
}
