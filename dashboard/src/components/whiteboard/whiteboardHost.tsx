import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useI18n } from '../../context/I18nContext';
import type { WidgetPayload } from '../../lib/whiteboardWidgets';

/**
 * What a widget needs from the canvas it sits on. Provided by `WhiteboardCanvas` around the
 * Excalidraw tree, so the widgets `renderEmbeddable` returns can reach it through context.
 */
export interface WhiteboardHost {
  /** Write a widget's new payload: `newElementWith` + `updateScene` in ONE call that also keeps
   *  the widget the `activeEmbeddable`, so it stays interactive after the edit. `update` is
   *  applied to the payload CURRENTLY in the scene, not the one the widget last rendered with,
   *  so two quick edits never overwrite each other. */
  commitWidget: (elementId: string, update: (current: WidgetPayload) => WidgetPayload) => void;
  /** A short message in Excalidraw's own toast. */
  toast: (message: string) => void;
  /** The board this canvas shows. An agent card sends it with every message (so the agent is
   *  shown this board) and keys its composer bucket by it. Absent outside a board page. */
  boardSlug?: string;
  /** Move the board's view for a wheel a widget could not use (an HTML block's scroll chain),
   *  pinch zooming around `anchor`, a viewport point. Absent outside a board page. */
  wheelBoard?: (wheel: { dx: number; dy: number; pinch: boolean; shift: boolean }, anchor: { clientX: number; clientY: number }) => void;
}

const noop: WhiteboardHost = { commitWidget: () => {}, toast: () => {} };

export const WhiteboardHostContext = createContext<WhiteboardHost>(noop);

export function useWhiteboardHost(): WhiteboardHost {
  return useContext(WhiteboardHostContext);
}

/**
 * `t(key)` with an in-place English fallback. The app's `t` returns the key itself when a key
 * is missing, and the whiteboard keys land in the strings file in a later wave.
 */
export function useWbText(): (key: string, fallback: string) => string {
  const { t } = useI18n();
  return useCallback((key: string, fallback: string) => {
    const v = t(key);
    return v === key ? fallback : v;
  }, [t]);
}

/** The live value of `<html data-theme>`: the attribute is what actually restyles the tokens
 *  (same reasoning as HtmlView's hook of the same name). */
export function useDataTheme(): 'light' | 'dark' {
  const read = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
