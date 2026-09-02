import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';
import { useAppZoom } from '../../../hooks/useAppZoom';
import { FullscreenOverlay } from '../../layout/FullscreenOverlay';
import { DownloadNote } from '../../layout/DownloadNote';
import { deliverDownload, deliveredNote, type ExportNote } from '../../../lib/exportDownload';
import {
  buildChatSrcdoc, resolveChatKitTokens, readHeightMessage, readSnapshotMessage, htmlOutline,
  CHAT_HTML_SANDBOX, HTML_PENDING_HEIGHT, HEIGHT_REQUEST_KEY, SNAPSHOT_REQUEST_KEY,
  type HtmlSnapshot,
} from './chatHtmlKit';
import {
  buildStandaloneHtml, exportFilename, titleFromHtml, rasterize,
  copyBlobAsImage, printStandalone, measureStandalone,
} from './htmlExport';
import './HtmlView.css';

/**
 * A ```dream-html block — HTML the AGENT wrote, drawn in a network-less sandboxed iframe.
 *
 * This is the Chat surface's main expressive channel since 2026-08-26, when the typed
 * `chart`/`page` payloads retired. The trade it makes is deliberate: we stop constraining
 * WHAT can be said (a flow, a tabbed comparison, a timeline, two candidate designs side by
 * side — none of which a fixed widget vocabulary could reach) and constrain instead what the
 * markup can DO. It can draw and compute; it cannot fetch, beacon, or touch the app.
 *
 * SECURITY: `sandbox="allow-scripts"` with NO `allow-same-origin`, plus the srcdoc's
 * `default-src 'none'` CSP — see `lib/sandboxHtml.ts` for the full argument, including why
 * the markup is deliberately NOT sanitized (the sandbox is the boundary, not a filter).
 *
 * THREE THINGS THIS ADDS over just dropping markup in an iframe, each fixing a defect the
 * Lab's html/v1 card shipped with:
 *
 *   1. HEIGHT FOLLOWS CONTENT. The Lab hardcoded 232px and cropped anything taller. Here the
 *      body measures itself and posts the number out; until the first message arrives the
 *      frame sits at a small placeholder rather than a tall empty gap. That placeholder is
 *      also the failure mode, so the measurement is a HANDSHAKE and not an announcement —
 *      the host asks again until it has one (`askForHeight`).
 *   2. FULLSCREEN IS A MODE, NOT A ZOOM. `mode="full"` also reaches the kit (`html[data-dc-
 *      mode]`), so a deck's slides become real viewport-height pages instead of the stacked
 *      sections they are inline.
 *   3. THE BRAND OVERRIDE. The vault's own CSS rides in after the kit, so a project's HTML
 *      answers can look like that project without the agent writing a single color.
 *
 * The block wears CARD CHROME (`HtmlView.css`) rather than sitting loose in the transcript —
 * see that file's header for why the original chrome-less version was wrong.
 */

/** The live value of `<html data-theme>`.
 *
 *  Watching the ATTRIBUTE rather than `useTheme().resolved` is the Lab's hard-won lesson
 *  (2026-08-25): the attribute is what actually restyles the tokens, and it can change from
 *  outside the theme context (verify harnesses do exactly this). Watching the source of
 *  truth means an iframe can never be left holding the other theme's colors. */
function useDataTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') ?? 'light');
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') ?? 'light');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme === 'dark' ? 'dark' : 'light';
}

interface KitOverride { css: string | null; path: string; notice: string | null }

/**
 * The vault's `_dream_context/overrides/chat-html-kit.css`, if it has one.
 *
 * `retry: false` and a null fallback are the point: an older backend has no such route, and
 * a missing override must degrade to "the base kit" silently rather than to a broken block.
 * Cached indefinitely per vault — a brand sheet is a file a human edits between sessions,
 * not something worth polling on every message.
 */
