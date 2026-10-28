import type { ComponentProps } from 'react';
import type { ExcalidrawEmbeddableElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import ExcalidrawCanvas from '../core/ExcalidrawCanvas';
import { WidgetSlot } from './WhiteboardCanvas';
import { isWidgetLink } from './widgetModel';
import { widgetSlotProps } from './widgetSlot';

/**
 * A whiteboard drawn read-only (a Super stage card, a board in the chat, its full screen): the
 * read-only canvas, with the board's widgets drawn by the same slot the Whiteboards page uses.
 * Without it every widget is an empty embeddable box (owner 2026-10-28: "the widgets do not
 * load in the card"). Lazy-loaded like both canvases it joins.
 *
 * Read-only for real: a widget is always drawn INACTIVE. Excalidraw activates an embeddable on
 * a centre click even in view mode, and an active note, todo, wiki or HTML card opens its
 * editor — whose save would go to the default host's no-op `commitWidget` and be lost without
 * a word. Inactive, no widget shows an edit control; the board is edited on its own page.
 */
const EMBEDS = {
  validateEmbeddable: isWidgetLink,
  renderEmbeddable: (element: NonDeleted<ExcalidrawEmbeddableElement>) => <WidgetSlot {...widgetSlotProps(element, false)} />,
};

export default function WhiteboardReadCanvas(props: Omit<ComponentProps<typeof ExcalidrawCanvas>, 'embeds'>) {
  return <ExcalidrawCanvas {...props} embeds={EMBEDS as ComponentProps<typeof ExcalidrawCanvas>['embeds']} />;
}
