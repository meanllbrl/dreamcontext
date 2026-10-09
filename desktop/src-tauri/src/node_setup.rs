// dreamcontext desktop shell — the Node setup screen (and the startup error screen).
//
// A first launch on a Mac with no usable Node used to end in a plain error window that said
// "install Node 18+" and nothing else: a dead end before the app had shown anything. Now the
// boot thread stops at `run_blocking`, which opens `frontend-placeholder/node-setup.html` (a
// self-contained page, like the splash) and waits while the page drives the install of a
// private Node (src/node_runtime.rs). When it lands, boot continues on that Node and
// `hand_over` swaps the setup screen for the Launcher the same way the splash does.
//
// The page asks for everything through six commands that take no strings from it: start,
// status, cancel, retry (a relaunch), quit, and opening Node's fixed download page. The same
// window, in `?mode=error`, is the startup error screen, so a failed boot always offers
// "Try again" instead of a read-only message.
//
// Contract with the page (pinned in the onboarding plan §3): the command names below, the
// `SetupStatus` shape, and `window.__dcNodeSetupExit()`, which the shell calls before closing.

use crate::node_runtime::{self, NodeProblem, Phase, SetupError};
use crate::splash;
use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const LABEL: &str = "node-setup";
const PAGE: &str = "node-setup.html";
/// Opened by "Get Node.js yourself". Fixed: the page can never choose what is opened.
const DOWNLOAD_PAGE: &str = "https://nodejs.org/en/download";
/// Matches the page's exit fade, like the splash's.
const FADE: Duration = Duration::from_millis(340);
/// A Launcher whose load event never arrives is shown anyway.
const LAUNCHER_DEADLINE: Duration = Duration::from_secs(10);
/// An error message is shown, not stored: keep the URL fragment short.
const MAX_ERROR_CHARS: usize = 2000;

/// What `node_setup_status` answers. Field names and values are the page's contract.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct SetupStatus {
    /// `install` | `error`
    pub(crate) mode: &'static str,
    /// `idle` | `downloading` | `verifying` | `unpacking` | `done` | `error`
    pub(crate) phase: &'static str,
    pub(crate) received: u64,
    pub(crate) total: Option<u64>,
    /// `offline` | `checksum` | `disk` | `os` | `other`, only when `phase` is `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<&'static str>,
    /// `missing` | `too-old`: which sentence the page opens with.
    pub(crate) reason: &'static str,
}

impl Default for SetupStatus {
    fn default() -> Self {
        SetupStatus { mode: "install", phase: "idle", received: 0, total: None, error: None, reason: "missing" }
    }
}

#[derive(Default)]
struct Inner {
    status: SetupStatus,
    running: bool,
    /// Set once the private Node is in place: the path boot continues with.
    installed: Option<String>,
}

/// Managed state: the screen's status, the boot thread's wake-up, and the cancel flag the
/// download loop polls.
#[derive(Default)]
pub(crate) struct NodeSetupState {
    inner: Mutex<Inner>,
    ready: Condvar,
    cancel: AtomicBool,
}

fn phase_name(phase: Phase) -> &'static str {
    match phase {
        Phase::Downloading => "downloading",
        Phase::Verifying => "verifying",
        Phase::Unpacking => "unpacking",
        Phase::Done => "done",
    }
}

fn apply_progress(status: &mut SetupStatus, phase: Phase, received: u64, total: Option<u64>) {
    status.phase = phase_name(phase);
    status.received = received;
    status.total = total;
    status.error = None;
}

/// A cancel goes back to idle (the page offers to start again); anything else is an error.
fn apply_error(status: &mut SetupStatus, err: &SetupError) {
    if *err == SetupError::Canceled {
        status.phase = "idle";
        status.error = None;
    } else {
        status.phase = "error";
        status.error = Some(err.kind());
    }
}

/// Percent-encode everything but RFC 3986 unreserved bytes, for the error screen's fragment.
fn percent_encode(text: &str) -> String {
    text.chars()
        .take(MAX_ERROR_CHARS)
        .collect::<String>()
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn ours(window: &tauri::WebviewWindow) -> bool {
    window.label() == LABEL
}

fn builder<'a>(app: &'a AppHandle, path: String) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(path.into()))
        .title("dreamcontext")
        .inner_size(720.0, 460.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // Transparent so the page's rounded card is the window's shape, like the splash.
        .transparent(true)
        .shadow(true)
        .center()
        .focused(true)
}

