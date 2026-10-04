import type { Plugin } from 'vite';
import { WIDGET_LINK_PREFIX } from './src/lib/whiteboardWidgets';

/**
 * Excalidraw paints a link icon outside the top-right corner of every element that has a `link`,
 * with no option to turn it off. A whiteboard widget's link is its identity
 * (`dreamcontext://<kind>/<ref>`, the file format), not something to follow: the card opens itself,
 * and the icon floats over the neighbouring card. This rewrites the one guard in front of that
 * paint so a widget link draws nothing; every other link keeps its icon.
 *
 * `if (el.link && !appState.selectedElementIds[el.id])` in the dev build,
 * `if(e.link&&!n.selectedElementIds[e.id])` in the minified one.
 */
const LINK_ICON_GUARD = /if\s*\(\s*([\w$]+)\.link\s*&&\s*!([\w$]+)\.selectedElementIds\[\1\.id\]\s*\)/g;

export function hideWidgetLinkIcon(code: string): { code: string; count: number } {
  let count = 0;
  const out = code.replace(LINK_ICON_GUARD, (_match, el: string, state: string) => {
    count++;
    return `if(${el}.link&&!${el}.link.startsWith(${JSON.stringify(WIDGET_LINK_PREFIX)})&&!${state}.selectedElementIds[${el}.id])`;
  });
  return { code: out, count };
}

/**
 * A production build fails when the guard was not found exactly once: an Excalidraw upgrade that
 * moves it must not ship the icon back silently. Dev serves pre-bundled chunks one request at a
 * time, so there is no end to count at; it only rewrites.
 */
export function excalidrawWidgetLinkIcon(): Plugin {
  let patched = 0;
  let building = false;
  return {
    name: 'dc-excalidraw-widget-link-icon',
    configResolved(config) { building = config.command === 'build'; },
    transform(code, id) {
      if (!id.includes('excalidraw') && !id.includes('.vite/deps')) return null;
      if (!code.includes('selectedElementIds')) return null;
      const result = hideWidgetLinkIcon(code);
      if (result.count === 0) return null;
      patched += result.count;
      return { code: result.code, map: null };
    },
    buildEnd(error) {
      if (!building || error) return;
      if (patched !== 1) {
        this.error(`dc-excalidraw-widget-link-icon: expected Excalidraw's link-icon guard once, found it ${patched} times. Update LINK_ICON_GUARD for this Excalidraw version.`);
      }
    },
  };
}
