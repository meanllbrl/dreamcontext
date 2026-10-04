import { useState } from 'react';
import { useBoard } from '../../../hooks/useBoards';
import { splitLabCardRef } from '../../../lib/whiteboardWidgets';
import { useWbText } from '../whiteboardHost';
import { LabCardView } from './LabCardView';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import { WidgetWindowChip } from './WidgetWindowChip';
import type { WidgetProps } from './types';

/**
 * A Lab board card on a whiteboard (`lab-card`, ref `<board>/<card-id>`): drawn by the board's
 * own engine, so it looks and behaves as it does in Lab (breakdown chips, tabs, segments, an app
 * page), with its date window on the card and a full-screen view.
 *
 * The card is READ from the board on every render (the same query Lab's page uses, so an edit
 * in Lab shows here on its next poll); the whiteboard stores only the ref. A board or card that
 * is gone says so, never a blank.
 */
export function LabCardWidget({ payload, active, size }: WidgetProps) {
  const tx = useWbText();
  const parts = splitLabCardRef(payload.ref);
  const shown = useBoard(parts?.board ?? null);
  const [fullscreen, setFullscreen] = useState(false);
  const card = parts ? shown.data?.board.cards.find((c) => c.id === parts.card) ?? null : null;
  const primary = card?.insight ? shown.data?.summaries[card.insight] : undefined;
  const title = payload.title || card?.title || primary?.title || payload.ref || tx('whiteboard.kind.lab-card', 'Lab card');

  let body;
  if (!parts) {
    body = <WidgetNotice tone="missing">{tx('whiteboard.widget.badRef', 'This widget has no valid reference.')}</WidgetNotice>;
  } else if (shown.isError) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.labCard.noBoard', 'Lab board not found:')}&nbsp;<code>{parts.board}</code>
      </WidgetNotice>
    );
  } else if (!shown.data) {
    body = <WidgetNotice tone="loading">{tx('whiteboard.widget.loading', 'Loading…')}</WidgetNotice>;
  } else if (!card) {
    body = (
      <WidgetNotice tone="missing">
        {tx('whiteboard.labCard.noCard', 'No such card on this board:')}&nbsp;<code>{payload.ref}</code>
      </WidgetNotice>
    );
  } else {
    body = (
      <LabCardView
        response={shown.data}
        card={card}
        fullscreen={fullscreen}
        onExitFullscreen={() => setFullscreen(false)}
      />
    );
  }

  return (
    <WidgetFrame
      kind="lab-card"
      title={title}
      active={active}
      size={size}
      meta={card?.insight ? <WidgetWindowChip slug={card.insight} /> : null}
      actions={card ? (
        <WidgetButton onClick={() => setFullscreen(true)} title={tx('whiteboard.labCard.fullscreen', 'Full screen')}>⤢</WidgetButton>
      ) : null}
    >
      {body}
    </WidgetFrame>
  );
}
