/**
 * Card pictures for Telegram, built by the SERVER from bytes it holds (plan S1, T1-T6, W1, W2, Y1).
 *
 * Pictures in v1: dream-html blocks (taken from the transcript the server already holds),
 * project HTML report pages (read through the H outbound classifier), and insight cards
 * (`render_card`, see `insight-seal.ts`). Everything else goes as text.
 *
 * The sealed page the shell's `html_snapshot` webview renders is built here:
 *   - the MAIN frame holds only the server's own constant script (it sizes the frame from a
 *     height message: a finite number 1..20000 from that frame's own window, nothing else);
 *   - authored bytes run only inside a server-emitted `<iframe sandbox="${SANDBOX_GRANT}"
 *     allow="${SANDBOX_ALLOW}" srcdoc="…">`, built with the same kit the Mac uses
 *     (`buildChatSrcdocServer` / `buildReportSrcdocServer`, byte-equal to the dashboard's);
 *   - the shell puts its sealed CSP first (`html_snapshot.rs` `seal`), so nothing loads.
 *
 * Redaction (T3, W2, Y1): the redactor runs over the WHOLE raw string (script literals and
 * attribute values included) with the base64 body of image/font `data:` URLs left out, and over
 * every other `data:` payload decoded. Any hit → no picture: the caller sends one text line.
 */
import { SERVER_RENDER_WIDTH_PX } from './contract.js';
import { wouldRedact } from './format.js';
import { SANDBOX_ALLOW, SANDBOX_CSP, SANDBOX_GRANT, buildChatSrcdocServer, buildReportSrcdocServer } from './chat-kit.js';
import { chatHtmlTokens, reportTokens } from './kit-tokens.js';

/** `data:` media types whose payload is neither decoded nor scanned (Y1, exact list). */
const OPAQUE_DATA = /^(?:image\/(?:png|jpeg|gif|webp|avif)|font\/[a-z0-9.+-]+)$/i;
/** A `data:` URL inside markup: media type, params, payload up to a quote, `)`, `<` or space. */
const DATA_URL = /data:([^,;\s"'()<>]*)((?:;[^,;\s"'()<>]*)*),([^\s"'()<>]*)/gi;

export interface DataPayload { type: string; opaque: boolean; text: string | null }

/** Every `data:` payload in `raw`, the text ones decoded (base64 or percent-encoded). */
export function dataPayloads(raw: string): DataPayload[] {
  const out: DataPayload[] = [];
  for (const m of raw.matchAll(DATA_URL)) {
    const type = (m[1] || '').trim().toLowerCase();
    const params = (m[2] || '').toLowerCase();
    if (type && OPAQUE_DATA.test(type)) { out.push({ type, opaque: true, text: null }); continue; }
    const body = m[3] ?? '';
    let text: string | null = null;
    try {
      text = /;base64(;|$)/.test(params) ? Buffer.from(decodeURIComponent(body), 'base64').toString('utf8') : decodeURIComponent(body);
    } catch {
      text = body;
    }
    out.push({ type: type || 'text/plain', opaque: false, text });
  }
  return out;
}

/** `raw` with the payload of every opaque (image/font) `data:` URL removed, for the raw pass. */
export function withoutOpaquePayloads(raw: string): string {
  return raw.replace(DATA_URL, (all, type: string, params: string) => (type && OPAQUE_DATA.test(type.trim()) ? `data:${type}${params},` : all));
}

/** Would anything in this authored markup be redacted? Then it never becomes a picture. */
export function authoredSecretHit(raw: string): boolean {
  if (wouldRedact(withoutOpaquePayloads(raw))) return true;
  return dataPayloads(raw).some((p) => !p.opaque && p.text !== null && wouldRedact(p.text));
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The server's ONLY main-frame script (W2): sizes the frame from its own height message. */
export const SEALED_MAIN_SCRIPT = "(function(){var f=document.getElementById('dc-frame');addEventListener('message',function(e){if(!f||e.source!==f.contentWindow)return;var d=e.data;if(!d||typeof d!=='object')return;var h=d.__dreamHtmlHeight;if(typeof h!=='number'||!isFinite(h)||h<1||h>20000)return;f.style.height=Math.ceil(h)+'px';});})();";

/** The main document around one server-built srcdoc: CSP meta first, the constant script, the
 *  sandboxed frame. No authored byte outside the frame's `srcdoc` attribute. */
export function sealedFramePage(srcdoc: string, opts: { background: string; width?: number; height?: number }): string {
  const w = opts.width ?? SERVER_RENDER_WIDTH_PX;
  const h = opts.height ?? 120;
  const bg = /^#[0-9a-fA-F]{3,8}$/.test(opts.background) ? opts.background : '#ffffff';
  return [
    '<!doctype html><html><head>',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta charset="utf-8">',
    `<style>html,body{margin:0;padding:0;background:${bg}}#dc-frame{display:block;border:0;width:${w}px;height:${h}px}</style>`,
    '</head><body>',
    `<iframe id="dc-frame" sandbox="${SANDBOX_GRANT}" allow="${SANDBOX_ALLOW}" srcdoc="${attr(srcdoc)}"></iframe>`,
    `<script>${SEALED_MAIN_SCRIPT}</script>`,
    '</body></html>',
  ].join('');
}

export type PagePlan = { ok: true; page: string; width: number } | { ok: false; reason: 'secret' | 'empty' };

/** A dream-html block (or an option preview's markup, W2) as the chat pane draws it, light. */
export function dreamHtmlPage(html: string, opts: { lang?: string } = {}): PagePlan {
  if (!html.trim()) return { ok: false, reason: 'empty' };
  if (authoredSecretHit(html)) return { ok: false, reason: 'secret' };
  const tokens = chatHtmlTokens('light');
  const srcdoc = buildChatSrcdocServer({ html, tokens, scheme: 'light', mode: 'card', ...(opts.lang ? { lang: opts.lang } : {}) });
  return { ok: true, page: sealedFramePage(srcdoc, { background: tokens['--color-bg'] ?? '#ffffff' }), width: SERVER_RENDER_WIDTH_PX };
}

/** A project HTML report page (bytes the server read through H), as the file viewer draws it. */
export function reportPage(html: string): PagePlan {
  if (!html.trim()) return { ok: false, reason: 'empty' };
  if (authoredSecretHit(html)) return { ok: false, reason: 'secret' };
  const tokens = reportTokens('light');
  const srcdoc = buildReportSrcdocServer(html, tokens, 'light');
  return { ok: true, page: sealedFramePage(srcdoc, { background: tokens['--color-bg'] ?? '#ffffff', height: 600 }), width: SERVER_RENDER_WIDTH_PX };
}

// ─── Blocks in a Super text ─────────────────────────────────────────────────

export interface FenceBlock { lang: string; body: string; index: number }

/** Every fenced block of a text, in order (the same fence rule as `format.ts`). */
export function fenceBlocks(text: string): FenceBlock[] {
  const out: FenceBlock[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const f = /^[ \t]*(```|~~~)\s*([A-Za-z0-9_-]*)/.exec(lines[i]);
    if (!f) { i++; continue; }
    const marker = f[1];
    const body: string[] = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
    i++;
    out.push({ lang: f[2].toLowerCase(), body: body.join('\n'), index: out.length });
  }
  return out;
}
