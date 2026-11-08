/**
 * The srcdoc for a project HTML report page, as the file viewer (`FrameViewer.tsx`
 * `HtmlFrame`) draws it: the chat kit's class CSS, the page-default CSS for pages that
 * bring no styles of their own, and the viewer's bridges (height, selection, link guard,
 * zoom, kit behaviour).
 *
 * A function of its own, not an inline `useMemo` body, so the Telegram server builder
 * (`src/lib/telegram/chat-kit.ts`, written by `scripts/gen-telegram-kits.ts`) can be pinned
 * byte-equal to exactly what the Mac shows (`tests/unit/telegram-kits.test.ts`).
 * No React, no CSS imports: importable by root vitest.
 */
import { buildSandboxSrcdoc } from './sandboxHtml';
import { pageDefaultCss } from './pageDefaultCss';
import { SELECTION_BRIDGE } from './textSelection';
import { LINK_GUARD } from './htmlLocalAssets';
import { ZOOM_BRIDGE } from '../components/layout/frameZoomBridge';
import { CHAT_HTML_KIT_CSS, HEIGHT_BRIDGE, KIT_BEHAVIOUR } from '../components/sleepy/chat/chatHtmlKit';

export function buildReportSrcdoc(html: string, tokens: Record<string, string>, scheme: 'light' | 'dark' = 'light'): string {
  return buildSandboxSrcdoc({
    html,
    css: CHAT_HTML_KIT_CSS,
    tokens,
    scheme,
    overrideCss: pageDefaultCss(true),
    headScript: `${HEIGHT_BRIDGE}\n${SELECTION_BRIDGE}\n${LINK_GUARD}\n${ZOOM_BRIDGE}\n${KIT_BEHAVIOUR}`,
  });
}
