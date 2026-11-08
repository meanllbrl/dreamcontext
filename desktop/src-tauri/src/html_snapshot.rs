// A sealed, invisible webview that turns one server-built HTML page into PNG slices.
//
// Telegram cannot show a dream-html card, an insight or a report page, so the server builds the
// page (plan T1/T2: the chat kit around a sandboxed srcdoc frame, nothing authored in the main
// frame) and asks the window, over `hub_command html_snapshot`, for a picture. The window passes
// the bytes here. This webview is the only renderer (R2), and it can paint only what it is handed:
//
//   - its label `html-snapshot` matches NO capability (a test reads every capability file), so
//     no Tauri command, not even an event, answers it;
//   - it loads `about:blank`, then the page as an HTML string with no base URL; every navigation
//     but `about:blank` / `about:srcdoc` is refused, and there is no new-window handler (wry's
//     default refuses `window.open` and `target=_blank`);
//   - a Content-Security-Policy is put in front of every page: no `connect-src`, no `frame-src`
//     fetch, no media, images and fonts only as `data:`; any `http(s):`, `file:` or same-origin URL
//     in the markup fails to load;
//   - a non-persistent data store (nothing survives the snapshot), media devices removed from
//     the main frame before any page script runs (authored frames get `allow=""` from the server);
//   - the window is built hidden, kept transparent and click-through off every screen while it
//     paints, and destroyed after every call, success or not.
//
// Caps: the page at most 4 MB, the PNGs together at most 4 MB, 5 s per call, one call at a time,
// 6 calls a minute. A slice that comes out a single flat colour (a sleeping display, a closed lid)
// is refused as `blank`, never sent: the server then sends the card as text.
//
// macOS only (WKWebView's own snapshot); elsewhere `unsupported`, and the server sends text.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager, Url, Webview};

pub(crate) const LABEL: &str = "html-snapshot";
const MAX_HTML_BYTES: usize = 4 * 1024 * 1024;
const MAX_PNG_BYTES: usize = 4 * 1024 * 1024;
const BUDGET: Duration = Duration::from_secs(5);
const PER_MINUTE: usize = 6;
/// CSS px: one slice at most this tall, at most this many slices (contract RENDER_MAX_*).
const SLICE_MAX: u32 = 2048;
const SLICES_MAX: u32 = 4;
const WIDTH_DEFAULT: u32 = 720;
const WIDTH_MIN: u32 = 200;
const WIDTH_MAX: u32 = 1600;

/// What every page renders under (R2), plus inline script for the server's own constant script
/// and the kit inside the sandboxed frame. Nothing reaches the network: no connect, frame, media
/// or object source is granted, and `default-src 'none'` covers every other fetch.
pub(crate) const SEALED_CSP: &str =
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/// Runs in the main frame before any page script: no camera or microphone, no popups.
const MAIN_FRAME_GUARD: &str = r#"(function(){try{var n=Navigator.prototype;Object.defineProperty(n,'mediaDevices',{get:function(){return undefined},configurable:false});['getUserMedia','webkitGetUserMedia'].forEach(function(k){try{Object.defineProperty(n,k,{value:undefined,configurable:false})}catch(e){}});window.open=function(){return null};}catch(e){}})();"#;

/// WebKit feature keys that open connections without asking the CSP. Off in the sealed webview.
/// Keys as the spike read them from `+[WKPreferences _features]` on macOS 26 (WebKit 21x).
const SEALED_FEATURES_OFF: &[&str] = &[
    "LinkPreconnect",
    "LinkPreconnectEarlyHintsEnabled",
    "LinkDNSPrefetchEnabled",
    "LinkPrefetchEnabled",
    "LinkPreloadEnabled",
    "SpeculationRulesPrefetchEnabled",
    "MediaPreloadingEnabled",
    "PeerConnectionEnabled",
    "BackgroundFetchAPIEnabled",
    "ServiceWorkerNavigationPreloadEnabled",
];
/// Turned off for sure: preconnect and DNS prefetch (by feature or by the older setter) and WebRTC.
/// Without all three the sealed webview refuses to render.
pub(crate) fn hardening_complete(off: &[String]) -> bool {
    let has = |k: &str| off.iter().any(|o| o == k);
    has("LinkPreconnect")
        && (has("LinkDNSPrefetchEnabled") || has("_setDNSPrefetchingEnabled:"))
        && (has("PeerConnectionEnabled") || has("_setPeerConnectionEnabled:"))
}

/// What the last render turned off (the spike reports it).
static FEATURES_OFF: Mutex<Vec<String>> = Mutex::new(Vec::new());