function useChatKitOverride() {
  const api = useApi();
  return useQuery({
    queryKey: ['chat-html-kit'],
    queryFn: () => api.get<KitOverride>('/chat/html-kit'),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** How the host recovers a measurement that never reached it: ask the frame again, on a
 *  short beat, until one arrives. The window is deliberately finite — a frame whose bridge
 *  genuinely never ran will never answer, and a timer that outlives the transcript to keep
 *  asking it is worse than a clipped block. */
const HEIGHT_RETRY_MS = 250;
const HEIGHT_RETRIES = 16;

/**
 * The iframe itself. `mode` decides both the kit's slide behaviour and who owns the height:
 * inline the CONTENT does (via the bridge), fullscreen the OVERLAY does (the frame fills it,
 * and the document scrolls inside).
 */
function HtmlFrame({ html, overrideCss, mode, title, reading, frameRefOut }: {
  html: string;
  overrideCss?: string;
  mode: 'card' | 'full';
  title: string;
  /**
   * The element the transcript's reading tokens are resolved from — see `HtmlView`, which
   * owns it. Passed in rather than read from a local ref because the FULLSCREEN frame is
   * portaled to `document.body`, outside `.chat-pane`, where those tokens do not exist:
   * resolving locally would make the presentation the one place the zoom control stops
   * working.
   */
  reading: Element | null;
  /** The overlay's export bar needs to TALK to this frame (the snapshot request), and it
   *  renders in the dialog header, not inside here. Shared ref rather than a callback so
   *  there is exactly one frame identity both sides agree on. */
  frameRefOut?: React.MutableRefObject<HTMLIFrameElement | null>;
}) {
  const theme = useDataTheme();
  const zoom = useAppZoom();
  const { locale } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [measured, setMeasured] = useState<{ html: string; height: number } | null>(null);

  // Rebuilt on theme flip: same html, freshly resolved token values, and the matching
  // color-scheme (a mismatch makes Chromium paint an opaque white canvas behind the
  // transparent body — under the dark theme, a white slab with near-white text on it).
  // `zoom` is in the deps for its EFFECT, not its value: the reading size is read out of
  // the pane's computed style, and the pane only carries the new one after the zoom control
  // has written --zoom. Without it the frame keeps the size it was built at and the block
  // is the one thing on screen that does not follow "− 100% +".
  const srcdoc = useMemo(
    () => buildChatSrcdoc({
      html,
      tokens: resolveChatKitTokens(reading),
      scheme: theme,
      overrideCss,
      mode,
      lang: locale,
    }),
    [html, theme, overrideCss, mode, reading, locale, zoom],
  );

  /**
   * A measurement belongs to the BODY it measured, so it is stored with that body rather
   * than reset by an effect when `html` changes. Same guarantee the reset was there for — a
   * fresh body never inherits the old one's height, so a block that got shorter leaves no
   * gap — without the reset's race: a passive effect runs after paint, so a height that the
   * new document reported FIRST was clobbered back to null by it, and the bridge, having
   * already said its piece, never spoke again.
   *
   * Keyed on `html` and not on `srcdoc` on purpose: a theme flip rebuilds the srcdoc around
   * identical content, and a block that visibly collapses to 40px and grows back every time
   * the theme changes is a worse lie than briefly holding the last true height.
   */
  const height = measured?.html === html ? measured.height : null;

  // useLayoutEffect, NOT useEffect — this is the defect at the heart of this file. Passive
  // effects are flushed after paint, and under a busy main thread (a streaming turn is
  // exactly that) that flush can land AFTER the frame's document has parsed, run the bridge
  // and posted its one height. Nobody was listening, the body never changes size again, and
  // the block sat at its 40px floor for the rest of the session. A layout effect runs
  // synchronously inside the commit, before the browser can run the frame's parser task.
  useLayoutEffect(() => {
    if (mode !== 'card') return;
    function onMessage(event: MessageEvent) {
      // AUTHENTICATE BY SOURCE, NOT ORIGIN. A frame sandboxed without `allow-same-origin`
      // has the opaque origin "null", so an origin check here would either reject our own
      // frame or accept every other sandboxed frame on the page. Window identity is the
      // thing that actually distinguishes them.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const next = readHeightMessage(event.data);
      if (next !== null) setMeasured({ html, height: next });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mode, html]);

  /** "Tell me again" — answered forcibly, past the bridge's own dedupe. */
  const askForHeight = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ [HEIGHT_REQUEST_KEY]: true }, '*');
  }, []);

  // Belt and braces, in that order. `load` is the host's own signal that the document is
  // parsed and its listener installed, so this ask can't be too early; the interval covers
  // every remaining way a single message can go missing (a ping that raced the parse, a
  // srcdoc swapped mid-flight) and stops the moment a height lands.
  useEffect(() => {
    if (mode !== 'card' || height !== null) return;
    let asked = 0;
    const timer = window.setInterval(() => {
      askForHeight();
      if (++asked >= HEIGHT_RETRIES) window.clearInterval(timer);
    }, HEIGHT_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [mode, height, srcdoc, askForHeight]);

  return (
    <iframe
      ref={(el) => { frameRef.current = el; if (frameRefOut) frameRefOut.current = el; }}
      className="chat-htmlview-frame"
      title={title}
      sandbox={CHAT_HTML_SANDBOX}
      srcDoc={srcdoc}
      onLoad={mode === 'card' ? askForHeight : undefined}
      style={{
        // Pre-measurement the frame stands exactly where the placeholder stood, so a block
        // arriving GROWS out of the slot it was already holding instead of collapsing to a
        // 40px sliver and snapping open. See HTML_PENDING_HEIGHT.
        height: mode === 'full' ? '100%' : (height ?? HTML_PENDING_HEIGHT),
        colorScheme: theme,
      }}
    />
  );
}

/**
 * Ask the block what it currently looks like, and wait for the answer.
 *
 * Authenticated by SOURCE for the same reason the height listener is (`event.source`): a
 * frame with no same-origin grant has the opaque origin "null", so an origin check would
 * either reject our own frame or accept every other sandboxed frame on the page.
 *
 * The timeout is the honest half. A block whose author left an unclosed `<script>` has no
 * bridge at all (that is a real defect this codebase has already been bitten by), and an
 * export that hangs forever on a spinner is worse than one that says it could not.
 */
const SNAPSHOT_TIMEOUT_MS = 4000;

function requestSnapshot(frame: HTMLIFrameElement | null): Promise<HtmlSnapshot> {
  return new Promise((resolve, reject) => {
    const win = frame?.contentWindow;
    if (!win) { reject(new Error('The block is not on screen.')); return; }
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    function onMessage(event: MessageEvent) {
      if (event.source !== win) return;
      const snap = readSnapshotMessage(event.data);
      if (!snap) return;
      cleanup();
      resolve(snap);
    }
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The block did not answer in time.'));
    }, SNAPSHOT_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    win.postMessage({ [SNAPSHOT_REQUEST_KEY]: true }, '*');
  });
}

/**
 * The export bar — the five buttons the owner's sketch asked for, minus Save (E2).
 *
 * Every one of them starts the same way: ask the frame for the picture it is showing, wrap
 * it in a standalone document, and then differ only in what they do with that document.
 * That shared first step is the feature — "export" and "what I am looking at" are the same
 * thing, or the button is a lie.
 */
function ExportActions({ frameRef, html, reading, overrideCss, lang, theme, source }: {
  frameRef: React.MutableRefObject<HTMLIFrameElement | null>;
  html: string;
  reading: Element | null;
  overrideCss?: string;
  lang: string;
  theme: 'light' | 'dark';
  source?: string;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ExportNote | null>(null);
  const [naming, setNaming] = useState<string | null>(null);

  const title = useMemo(() => titleFromHtml(html), [html]);

  /** The one shared step. Returns the standalone document for the CURRENT screen state. */
  const buildDoc = useCallback(async () => {
    const snap = await requestSnapshot(frameRef.current);
    return buildStandaloneHtml({
      html: snap.html,
      tokens: resolveChatKitTokens(reading),
      meta: { title, source },
      scheme: theme,
      overrideCss,
      lang,
    });
  }, [frameRef, reading, title, source, theme, overrideCss, lang]);

  const run = useCallback(async (label: string, fn: () => Promise<ExportNote | null>) => {
    setBusy(label);
    setNote(null);
    try {
      setNote(await fn());
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Export failed.' });
    } finally {
      setBusy(null);
    }
  }, []);

  const png = () => run('PNG', async () => {
    const doc = await buildDoc();
    const { width, height } = await measureStandalone(doc);
    return deliveredNote(
      await deliverDownload(await rasterize(doc, width, height), exportFilename(title, 'png')),
    );
  });

  // The one action with no file to report: the OS print sheet IS the feedback, and it is
  // in front of everything. A note under it would be talking to a covered window.
  const pdf = () => run('PDF', async () => {
    await printStandalone(await buildDoc());
    return null;
  });

  const htmlFile = () => run('HTML', async () => {
    const doc = await buildDoc();
    return deliveredNote(await deliverDownload(
      new Blob([doc], { type: 'text/html' }), exportFilename(title, 'html'),
    ));
  });

  const copy = () => run('Copy', async () => {
    const doc = await buildDoc();
    const { width, height } = await measureStandalone(doc);
    const okCopy = await copyBlobAsImage(await rasterize(doc, width, height));
    return { text: okCopy ? '✓ copied as an image' : 'This browser cannot put an image on the clipboard.' };
  });

  /**
   * Save it into the brain under a name.
   *
   * Saves the SNAPSHOT, like every other action here — what you keep is what you were
   * looking at. The name is asked for rather than derived because the derived one is the
   * block's heading, and the heading is what made sense inside the conversation; the name
   * is what has to make sense in a list three weeks later.
   */
  const save = (name: string) => run('Save', async () => {
    const snap = await requestSnapshot(frameRef.current);
    await api.post('/artifacts', { title: name, html: snap.html, sourceTitle: source ?? null });
    // The saved-blocks list is a separate surface; invalidate so it does not show a stale
    // list the moment the user goes looking for what they just saved.
    await queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    setNaming(null);
    return { text: '✓ saved to the brain' };
  });

  if (naming !== null) {
    return (
      <form
        className="chat-htmlexport-name"
        onSubmit={(e) => { e.preventDefault(); if (naming.trim()) save(naming.trim()); }}
      >
        <input
          className="chat-htmlexport-input"
          value={naming}
          autoFocus
          maxLength={120}
          placeholder="Name this block"
          aria-label="Name this block"
          onChange={(e) => setNaming(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }}
        />
        <button className="chat-htmlexport-btn" type="submit" disabled={!naming.trim() || !!busy}>
          {busy === 'Save' ? '…' : 'Save'}
        </button>
        <button className="chat-htmlexport-btn" type="button" onClick={() => setNaming(null)}>
          Cancel
        </button>
      </form>
    );
  }

  return (
    <>
      {note && <DownloadNote note={note} />}
      <button className="chat-htmlexport-btn" onClick={png} disabled={!!busy}
        title="Download this block as a PNG image">
        {busy === 'PNG' ? '…' : '↓ PNG'}
      </button>
      <button className="chat-htmlexport-btn" onClick={pdf} disabled={!!busy}
        title="Print this block, or save it as a PDF">
        {busy === 'PDF' ? '…' : 'PDF'}
      </button>
      <button className="chat-htmlexport-btn" onClick={htmlFile} disabled={!!busy}
        title="Download as one self-contained HTML file — no network, opens anywhere">
        {busy === 'HTML' ? '…' : 'HTML'}
      </button>
      <button className="chat-htmlexport-btn" onClick={copy} disabled={!!busy}
        title="Copy this block to the clipboard as an image">
        {busy === 'Copy' ? '…' : '⧉ Copy'}
      </button>
      <button className="chat-htmlexport-btn" onClick={() => { setNote(null); setNaming(title); }}
        disabled={!!busy} title="Save this block into the brain under a name">
        ☆ Save
      </button>
    </>
  );
}

function HtmlFullscreen({ html, overrideCss, onClose, reading, source }: {
  html: string;
  overrideCss?: string;
  onClose: () => void;
  reading: Element | null;
  source?: string;
}) {
  const fullFrame = useRef<HTMLIFrameElement | null>(null);
  const theme = useDataTheme();
  const { locale } = useI18n();
  // Portaled to document.body because `.agent-surface` sets `contain: layout paint`, which
  // makes it the containing block for `position: fixed` — an un-portaled overlay would be
  // clipped to the chat pane instead of covering the window. Same reason `BoardFullscreen`
  // portals; it cost a bug the first time it was learned.
  return createPortal(
    <FullscreenOverlay
      label="Presentation"
      onClose={onClose}
      actions={(
        <ExportActions
          frameRef={fullFrame}
          html={html}
          reading={reading}
          overrideCss={overrideCss}
          lang={locale}
          theme={theme}
          source={source}
        />
      )}
    >
      <div className="chat-htmlview-full">
        <HtmlFrame html={html} overrideCss={overrideCss} mode="full" title="Presentation"
          reading={reading} frameRefOut={fullFrame} />
      </div>
    </FullscreenOverlay>,
    document.body,
  );
}

/**
 * The slot a `dream-html` block holds while it is still being written.
 *
 * It wears `.chat-htmlview` — the finished block's OWN chrome — on purpose: same box, same
 * measure, same surface, so the card that replaces it does not appear to arrive from
 * somewhere else. What it stands in for is a real absence: the markup is hidden until the
 * fence closes (half-written HTML must never reach the screen), and at ~600 tokens for a
 * 2KB block that is 10-20 seconds of nothing. The old placeholder was a small pill at the
 * BOTTOM of the message, which told the reader neither what was coming nor where — the
 * owner's report of the whole block feeling "kopuk" starts here.
 *
 * So it does two things a pill cannot: it occupies the block's real position (its segment
 * sits exactly where the finished block will — see `ChatSegment`), and it GROWS, filling in
 * each title as the markup closes it. Nothing half-written is ever shown.
 */
export function HtmlPending({ partial }: { partial: string }) {
  const outline = useMemo(() => htmlOutline(partial), [partial]);

  return (
    <div className="chat-htmlview chat-htmlpending" style={{ minHeight: HTML_PENDING_HEIGHT }}>
      <p className="chat-htmlpending-head">
        <span className="chat-htmlpending-dots" aria-hidden>
          <span /><span /><span />
        </span>
        {/* The one thing announced, once. The outline below is aria-hidden: it changes every
            few hundred milliseconds, and a live region that re-reads a growing list of
            headings is worse than silence — the finished block announces itself. */}
        <span role="status">Drawing the answer…</span>
      </p>
      {outline.length > 0 && (
        <ul className="chat-htmlpending-outline" aria-hidden>
          {outline.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
      <span className="chat-htmlpending-bars" aria-hidden>
        <span /><span /><span />
      </span>
    </div>
  );
}

export function HtmlView({ html }: { html: string }) {
  const [full, setFull] = useState(false);
  const { data } = useChatKitOverride();
  const overrideCss = data?.css ?? undefined;

  /**
   * This wrapper is the block's own place IN the transcript, which makes it the honest
   * place to read the transcript's reading size from — whatever `.chat-pane` (or a future
   * host) has set on the column this block sits in, rather than a selector this file would
   * have to keep in sync. State and not a bare ref because the first render has no node yet
   * and the srcdoc has to be rebuilt once it does.
   */
  const [reading, setReading] = useState<Element | null>(null);

  return (
    <div className="chat-htmlview" ref={setReading}>
      <HtmlFrame html={html} overrideCss={overrideCss} mode="card" title="Rendered answer" reading={reading} />
      <button
        type="button"
        className="chat-htmlview-full-btn"
        onClick={() => setFull(true)}
        aria-label="Open full screen"
        title="Open full screen"
      >
        <span aria-hidden>⛶</span>
      </button>
      {data?.notice && <p className="chat-htmlview-notice" role="status">{data.notice}</p>}
      {full && <HtmlFullscreen html={html} overrideCss={overrideCss} onClose={() => setFull(false)} reading={reading} />}
    </div>
  );
}
