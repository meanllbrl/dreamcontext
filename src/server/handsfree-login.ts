import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { listVaults } from '../lib/vaults.js';
import {
  clearDeviceCookieHeader, deviceCookieHeader, deviceCookieValue, deviceLabel, hasValidDeviceSession,
  loginClientKey, macHandsfreeAuth, notifyMacSignIn,
} from './handsfree-auth.js';
import { isPhoneSocket, macExposedVaults } from './phone-origin.js';
import { liveChatsSnapshot } from './routes/agent-chat-live.js';
import { MAC_LOGIN_TOKEN_PARAM, MAC_SURFACE_HEADER, type MacPhonePayload } from '../lib/handsfree/mac/contract.js';
import { sendError } from './middleware.js';
import { OFFLINE_PATH, SW_PATH, serviceWorkerSource, shortHash } from './handsfree-sw.js';

/**
 * The phone's server-rendered pages on Mac mode's phone listener (hands-free): `/login`, the
 * service worker and its offline page, plus the phone's chip route.
 *
 * Every page is standalone (no SPA bundle), fully inline (the offline page must paint with no
 * network), makes no third-party request and runs under a strict CSP whose script and style
 * hashes are computed here, so no nonce plumbing is needed and the cached offline page stays
 * valid. Strings are EN/TR, chosen by Accept-Language (the offline page re-picks on the device,
 * since it is cached once).
 */

type Lang = 'en' | 'tr';

