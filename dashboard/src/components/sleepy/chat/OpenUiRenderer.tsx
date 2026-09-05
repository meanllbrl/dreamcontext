/**
 * The lazy half of `dream-ui`: everything that actually imports OpenUI.
 *
 * Kept in its own module for one reason — every import below is part of a dependency tree
 * (parser, component library, charting) that a user who never turns the experiment on must
 * never pay for. `OpenUiView` reaches it through `lazyWithReload`, so Vite emits this file
 * and its imports as a separate chunk.
 *
 * WHAT IS DELIBERATELY NOT HERE YET, so a later wave is a change to this file rather than a
 * re-argument:
 *   • Theming. The block currently renders in OpenUI's own light/dark theme, which does NOT
 *     match the transcript's type, size or fonts. That is Wave 4, and it is the axis this
 *     project has already had to fix three times for `dream-html` (F1–F8): the fix is to
 *     derive a theme from the app's RESOLVED tokens (`resolveTokens` in `chatHtmlKit.ts`),
 *     never to re-declare values here.
 *   • Trimming the library. Wave 2 replaces `openuiChatLibrary` with a subset, because the
 *     generated system prompt has to fit the briefing's measured budget.
 *   • `onAction` wiring. Wave 5.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { ThemeProvider, createTheme } from '@openuidev/react-ui';
import { useTheme } from '../../../context/ThemeContext';
import { useI18n } from '../../../context/I18nContext';
import { buildOpenUiTheme, OPENUI_BLOCK_STYLE } from './openuiTheme';
import { openUiChatLibrary } from './openuiLibrary';
import { askTextFor } from './openuiAction';
import '@openuidev/react-ui/index.css';

export default function OpenUiRenderer({ source, streaming = false, onAsk }: {
  source: string;
  streaming?: boolean;
  /** The ONLY way anything inside this block can affect the app: hand a line of TEXT to the
   *  conversation. Absent (a read-only host) means a follow-up renders and does nothing. */
  onAsk?: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [drewNothing, setDrewNothing] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const { resolved: appTheme } = useTheme();
  const { locale } = useI18n();
  const [zoom, setZoom] = useState(() => readZoom());
  // The theme is derived from COMPUTED styles on this element, so it cannot be built before
  // the element exists. This flips once on mount and re-runs the derivation with a real node
  // to read from — without it the first paint would use the fallbacks and never correct.
  const [mounted, setMounted] = useState(false);

  // The app's zoom control changes `--zoom`, which `--chat-text` is a `calc()` over. Nothing
  // in React re-renders on that, so the derived type ramp would keep the size it was built
  // with — the same defect as G1 on the `dream-html` side, where the window's zoom moved the
  // transcript and left every block behind.
  useEffect(() => {
    const sync = () => setZoom(readZoom());
    window.addEventListener('dreamcontext-zoom', sync);
    return () => window.removeEventListener('dreamcontext-zoom', sync);
  }, []);

  // Re-derived when the theme, the zoom or the element changes — never memoised on `source`,
  // which has nothing to do with how it should look.
  const theme = useMemo(
    () => createTheme(buildOpenUiTheme(host.current) as never),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appTheme, zoom, mounted],
  );

  /**
   * "Did anything actually appear?" — asked of the DOM, not of the parser.
   *
   * The measurable failure of this experiment is not a thrown error; it is a block that
   * renders EMPTY. The very first hand-written sample in this project did exactly that,
   * silently, with no error at all, because the grammar is positional and the sample used
   * named arguments. A parse-result check would not have caught it either — the program
   * parsed, it just resolved to nothing.
   *
   * So the check is the honest one: after render, does this subtree contain any element?
   * That catches every cause at once — a rejected program, an unknown component name, a
   * root whose children were all unreferenced and silently dropped.
   *
   * Only asserted once the stream is OVER. Mid-stream an empty subtree is the normal state
   * of a block that has had two tokens.
   */
  useEffect(() => {
    if (streaming) { setDrewNothing(false); return; }
    // A frame later: the renderer mounts its tree in an effect of its own.
    const id = window.requestAnimationFrame(() => {
      setDrewNothing((host.current?.querySelector('*') ?? null) === null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [source, streaming]);

  if (drewNothing) {
    return (
      <ul className="chat-view-notice">
        <li>
          A UI block was written here but drew nothing{reason ? ` — ${reason}` : ' — the notation was not accepted'}.
          The answer's text is unaffected.
        </li>
      </ul>
    );
  }

  return (
    <div
      className="chat-openui-block"
      ref={(el) => { host.current = el; if (el && !mounted) setMounted(true); }}
      style={OPENUI_BLOCK_STYLE}
      // The BLOCK's language, not the document's. `index.html` is `lang="en"` and nothing
      // changes it at runtime, while this project's answers are frequently Turkish — and the
      // package's CSS uses `text-transform: capitalize` in six places, which is locale-aware:
      // under `en` it turns "işlem" into "Işlem" (dotless I), which is the wrong letter in
      // Turkish. Scoped here rather than fixed globally, because the document's language is
      // not this experiment's to change.
      lang={locale}
    >
      <ThemeProvider
        // OUR switch, not the OS's. The package stylesheet flips on
        // `prefers-color-scheme: dark`; this app's theme is a `data-theme` attribute the user
        // picks, and "system" is only one of its options. Without this a Light reader on a
        // dark-mode Mac gets a dark block inside a light transcript.
        mode={appTheme === 'dark' ? 'dark' : 'light'}
        lightTheme={theme}
        darkTheme={theme}
      >
        <Renderer
        response={source}
        library={openUiChatLibrary}
        // TRUE while the fence is still open. The grammar is line-oriented and the parser is
        // built for partial input, which is what lets a block DRAW as it is written instead
        // of appearing whole at the closing fence. Measured on a 6-line program: the card
        // frame is on screen after line 1, the table after line 4.
        isStreaming={streaming}
        // NOT NEGOTIABLE while this renders in-process: the renderer would happily accept a
        // function map or an MCP client here and let agent-authored UI call tools. `null` is
        // the whole point, and `tests/unit/openui-view.test.ts` fails if it ever changes.
        toolProvider={null}
        // A generated control may ASK, never ACT — and this is the whole of what "ask" means.
        onAction={(event) => {
          const text = askTextFor(event);
          if (!text) {
            // Everything that is not a plain continue-the-conversation is refused HERE, at
            // the boundary, rather than by hoping the vocabulary never grows one. The
            // package's other builtin is `open_url`, which would be a second and ungated
            // route to what `dream-actions` gates to https on the client AND in Rust.
            console.warn('[dream-ui] action refused — only continue_conversation carries text', event);
            return;
          }
          onAsk?.(text);
        }}
        // Parse errors are the expected failure of this experiment, not an exception: the
        // model has had little practice with this grammar. They surface here rather than
        // throwing, so the boundary in `OpenUiView` stays for the unexpected kind.
        onError={(errors) => {
          console.warn('[dream-ui] parse errors', errors);
          // Kept for the notice above, and deliberately NOT rendered as the error text
          // itself: a parser message quotes the source, and raw openui-lang spilled into the
          // transcript is the one thing this surface must never show the user.
          const first = Array.isArray(errors) ? errors[0] : null;
          const kind = first && typeof first === 'object' && 'type' in first ? String((first as { type: unknown }).type) : '';
          setReason(kind ? `the notation was not accepted (${kind})` : null);
        }}
        />
      </ThemeProvider>
    </div>
  );
}

/** The window zoom, read off the live document. Same source the kit's own scaling uses. */
function readZoom(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--zoom').trim() || '1';
  } catch {
    return '1';
  }
}
