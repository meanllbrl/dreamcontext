import type { WidgetPayload, WidgetSize } from '../../../lib/whiteboardWidgets';

/** What every widget component is handed by the registry. */
export interface WidgetProps {
  /** The Excalidraw element id: the handle `commitWidget` writes through. */
  elementId: string;
  payload: WidgetPayload;
  /** True while this widget is Excalidraw's `activeEmbeddable` and receives pointer events. */
  active: boolean;
  /** The grid preset the widget renders to (A17): `dc.size`, or the one nearest its box. */
  size: WidgetSize;
  /** The box height in scene px: a free-form resize can make it differ from the preset's. */
  height?: number;
}
