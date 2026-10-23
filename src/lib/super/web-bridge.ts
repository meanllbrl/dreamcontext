/**
 * The script the web-card session proxy (`src/server/web-session-proxy.ts`) puts at the top of
 * every page it serves from an approved dev server (owner 2026-10-22). It runs in the dev app's
 * own origin, inside the card's frame, and does four things:
 *
 *  1. KEEPS localStorage across app runs. WKWebView holds a frame's storage in memory only, so
 *     the bridge posts the page's localStorage to the proxy (debounced, and on pagehide) and, on
 *     the first load of a run (its localStorage empty), reads it back with a same-origin
 *     synchronous request BEFORE the app's own scripts run. The stored copy is never inside
 *     this script: a page on another site may load a script cross-origin, never read JSON.
 *  2. Keeps the page's cookies its own: cookies on 127.0.0.1 are shared by every port, so the
 *     proxy prefixes every cookie name with the session key (`dc<key>.`) and this bridge does
 *     the same for `document.cookie`, reading back only its own, prefix removed. The page sees
 *     its cookies under their own names; another card's (or the dashboard's) never. It also
 *     records the names, so "Clear cache" can expire them.
 *  3. INSPECT: on the card's word, hover outlines an element, a click picks it (the page never
 *     sees that click), Esc leaves. A pick posts the page URL, a CSS selector, the tag and key
 *     attributes, the visible text, the nearest React components, the box and a picture of the
 *     element (drawn through an SVG foreignObject; WKWebView and Chromium both draw it untainted).
 *  4. Posts the card's pinch and ctrl/cmd + wheel (the `frameZoomBridge` message), so a card
 *     zoomed in place still follows the trackpad over a live page.
 *
 * It talks ONLY to the dashboard's origin(s) (`parents`): every postMessage names that target,
 * and a message is read only from the parent window at one of those origins. A field input's
 * value is never read.
 */

/** The proxy's own paths, outside any dev app's routes. */
export const BRIDGE_PATH = '/__dreamcontext/bridge.js';
export const STORAGE_PATH = '/__dreamcontext/storage';
export const CLEAR_PATH = '/__dreamcontext/clear';
/** The postMessage key of the card ↔ page channel (the zoom bridge keeps its own). */
export const WEB_CARD_KEY = '__dreamWebCard';

/** JSON for an inline script: `<`, U+2028 and U+2029 escaped, so no value can end the tag. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The cookie-name prefix of a session (`dc<key>.`): the proxy and the bridge use the same one. */
export function cookiePrefix(key: string): string {
  return `dc${key}.`;
}

export function webBridgeScript(opts: { parents: readonly string[]; generation: number; cookiePrefix: string }): string {
  // Function replacements: a `$` in a value must never read as a replacement pattern.
  return BRIDGE_SOURCE
    .replace('__PREFIX__', () => inlineJson(opts.cookiePrefix))
    .replace('__PARENTS__', () => inlineJson(opts.parents))
    .replace('__GENERATION__', () => String(Math.max(0, Math.floor(opts.generation))))
    .replace('__STORAGE__', () => inlineJson(STORAGE_PATH))
    .replace('__KEY__', () => inlineJson(WEB_CARD_KEY));
}

/**
 * The page "Clear cache" navigates the frame to: it clears what only the page itself can reach
 * (localStorage, sessionStorage, IndexedDB, Cache Storage, service workers), then goes back to
 * where the owner was. The response carrying it expires the known cookies and clears the HTTP
 * cache (headers, set by the proxy).
 */
