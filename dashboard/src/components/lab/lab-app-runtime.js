/**
 * lab-app-runtime.js — the shim injected into every `app/v1` page's sandboxed
 * srcdoc (host<->iframe postMessage bridge). This is the REFERENCE COPY a
 * script author reads; the shipped shim is `LAB_APP_RUNTIME_JS` in
 * labAppRuntime.ts (SAME text — vitest stubs raw file imports, the
 * lab-html-kit.css lesson, so the runtime cannot live behind an import
 * either). tests/unit/lab-app-body.test.ts pins the two byte-identical.
 *
 * Per-instance config (nonce, current page id, params, the declared page
 * list) is NOT baked into this file — it is set by a small JSON assignment
 * the host injects immediately before this script (`window.__LAB_APP__`),
 * so this shim's own text never changes between insights or reloads.
 *
 * Every message this shim sends or accepts carries three envelope fields:
 * `__dreamLabApp: 1` (namespaced so an unrelated postMessage can never be
 * misread as one of ours), `v: 1` (protocol version), and `nonce` (minted
 * fresh by the host per mounted iframe instance — a document that navigated
 * itself away from this srcdoc never learned it, so it cannot keep talking
 * to the host even in the window before the host's own load-count teardown
 * notices the navigation and stops posting).
 *
 * window.lab is the author-facing API: `lab.page`, `lab.params`,
 * `lab.navigate(pageId, params?)`, `lab.data(key?)` (a Promise resolving to
 * the host-served Dataset — the numbers were embedded at sync time, never
 * fetched), `lab.onRoute(callback)`.
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
