import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isCloud, cloudLocalPath, cloudPhase } from './cloud-mode.js';
import { listVaults } from '../lib/vaults.js';
import { cloudIdle } from './cloud-idle.js';
import { clearDeviceCookieHeader, deviceCookieValue, hasValidDeviceSession } from './handsfree-auth.js';
import { cloudServices } from './routes/handsfree-cloud.js';
import { sendError } from './middleware.js';
import { OFFLINE_PATH, SW_PATH, serviceWorkerSource, shortHash } from './handsfree-sw.js';

/**
 * The phone's server-rendered pages in cloud mode (hands-free): `/login`, the sealed page, the
 * service worker and its offline Wake page, plus the phone's status route.
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
    // The offline worker (AC16) is registered from the login page: worker-src would otherwise
    // fall back to the hash-only script-src and refuse /handsfree-sw.js.
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

// ─── Login ──────────────────────────────────────────────────────────────────

const LOGIN_STRINGS = {
  en: {
    title: 'Sign in · dreamcontext',
    heading: 'Sign in to your cloud project',
    lead: 'Type the six-word password your laptop showed you.',
    label: 'Password',
    show: 'Show',
    hide: 'Hide',
    submit: 'Sign in',
    checking: 'Checking…',
    wrong: 'That password is not right. Check the six words and try again.',
    wait: 'Too many tries. You can try again in {s} s.',
    busy: 'The machine is busy. Try again in {s} s.',
    notConfigured: 'This cloud machine has no password yet. On your laptop, run: dreamcontext handsfree password',
    network: 'Could not reach the cloud machine. Check your connection and try again.',
    refused: 'This sign-in was refused. Open the link your laptop gave you and try again.',
    revoked: 'This device was signed out. Sign in again with the current password.',
    asleep: 'If this link shows a GitHub 404 page instead, the cloud machine is asleep: open github.com/codespaces in this browser, signed in as yourself, and start it.',
  },
  tr: {
    title: 'Giriş · dreamcontext',
    heading: 'Bulut projene giriş yap',
    lead: 'Laptopunun gösterdiği altı kelimelik şifreyi yaz.',
    label: 'Şifre',
    show: 'Göster',
    hide: 'Gizle',
    submit: 'Giriş yap',
    checking: 'Kontrol ediliyor…',
    wrong: 'Şifre yanlış. Altı kelimeyi kontrol edip tekrar dene.',
    wait: 'Çok fazla deneme. {s} sn sonra tekrar deneyebilirsin.',
    busy: 'Makine meşgul. {s} sn sonra tekrar dene.',
    notConfigured: 'Bu bulut makinesinin henüz şifresi yok. Laptopunda şunu çalıştır: dreamcontext handsfree password',
    network: 'Bulut makinesine ulaşılamadı. Bağlantını kontrol edip tekrar dene.',
    refused: 'Bu giriş reddedildi. Laptopunun verdiği bağlantıyı açıp tekrar dene.',
    revoked: 'Bu cihazın oturumu kapatıldı. Güncel şifreyle tekrar giriş yap.',
    asleep: 'Bu bağlantı bunun yerine GitHub 404 sayfası gösterirse bulut makinesi uyuyordur: bu tarayıcıda kendi hesabınla github.com/codespaces sayfasını açıp makineyi başlat.',
  },
} as const;

/** Unregisters our service worker and drops its caches (sealed and revoked pages). */
const UNREGISTER_JS = `
function dcForgetOffline(){
  try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister();});});}}catch(e){}
  try{if(window.caches&&caches.keys){caches.keys().then(function(ks){ks.forEach(function(k){if(k.indexOf('dc-hf-')===0)caches.delete(k);});});}}catch(e){}
}`;

/**
 * After a successful login: register the offline worker HERE (AC16), before leaving the page.
 * The SPA registers it too, but only from the chat surface's cloud chip; a phone that lands
 * anywhere else (the launcher) and then sees the machine stop would get the browser's own
 * error page instead of the Wake page. Waits for the registration at most 4 s, then enters.
 */
