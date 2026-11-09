/**
 * The Telegram picture builders draw with the SAME kit the Mac draws with.
 *
 * The server cannot import `dashboard/src` (rootDir is `src`), so
 * `scripts/gen-telegram-kits.ts` writes literal copies into `src/lib/telegram/` and
 * `src/lib/sandbox-font.ts`. This test imports both sides and requires byte-equal OUTPUT for
 * fixed inputs: a dashboard change fails here until `npm run gen:telegram-kits` runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildChatSrcdoc, CHAT_HTML_KIT_CSS, HEIGHT_BRIDGE, KIT_BEHAVIOUR, CHAT_KIT_TOKENS as CHAT_TOKEN_NAMES } from '../../dashboard/src/components/sleepy/chat/chatHtmlKit';
import { buildSrcdoc, HTML_KIT_TOKENS } from '../../dashboard/src/components/lab/labHtmlKit';
import { buildReportSrcdoc } from '../../dashboard/src/lib/reportSrcdoc';
import { buildSandboxSrcdoc, SANDBOX_FONT_CSS as DASH_FONT } from '../../dashboard/src/lib/sandboxHtml';
import { pageDefaultCss } from '../../dashboard/src/lib/pageDefaultCss';
import { SELECTION_BRIDGE } from '../../dashboard/src/lib/textSelection';
import { LINK_GUARD } from '../../dashboard/src/lib/htmlLocalAssets';
import { ZOOM_BRIDGE } from '../../dashboard/src/components/layout/frameZoomBridge';
import { buildChatSrcdocServer, buildReportSrcdocServer } from '../../src/lib/telegram/chat-kit.js';
import { buildLabSrcdocServer } from '../../src/lib/telegram/lab-kit.js';
import { SANDBOX_FONT_CSS as SERVER_FONT } from '../../src/lib/sandbox-font.js';
import { CHAT_KIT_TOKENS, LAB_KIT_TOKENS, CHAT_READING_TOKENS, chatHtmlTokens, reportTokens, labTokens } from '../../src/lib/telegram/kit-tokens.js';
import { resolveTokensFromCss } from '../../scripts/telegram-kit-tokens';
import { renderAll, OUTPUTS, TOKENS_CSS } from '../../scripts/gen-telegram-kits';

// A dream-html card the way agents write them: kit classes, a Turkish string, an inline script.
const DREAM_HTML = `<div class="dc-card"><div class="dc-card-title">Haftalık özet · İş</div>
<p class="dc-p">Şu an <span class="dc-mark">3 iş</span> çalışıyor.</p>
<script>document.querySelector('.dc-p').dataset.ok = '1';</script></div>`;
// A report page that brings its own styles (pageDefaultCss steps aside) …
const REPORT_STYLED = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#fafafa}</style></head><body><h1>Rapor</h1><p>Çıktı</p></body></html>`;
// … and one that brings none (pageDefaultCss's inset defaults apply).
const REPORT_BARE = `<h1>Rapor</h1><table><tr><td>Gün</td><td>12</td></tr></table>`;
const INSIGHT_HTML = `<div class="kpi"><span class="kpi-value">1.204</span><span class="kpi-label">Aktif kullanıcı</span></div>`;

describe('server kit builders are byte-equal to the dashboard builders', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`dream-html card (${scheme}, lang, card and full mode)`, () => {
      const tokens = chatHtmlTokens(scheme);
      for (const mode of ['card', 'full'] as const) {
        const a = buildChatSrcdoc({ html: DREAM_HTML, tokens, scheme, mode, lang: 'tr' });
        const b = buildChatSrcdocServer({ html: DREAM_HTML, tokens, scheme, mode, lang: 'tr' });
        expect(b).toBe(a);
      }
      // A lang with markup in it is cleaned the same way on both sides.
      expect(buildChatSrcdocServer({ html: DREAM_HTML, tokens, lang: 'tr"><x' }))
        .toBe(buildChatSrcdoc({ html: DREAM_HTML, tokens, lang: 'tr"><x' }));
      // No lang, an override CSS.
      expect(buildChatSrcdocServer({ html: DREAM_HTML, tokens, overrideCss: '.dc-card{padding:0}' }))
        .toBe(buildChatSrcdoc({ html: DREAM_HTML, tokens, overrideCss: '.dc-card{padding:0}' }));
    });

    it(`report page with and without its own styles (${scheme})`, () => {
      const tokens = reportTokens(scheme);
      for (const html of [REPORT_STYLED, REPORT_BARE]) {
        expect(buildReportSrcdocServer(html, tokens, scheme)).toBe(buildReportSrcdoc(html, tokens, scheme));
      }
    });

    it(`html/v1 insight (${scheme})`, () => {
      const tokens = labTokens(scheme);
      expect(buildLabSrcdocServer(INSIGHT_HTML, tokens, scheme)).toBe(buildSrcdoc(INSIGHT_HTML, tokens, scheme));
    });
  }
});

describe('buildReportSrcdoc is a behaviour-neutral extraction of HtmlFrame', () => {
  it('equals the composition FrameViewer used inline', () => {
    const tokens = reportTokens('light');
    for (const scheme of ['light', 'dark'] as const) {
      for (const html of [REPORT_STYLED, REPORT_BARE]) {
        const inline = buildSandboxSrcdoc({
          html, css: CHAT_HTML_KIT_CSS, tokens, scheme, overrideCss: pageDefaultCss(true),
          headScript: `${HEIGHT_BRIDGE}\n${SELECTION_BRIDGE}\n${LINK_GUARD}\n${ZOOM_BRIDGE}\n${KIT_BEHAVIOUR}`,
        });
        expect(buildReportSrcdoc(html, tokens, scheme)).toBe(inline);
      }
    }
  });

  it('FrameViewer calls it (no second inline composition left behind)', () => {
    const src = readFileSync('dashboard/src/components/layout/FrameViewer.tsx', 'utf-8');
    expect(src).toContain('buildReportSrcdoc(html, pageTokens(resolveChatKitTokens(), scheme, theme), scheme,');
    expect(src).not.toMatch(/buildSandboxSrcdoc\(/);
  });
});

describe('mirrors and tokens', () => {
  it('src/lib/sandbox-font.ts equals the dashboard SANDBOX_FONT_CSS', () => {
    expect(SERVER_FONT).toBe(DASH_FONT);
  });

  it('kit-tokens holds the values tokens.css resolves to today', () => {
    const css = readFileSync(TOKENS_CSS, 'utf-8');
    for (const scheme of ['light', 'dark'] as const) {
      expect(CHAT_KIT_TOKENS[scheme]).toEqual(resolveTokensFromCss(css, CHAT_TOKEN_NAMES, scheme));
      expect(LAB_KIT_TOKENS[scheme]).toEqual(resolveTokensFromCss(css, HTML_KIT_TOKENS, scheme));
    }
    // A resolved value never carries a var(): the server has no cascade to finish it.
    for (const map of [CHAT_KIT_TOKENS.light, CHAT_KIT_TOKENS.dark, LAB_KIT_TOKENS.light, LAB_KIT_TOKENS.dark]) {
      for (const v of Object.values(map)) expect(v).not.toContain('var(');
    }
    expect(CHAT_KIT_TOKENS.light['--color-bg-elevated']).toBeTruthy();
  });

  it('dream-html reads at the chat pane size (15px, 1.75), report pages get no reading tokens', () => {
    const pane = readFileSync('dashboard/src/components/sleepy/ChatPane.css', 'utf-8');
    expect(pane).toContain('--chat-text: calc(15px * var(--zoom, 1));');
    expect(pane).toContain('--chat-line-height: 1.75;');
    expect(CHAT_READING_TOKENS).toEqual({ '--chat-text': '15px', '--chat-line-height': '1.75' });
    expect(chatHtmlTokens()['--chat-text']).toBe('15px');
    expect(reportTokens()['--chat-text']).toBeUndefined();
  });

  it('the generated files are exactly what the generator writes now', () => {
    const out = renderAll();
    for (const key of Object.keys(OUTPUTS) as (keyof typeof OUTPUTS)[]) {
      expect(readFileSync(OUTPUTS[key], 'utf-8'), `${OUTPUTS[key]} is stale: run npm run gen:telegram-kits`).toBe(out[key]);
    }
  });
});