/** The first of en/tr the client prefers (by q), default en. */
export function pickLang(acceptLanguage: string | undefined): Lang {
  const tags = String(acceptLanguage || '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().toLowerCase().split(';');
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((t) => t.tag && Number.isFinite(t.q) && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const t of tags) {
    if (t.tag === 'tr' || t.tag.startsWith('tr-')) return 'tr';
    if (t.tag === 'en' || t.tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** JSON safe inside a `<script type="application/json">` block. */
function jsonData(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

function sha256B64(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('base64');
}

function csp(script: string, style: string): string {
  return [
    "default-src 'none'",
    `script-src 'sha256-${sha256B64(script)}'`,
    `style-src 'sha256-${sha256B64(style)}'`,
    "connect-src 'self'",
    "worker-src 'self'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#d6d3d1;--accent:#1c1917;--accent-fg:#fafaf9;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#f5f5f4;--accent-fg:#0c0a09;--err:#f87171}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom));min-height:100vh}
main{max-width:420px;margin:0 auto}
h1{font-size:24px;line-height:1.25;margin:32px 0 8px}
p{margin:8px 0;color:var(--muted)}
label{display:block;font-weight:600;margin:24px 0 8px}
.row{display:flex;gap:8px}
input{flex:1;min-width:0;font:inherit;padding:14px 12px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--fg)}
button,a.btn{display:block;width:100%;font:inherit;font-weight:600;margin:16px 0 0;padding:14px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-fg);text-align:center;text-decoration:none;cursor:pointer}
button.ghost{width:auto;margin:0;padding:0 14px;background:transparent;color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
a{color:var(--fg)}
ol{padding-left:20px;color:var(--muted)}
li{margin:6px 0}
.msg{min-height:1.5em;margin-top:12px}
.err{color:var(--err)}
.small{font-size:14px}
`;

function page(lang: Lang, title: string, body: string, script: string, dataJson: string | null): { html: string; csp: string } {
  const data = dataJson === null ? '' : `<script type="application/json" id="dc-data">${dataJson}</script>\n`;
  const scriptTag = script ? `<script>${script}</script>\n` : '';
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${data}${scriptTag}</body>
</html>
`;
  return { html, csp: csp(script, STYLE) };
}

function sendPage(res: ServerResponse, status: number, p: { html: string; csp: string }, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(p.html),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': p.csp,
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(p.html);
}

// ─── Mac mode's login page (the phone listener) ─────────────────────────────

const MAC_LOGIN_STRINGS = {
  en: {
    title: 'Sign in · dreamcontext',
    heading: 'Sign in to your Mac',
    lead: 'Type the six-word password your Mac showed you, or scan the QR code on its screen.',
    label: 'Password',
    show: 'Show',
    hide: 'Hide',
    submit: 'Sign in',
    checking: 'Checking…',
    wrong: 'That password is not right. Check the six words and try again.',
    wait: 'Too many tries. You can try again in {s} s.',
    busy: 'Your Mac is busy. Try again in {s} s.',
    notConfigured: 'Your Mac has no hands-free password yet. On the Mac, open Hands-free and set it up.',
    network: 'Could not reach your Mac. Check your connection and try again.',
    refused: 'This sign-in was refused. Open the link your Mac gave you and try again.',
    revoked: 'This device was signed out. Sign in again with the current password.',
    qr: 'That QR code was already used or has expired. Show a new one on your Mac, or type the password.',
  },
  tr: {
    title: 'Giriş · dreamcontext',
    heading: 'Mac\'ine giriş yap',
    lead: 'Mac\'inin gösterdiği altı kelimelik şifreyi yaz ya da ekrandaki QR kodu okut.',
    label: 'Şifre',
    show: 'Göster',
    hide: 'Gizle',
    submit: 'Giriş yap',
    checking: 'Kontrol ediliyor…',
    wrong: 'Şifre yanlış. Altı kelimeyi kontrol edip tekrar dene.',
    wait: 'Çok fazla deneme. {s} sn sonra tekrar deneyebilirsin.',
    busy: 'Mac\'in meşgul. {s} sn sonra tekrar dene.',
    notConfigured: 'Mac\'inin henüz eller serbest şifresi yok. Mac\'te Eller serbest\'i açıp kur.',
    network: 'Mac\'ine ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
    refused: 'Bu giriş reddedildi. Mac\'inin verdiği bağlantıyı açıp tekrar dene.',
    revoked: 'Bu cihazın oturumu kapatıldı. Güncel şifreyle tekrar giriş yap.',
    qr: 'Bu QR kod kullanılmış ya da süresi dolmuş. Mac\'inde yenisini göster ya da şifreyi yaz.',
  },
} as const;

const MAC_LOGIN_JS = `(function(){
  var d=JSON.parse(document.getElementById('dc-data').textContent);
  var s=d.s;
  var form=document.getElementById('f'),input=document.getElementById('p'),btn=document.getElementById('go'),msg=document.getElementById('m'),tog=document.getElementById('t');
  var timer=null;
  function say(t,err){msg.textContent=t;msg.className='msg'+(err?' err':'');}
  if(d.qr){say(s.qr,true);}
  tog.addEventListener('click',function(){var shown=input.type==='text';input.type=shown?'password':'text';tog.textContent=shown?s.show:s.hide;input.focus();});
  function countdown(key,ms){
    var until=Date.now()+Math.max(1000,ms||1000);btn.disabled=true;
    if(timer)clearInterval(timer);
    function tick(){var left=Math.ceil((until-Date.now())/1000);if(left<=0){clearInterval(timer);timer=null;btn.disabled=false;say('');return;}say(s[key].replace('{s}',String(left)),true);}
    tick();timer=setInterval(tick,1000);
  }
  form.addEventListener('submit',function(ev){
    ev.preventDefault();
    if(btn.disabled)return;
    var pass=input.value;if(!pass.trim()){input.focus();return;}
    btn.disabled=true;say(s.checking,false);
    var ctl=window.AbortController?new AbortController():null,hang=ctl?setTimeout(function(){ctl.abort();},30000):null;
    fetch('/api/handsfree/login',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({passphrase:pass}),signal:ctl?ctl.signal:undefined})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(b){return {status:r.status,body:b,mac:r.headers.get('X-Dreamcontext-Surface')==='mac'};});})
      .then(function(o){
        if(hang)clearTimeout(hang);
        if(o.status===200&&o.body&&o.body.ok){input.value='';say(s.checking,false);location.replace('/');return;}
        var e=o.body&&o.body.error;
        if(o.status===429){countdown(e==='busy'?'busy':'wait',o.body.retryAfterMs);return;}
        btn.disabled=false;
        if(o.status===401&&e==='invalid_passphrase'){say(s.wrong,true);input.select();return;}
        if(o.status===503&&e==='not_configured'){say(s.notConfigured,true);return;}
        if(!o.mac){say(s.network,true);return;}
        say(s.refused,true);
      })
      .catch(function(){if(hang)clearTimeout(hang);btn.disabled=false;say(s.network,true);});
  });
})();`;

export function renderMacLoginPage(lang: Lang, opts: { revoked: boolean; qrFailed: boolean }): { html: string; csp: string } {
  const s = MAC_LOGIN_STRINGS[lang];
  const body = `<h1>${esc(s.heading)}</h1>
<p>${esc(opts.revoked ? s.revoked : s.lead)}</p>
<form id="f" method="post" action="/login" novalidate>
<label for="p">${esc(s.label)}</label>
<div class="row">
<input id="p" name="passphrase" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required>
<button class="ghost" id="t" type="button">${esc(s.show)}</button>
</div>
<button id="go" type="submit">${esc(s.submit)}</button>
<div class="msg" id="m" role="status" aria-live="polite"></div>
</form>`;
  return page(lang, s.title, body, MAC_LOGIN_JS, jsonData({ s, qr: opts.qrFailed }));
}

/** Headers every Mac `/login` response carries: the token in the URL must never leak through
 *  a Referer, and nothing about it may be cached. */
const MAC_LOGIN_HEADERS = { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } as const;

/**
 * GET /login on the phone listener. `?t=<token>` is the QR's one-time login: consumed
 * synchronously (single use), it mints a Mac device session and lands in `/`. A used, expired
 * or wrong token gets the login page and counts as a failure in the limiter. The query string
 * is never logged.
 */
function handleMacLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const lang = pickLang(req.headers['accept-language']);
  const auth = macHandsfreeAuth();
  const token = url.searchParams.get(MAC_LOGIN_TOKEN_PARAM);
  const clientKey = loginClientKey(req);
  if (token !== null) {
    const verdict = auth.limiter.check(clientKey);
    const outcome = verdict.allowed ? auth.consumeLoginToken(token) : 'invalid';
    if (outcome === 'ok') {
      auth.limiter.recordSuccess(clientKey);
      const label = deviceLabel(req);
      const id = auth.store.createDevice(label);
      notifyMacSignIn(label);
      res.writeHead(302, { Location: '/', 'Set-Cookie': deviceCookieHeader(id), ...MAC_LOGIN_HEADERS });
      res.end();
      return;
    }
    if (verdict.allowed) auth.limiter.recordFailure(clientKey);
    sendPage(res, 200, renderMacLoginPage(lang, { revoked: false, qrFailed: true }), { ...MAC_LOGIN_HEADERS });
    return;
  }
  const cookie = deviceCookieValue(req);
  if (cookie !== null && hasValidDeviceSession(req)) {
    res.writeHead(302, { Location: '/', ...MAC_LOGIN_HEADERS });
    res.end();
    return;
  }
  const revoked = url.searchParams.get('revoked') === '1' || cookie !== null;
  const extra: Record<string, string> = { ...MAC_LOGIN_HEADERS, ...(cookie !== null ? { 'Set-Cookie': clearDeviceCookieHeader() } : {}) };
  sendPage(res, 200, renderMacLoginPage(lang, { revoked, qrFailed: false }), extra);
}

/**
 * Where a signed-in phone lands on `/`: the project of the chat that ran most recently (a
 * running one first), else the project opened last — among the projects chosen at start while
 * Mac mode is on (then: the first chosen when none of them has a chat). Null when nothing is
 * registered (the SPA then decides).
 */
export function macLandingVault(): string | null {
  const exposed = macExposedVaults();
  const vaults = listVaults().filter((v) => !exposed.length || exposed.includes(v.name));
  if (exposed.length && !vaults.length) return null;
  const byPath = new Map(vaults.map((v) => [resolve(v.path), v.name]));
  const live = [...liveChatsSnapshot()]
    .filter((e) => byPath.has(resolve(e.projectRoot)))
    .sort((a, b) => Number(b.busy) - Number(a.busy) || (b.turnStartedAt ?? b.lastTurnEndedAt ?? 0) - (a.turnStartedAt ?? a.lastTurnEndedAt ?? 0));
  if (live.length) return byPath.get(resolve(live[0].projectRoot)) ?? null;
  if (exposed.length) return exposed.find((n) => vaults.some((v) => v.name === n)) ?? null;
  const recent = [...vaults].sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? ''));
  return recent[0]?.name ?? null;
}

/** The Mac gate's landing: `/` (no vault) opens a chat, never the launcher (AC4). */
export function redirectToMacChat(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isGetLike(req) || !/text\/html/.test(String(req.headers.accept || ''))) return false;
  let url: URL;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
  if (url.pathname !== '/' || url.searchParams.has('vault')) return false;
  const name = macLandingVault();
  if (!name) return false;
  url.searchParams.set('vault', name);
  res.writeHead(302, { Location: `/${url.search}`, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

let macPhoneSource: () => MacPhonePayload = () => ({ mode: 'mac', battery: { percent: null, charging: true }, sleepAllowed: false });

/** The Mac session registers the reader of its battery/sleep state for the phone's chip. */
export function setMacPhoneSource(source: (() => MacPhonePayload) | null): void {
  macPhoneSource = source ?? (() => ({ mode: 'mac', battery: { percent: null, charging: true }, sleepAllowed: false }));
}

// ─── Offline page ───────────────────────────────────────────────────────────

const OFFLINE_STRINGS = {
  en: {
    title: 'Mac not reachable · dreamcontext',
    checking: 'Reaching your Mac…',
    down: 'Your Mac is not reachable',
    lead: 'Hands-free is off, or the Mac is asleep or offline. Open the dreamcontext app on your Mac and start Hands-free again.',
    status: 'Last checked {s} s ago. Checking every few seconds.',
    first: 'Checking…',
    up: 'Your Mac answered. Opening…',
  },
  tr: {
    title: 'Mac\'e ulaşılamıyor · dreamcontext',
    checking: 'Mac\'ine ulaşılıyor…',
    down: 'Mac\'ine ulaşılamıyor',
    lead: 'Eller serbest kapalı ya da Mac uyuyor veya çevrimdışı. Mac\'inde dreamcontext uygulamasını açıp Eller serbest\'i yeniden başlat.',
    status: '{s} sn önce kontrol edildi. Birkaç saniyede bir kontrol ediliyor.',
    first: 'Kontrol ediliyor…',
    up: 'Mac\'in cevap verdi. Açılıyor…',
  },
} as const;

/** The language is picked on the device: the page is cached once and must speak the phone's
 *  language offline. It probes `/api/health` and reloads once the phone listener answers. */
const OFFLINE_JS = `(function(){
  var d=JSON.parse(document.getElementById('dc-data').textContent);
  var langs=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'en']);
  var lang='en';for(var i=0;i<langs.length;i++){var l=String(langs[i]).toLowerCase();if(l==='tr'||l.indexOf('tr-')===0){lang='tr';break;}if(l==='en'||l.indexOf('en-')===0){break;}}
  var s=d.strings[lang];document.documentElement.lang=lang;document.title=s.title;
  document.getElementById('lead').textContent=s.lead;
  var h=document.getElementById('h'),st=document.getElementById('st'),more=document.getElementById('more');
  h.textContent=s.checking;st.textContent=s.first;
  var fails=0,last=0,busy=false,done=false;
  function probe(){
    if(busy||done)return;busy=true;
    var ctl=window.AbortController?new AbortController():null;
    var t=setTimeout(function(){if(ctl)ctl.abort();},8000);
    fetch('/api/health',{cache:'no-store',credentials:'same-origin',redirect:'manual',signal:ctl?ctl.signal:undefined})
      .then(function(r){return r.headers.get(d.header)==='mac';},function(){return false;})
      .then(function(up){
        clearTimeout(t);busy=false;last=Date.now();
        if(up){done=true;h.textContent=s.up;st.textContent='';location.reload();return;}
        fails++;if(fails>=2){h.textContent=s.down;more.hidden=false;}
      });
  }
  setInterval(function(){
    if(done)return;
    if(last)st.textContent=s.status.replace('{s}',String(Math.round((Date.now()-last)/1000)));
  },1000);
  setInterval(probe,4000);
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')probe();});
  window.addEventListener('focus',probe);
  window.addEventListener('pageshow',probe);
  probe();
})();`;

export function renderOfflinePage(lang: Lang): { html: string; csp: string } {
  const s = OFFLINE_STRINGS[lang];
  const body = `<h1 id="h">${esc(s.checking)}</h1>
<p class="small" id="st" role="status" aria-live="polite">${esc(s.first)}</p>
<div id="more" hidden>
<p id="lead">${esc(s.lead)}</p>
</div>`;
  return page(lang, s.title, body, OFFLINE_JS, jsonData({ strings: OFFLINE_STRINGS, header: MAC_SURFACE_HEADER }));
}

/** The offline page and the SW are built once per process. */
let built: { offline: { html: string; csp: string }; sw: string } | null = null;
function builtAssets(): { offline: { html: string; csp: string }; sw: string } {
  if (!built) {
    const offline = renderOfflinePage('en');
    built = { offline, sw: serviceWorkerSource(shortHash(offline.html, offline.csp)) };
  }
  return built;
}

/** Tests only: rebuild the cached assets. */
export function resetPhonePagesForTests(): void {
  built = null;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

function isGetLike(req: IncomingMessage): boolean {
  const m = (req.method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * The non-API paths this module owns. Returns true when it answered. On a Mac-mode phone socket:
 * `/login`, the service worker and its offline page. Anywhere else the SW and the offline page
 * are 404 and `/login` is left to the SPA.
 */
export function handlePhonePages(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const p = url.pathname;
  if (p !== '/login' && p !== SW_PATH && p !== OFFLINE_PATH) return false;
  if (!isPhoneSocket(req)) {
    if (p === '/login') return false;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return true;
  }
  if (!isGetLike(req)) {
    sendError(res, 405, 'method_not_allowed', 'Method not allowed.');
    return true;
  }
  if (p === '/login') {
    handleMacLogin(req, res, url);
    return true;
  }
  const a = builtAssets();
  if (p === SW_PATH) {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(a.sw),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      // The worker may control the whole origin (it is served from the root anyway).
      'Service-Worker-Allowed': '/',
    });
    res.end(req.method === 'HEAD' ? undefined : a.sw);
    return true;
  }
  sendPage(res, 200, a.offline, { 'Cache-Control': 'no-cache' });
  return true;
}

/**
 * GET /api/handsfree/phone (a Mac-mode phone socket, device class): the phone's chip (battery,
 * whether sleep is allowed again). A pure read. 404 anywhere else.
 */
export async function handleHandsfreePhone(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isPhoneSocket(req)) {
    sendError(res, 404, 'not_found', 'No route: GET /api/handsfree/phone');
    return;
  }
  const body = JSON.stringify(macPhoneSource());
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