const ENTER_JS = `
function dcEnterApp(){
  var done=false;function go(){if(done)return;done=true;location.replace('/');}
  setTimeout(go,4000);
  try{if(navigator.serviceWorker&&navigator.serviceWorker.register){navigator.serviceWorker.register('/handsfree-sw.js',{scope:'/'}).then(go,go);return;}}catch(e){}
  go();
}`;

const LOGIN_JS = `${UNREGISTER_JS}${ENTER_JS}
(function(){
  var d=JSON.parse(document.getElementById('dc-data').textContent);
  var s=d.s;
  if(d.forget){dcForgetOffline();}
  var form=document.getElementById('f'),input=document.getElementById('p'),btn=document.getElementById('go'),msg=document.getElementById('m'),tog=document.getElementById('t');
  var timer=null;
  function say(t,err){msg.textContent=t;msg.className='msg'+(err?' err':'');}
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
    // A hung request (the forwarder, or a machine stopping) must not leave "checking" forever.
    var ctl=window.AbortController?new AbortController():null,hang=ctl?setTimeout(function(){ctl.abort();},30000):null;
    fetch('/api/handsfree/login',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-Tunnel-Skip-AntiPhishing-Page':'true'},body:JSON.stringify({passphrase:pass}),signal:ctl?ctl.signal:undefined})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(b){return {status:r.status,body:b,cloud:!!r.headers.get('X-Dreamcontext-Cloud')};});})
      .then(function(o){
        if(hang)clearTimeout(hang);
        if(o.status===200&&o.body&&o.body.ok){input.value='';say(s.checking,false);dcEnterApp();return;}
        var e=o.body&&o.body.error;
        if(o.status===429){countdown(e==='busy'?'busy':'wait',o.body.retryAfterMs);return;}
        btn.disabled=false;
        if(o.status===401&&e==='invalid_passphrase'){say(s.wrong,true);input.select();return;}
        if(o.status===503&&e==='not_configured'){say(s.notConfigured,true);return;}
        if(!o.cloud){say(s.network,true);return;}
        say(s.refused,true);
      })
      .catch(function(){if(hang)clearTimeout(hang);btn.disabled=false;say(s.network,true);});
  });
})();`;