/// Start the install on a worker thread. A second start while one runs, after it finished,
/// or on the error screen is ignored.
fn start_install(app: &AppHandle) {
    let Some(state) = app.try_state::<NodeSetupState>() else { return };
    {
        let Ok(mut g) = state.inner.lock() else { return };
        if g.running || g.installed.is_some() || g.status.mode != "install" {
            return;
        }
        g.running = true;
        state.cancel.store(false, Ordering::SeqCst);
        apply_progress(&mut g.status, Phase::Downloading, 0, None);
    }
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<NodeSetupState>();
        let report = |phase: Phase, received: u64, total: Option<u64>| {
            if let Ok(mut g) = state.inner.lock() {
                apply_progress(&mut g.status, phase, received, total);
            }
        };
        let result = node_runtime::install_managed(&report, &state.cancel);
        if let Ok(mut g) = state.inner.lock() {
            g.running = false;
            match result {
                Ok(path) => {
                    g.status.phase = "done";
                    g.installed = Some(path);
                }
                Err(e) => {
                    eprintln!("[node-setup] install did not finish: {e:?}");
                    apply_error(&mut g.status, &e);
                }
            }
        }
        state.ready.notify_all();
    });
}

/// The page starts the install (it does so on load; Retry after an error calls it again).
#[tauri::command]
pub(crate) fn node_setup_start(window: tauri::WebviewWindow) {
    if !ours(&window) {
        return;
    }
    if let Some(state) = window.app_handle().try_state::<NodeSetupState>() {
        // An error screen of the install kind goes back to a fresh attempt.
        if let Ok(mut g) = state.inner.lock() {
            if g.status.mode == "install" && g.status.phase == "error" {
                g.status.phase = "idle";
                g.status.error = None;
            }
        }
    }
    start_install(window.app_handle());
}

#[tauri::command]
pub(crate) fn node_setup_status(window: tauri::WebviewWindow) -> SetupStatus {
    window
        .app_handle()
        .try_state::<NodeSetupState>()
        .and_then(|s| s.inner.lock().ok().map(|g| g.status.clone()))
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn node_setup_cancel(window: tauri::WebviewWindow) {
    if !ours(&window) {
        return;
    }
    if let Some(state) = window.app_handle().try_state::<NodeSetupState>() {
        state.cancel.store(true, Ordering::SeqCst);
    }
}

/// "Try again" on the error screen: a clean relaunch, the one retry that resets everything.
#[tauri::command]
pub(crate) fn node_setup_retry(window: tauri::WebviewWindow) {
    if ours(&window) {
        window.app_handle().restart();
    }
}

#[tauri::command]
pub(crate) fn node_setup_quit(window: tauri::WebviewWindow) {
    if ours(&window) {
        window.app_handle().exit(0);
    }
}

#[tauri::command]
pub(crate) fn node_setup_open_download_page(window: tauri::WebviewWindow) {
    if !ours(&window) {
        return;
    }
    if let Err(e) = Command::new("/usr/bin/open").arg(DOWNLOAD_PAGE).spawn() {
        eprintln!("[node-setup] could not open the download page: {e}");
    }
}

/// Called from the boot thread when no usable Node exists: show the setup screen and block
/// until the private Node is installed. The user leaves by Quit, which exits the process.
pub(crate) fn run_blocking(app: &AppHandle, problem: NodeProblem) -> Result<String, String> {
    let state = app.try_state::<NodeSetupState>().ok_or("The setup screen is not available.")?;
    if let Ok(mut g) = state.inner.lock() {
        g.status = SetupStatus { reason: problem.reason(), ..SetupStatus::default() };
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let h = app.clone();
    app.run_on_main_thread(move || {
        let result = if h.get_webview_window(LABEL).is_some() {
            Ok(())
        } else if splash::is_open(&h) {
            splash::open_behind(&h, builder(&h, PAGE.to_string()), LABEL)
        } else {
            builder(&h, PAGE.to_string()).build().map(|_| ()).map_err(|e| format!("Could not open the setup screen: {e}"))
        };
        let _ = tx.send(result);
    })
    .map_err(|e| format!("Could not reach the main thread: {e}"))?;
    rx.recv().unwrap_or(Ok(()))?;

    let mut g = state.inner.lock().map_err(|_| "The setup screen's state is unavailable.")?;
    loop {
        if let Some(path) = g.installed.clone() {
            return Ok(path);
        }
        g = state.ready.wait(g).map_err(|_| "The setup screen's state is unavailable.")?;
    }
}

/// After a fresh install the server is up: build the Launcher hidden, show it once its page
/// has loaded (or at the deadline), then fade and close the setup screen. Main thread only.
pub(crate) fn hand_over(app: &AppHandle, port: u16) -> Result<(), String> {
    let done = Arc::new(AtomicBool::new(false));
    if app.get_webview_window("main").is_some() {
        reveal(app, &done);
        return Ok(());
    }
    let (h, d) = (app.clone(), done.clone());
    crate::launcher_builder(app, port)?
        .visible(false)
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                reveal(&h, &d);
            }
        })
        .build()
        .map_err(|e| format!("Could not create the window: {e}"))?;
    let (h, d) = (app.clone(), done);
    thread::spawn(move || {
        thread::sleep(LAUNCHER_DEADLINE);
        reveal(&h, &d);
    });
    Ok(())
}

