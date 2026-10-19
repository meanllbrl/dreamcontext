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
//
// The one-time intro. Until this Mac has played it (the `intro-played` marker in the app's
// data folder), the splash window opens on intro.html instead: the mark upside down and a
// button that sets it right, ridden through a ramp. It waits for a person, so it asks the
// shell to step the deadline back (`intro_hold`, to INTRO_WAIT); the click or Skip reports
// `intro_seen`, which writes the marker and re-arms the deadline for the ride and the clip
// (INTRO_TAIL). The page then goes on to splash.html, which plays the clip on from the
// intro's last frame and turns the first key as usual. A page that never asks for the hold
// keeps the ordinary deadline; a person who never clicks gets the app after INTRO_WAIT, and
// the intro again on the next launch, since nothing was written.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
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
/// How long the intro waits for its click before the app opens anyway.
const INTRO_WAIT: Duration = Duration::from_secs(300);
/// From the click: the ride (about 5s), then the clip from the intro's frame (1.25s, plus the
/// page's own 3s start limit and 1s safety net), with room to spare.
const INTRO_TAIL: Duration = Duration::from_secs(14);
/// Written once the intro has been played or skipped; while it is missing, the intro plays.
const INTRO_MARKER: &str = "intro-played";
/// The clip's card, and the intro's larger stage (both 16:9, the clip is drawn to cover).
const SPLASH_SIZE: (f64, f64) = (720.0, 405.0);
const INTRO_SIZE: (f64, f64) = (960.0, 540.0);

#[derive(Default)]
struct Keys {
    splash_done: bool,
    launcher_ready: bool,
    finished: bool,
    /// The window the splash hands over to: the Launcher (`main`) unless a first run with no
    /// usable Node put the Node setup screen behind the splash instead (src/node_setup.rs).
    successor: Option<&'static str>,
    /// Bumped each time the splash deadline is re-armed; a deadline from an older arm is spent.
    deadline_arm: u32,
    /// The intro's click (or Skip) arrived: a late `intro_hold` must not stretch the wait again.
    intro_clicked: bool,
}

/// Managed state: the two keys of the handoff.
#[derive(Default)]
pub(crate) struct SplashGate(Mutex<Keys>);

/// Build and show the opening screen. False if it could not be built, in which case the
/// caller opens the Launcher the ordinary, visible way.
pub(crate) fn open(app: &AppHandle) -> bool {
    let intro = intro_due(app);
    let (page, (width, height)) = if intro { ("intro.html", INTRO_SIZE) } else { ("splash.html", SPLASH_SIZE) };
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(page.into()))
        .title("dreamcontext")
        .inner_size(width, height)
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
            arm_deadline(app, SPLASH_DEADLINE);
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
    open_behind(app, crate::launcher_builder(app, port)?, "main")
}

/// Build `label` hidden behind the splash and make it the window the gate shows. Its page
/// load turns the second key; a load event that never arrives is covered by the deadline.
pub(crate) fn open_behind(
    app: &AppHandle,
    builder: WebviewWindowBuilder<'_, tauri::Wry, AppHandle>,
    label: &'static str,
) -> Result<(), String> {
    if let Some(gate) = app.try_state::<SplashGate>() {
        if let Ok(mut k) = gate.0.lock() {
            k.successor = Some(label);
        }
    }
    if app.get_webview_window(label).is_some() {
        // Something already built it (a link that arrived first): nothing to wait for.
        turn(app, |k| k.launcher_ready = true);
        return Ok(());
    }
    let handle = app.clone();
    builder
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

/// The intro is on screen and waits for a person: the deadline steps back to INTRO_WAIT.
/// Only the splash window may ask (its capability is the only one that grants it).
#[tauri::command]
pub(crate) fn intro_hold(window: tauri::WebviewWindow) {
    if window.label() != LABEL {
        return;
    }
    // Checked under the same lock that re-arms, so an `intro_seen` racing in cannot be undone.
    arm_deadline_unless(window.app_handle(), INTRO_WAIT, |k| k.intro_clicked);
}

/// The intro was played (its button) or skipped: it never plays again on this Mac, and the
/// deadline is re-armed for the ride and the clip that follows it.
#[tauri::command]
pub(crate) fn intro_seen(window: tauri::WebviewWindow) {
    if window.label() != LABEL {
        return;
    }
    let app = window.app_handle();
    if let Some(gate) = app.try_state::<SplashGate>() {
        if let Ok(mut k) = gate.0.lock() {
            k.intro_clicked = true;
        }
    }
    match intro_marker(app) {
        Some(marker) => {
            if let Err(e) = write_marker(&marker) {
                eprintln!("[splash] could not record the intro as played: {e}");
            }
        }
        None => eprintln!("[splash] no app data folder to record the intro in"),
    }
    arm_deadline(app, INTRO_TAIL);
}

fn intro_marker(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(INTRO_MARKER))
}

/// The intro plays while its marker is missing. Anything at that path, a link included,
/// counts as played; a folder that cannot be resolved or read means no intro rather than one
/// on every launch.
fn intro_due(app: &AppHandle) -> bool {
    match intro_marker(app) {
        Some(marker) => matches!(marker.symlink_metadata(), Err(e) if e.kind() == ErrorKind::NotFound),
        None => false,
    }
}

/// `create_new` never follows a link planted at the path: whatever already sits there is
/// taken as the record.
fn write_marker(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(b"The one-time intro has played on this Mac. Delete this file to see it again.\n"),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

/// Re-arm the splash deadline: `after` from now, the first key turns unless another arm came
/// since. The intro moves it twice (the wait for the click, then the ride and the clip).
fn arm_deadline(app: &AppHandle, after: Duration) {
    arm_deadline_unless(app, after, |_| false);
}

/// `arm_deadline`, skipped when `skip` holds for the keys at the moment of re-arming.
fn arm_deadline_unless(app: &AppHandle, after: Duration, skip: impl FnOnce(&Keys) -> bool) {
    let Some(gate) = app.try_state::<SplashGate>() else { return };
    let arm = {
        let Ok(mut k) = gate.0.lock() else { return };
        if skip(&k) {
            return;
        }
        k.deadline_arm = k.deadline_arm.wrapping_add(1);
        k.deadline_arm
    };
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(after);
        turn(&handle, |k| {
            if k.deadline_arm == arm {
                k.splash_done = true;
            }
        });
    });
}

/// Turn one key; when both have turned, hand over exactly once.
fn turn(app: &AppHandle, set: impl FnOnce(&mut Keys)) {
    let Some(gate) = app.try_state::<SplashGate>() else { return };
    let successor = {
        let Ok(mut k) = gate.0.lock() else { return };
        set(&mut k);
        if k.finished || !(k.splash_done && k.launcher_ready) {
            return;
        }
        k.finished = true;
        k.successor.unwrap_or("main")
    };
    // The successor first, so the app is never windowless between the two.
    if let Some(next) = app.get_webview_window(successor) {
        let _ = next.show();
        let _ = next.set_focus();
    }
    if let Some(splash) = app.get_webview_window(LABEL) {
        let _ = splash.eval("window.__dcSplashExit && window.__dcSplashExit()");
        thread::spawn(move || {
            thread::sleep(FADE);
            let _ = splash.close();
        });
    }
}