static BUSY: AtomicBool = AtomicBool::new(false);
static RECENT: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

struct Slot;
impl Slot {
    fn take() -> Result<Slot, String> {
        BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Slot)
            .map_err(|_| "busy".to_string())
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// At most `PER_MINUTE` calls in any 60 s; a refused call does not count.
pub(crate) fn admit_rate(recent: &mut VecDeque<Instant>, now: Instant) -> bool {
    while recent.front().is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60)) {
        recent.pop_front();
    }
    if recent.len() >= PER_MINUTE {
        return false;
    }
    recent.push_back(now);
    true
}

/// Only about:blank (the start and the HTML string's own document) and about:srcdoc frames.
pub(crate) fn navigation_allowed(url: &str) -> bool {
    url == "about:blank" || url == "about:srcdoc"
}

pub(crate) fn clamp_width(width: Option<u32>) -> u32 {
    width.unwrap_or(WIDTH_DEFAULT).clamp(WIDTH_MIN, WIDTH_MAX)
}

/// The page with the sealed CSP as its first head element. After a leading doctype when there is
/// one (anything before it would put the page in quirks mode), else first.
pub(crate) fn seal(html: &str) -> String {
    let meta = format!("<meta data-dc-sealed http-equiv=\"Content-Security-Policy\" content=\"{SEALED_CSP}\">");
    let trimmed = html.trim_start();
    let lead = html.len() - trimmed.len();
    if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("<!doctype") {
        if let Some(end) = trimmed.find('>') {
            let cut = lead + end + 1;
            return format!("{}{meta}{}", &html[..cut], &html[cut..]);
        }
    }
    format!("{meta}{html}")
}

/// Heights of the slices a page of `height` CSS px is cut into, and whether it was cut short.
pub(crate) fn slice_plan(height: u32) -> (Vec<u32>, bool) {
    let h = height.max(1);
    let cap = SLICE_MAX * SLICES_MAX;
    let shown = h.min(cap);
    let mut out = Vec::new();
    let mut left = shown;
    while left > 0 {
        let s = left.min(SLICE_MAX);
        out.push(s);
        left -= s;
    }
    (out, h > cap)
}

pub(crate) fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// One rendered page: PNG slices (each a separate picture), its width and measured height.
pub(crate) struct Rendered {
    pub pngs: Vec<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    pub truncated: bool,
}

/// The window asks for a picture of a server-built page (`hub_command html_snapshot`).
#[tauri::command]
pub(crate) async fn html_snapshot(app: AppHandle, webview: Webview, html: String, width: Option<u32>) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported".into());
    }
    let port = app.try_state::<crate::DashboardPort>().map(|p| p.0).ok_or("the server is not up yet")?;
    let url = webview.url().map_err(|e| e.to_string())?;
    if !crate::telegram_confirm::caller_label_ok(webview.label()) || !crate::owner_key::is_own_server_page(&url, port) {
        return Err("forbidden".into());
    }
    if html.len() > MAX_HTML_BYTES {
        return Err("too_large".into());
    }
    let _slot = Slot::take()?;
    {
        let mut recent = RECENT.lock().map_err(|_| "failed".to_string())?;
        if !admit_rate(&mut recent, Instant::now()) {
            return Err("rate".into());
        }
    }
    let r = render(&app, &html, clamp_width(width), Duration::ZERO).await?;
    Ok(serde_json::json!({
        "ok": true,
        "pngs": r.pngs.iter().map(|p| base64(p)).collect::<Vec<_>>(),
        "width": r.width,
        "height": r.height,
        "truncated": r.truncated,
    }))
}