/// The Launcher first, so the app is never windowless, then the setup screen fades out.
fn reveal(app: &AppHandle, done: &AtomicBool) {
    if done.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(setup) = app.get_webview_window(LABEL) {
        let _ = setup.eval("window.__dcNodeSetupExit && window.__dcNodeSetupExit()");
        thread::spawn(move || {
            thread::sleep(FADE);
            let _ = setup.close();
        });
    }
}

/// The startup error screen: the same window in error mode, with "Try again" and "Quit".
/// The message travels in the URL fragment and the page renders it as text only.
pub(crate) fn show_error(app: &AppHandle, msg: &str) {
    if let Some(state) = app.try_state::<NodeSetupState>() {
        if let Ok(mut g) = state.inner.lock() {
            g.status.mode = "error";
            g.status.phase = "error";
            g.status.error = Some("other");
        }
    }
    let path = format!("{PAGE}?mode=error#{}", percent_encode(msg));
    if let Some(existing) = app.get_webview_window(LABEL) {
        // Rebuilding under the same label would collide with the closing window: navigate.
        let navigated = existing
            .url()
            .ok()
            .and_then(|u| u.join(&path).ok())
            .map(|u| existing.navigate(u).is_ok())
            .unwrap_or(false);
        if navigated {
            let _ = existing.show();
            let _ = existing.set_focus();
            return;
        }
    }
    if let Err(e) = builder(app, path).build() {
        eprintln!("[node-setup] could not open the error screen: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_serialises_to_the_page_contract() {
        let idle = serde_json::to_value(SetupStatus::default()).unwrap();
        assert_eq!(
            idle,
            serde_json::json!({ "mode": "install", "phase": "idle", "received": 0, "total": null, "reason": "missing" })
        );
        let mut s = SetupStatus { reason: NodeProblem::TooOld { found: "/n".into(), version: "16.0.0".into() }.reason(), ..SetupStatus::default() };
        apply_progress(&mut s, Phase::Downloading, 1024, Some(52_909_993));
        assert_eq!(serde_json::to_value(&s).unwrap()["total"], 52_909_993);
        assert_eq!(s.reason, "too-old");
        apply_error(&mut s, &SetupError::Offline);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!((v["phase"].as_str(), v["error"].as_str()), (Some("error"), Some("offline")));
    }

    #[test]
    fn a_cancel_returns_to_idle_without_an_error() {
        let mut s = SetupStatus::default();
        apply_progress(&mut s, Phase::Verifying, 10, Some(10));
        apply_error(&mut s, &SetupError::Canceled);
        assert_eq!((s.phase, s.error), ("idle", None));
        apply_error(&mut s, &SetupError::UnsupportedOs { need: "13.5".into() });
        assert_eq!(s.error, Some("os"));
    }

    #[test]
    fn error_text_is_fully_encoded_for_the_fragment() {
        assert_eq!(percent_encode("a b#<x>"), "a%20b%23%3Cx%3E");
        assert_eq!(percent_encode("Öğ"), "%C3%96%C4%9F");
        assert_eq!(percent_encode(&"x".repeat(5000)).len(), MAX_ERROR_CHARS);
    }
}