export function clearPageHtml(next: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Clearing…</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;font:13px system-ui,sans-serif;color:#8a8a99">Clearing…
<script>(function () {
  var NEXT = ${inlineJson(next)};
  function settle(p) { return Promise.race([p.catch(function () {}), new Promise(function (r) { setTimeout(r, 1500); })]); }
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  var jobs = [];
  try {
    if (window.indexedDB && indexedDB.databases) {
      jobs.push(settle(indexedDB.databases().then(function (dbs) {
        return Promise.all(dbs.map(function (d) {
          return new Promise(function (r) { var q = indexedDB.deleteDatabase(d.name); q.onsuccess = q.onerror = q.onblocked = function () { r(); }; });
        }));
      })));
    }
  } catch (e) {}
  try { if (window.caches) jobs.push(settle(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }))); } catch (e) {}
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(settle(navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); })));
    }
  } catch (e) {}
  Promise.all(jobs).then(function () { location.replace(NEXT); });
})();</script></body></html>`;
}

/**
 * The bridge itself, plain ES2017 (it runs in whatever the dev app is). Placeholders are filled
 * by `webBridgeScript`; nothing in it may depend on the page's globals beyond the DOM.
 */
const BRIDGE_SOURCE = `(function () {
  'use strict';
  if (window.__dreamWebCardBridge) return;
  window.__dreamWebCardBridge = true;
  var PREFIX = __PREFIX__;
  var PARENTS = __PARENTS__;
  var GEN = __GENERATION__;
  var STORAGE = __STORAGE__;
  var KEY = __KEY__;
  var MAX_POST = 5500000;

  // ── 1. localStorage across app runs ────────────────────────────────────────────────
  var ls = null;
  try { ls = window.localStorage; } catch (e) { ls = null; }
  if (ls) {
    try {
      if (ls.length === 0) {
        var x = new XMLHttpRequest();
        x.open('GET', STORAGE, false);
        x.send(null);
        if (x.status === 200) {
          var kept = JSON.parse(x.responseText);
          for (var k in kept) if (Object.prototype.hasOwnProperty.call(kept, k) && typeof kept[k] === 'string') ls.setItem(k, kept[k]);
        }
      }
    } catch (e) { /* nothing kept, or storage refused */ }
  }

  var cookieNames = {};
  var last = null;
  var timer = 0;
  function defaultPath() { var p = location.pathname; var i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; }
  function payload() {
    var o = {};
    try { for (var i = 0; i < ls.length; i++) { var key = ls.key(i); if (key !== null) o[key] = ls.getItem(key); } } catch (e) {}
    var c = [];
    for (var n in cookieNames) if (Object.prototype.hasOwnProperty.call(cookieNames, n)) c.push({ name: n, path: cookieNames[n] });
    return JSON.stringify({ localStorage: o, cookies: c });
  }
  function flush(beacon) {
    if (!ls) return;
    var body;
    try { body = payload(); } catch (e) { return; }
    if (body === last) return;
    var bytes = body.length;
    try { bytes = new Blob([body]).size; } catch (e) {}
    if (bytes > MAX_POST) return;
    last = body;
    var url = STORAGE + '?g=' + GEN;
    try {
      if (beacon && navigator.sendBeacon && navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { fetch(url, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: body.length < 60000 }); } catch (e) {}
  }
  function schedule() { if (timer) return; timer = setTimeout(function () { timer = 0; flush(false); }, 400); }
  if (ls && window.Storage) {
    ['setItem', 'removeItem', 'clear'].forEach(function (name) {
      var orig = Storage.prototype[name];
      if (typeof orig !== 'function') return;
      Storage.prototype[name] = function () {
        var r = orig.apply(this, arguments);
        if (this === ls) schedule();
        return r;
      };
    });
    setInterval(function () { flush(false); }, 10000);
    window.addEventListener('pagehide', function () { flush(true); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
    setTimeout(function () { flush(false); }, 1500);
  }

  // ── 2. this page's own cookies (prefixed on the wire, plain to the page) ────────────
  try {
    var cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cd && cd.get && cd.set) {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        enumerable: true,
        get: function () {
          var all = String(cd.get.call(document) || '').split(/;\\s*/);
          var mine = [];
          for (var i = 0; i < all.length; i++) if (all[i].indexOf(PREFIX) === 0) mine.push(all[i].slice(PREFIX.length));
          return mine.join('; ');
        },
        set: function (v) {
          var s = String(v);
          var m = /^\\s*([^=;\\s]+)\\s*=/.exec(s);
          if (!m) return;
          try {
            var p = /;\\s*path\\s*=\\s*([^;]*)/i.exec(s);
            var path = p && p[1].trim().charAt(0) === '/' ? p[1].trim() : defaultPath();
            if (cookieNames[m[1]] !== path) { cookieNames[m[1]] = path; schedule(); }
          } catch (e) {}
          cd.set.call(document, PREFIX + s.replace(/^\\s+/, ''));
        },
      });
    }
  } catch (e) {}

  if (window.parent === window) return;

  function post(m) {
    var o = {};
    o[KEY] = m;
    for (var i = 0; i < PARENTS.length; i++) { try { window.parent.postMessage(o, PARENTS[i]); } catch (e) {} }
  }
  function zoom(m) {
    var o = { __dreamFrameZoom: m };
    for (var i = 0; i < PARENTS.length; i++) { try { window.parent.postMessage(o, PARENTS[i]); } catch (e) {} }
  }

  // ── where the page is (the card's Clear goes back here; a pick names it) ──────────
  var lastHref = '';
  function hello() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    post({ kind: 'hello', href: location.href, title: String(document.title || '').slice(0, 200) });
  }
  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function () { var r = orig.apply(this, arguments); setTimeout(hello, 0); return r; };
  });
  window.addEventListener('popstate', hello);
  window.addEventListener('hashchange', hello);
  setInterval(hello, 1000);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello); else hello();

  // ── 4. the card's pinch and ctrl/cmd + wheel ───────────────────────────────────────
  window.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoom({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY, ctrl: true, x: e.clientX, y: e.clientY });
  }, { passive: false });
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (t) {
    window.addEventListener(t, function (e) {
      e.preventDefault();
      zoom({ kind: 'gesture', phase: t.slice(7), scale: e.scale, x: e.clientX, y: e.clientY });
    });
  });

  // ── 3. Inspect ──────────────────────────────────────────────────────────────────────
  var inspecting = false;
  var host = null, boxEl = null, labelEl = null, hoverEl = null;
  function overlay() {
    if (host) return;
    host = document.createElement('dreamcontext-inspect');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    var root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;
    var style = document.createElement('style');
    style.textContent = '.b{position:fixed;pointer-events:none;border:2px solid #7c6cff;background:rgba(124,108,255,.14);border-radius:3px;box-sizing:border-box;transition:left 60ms,top 60ms,width 60ms,height 60ms}'
      + '.b.picked{border-color:#3fbf7f;background:rgba(63,191,127,.22)}'
      + '.l{position:fixed;pointer-events:none;font:600 11px/1.6 -apple-system,system-ui,sans-serif;color:#fff;background:#24203a;padding:1px 7px;border-radius:5px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}';
    boxEl = document.createElement('div'); boxEl.className = 'b';
    labelEl = document.createElement('div'); labelEl.className = 'l';
    root.appendChild(style); root.appendChild(boxEl); root.appendChild(labelEl);
    (document.documentElement || document.body).appendChild(host);
  }
  function draw(el, picked) {
    if (!boxEl) return;
    var r = el.getBoundingClientRect();
    boxEl.className = picked ? 'b picked' : 'b';
    boxEl.style.left = r.left + 'px'; boxEl.style.top = r.top + 'px';
    boxEl.style.width = r.width + 'px'; boxEl.style.height = r.height + 'px';
    var names = reactOf(el);
    labelEl.textContent = (names && names.length ? names[0] + ' · ' : '') + el.tagName.toLowerCase() + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
    labelEl.style.left = Math.max(0, r.left) + 'px';
    labelEl.style.top = (r.top > 22 ? r.top - 21 : Math.min(window.innerHeight - 20, r.bottom + 3)) + 'px';
  }
  function target(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    return el && el !== host && el.nodeType === 1 ? el : null;
  }
  function onMove(e) { if (!inspecting) return; var el = target(e); if (el && el !== hoverEl) { hoverEl = el; draw(el, false); } }
  function swallow(e) { if (!inspecting) return; e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  function onClick(e) {
    if (!inspecting) return;
    swallow(e);
    var el = target(e) || hoverEl;
    if (el) pick(el);
  }
  function onKey(e) { if (inspecting && e.key === 'Escape') { swallow(e); setInspect(false); post({ kind: 'inspect', on: false }); } }
  var prevCursor = '';
  function setInspect(on) {
    if (on === inspecting) return;
    inspecting = on;
    if (on) {
      overlay();
      host.style.display = '';
      prevCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'crosshair';
    } else {
      if (host) host.style.display = 'none';
      document.documentElement.style.cursor = prevCursor;
      hoverEl = null;
    }
  }
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('pointermove', onMove, true);
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'submit', 'touchstart'].forEach(function (t) {
    window.addEventListener(t, swallow, { capture: true, passive: false });
  });
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);

  function esc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  function unique(sel) { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } }
  var TEST_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'aria-label', 'name'];
  function stableClass(c) { return c.length < 40 && !/\\d{3,}|^css-|^sc-|^jsx-|__[A-Za-z0-9_-]{5,}$|^_[A-Za-z0-9]{5,}$/.test(c); }
  function part(el) {
    var t = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\\w-]{0,60}$/.test(el.id) && !/\\d{4,}/.test(el.id)) {
      var s = '#' + esc(el.id);
      if (unique(s)) return { s: s, done: true };
    }
    for (var i = 0; i < TEST_ATTRS.length; i++) {
      var v = el.getAttribute(TEST_ATTRS[i]);
      if (v && v.length < 80) {
        var s2 = t + '[' + TEST_ATTRS[i] + '="' + v.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]';
        if (unique(s2)) return { s: s2, done: true };
      }
    }
    var cls = Array.prototype.slice.call(el.classList || []).filter(stableClass).slice(0, 2).map(function (c) { return '.' + esc(c); }).join('');
    var p = t + cls;
    var par = el.parentElement;
    if (par) {
      var same = Array.prototype.filter.call(par.children, function (c) { return c.tagName === el.tagName; });
      if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    return { s: p, done: false };
  }
  function selectorFor(el) {
    var parts = [];
    var cur = el;
    for (var depth = 0; cur && cur.nodeType === 1 && depth < 14; depth++) {
      var p = part(cur);
      parts.unshift(p.s);
      var sel = parts.join(' > ');
      if (p.done || unique(sel)) return sel;
      if (cur === document.body || cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }
  var KEEP_ATTRS = ['id', 'class', 'name', 'type', 'role', 'aria-label', 'href', 'src', 'alt', 'placeholder', 'title', 'for', 'data-testid', 'data-test', 'data-cy'];
  function attrsOf(el) {
    var o = {};
    for (var i = 0; i < KEEP_ATTRS.length; i++) {
      var v = el.getAttribute(KEEP_ATTRS[i]);
      if (v !== null && v !== '') o[KEEP_ATTRS[i]] = v.length > 160 ? v.slice(0, 159) + '…' : v;
    }
    return o;
  }
  function textOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return '';
    var t = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.length > 300 ? t.slice(0, 299) + '…' : t;
  }
  var FRAMEWORK = /^(InnerLayoutRouter|OuterLayoutRouter|RedirectBoundary|RedirectErrorBoundary|NotFoundBoundary|NotFoundErrorBoundary|ErrorBoundary|ErrorBoundaryHandler|LoadingBoundary|ScrollAndFocusHandler|InnerScrollAndFocusHandler|RenderFromTemplateContext|HotReload|Router|AppRouter|ServerRoot|Root|ReactDevOverlay|HTTPAccessFallbackBoundary|HTTPAccessFallbackErrorBoundary|DevRootHTTPAccessFallbackBoundary|PathnameContextProviderAdapter|AppContainer|StrictMode|Suspense|Fragment|Profiler|Head|Script|Link|Image|ForwardRef|Memo|SegmentViewNode|SegmentStateProvider)$/;
  function reactOf(el) {
    var cur = el, fiber = null;
    for (var d = 0; cur && !fiber && d < 10; d++) {
      var keys = Object.keys(cur);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) { fiber = cur[keys[i]]; break; }
      }
      cur = cur.parentElement;
    }
    var names = [];
    for (var g = 0; fiber && names.length < 3 && g < 300; g++) {
      var t = fiber.type;
      if (t && typeof t !== 'string') {
        var n = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || '';
        if (n && /^[A-Z]/.test(n) && !FRAMEWORK.test(n) && !/(Provider|Context|Consumer|Boundary)$/.test(n) && names.indexOf(n) < 0) names.push(n);
      }
      fiber = fiber.return;
    }
    return names.length ? names : null;
  }

  function backdrop(el) {
    for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      var b = getComputedStyle(cur).backgroundColor;
      if (b && b !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(b)) return b;
    }
    return '#ffffff';
  }
  var MAX_NODES = 900;
  function capture(el) {
    return new Promise(function (resolve) {
      var done = false;
      function end(v) { if (!done) { done = true; resolve(v); } }
      setTimeout(function () { end(null); }, 3000);
      try {
        var r = el.getBoundingClientRect();
        var w = Math.ceil(r.width), h = Math.ceil(r.height);
        if (w < 1 || h < 1) return end(null);
        var count = 0;
        var clone = el.cloneNode(true);
        var inline = function (src, dst) {
          if (++count > MAX_NODES) throw new Error('too big');
          var cs = getComputedStyle(src);
          var css = '';
          for (var i = 0; i < cs.length; i++) css += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
          dst.setAttribute('style', css);
          var sc = src.children, dc = dst.children;
          for (var j = 0; j < sc.length && j < dc.length; j++) inline(sc[j], dc[j]);
        };
        inline(el, clone);
        clone.style.position = 'relative';
        clone.style.left = '0'; clone.style.top = '0'; clone.style.right = 'auto'; clone.style.bottom = 'auto';
        clone.style.margin = '0'; clone.style.transform = 'none';
        var origCanvas = el.tagName === 'CANVAS' ? [el] : Array.prototype.slice.call(el.querySelectorAll('canvas'));
        var cloneCanvas = clone.tagName === 'CANVAS' ? [clone] : Array.prototype.slice.call(clone.querySelectorAll('canvas'));
        origCanvas.forEach(function (c, i) {
          try { var im = document.createElement('img'); im.src = c.toDataURL(); im.setAttribute('style', cloneCanvas[i].getAttribute('style') || ''); cloneCanvas[i].parentNode.replaceChild(im, cloneCanvas[i]); } catch (e) {}
        });
        Array.prototype.slice.call(clone.querySelectorAll('script,iframe,video,audio,object,embed')).forEach(function (n) {
          var ph = document.createElement('div'); ph.setAttribute('style', n.getAttribute('style') || ''); n.parentNode.replaceChild(ph, n);
        });
        var origImgs = el.tagName === 'IMG' ? [el] : Array.prototype.slice.call(el.querySelectorAll('img'));
        var cloneImgs = clone.tagName === 'IMG' ? [clone] : Array.prototype.slice.call(clone.querySelectorAll('img'));
        origImgs.forEach(function (im, i) {
          try {
            if (!im.complete || !im.naturalWidth || !cloneImgs[i]) return;
            var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
            c.getContext('2d').drawImage(im, 0, 0);
            cloneImgs[i].setAttribute('src', c.toDataURL());
            cloneImgs[i].removeAttribute('srcset');
          } catch (e) { cloneImgs[i].removeAttribute('src'); cloneImgs[i].removeAttribute('srcset'); }
        });
        var xml = new XMLSerializer().serializeToString(clone);
        if (xml.length > 12000000) return end(null);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject x="0" y="0" width="100%" height="100%">'
          + '<div xmlns="http://www.w3.org/1999/xhtml" style="margin:0;padding:0">' + xml + '</div></foreignObject></svg>';
        var img = new Image();
        img.onload = function () {
          try {
            var scale = Math.min(2, window.devicePixelRatio || 1, 1600 / w, 1600 / h);
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
            var g = c.getContext('2d');
            g.scale(scale, scale);
            // A transparent element is drawn on what it sits on (else black text reads as nothing).
            var bg = backdrop(el);
            if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
            g.drawImage(img, 0, 0);
            var data = c.toDataURL('image/png');
            if (data.length > 1500000) data = c.toDataURL('image/jpeg', 0.82);
            end(data.length > 1500000 ? null : data);
          } catch (e) { end(null); }
        };
        img.onerror = function () { end(null); };
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      } catch (e) { end(null); }
    });
  }

  function pick(el) {
    draw(el, true);
    var r = el.getBoundingClientRect();
    var desc = {
      kind: 'pick',
      href: location.href,
      title: String(document.title || '').slice(0, 200),
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      attrs: attrsOf(el),
      text: textOf(el),
      component: reactOf(el),
      box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    var shownAt = Date.now();
    setTimeout(function () { if (hoverEl === el || Date.now() - shownAt > 500) draw(el, false); }, 600);
    capture(el).then(function (crop) { desc.crop = crop; post(desc); });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || PARENTS.indexOf(e.origin) < 0) return;
    var m = e.data && e.data[KEY];
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'inspect') setInspect(!!m.on);
    else if (m.kind === 'reload') location.reload();
    else if (m.kind === 'where') { lastHref = ''; hello(); }
  });
})();
`;