/// Render under the 5 s budget (plus `extra`, the spike's own wait), destroying the window
/// whatever happens.
pub(crate) async fn render(app: &AppHandle, html: &str, width: u32, extra: Duration) -> Result<Rendered, String> {
    let sealed = seal(html);
    let out = tokio::time::timeout(BUDGET + extra, imp::render(app.clone(), sealed, width, extra)).await;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.destroy();
    }
    match out {
        Err(_) => Err("timeout".into()),
        Ok(r) => r,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use block2::RcBlock;
    use objc2::encode::{Encoding, RefEncode};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{class, msg_send};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
    use std::ffi::c_char;
    use tauri::{LogicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    /// NSBitmapImageFileTypePNG.
    const PNG_TYPE: usize = 4;

    pub(super) async fn render(app: AppHandle, sealed: String, width: u32, extra: Duration) -> Result<Rendered, String> {
        if let Some(old) = app.get_webview_window(LABEL) {
            let _ = old.destroy();
        }
        let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;
        let win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(blank))
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .decorations(false)
            .resizable(false)
            .inner_size(f64::from(width), 600.0)
            .incognito(true)
            .initialization_script(MAIN_FRAME_GUARD)
            .on_navigation(|u| navigation_allowed(u.as_str()))
            .build()
            .map_err(|e| format!("failed: {e}"))?;

        park_offscreen(&win).await?;
        load_html(&win, sealed).await?;

        // The page is ours once our own sealed meta is in the document and everything loaded.
        let deadline = Instant::now() + BUDGET + extra;
        loop {
            let ready = eval(&win, "String(document.readyState==='complete'&&!!document.querySelector('meta[data-dc-sealed]')&&(!document.fonts||document.fonts.status==='loaded'))").await?;
            if ready == "true" {
                break;
            }
            if Instant::now() >= deadline {
                return Err("timeout".into());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        // Frames size themselves by postMessage after load; give them two frames' worth, plus the
        // spike's own wait for its probes.
        tokio::time::sleep(Duration::from_millis(160) + extra).await;
        let measured = eval(&win, "String(Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0)))").await?;
        let height: u32 = measured.trim().parse().unwrap_or(1).max(1);
        let (slices, truncated) = slice_plan(height);
        let shown: u32 = slices.iter().sum();
        win.set_size(LogicalSize::new(f64::from(width), f64::from(shown))).map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(180)).await;

        let mut pngs = Vec::new();
        let mut total = 0usize;
        let mut y = 0u32;
        for (i, h) in slices.into_iter().enumerate() {
            // Only the FIRST slice decides "blank" (a display that did not paint paints nothing at
            // all); a later slice that is all bottom padding is a real, if plain, picture.
            let png = snapshot(&win, NSRect::new(NSPoint::new(0.0, f64::from(y)), NSSize::new(f64::from(width), f64::from(h))), i == 0).await?;
            total += png.len();
            if total > MAX_PNG_BYTES {
                return Err("too_large".into());
            }
            pngs.push(png);
            y += h;
        }
        Ok(Rendered { pngs, width, height, truncated })
    }

    /// Transparent, click-through, off every screen, ordered in without becoming key: WebKit
    /// paints a page whose window is on screen, never one that was only built hidden.
    async fn park_offscreen(win: &WebviewWindow) -> Result<(), String> {
        let (tx, mut rx) = tauri::async_runtime::channel::<bool>(1);
        let w = win.clone();
        win.run_on_main_thread(move || {
            let ok = match w.ns_window() {
                Ok(ptr) if !ptr.is_null() => {
                    let ns = ptr as *mut AnyObject;
                    // SAFETY: main thread, `ns_window` is this window's live NSWindow.
                    unsafe {
                        let _: () = msg_send![ns, setAlphaValue: 0.0f64];
                        let _: () = msg_send![ns, setIgnoresMouseEvents: Bool::YES];
                        let _: () = msg_send![ns, setExcludedFromWindowsMenu: Bool::YES];
                        let _: () = msg_send![ns, setHasShadow: Bool::NO];
                        let _: () = msg_send![ns, setFrameOrigin: NSPoint::new(-32000.0, -32000.0)];
                        let nil: *mut AnyObject = std::ptr::null_mut();
                        let _: () = msg_send![ns, orderBack: nil];
                    }
                    true
                }
                _ => false,
            };
            let _ = tx.try_send(ok);
        })
        .map_err(|e| e.to_string())?;
        // No own timeout: the call's 5 s budget bounds the wait for the main thread.
        match rx.recv().await {
            Some(true) => Ok(()),
            _ => Err("failed: no window".into()),
        }
    }

    /// WebKit opens a connection for `<link rel=preconnect>`, resolves `dns-prefetch` names and
    /// runs WebRTC without asking the CSP (the spike saw an empty TCP connect from an authored
    /// frame), so a card could beacon a host, or spell data into a DNS name. Those features are
    /// switched off for this webview before the page loads. Returns what it turned off.
    unsafe fn harden_preferences(view: *mut AnyObject) -> Vec<String> {
        let mut off = Vec::new();
        let config: *mut AnyObject = msg_send![view, configuration];
        if config.is_null() {
            return off;
        }
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            return off;
        }
        for (sel, name) in [(objc2::sel!(_setDNSPrefetchingEnabled:), "_setDNSPrefetchingEnabled:"), (objc2::sel!(_setPeerConnectionEnabled:), "_setPeerConnectionEnabled:")] {
            let can: bool = msg_send![prefs, respondsToSelector: sel];
            if can {
                if name.starts_with("_setDNS") {
                    let _: () = msg_send![prefs, _setDNSPrefetchingEnabled: Bool::NO];
                } else {
                    let _: () = msg_send![prefs, _setPeerConnectionEnabled: Bool::NO];
                }
                off.push(name.to_string());
            }
        }
        let cls = class!(WKPreferences);
        let can_list: bool = msg_send![cls, respondsToSelector: objc2::sel!(_features)];
        let can_set: bool = !prefs.is_null() && msg_send![prefs, respondsToSelector: objc2::sel!(_setEnabled:forFeature:)];
        if !can_list || !can_set {
            return off;
        }
        let feats: *mut AnyObject = msg_send![cls, _features];
        if feats.is_null() {
            return off;
        }
        let n: usize = msg_send![feats, count];
        for i in 0..n {
            let f: *mut AnyObject = msg_send![feats, objectAtIndex: i];
            let key: *mut AnyObject = msg_send![f, key];
            let Some(k) = ns_string_of(key) else { continue };
            if SEALED_FEATURES_OFF.contains(&k.as_str()) {
                let _: () = msg_send![prefs, _setEnabled: Bool::NO, forFeature: f];
                off.push(k);
            }
        }
        off
    }

    async fn load_html(win: &WebviewWindow, sealed: String) -> Result<(), String> {
        let (tx, mut rx) = tauri::async_runtime::channel::<bool>(1);
        win.with_webview(move |wv| {
            let view = wv.inner() as *mut AnyObject;
            if view.is_null() {
                let _ = tx.try_send(false);
                return;
            }
            // SAFETY: main thread, live WKWebView; every SPI is probed with respondsToSelector.
            let off = unsafe { harden_preferences(view) };
            let sealed_off = hardening_complete(&off);
            if let Ok(mut last) = FEATURES_OFF.lock() {
                *last = off;
            }
            // Fail closed: a WebKit where preconnect, DNS prefetch or WebRTC could not be turned off
            // renders nothing (the server sends the card as text), never a page that can beacon.
            if !sealed_off {
                let _ = tx.try_send(false);
                return;
            }
            let html = NSString::from_str(&sealed);
            let nil: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: `with_webview` runs on the main thread with the live WKWebView. A nil base
            // URL keeps the document at about:blank with an opaque origin.
            unsafe {
                let _: *mut AnyObject = msg_send![view, loadHTMLString: &*html, baseURL: nil];
            }
            let _ = tx.try_send(true);
        })
        .map_err(|e| e.to_string())?;
        match rx.recv().await {
            Some(true) => Ok(()),
            _ => Err("unsupported".into()),
        }
    }

    fn ns_string_of(obj: *mut AnyObject) -> Option<String> {
        if obj.is_null() {
            return None;
        }
        // SAFETY: checked to be an NSString before the cast.
        unsafe {
            let is_str: bool = msg_send![obj, isKindOfClass: class!(NSString)];
            if !is_str {
                return None;
            }
            Some((*(obj as *const NSString)).to_string())
        }
    }

    /// `-[WKWebView evaluateJavaScript:completionHandler:]`; every script here returns a string.
    async fn eval(win: &WebviewWindow, js: &'static str) -> Result<String, String> {
        let (tx, mut rx) = tauri::async_runtime::channel::<Option<String>>(1);
        win.with_webview(move |wv| {
            let view = wv.inner() as *mut AnyObject;
            if view.is_null() {
                let _ = tx.try_send(None);
                return;
            }
            let script = NSString::from_str(js);
            let done = RcBlock::new(move |result: *mut AnyObject, _err: *mut AnyObject| {
                let _ = tx.try_send(ns_string_of(result));
            });
            // SAFETY: main thread, live WKWebView; the block is retained by WebKit until called.
            unsafe {
                let _: () = msg_send![view, evaluateJavaScript: &*script, completionHandler: &*done];
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(rx.recv().await.flatten().unwrap_or_default())
    }

    #[repr(C)]
    struct CGImageOpaque {
        _p: [u8; 0],
    }
    // SAFETY: the encoding CoreGraphics gives `CGImageRef`.
    unsafe impl RefEncode for CGImageOpaque {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("CGImage", &[]));
    }

    /// One slice through `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`, as PNG.
    async fn snapshot(win: &WebviewWindow, rect: NSRect, refuse_flat: bool) -> Result<Vec<u8>, String> {
        let (tx, mut rx) = tauri::async_runtime::channel::<Result<Vec<u8>, String>>(1);
        win.with_webview(move |wv| {
            let view = wv.inner() as *mut AnyObject;
            if view.is_null() {
                let _ = tx.try_send(Err("failed".into()));
                return;
            }
            // SAFETY: main thread, live WKWebView; WKSnapshotConfiguration exists since 10.13.
            unsafe {
                let config: Option<Retained<AnyObject>> = msg_send![class!(WKSnapshotConfiguration), new];
                let Some(config) = config else {
                    let _ = tx.try_send(Err("failed".into()));
                    return;
                };
                let _: () = msg_send![&*config, setRect: rect];
                let _: () = msg_send![&*config, setAfterScreenUpdates: Bool::YES];
                let done = RcBlock::new(move |image: *mut AnyObject, _err: *mut AnyObject| {
                    let _ = tx.try_send(png_of(image, refuse_flat));
                });
                let _: () = msg_send![view, takeSnapshotWithConfiguration: &*config, completionHandler: &*done];
            }
        })
        .map_err(|e| e.to_string())?;
        rx.recv().await.unwrap_or_else(|| Err("failed".into()))
    }

    /// NSImage → PNG bytes, refusing a slice that is one flat colour.
    fn png_of(image: *mut AnyObject, refuse_flat: bool) -> Result<Vec<u8>, String> {
        if image.is_null() {
            return Err("failed".into());
        }
        // SAFETY: main thread (WebKit calls the handler there); every object is checked for nil.
        unsafe {
            let null_rect: *mut NSRect = std::ptr::null_mut();
            let nil: *mut AnyObject = std::ptr::null_mut();
            let cg: *mut CGImageOpaque = msg_send![image, CGImageForProposedRect: null_rect, context: nil, hints: nil];
            if cg.is_null() {
                return Err("failed".into());
            }
            let alloc: *mut AnyObject = msg_send![class!(NSBitmapImageRep), alloc];
            let rep: *mut AnyObject = msg_send![alloc, initWithCGImage: cg];
            let Some(rep) = Retained::from_raw(rep) else {
                return Err("failed".into());
            };
            if refuse_flat && is_flat(&rep) {
                return Err("blank".into());
            }
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let data: *mut AnyObject = msg_send![&*rep, representationUsingType: PNG_TYPE, properties: props];
            if data.is_null() {
                return Err("failed".into());
            }
            let len: usize = msg_send![data, length];
            let bytes: *const std::ffi::c_void = msg_send![data, bytes];
            if bytes.is_null() || len == 0 {
                return Err("failed".into());
            }
            Ok(std::slice::from_raw_parts(bytes as *const u8, len).to_vec())
        }
    }

    /// Every pixel equal to the first: what a display that did not paint gives back.
    unsafe fn is_flat(rep: &AnyObject) -> bool {
        let data: *mut c_char = msg_send![rep, bitmapData];
        let row: isize = msg_send![rep, bytesPerRow];
        let high: isize = msg_send![rep, pixelsHigh];
        let wide: isize = msg_send![rep, pixelsWide];
        let bpp: isize = msg_send![rep, bitsPerPixel];
        if data.is_null() || row <= 0 || high <= 0 || wide <= 0 || bpp < 8 {
            return false; // unknown layout: let the picture through rather than guess
        }
        let px = (bpp / 8) as usize;
        let buf = std::slice::from_raw_parts(data as *const u8, (row * high) as usize);
        let first = &buf[..px];
        (0..high as usize).all(|y| {
            let line = &buf[y * row as usize..y * row as usize + wide as usize * px];
            line.chunks_exact(px).all(|p| p == first)
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::*;
    pub(super) async fn render(_app: AppHandle, _sealed: String, _width: u32, _extra: Duration) -> Result<Rendered, String> {
        Err("unsupported".into())
    }
}

// ─── The spike (debug builds only) ────────────────────────────────────────────
//
// `DREAMCONTEXT_HTML_SNAPSHOT_SPIKE=<dir> target/debug/dreamcontext-desktop` renders one probe
// page in the real sealed webview and exits, before any server or window starts. The probe tries
// every way out it can (fetch, image, CSS url, @import, @font-face, preconnect, dns-prefetch,
// meta refresh, location, window.open, a target=_blank form, getUserMedia, the Tauri IPC) from
// the main frame AND from a sandboxed srcdoc frame, against a loopback listener this spike owns.
// `<dir>/spike.json` records what the page saw and how many connections the listener got; the
// slices land beside it as `slice-N.png`.

/// The spike is running: destroying its window must not end the app before it writes its report.
#[cfg(debug_assertions)]
pub(crate) static SPIKE_RUNNING: AtomicBool = AtomicBool::new(false);

#[cfg(debug_assertions)]
pub(crate) fn spike_if_asked(app: &AppHandle) -> bool {
    let Ok(dir) = std::env::var("DREAMCONTEXT_HTML_SNAPSHOT_SPIKE") else {
        return false;
    };
    SPIKE_RUNNING.store(true, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let out = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&out);
        let hits = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let listen = |name: &'static str| -> u16 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("spike listener");
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            let seen = hits.clone();
            std::thread::spawn(move || {
                use std::io::Read;
                for s in listener.incoming().flatten() {
                    let mut s = s;
                    let _ = s.set_read_timeout(Some(Duration::from_millis(300)));
                    let mut buf = [0u8; 512];
                    let n = s.read(&mut buf).unwrap_or(0);
                    let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
                    if let Ok(mut h) = seen.lock() {
                        h.push(format!("{name}: {}", if line.is_empty() { "(connected, sent nothing)".to_string() } else { line }));
                    }
                }
            });
            port
        };
        let port = listen("main frame");
        let frame_port = listen("authored frame");
        let probe = spike_probe(port, frame_port);
        let started = Instant::now();
        let result = render(&app, &probe, WIDTH_DEFAULT, Duration::from_millis(2500)).await;
        eprintln!("[spike] render finished in {:?}: {}", started.elapsed(), result.as_ref().map(|r| r.pngs.len().to_string()).unwrap_or_else(|e| e.clone()));
        tokio::time::sleep(Duration::from_millis(500)).await;
        let report = match &result {
            Ok(r) => {
                for (i, p) in r.pngs.iter().enumerate() {
                    let _ = std::fs::write(out.join(format!("slice-{i}.png")), p);
                }
                serde_json::json!({ "ok": true, "slices": r.pngs.len(), "width": r.width, "height": r.height })
            }
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
        let connections = hits.lock().map(|h| h.clone()).unwrap_or_default();
        let off = FEATURES_OFF.lock().map(|v| v.clone()).unwrap_or_default();
        let selectors = spike_selectors();
        let doc = serde_json::json!({ "render": report, "loopbackConnections": connections, "mainPort": port, "framePort": frame_port, "featuresOff": off, "prefSelectors": selectors });
        let _ = std::fs::write(out.join("spike.json"), serde_json::to_vec_pretty(&doc).unwrap_or_default());
        SPIKE_RUNNING.store(false, Ordering::SeqCst);
        app.exit(0);
    });
    true
}

/// WKPreferences selectors and feature keys that mention connect, DNS or fetch (the spike's map).
#[cfg(all(debug_assertions, target_os = "macos"))]
fn spike_selectors() -> Vec<String> {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{class, msg_send};
    let mut out = Vec::new();
    let cls: &AnyClass = class!(WKPreferences);
    for m in cls.instance_methods().iter() {
        let name = m.name().name().to_string_lossy().to_string();
        let l = name.to_lowercase();
        if l.contains("connect") || l.contains("dns") || l.contains("prefetch") {
            out.push(format!("-{name}"));
        }
    }
    unsafe {
        let feats: *mut AnyObject = msg_send![cls, _features];
        if !feats.is_null() {
            let n: usize = msg_send![feats, count];
            for i in 0..n {
                let f: *mut AnyObject = msg_send![feats, objectAtIndex: i];
                let key: *mut AnyObject = msg_send![f, key];
                let is_str: bool = !key.is_null() && msg_send![key, isKindOfClass: class!(NSString)];
                if is_str {
                    let k = (*(key as *const objc2_foundation::NSString)).to_string();
                    let l = k.to_lowercase();
                    if l.contains("connect") || l.contains("dns") || l.contains("fetch") || l.contains("preload") {
                        out.push(format!("feature {k}"));
                    }
                }
            }
        }
    }
    out
}
#[cfg(all(debug_assertions, not(target_os = "macos")))]
fn spike_selectors() -> Vec<String> {
    Vec::new()
}

/// The probe page: results painted as text (visible in the PNG) and counted by the listener.
#[cfg(debug_assertions)]
fn spike_probe(port: u16, frame_port: u16) -> String {
    let main_u = format!("http://127.0.0.1:{port}");
    let frame_u = format!("http://127.0.0.1:{frame_port}");
    let tries = |u: &str| format!(
        r#"
var out=[];function note(k,v){{out.push(k+': '+v);var d=document.getElementById('r');if(d)d.textContent=out.join('\n');try{{parent!==window&&parent.postMessage({{k:k,v:v}},'*')}}catch(e){{}}}}
try{{fetch('{u}/fetch-'+WHERE).then(function(){{note('fetch','REACHED')}},function(){{note('fetch','blocked')}})}}catch(e){{note('fetch','threw')}}
try{{var t=window.__TAURI_INTERNALS__;if(!t){{note('tauri','absent')}}else{{t.invoke('focus_diag',{{line:'html_snapshot spike'}}).then(function(){{note('tauri','INVOKED')}},function(e){{note('tauri','refused')}})}}}}catch(e){{note('tauri','threw')}}
try{{var t2=window.__TAURI_INTERNALS__;if(t2)t2.invoke('plugin:__TAURI_CHANNEL__|fetch',{{}}).then(function(){{note('channel','INVOKED')}},function(){{note('channel','refused')}});else note('channel','absent')}}catch(e){{note('channel','threw')}}
try{{var md=navigator.mediaDevices;if(!md||!md.getUserMedia){{note('mic','absent')}}else{{md.getUserMedia({{audio:true}}).then(function(){{note('mic','GRANTED')}},function(e){{note('mic','refused')}})}}}}catch(e){{note('mic','threw')}}
try{{var w=window.open('{u}/open-'+WHERE);note('open',w?'OPENED':'null')}}catch(e){{note('open','threw')}}
try{{var f=document.createElement('form');f.action='{u}/form-'+WHERE;f.target='_blank';f.method='get';document.body.appendChild(f);f.submit();note('form','submitted')}}catch(e){{note('form','threw')}}
try{{if(!window.RTCPeerConnection){{note('webrtc','absent')}}else{{var pc=new RTCPeerConnection({{iceServers:[{{urls:'turn:'+'{u}'.replace('http://','')+'?transport=tcp',username:'u',credential:'c'}}]}});pc.createDataChannel('x');pc.createOffer().then(function(o){{return pc.setLocalDescription(o)}}).then(function(){{note('webrtc','started')}},function(){{note('webrtc','refused')}})}}}}catch(e){{note('webrtc','threw')}}
try{{var ws=new WebSocket('{u}'.replace('http','ws')+'/ws-'+WHERE);ws.onopen=function(){{note('ws','OPEN')}};ws.onerror=function(){{note('ws','blocked')}}}}catch(e){{note('ws','threw')}}
try{{note('beacon',navigator.sendBeacon?(navigator.sendBeacon('{u}/beacon-'+WHERE,'x')?'QUEUED':'refused'):'absent')}}catch(e){{note('beacon','threw')}}
try{{var es=new EventSource('{u}/es-'+WHERE);es.onerror=function(){{note('eventsource','blocked')}}}}catch(e){{note('eventsource','threw')}}
setTimeout(function(){{try{{location.href='{u}/location-'+WHERE}}catch(e){{note('location','threw')}}}},300);
"#
    );
    let u = frame_u.as_str();
    let frame_tries = tries(u);
    let frame_doc = format!(
        r#"<!doctype html><html><head><meta http-equiv="refresh" content="0;url={u}/refresh-frame"><link rel="preconnect" href="{u}/preconnect-frame"><link rel="dns-prefetch" href="{u}/dns-frame"><link rel="prefetch" href="{u}/prefetch-frame"><link rel="preload" as="image" href="{u}/preload-frame"><link rel="stylesheet" href="{u}/css-link-frame"><style>@import url('{u}/import-frame');@font-face{{font-family:x;src:url('{u}/font-frame')}}body{{margin:0;font:13px monospace;background:#ff00ff;color:#000;background-image:url('{u}/bg-frame')}}</style></head><body><b>FRAME PAINTED</b><img src="{u}/img-frame"><svg width="10" height="10"><use href="{u}/use-frame#x"/><filter id="f"><feImage href="{u}/feimage-frame"/></filter></svg><pre id="r"></pre><script>var WHERE='frame';{frame_tries}</script></body></html>"#
    );
    let srcdoc = frame_doc.replace('&', "&amp;").replace('"', "&quot;");
    let u = main_u.as_str();
    let main_tries = tries(u);
    format!(
        r#"<!doctype html><html><head><link rel="preconnect" href="{u}/preconnect"><link rel="dns-prefetch" href="{u}/dns"><link rel="stylesheet" href="{u}/css-link"><style>@import url('{u}/import');body{{margin:0;padding:16px;font:14px -apple-system,sans-serif;background:#fff;color:#111;background-image:url('{u}/bg')}}iframe{{width:100%;height:340px;border:2px solid #7b68ee}}</style></head><body><h3>html_snapshot spike</h3><img src="{u}/img"><pre id="r"></pre><pre id="fr"></pre><iframe sandbox="allow-scripts" allow="" srcdoc="{srcdoc}"></iframe><script>var WHERE='main';var fr=[];addEventListener('message',function(e){{if(e.data&&e.data.k){{fr.push('frame '+e.data.k+': '+e.data.v);document.getElementById('fr').textContent=fr.join('\n')}}}});{main_tries}</script></body></html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_matches_no_capability() {
        // Every capability file's window patterns, as the shell ships them.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut all: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("capabilities dir").flatten() {
            all.push(std::fs::read_to_string(entry.path()).expect("capability file"));
        }
        for text in all {
            let v: Value = serde_json::from_str(&text).expect("capability json");
            for pat in v["windows"].as_array().cloned().unwrap_or_default() {
                let p = pat.as_str().unwrap_or("");
                let hit = match p.strip_suffix('*') {
                    Some(prefix) => LABEL.starts_with(prefix),
                    None => p == LABEL,
                };
                assert!(!hit, "capability window pattern {p:?} matches {LABEL}");
            }
        }
    }

    #[test]
    fn only_blank_and_srcdoc_navigate() {
        assert!(navigation_allowed("about:blank"));
        assert!(navigation_allowed("about:srcdoc"));
        for bad in ["http://127.0.0.1:4173/api/health", "file:///etc/passwd", "data:text/html,x", "about:blank#x", "javascript:1", "https://evil.test/"] {
            assert!(!navigation_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn six_a_minute_then_refused_until_the_oldest_ages_out() {
        let mut q = VecDeque::new();
        let t0 = Instant::now();
        for i in 0..PER_MINUTE {
            assert!(admit_rate(&mut q, t0 + Duration::from_secs(i as u64)), "call {i}");
        }
        assert!(!admit_rate(&mut q, t0 + Duration::from_secs(30)));
        assert!(admit_rate(&mut q, t0 + Duration::from_secs(61)));
    }

    #[test]
    fn one_call_at_a_time() {
        let first = Slot::take().unwrap();
        assert_eq!(Slot::take().err().as_deref(), Some("busy"));
        drop(first);
        assert!(Slot::take().is_ok());
    }

    #[test]
    fn the_seal_goes_after_the_doctype_or_first() {
        let s = seal("<!DOCTYPE html><html><head></head><body>x</body></html>");
        assert!(s.starts_with("<!DOCTYPE html><meta data-dc-sealed http-equiv=\"Content-Security-Policy\""));
        assert!(s.contains(SEALED_CSP));
        let s = seal("<div>x</div>");
        assert!(s.starts_with("<meta data-dc-sealed"));
        assert!(!SEALED_CSP.contains("connect-src") && !SEALED_CSP.contains("frame-src") && SEALED_CSP.starts_with("default-src 'none'"));
    }

    #[test]
    fn tall_pages_are_cut_into_at_most_four_slices() {
        assert_eq!(slice_plan(0), (vec![1], false));
        assert_eq!(slice_plan(900), (vec![900], false));
        assert_eq!(slice_plan(2049), (vec![2048, 1], false));
        assert_eq!(slice_plan(8192), (vec![2048; 4], false));
        assert_eq!(slice_plan(20000), (vec![2048; 4], true));
    }

    #[test]
    fn width_is_clamped_and_defaults_to_720() {
        assert_eq!(clamp_width(None), 720);
        assert_eq!(clamp_width(Some(10)), WIDTH_MIN);
        assert_eq!(clamp_width(Some(99999)), WIDTH_MAX);
    }

    #[test]
    fn rendering_needs_preconnect_dns_prefetch_and_webrtc_off() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(hardening_complete(&v(&["LinkPreconnect", "LinkDNSPrefetchEnabled", "PeerConnectionEnabled"])));
        assert!(hardening_complete(&v(&["LinkPreconnect", "_setDNSPrefetchingEnabled:", "_setPeerConnectionEnabled:"])));
        assert!(!hardening_complete(&v(&["LinkDNSPrefetchEnabled", "PeerConnectionEnabled"])));
        assert!(!hardening_complete(&v(&["LinkPreconnect", "PeerConnectionEnabled"])));
        assert!(!hardening_complete(&v(&[])));
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0x00]), "//4A");
    }
}
