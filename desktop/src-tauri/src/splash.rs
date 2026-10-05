// dreamcontext desktop shell — the opening screen.
//
// A cold launch used to show NOTHING for the second or three the dashboard server takes to
// answer /api/health: `setup` blocked on that poll, so not even a window could paint. The
// opening screen fills exactly that gap with the logo reveal (frontend-placeholder/splash.*,
// rendered from marketing/remotion `Splash-konsolidasyon`).
//
// The page does not start its own clip. In macOS Low Power Mode WebKit refuses every <video>
// play() no user gesture started, muted or not (`video low power mode restriction` ->
// `UserGestureRequired`), and wry's `autoplay: true` does not lift it: the owner saw only the
// final still, without sound. A script run through `-[WKWebView evaluateJavaScript:]` DOES
// count as a gesture, and that is what `WebviewWindow::eval` uses. So the page loads the clip,
// and once it can play it invokes `splash_play`; the shell answers by evaluating
// `window.__dcSplashPlay()`, whose play() then runs inside the gesture. Measured in a real
// WKWebView under Low Power Mode: unmuted, start to `ended`.
//
// The handoff is a two-key gate. The Launcher is built HIDDEN once the server answers, and
// is shown only when BOTH keys have turned:
//   1. the splash is done — its clip ended, the user skipped it (a click or a key), the clip
//      never started within 3s and the page showed the still instead, or the page's safety
//      timer (the clip's length plus a second, from when it started) fired;
//   2. the Launcher's page has finished loading.
// Then the Launcher is shown under the always-on-top splash, which fades and closes.
//
// Fail open: neither key can hold the app back for long. A page that never reports (a
// webview that cannot play the clip, a refused IPC call) and a Launcher whose load event
// never arrives each have a Rust-side deadline that turns the key anyway — a visible app
// with a problem beats a hidden one.

use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "splash";

/// Past this the splash counts as done whatever the page says. The page's worst case is a
/// clip that starts at its 3s limit, runs 2.6s and then waits out its 1s safety net (6.6s),
/// plus the moment the webview takes to load the page; a timer here must never cut that clip.
const SPLASH_DEADLINE: Duration = Duration::from_secs(8);
/// A Launcher that has not reported its load by now is shown anyway. Counted from when it is
/// built, after the server answers, so it trails the splash deadline.
const LAUNCHER_DEADLINE: Duration = Duration::from_secs(10);
/// Matches the `.out` fade in splash.html.
const FADE: Duration = Duration::from_millis(340);

#[derive(Default)]
struct Keys {
    splash_done: bool,
    launcher_ready: bool,
    finished: bool,
}

/// Managed state: the two keys of the handoff.
#[derive(Default)]
pub(crate) struct SplashGate(Mutex<Keys>);

/// Build and show the opening screen. False if it could not be built, in which case the
/// caller opens the Launcher the ordinary, visible way.
pub(crate) fn open(app: &AppHandle) -> bool {
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("splash.html".into()))
        .title("dreamcontext")
        .inner_size(720.0, 405.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // Transparent so the page's rounded card IS the window's shape (macOS private API,
        // already enabled for the notch).
        .transparent(true)
        .shadow(true)
        // Stays above the Launcher while it fades, so the handoff is a dissolve, not a swap.
        .always_on_top(true)
        .center()
        .focused(true)
        .build();
    match built {
        Ok(_) => {
            let handle = app.clone();
            thread::spawn(move || {
                thread::sleep(SPLASH_DEADLINE);
                turn(&handle, |k| k.splash_done = true);
            });
            true
        }
        Err(e) => {
            eprintln!("[splash] could not open the opening screen: {e}");
            false
        }
    }
}

pub(crate) fn is_open(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some()
}

/// Build the Launcher hidden behind the splash; it is shown when the gate opens.
pub(crate) fn open_launcher_behind(app: &AppHandle, port: u16) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        // Something already built it (a link that arrived first): nothing to wait for.
        turn(app, |k| k.launcher_ready = true);
        return Ok(());
    }
    let handle = app.clone();
    crate::launcher_builder(app, port)?
        .visible(false)
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                turn(&handle, |k| k.launcher_ready = true);
            }
        })
        .build()
        .map_err(|e| format!("Could not create the window: {e}"))?;
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(LAUNCHER_DEADLINE);
        turn(&handle, |k| k.launcher_ready = true);
    });
    Ok(())
}

/// Startup failed: drop the splash at once. The caller has already opened the error
/// window, so closing this one never leaves the app with no window at all.
pub(crate) fn abort(app: &AppHandle) {
    if let Some(gate) = app.try_state::<SplashGate>() {
        if let Ok(mut k) = gate.0.lock() {
            k.finished = true;
        }
    }
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

/// The page reports its clip ended or was skipped.
#[tauri::command]
pub(crate) fn splash_done(app: AppHandle) {
    turn(&app, |k| k.splash_done = true);
}

/// The page's clip can play and it asks to be started. Played from here, inside the
/// webview's evaluateJavaScript, the play() counts as a user gesture, which is what Low Power
/// Mode demands even of a muted clip (see the top of this file). Only the splash window may
/// ask; its capability is the only one that grants this command.
#[tauri::command]
pub(crate) fn splash_play(window: tauri::WebviewWindow) {
    if window.label() != LABEL {
        return;
    }
    if let Err(e) = window.eval("window.__dcSplashPlay && window.__dcSplashPlay()") {
        // The page's own fallback plays it (or shows the still) without the shell.
        eprintln!("[splash] could not start the clip: {e}");
    }
}

/// Turn one key; when both have turned, hand over exactly once.
fn turn(app: &AppHandle, set: impl FnOnce(&mut Keys)) {
    let Some(gate) = app.try_state::<SplashGate>() else { return };
    {
        let Ok(mut k) = gate.0.lock() else { return };
        set(&mut k);
        if k.finished || !(k.splash_done && k.launcher_ready) {
            return;
        }
        k.finished = true;
    }
    // Launcher first, so the app is never windowless between the two.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window(LABEL) {
        let _ = splash.eval("window.__dcSplashExit && window.__dcSplashExit()");
        thread::spawn(move || {
            thread::sleep(FADE);
            let _ = splash.close();
        });
    }
}