export function renderLoginPage(lang: Lang, opts: { revoked: boolean }): { html: string; csp: string } {
  const s = LOGIN_STRINGS[lang];
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
</form>
<p class="small">${esc(s.asleep)}</p>`;
  return page(lang, s.title, body, LOGIN_JS, jsonData({ s, forget: opts.revoked }));
}

// ─── Sealed (and still-going) page ──────────────────────────────────────────

const SEALED_STRINGS = {
  en: {
    title: 'Back on your laptop · dreamcontext',
    heading: 'This project is back on your laptop.',
    body: 'Hands-free mode has ended. Open dreamcontext on your laptop to keep working.',
    goingHeading: 'Your laptop is still sending this project.',
    goingBody: 'Keep this page open: it opens your chat by itself once the project is ready.',
  },
  tr: {
    title: 'Laptopuna döndü · dreamcontext',
    heading: 'Bu proje laptopuna döndü.',
    body: 'Eller serbest mod bitti. Çalışmaya devam etmek için laptopundaki dreamcontext\'i aç.',
    goingHeading: 'Laptopun bu projeyi hâlâ gönderiyor.',
    goingBody: 'Bu sayfayı açık tut: proje hazır olunca sohbetin kendiliğinden açılır.',
  },
} as const;

const SEALED_JS = `${UNREGISTER_JS}
dcForgetOffline();`;

const GOING_JS = `setTimeout(function(){location.reload();},10000);`;

/** The going variant is a sealed cloud with a trip on its way in: no SW to forget yet. */
function cloudIsGoing(): boolean {
  try {
    const r = cloudServices().state.get();
    return r.phase === 'sealed' && r.goingSince !== null;
  } catch {
    return false;
  }
}

export function renderSealedPage(lang: Lang, going: boolean): { html: string; csp: string } {
  const s = SEALED_STRINGS[lang];
  const body = going
    ? `<h1>${esc(s.goingHeading)}</h1>\n<p>${esc(s.goingBody)}</p>`
    : `<h1>${esc(s.heading)}</h1>\n<p>${esc(s.body)}</p>`;
  return page(lang, s.title, body, going ? GOING_JS : SEALED_JS, null);
}

/** cloudGate's sealed branch: an HTML navigation (signed in or not) gets this, not JSON. */
export function sendSealedPage(req: IncomingMessage, res: ServerResponse): void {
  const going = cloudIsGoing();
  const lang = pickLang(req.headers['accept-language']);
  sendPage(res, 503, renderSealedPage(lang, going));
}

// ─── Offline Wake page ──────────────────────────────────────────────────────

const OFFLINE_STRINGS = {
  en: {
    title: 'Cloud machine · dreamcontext',
    checking: 'Checking the cloud machine…',
    asleep: 'The cloud machine is asleep',
    lead: 'It sleeps when nobody uses it. Wake it with GitHub:',
    step1: 'Tap Wake. GitHub opens in a new tab and starts the machine.',
    android: 'On Android: if the GitHub page stays white, tap ⋮ (top right) and turn on Desktop site.',
    step2: 'Wait until the new tab shows GitHub\'s editor (about a minute).',
    step3: 'Come back to THIS tab. It opens your chat by itself as soon as the machine answers.',
    step3App: 'Come back to THIS app. It opens your chat by itself as soon as the machine answers.',
    wake: 'Wake',
    alt: 'Or start it from github.com/codespaces',
    signin: 'GitHub must know it is you: sign in to github.com in this browser first, or Wake shows a sign-in or 404 page.',
    status: 'Last checked {s} s ago. Checking every few seconds.',
    first: 'Checking…',
    awake: 'The machine answered. Opening…',
    stuck: 'Machine running but this tab stays here? Clear this browser\'s site data for github.dev and reload.',
  },
  tr: {
    title: 'Bulut makinesi · dreamcontext',
    checking: 'Bulut makinesi kontrol ediliyor…',
    asleep: 'Bulut makinesi uyuyor',
    lead: 'Kimse kullanmayınca uyur. GitHub ile uyandır:',
    step1: 'Uyandır\'a dokun. GitHub yeni bir sekmede açılır ve makineyi başlatır.',
    android: 'Android\'de: GitHub sayfası beyaz kalırsa sağ üstteki ⋮ menüsünden Masaüstü sitesi\'ni aç.',
    step2: 'Yeni sekmede GitHub editörü görünene kadar bekle (yaklaşık bir dakika).',
    step3: 'BU sekmeye geri dön. Makine cevap verir vermez sohbetin kendiliğinden açılır.',
    step3App: 'BU uygulamaya geri dön. Makine cevap verir vermez sohbetin kendiliğinden açılır.',
    wake: 'Uyandır',
    alt: 'Ya da github.com/codespaces üzerinden başlat',
    signin: 'GitHub\'ın seni tanıması gerek: önce bu tarayıcıda github.com\'a giriş yap, yoksa Uyandır bir giriş ya da 404 sayfası gösterir.',
    status: '{s} sn önce kontrol edildi. Birkaç saniyede bir kontrol ediliyor.',
    first: 'Kontrol ediliyor…',
    awake: 'Makine cevap verdi. Açılıyor…',
    stuck: 'Makine çalışıyor ama bu sekme burada mı kaldı? Bu tarayıcıda github.dev site verilerini temizle ve yenile.',
  },
} as const;

/**
 * Pure: is this device Android (smoke #7: there github.dev stays white until Chrome's Desktop
 * site is on)? Self-contained on purpose: its source is embedded verbatim into OFFLINE_JS,
 * which runs on the device, since the cached page is rendered once per process.
 */
export function isAndroid(ua: unknown, uaData: unknown): boolean {
  const platform = uaData && typeof uaData === 'object' ? (uaData as { platform?: unknown }).platform : undefined;
  return platform === 'Android' || /Android/i.test(String(ua || ''));
}

/** The language, the standalone (home-screen app) wording and the Android step are picked on
 *  the device: the page is cached once and must speak the phone's language offline. */
const OFFLINE_JS = `(function(){
  var isAndroid=(${isAndroid.toString()});
  var d=JSON.parse(document.getElementById('dc-data').textContent);
  var langs=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||'en']);
  var lang='en';for(var i=0;i<langs.length;i++){var l=String(langs[i]).toLowerCase();if(l==='tr'||l.indexOf('tr-')===0){lang='tr';break;}if(l==='en'||l.indexOf('en-')===0){break;}}
  var s=d.strings[lang];document.documentElement.lang=lang;document.title=s.title;
  var app=(window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone===true;
  var ids=['lead','step1','step2','wake','alt','signin','stuck'];
  for(var k=0;k<ids.length;k++){var el=document.getElementById(ids[k]);if(el)el.textContent=s[ids[k]];}
  document.getElementById('step3').textContent=app?s.step3App:s.step3;
  var andr=document.getElementById('android');andr.textContent=s.android;andr.hidden=!isAndroid(navigator.userAgent,navigator.userAgentData);
  var h=document.getElementById('h'),st=document.getElementById('st'),steps=document.getElementById('steps');
  h.textContent=s.checking;st.textContent=s.first;
  var fails=0,last=0,busy=false,done=false;
  function showAsleep(){h.textContent=s.asleep;steps.hidden=false;}
  function probe(){
    if(busy||done)return;busy=true;
    var ctl=window.AbortController?new AbortController():null;
    var t=setTimeout(function(){if(ctl)ctl.abort();},8000);
    fetch('/api/health',{cache:'no-store',credentials:'same-origin',redirect:'manual',headers:{'X-Tunnel-Skip-AntiPhishing-Page':'true'},signal:ctl?ctl.signal:undefined})
      .then(function(r){return !!r.headers.get('X-Dreamcontext-Cloud');},function(){return false;})
      .then(function(up){
        clearTimeout(t);busy=false;last=Date.now();
        if(up){done=true;h.textContent=s.awake;st.textContent='';location.reload();return;}
        fails++;if(fails>=2)showAsleep();
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

/** `https://<name>-8080.<domain>` → the codespace's own github.dev page (Wake A), or null. */
export function wakeUrlFromOrigin(origin: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9-]{1,100})-8080\.[a-z0-9.-]{1,100}$/i.exec(String(origin || '').replace(/\/+$/, ''));
  return m ? `https://${m[1]}.github.dev` : null;
}

const CODESPACES_LIST = 'https://github.com/codespaces';

export function renderOfflinePage(lang: Lang, wakeUrl: string | null): { html: string; csp: string } {
  const s = OFFLINE_STRINGS[lang];
  const wake = wakeUrl ?? CODESPACES_LIST;
  const body = `<h1 id="h">${esc(s.checking)}</h1>
<p class="small" id="st" role="status" aria-live="polite">${esc(s.first)}</p>
<div id="steps" hidden>
<p id="lead">${esc(s.lead)}</p>
<ol>
<li id="step1">${esc(s.step1)}</li>
<li id="android" hidden>${esc(s.android)}</li>
<li id="step2">${esc(s.step2)}</li>
<li id="step3">${esc(s.step3)}</li>
</ol>
<a class="btn" id="wake" href="${esc(wake)}" target="_blank" rel="noopener noreferrer">${esc(s.wake)}</a>
<p class="small"><a id="alt" href="${CODESPACES_LIST}" target="_blank" rel="noopener noreferrer">${esc(s.alt)}</a></p>
<p class="small" id="signin">${esc(s.signin)}</p>
<p class="small" id="stuck">${esc(s.stuck)}</p>
</div>`;
  return page(lang, s.title, body, OFFLINE_JS, jsonData({ strings: OFFLINE_STRINGS }));
}

/** The offline page and the SW are built once per process (the codespace name is fixed). */
let built: { offline: { html: string; csp: string }; sw: string } | null = null;
function builtAssets(): { offline: { html: string; csp: string }; sw: string } {
  if (!built) {
    const offline = renderOfflinePage('en', wakeUrlFromOrigin(process.env.DC_HF_ORIGIN));
    built = { offline, sw: serviceWorkerSource(shortHash(offline.html, offline.csp)) };
  }
  return built;
}

/** Tests only: rebuild after changing DC_HF_ORIGIN. */
export function resetPhonePagesForTests(): void {
  built = null;
}

// ─── The trip's chat ────────────────────────────────────────────────────────

/**
 * The registered name of the project the trip went with, read only from the cloud's own state:
 * the go manifest lists the active vault FIRST (scope.ts adds it before any linked repo; its
 * kind is `repo` when the vault is itself a git repository), and the cloud's HOME is the
 * mirrored laptop home, so its vault registry names it. Null when there is no trip or no
 * registered vault at that path (the SPA then decides, as before).
 */
export function tripVaultName(): string | null {
  let first: { absPath?: unknown; kind?: unknown } | undefined;
  try {
    const go = cloudServices().state.get().go as { roots?: Array<{ absPath?: unknown; kind?: unknown }> } | null;
    first = go?.roots?.find((r) => r && r.kind !== 'worktree' && r.kind !== 'transcripts');
  } catch {
    return null;
  }
  if (!first || typeof first.absPath !== 'string') return null;
  const want = new Set([resolve(first.absPath), resolve(cloudLocalPath(first.absPath))]);
  const hit = listVaults().find((v) => want.has(resolve(v.path)));
  return hit ? hit.name : null;
}

/**
 * cloudGate, after every other gate passed (signed in, not sealed): a page navigation to
 * exactly `/` with no `vault` opens the trip's project chat instead of the launcher (AC3: the
 * login opens Chat). Returns true when it answered.
 */
export function redirectToTripChat(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isGetLike(req) || !/text\/html/.test(String(req.headers.accept || ''))) return false;
  let url: URL;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
  if (url.pathname !== '/' || url.searchParams.has('vault')) return false;
  const name = tripVaultName();
  if (!name) return false;
  url.searchParams.set('vault', name);
  res.writeHead(302, { Location: `/${url.search}`, 'Cache-Control': 'no-store' });
  res.end();
  return true;
}

// ─── Handlers ───────────────────────────────────────────────────────────────

function isGetLike(req: IncomingMessage): boolean {
  const m = (req.method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const lang = pickLang(req.headers['accept-language']);
  // AC3: a sealed cloud serves only the sealed page.
  if (cloudPhase() === 'sealed') {
    sendSealedPage(req, res);
    return;
  }
  const cookie = deviceCookieValue(req);
  if (cookie !== null && hasValidDeviceSession(req)) {
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  // A cookie the server no longer accepts (revoke-all, password change, expiry): forget the
  // offline worker too (AC16). A first visit with no cookie unregisters nothing.
  const revoked = url.searchParams.get('revoked') === '1' || cookie !== null;
  const extra: Record<string, string> = cookie !== null ? { 'Set-Cookie': clearDeviceCookieHeader() } : {};
  sendPage(res, 200, renderLoginPage(lang, { revoked }), extra);
}

/**
 * The non-API paths this module owns. Returns true when it answered. Off the cloud the SW and
 * the offline page are 404 and `/login` is left to the SPA.
 */
export function handlePhonePages(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const p = url.pathname;
  if (p !== '/login' && p !== SW_PATH && p !== OFFLINE_PATH) return false;
  if (!isCloud()) {
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
    handleLogin(req, res, url);
    return true;
  }
  const a = builtAssets();
  if (p === SW_PATH) {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': Buffer.byteLength(a.sw),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : a.sw);
    return true;
  }
  sendPage(res, 200, a.offline, { 'Cache-Control': 'no-cache' });
  return true;
}

/**
 * GET /api/handsfree/phone (cloud only, device class): `{ phase, stopAt }`. A pure read: it
 * never records an owner action, so polling it never keeps the machine awake (D14).
 */
export async function handleHandsfreePhone(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isCloud()) {
    sendError(res, 404, 'not_found', 'No route: GET /api/handsfree/phone');
    return;
  }
  const rec = cloudServices().state.get();
  const phase = rec.phase === 'sealed' && rec.goingSince !== null ? 'going' : rec.phase;
  const planned = cloudIdle()?.plannedStopAt() ?? null;
  const body = JSON.stringify({ phase, stopAt: planned === null ? null : new Date(planned).toISOString() });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
