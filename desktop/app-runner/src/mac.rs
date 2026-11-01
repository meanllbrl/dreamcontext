//! The AppKit/WebKit half of the runner. Everything that touches an Objective-C object runs
//! on the main thread; network calls run on worker threads and hand their result back with
//! `DispatchQueue::main()`. Decisions live in `model.rs` so they are unit-tested.

use std::cell::RefCell;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, ClassType, MainThreadOnly};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAppearance, NSAppearanceCustomization,
    NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSApplication,
    NSApplicationActivationPolicy, NSApplicationDelegate, NSBackingStoreType, NSBitmapImageFileType,
    NSBitmapImageRep, NSImage, NSMenu, NSMenuItem, NSModalResponseOK, NSOpenPanel, NSPasteboard,
    NSPasteboardTypeString, NSRunningApplication, NSTextField, NSWindow, NSWindowDelegate,
    NSWindowOcclusionState, NSWindowStyleMask, NSWorkspace,
};
use objc2_foundation::{
    MainThreadMarker, NSActivityOptions, NSArray, NSData, NSDictionary, NSError,
    NSHTTPURLResponse, NSNotification, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize,
    NSString, NSURLRequest, NSURLResponse, NSURL,
};
use objc2_web_kit::{
    WKDownload, WKDownloadDelegate, WKFrameInfo, WKNavigation, WKNavigationAction,
    WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
    WKNavigationResponsePolicy, WKOpenPanelParameters, WKScriptMessage, WKScriptMessageHandler,
    WKUIDelegate, WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView,
    WKWebViewConfiguration, WKWindowFeatures,
};

use crate::http;
use crate::model::{self, BundleInfo, FirstReach, NavDecision, Screen, Theme};

// ─── Shared state ────────────────────────────────────────────────────────────

/// The live connection the heartbeat thread uses: (generation, gateway port, runnerToken).
/// The token lives only in memory: never UserDefaults, never a log line.
static HEARTBEAT: Mutex<Option<(u64, u16, String)>> = Mutex::new(None);

/// Wakes the reconnect loop early (window activation) instead of waiting out its 2 s.
static WAKE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());

thread_local! {
    static RUNNER: RefCell<Option<Runner>> = const { RefCell::new(None) };
}

struct Runner {
    info: BundleInfo,
    window: Retained<NSWindow>,
    webview: Retained<WKWebView>,
    ucc: Retained<WKUserContentController>,
    download_delegate: Retained<DownloadDelegate>,
    _keep: Vec<Retained<NSObject>>,
    _activity: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    /// Gateway port + runner token of the current connection.
    conn: Option<(u16, String)>,
    /// The dashboard's port: the only other origin a subframe may load.
    dashboard_port: Option<u16>,
    /// Some while one of the runner's own screens is showing instead of the app.
    screen: Option<Screen>,
    theme: Theme,
    rev: Option<u64>,
    pending_reload: bool,
    hb_failures: u32,
    /// The app page finished loading at (snapshots wait for it + 300 ms).
    settled_at: Option<Instant>,
    connecting: bool,
    /// The reconnect loop that only re-reads desktop-server.json is running.
    auto_reconnect: bool,
    stop_sent: bool,
    generation: u64,
}

fn with<R>(f: impl FnOnce(&mut Runner) -> R) -> Option<R> {
    RUNNER.with(|cell| match cell.try_borrow_mut() {
        Ok(mut guard) => guard.as_mut().map(f),
        Err(_) => None,
    })
}

fn on_main(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

fn log(msg: &str) {
    // stderr only (Console via launchd). Never a token, never a URL with a code in it.
    eprintln!("[app-runner] {msg}");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

pub fn run() {
    let mtm = MainThreadMarker::new().expect("app-runner must start on the main thread");
    let info = match read_bundle_info() {
        Ok(i) => i,
        Err(e) => {
            log(&format!("cannot start: {e}"));
            fatal_alert(mtm, "Bu app açılamadı", &e);
            std::process::exit(1);
        }
    };

    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    let delegate: Retained<AppDelegate> = unsafe { msg_send![AppDelegate::alloc(mtm), init] };
    app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    build_menu(mtm, &app, &info.name);

    let runner = build_window(mtm, info);
    RUNNER.with(|c| *c.borrow_mut() = Some(runner));
    show_screen(Screen::Connecting, None);
    with(|r| {
        r.window.makeKeyAndOrderFront(None);
    });
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);

    thread::spawn(heartbeat_loop);
    spawn_connect(ConnectKind::First);

    // The delegate must outlive the run loop.
    std::mem::forget(delegate);
    app.run();
}

fn read_bundle_info() -> Result<BundleInfo, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Contents/MacOS/app-runner → Contents/Resources/dreamcontext-app.json
    let path = exe
        .parent()
        .and_then(|p| p.parent())
        .map(|c| c.join("Resources").join("dreamcontext-app.json"))
        .ok_or("no bundle around the runner")?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    model::parse_bundle_info(&raw)
}

fn fatal_alert(_mtm: MainThreadMarker, title: &str, body: &str) {
    if let Some(alert) = new_alert() {
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(body));
        alert.runModal();
    }
}

/// `+[NSAlert new]` typed as Option: AppKit constructors are bound non-null and a nil would
/// abort under `panic = "abort"` (the same guard as desktop/src-tauri/src/lib.rs).
fn new_alert() -> Option<Retained<NSAlert>> {
    unsafe { msg_send![NSAlert::class(), new] }
}

// ─── Window ──────────────────────────────────────────────────────────────────

fn build_window(mtm: MainThreadMarker, info: BundleInfo) -> Runner {
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1200.0, 800.0));
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str(&info.name));
    window.setMinSize(NSSize::new(420.0, 320.0));
    window.center();
    // Window size and place live in this app's own UserDefaults domain.
    let _ = window.setFrameAutosaveName(&NSString::from_str("dcAppWindow"));

    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    let ucc = unsafe { config.userContentController() };
    let msg: Retained<MessageHandler> = unsafe { msg_send![MessageHandler::alloc(mtm), init] };
    unsafe {
        ucc.addScriptMessageHandler_name(ProtocolObject::from_ref(&*msg), &NSString::from_str("dcCopy"));
        ucc.addScriptMessageHandler_name(ProtocolObject::from_ref(&*msg), &NSString::from_str("dcRunner"));
    }
    let webview = unsafe {
        WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), window.contentView().map(|v| v.frame()).unwrap_or(rect), &config)
    };
    let ui: Retained<UiDelegate> = unsafe { msg_send![UiDelegate::alloc(mtm), init] };
    let nav: Retained<NavDelegate> = unsafe { msg_send![NavDelegate::alloc(mtm), init] };
    let dl: Retained<DownloadDelegate> = unsafe { msg_send![DownloadDelegate::alloc(mtm), init] };
    let wd: Retained<WindowDelegate> = unsafe { msg_send![WindowDelegate::alloc(mtm), init] };
    unsafe {
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
        webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*nav)));
        webview.setInspectable(true);
    }
    window.setDelegate(Some(ProtocolObject::from_ref(&*wd)));
    window.setContentView(Some(&webview));

    // App Nap would slow the heartbeat and let the lease lapse under a hidden window.
    let activity = {
        let info = NSProcessInfo::processInfo();
        let reason = NSString::from_str("dreamcontext app window is open");
        Some(info.beginActivityWithOptions_reason(NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, &reason))
    };

    let keep: Vec<Retained<NSObject>> = vec![
        Retained::into_super(msg),
        Retained::into_super(ui),
        Retained::into_super(nav),
        Retained::into_super(wd),
    ];
    Runner {
        info,
        window,
        webview,
        ucc,
        download_delegate: dl,
        _keep: keep,
        _activity: activity,
        conn: None,
        dashboard_port: None,
        screen: None,
        theme: Theme::System,
        rev: None,
        pending_reload: false,
        hb_failures: 0,
        settled_at: None,
        connecting: false,
        auto_reconnect: false,
        stop_sent: false,
        generation: 0,
    }
}

fn build_menu(mtm: MainThreadMarker, app: &NSApplication, name: &str) {
    let item = |title: &str, action: Option<objc2::runtime::Sel>, key: &str| -> Retained<NSMenuItem> {
        unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(mtm),
                &NSString::from_str(title),
                action,
                &NSString::from_str(key),
            )
        }
    };
    let submenu = |title: &str, items: Vec<Retained<NSMenuItem>>| -> Retained<NSMenuItem> {
        let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
        for i in items {
            menu.addItem(&i);
        }
        let holder = item(title, None, "");
        holder.setSubmenu(Some(&menu));
        holder
    };
    let main = NSMenu::new(mtm);
    main.addItem(&submenu(
        name,
        vec![
            item(&format!("Hide {name}"), Some(sel!(hide:)), "h"),
            NSMenuItem::separatorItem(mtm),
            item(&format!("Quit {name}"), Some(sel!(terminate:)), "q"),
        ],
    ));
    main.addItem(&submenu(
        "Edit",
        vec![
            item("Undo", Some(sel!(undo:)), "z"),
            item("Redo", Some(sel!(redo:)), "Z"),
            NSMenuItem::separatorItem(mtm),
            item("Cut", Some(sel!(cut:)), "x"),
            item("Copy", Some(sel!(copy:)), "c"),
            item("Paste", Some(sel!(paste:)), "v"),
            item("Select All", Some(sel!(selectAll:)), "a"),
        ],
    ));
    // WKWebView answers `reload:` itself through the responder chain.
    main.addItem(&submenu("View", vec![item("Reload", Some(sel!(reload:)), "r")]));
    let window_menu = submenu(
        "Window",
        vec![
            item("Minimize", Some(sel!(performMiniaturize:)), "m"),
            item("Close", Some(sel!(performClose:)), "w"),
        ],
    );
    main.addItem(&window_menu);
    app.setMainMenu(Some(&main));
    if let Some(m) = window_menu.submenu() {
        app.setWindowsMenu(Some(&m));
    }
}

fn window_is_seen(w: &NSWindow) -> bool {
    w.isVisible() && !w.isMiniaturized() && w.occlusionState().contains(NSWindowOcclusionState::Visible)
}

fn bring_forward() {
    with(|r| {
        if r.window.isMiniaturized() {
            r.window.deminiaturize(None);
        }
        r.window.makeKeyAndOrderFront(None);
    });
}

fn show_screen(screen: Screen, detail: Option<String>) {
    with(|r| {
        r.screen = Some(screen);
        r.settled_at = None;
        let html = model::screen_html(screen, &r.info.name, detail.as_deref(), r.theme);
        unsafe {
            r.webview.loadHTMLString_baseURL(&NSString::from_str(&html), None);
        }
    });
}

fn load_app(url: &str) {
    with(|r| {
        let Some(nsurl) = NSURL::URLWithString(&NSString::from_str(url)) else {
            return;
        };
        r.screen = None;
        r.settled_at = None;
        r.pending_reload = false;
        let req = NSURLRequest::requestWithURL(&nsurl);
        unsafe {
            r.webview.loadRequest(&req);
        }
    });
}

fn apply_theme(theme: Theme) {
    with(|r| {
        let changed = r.theme != theme;
        r.theme = theme;
        let appearance = match theme {
            Theme::Dark => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }),
            Theme::Light => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua }),
            Theme::System => None,
        };
        r.window.setAppearance(appearance.as_deref());
        unsafe {
            r.ucc.removeAllUserScripts();
            let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                WKUserScript::alloc(MainThreadMarker::new().unwrap()),
                &NSString::from_str(&model::page_bootstrap_script(theme)),
                WKUserScriptInjectionTime::AtDocumentStart,
                true,
            );
            r.ucc.addUserScript(&script);
            if changed {
                r.webview.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&model::theme_change_script(theme)),
                    None,
                );
            }
        }
    });
}

fn reload_if_seen() {
    with(|r| {
        if r.pending_reload && r.screen.is_none() && window_is_seen(&r.window) {
            r.pending_reload = false;
            r.settled_at = None;
            unsafe {
                r.webview.reload();
            }
        }
    });
}

// ─── Connecting ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum ConnectKind {
    /// The window's first connection: may `open` a dreamcontext that is not running.
    First,
    /// "Yeniden bağlan" / "Başlat": the owner asked; same rules as First.
    Manual,
    /// A running window lost dreamcontext: only re-reads desktop-server.json. Never `open`.
    Auto,
}

enum Outcome {
    Connected(model::LaunchWindow),
    Show(Screen, Option<String>),
}

enum Attempt {
    Ok(model::LaunchWindow),
    Backend(String),
    Unreachable,
}

fn spawn_connect(kind: ConnectKind) {
    let go = with(|r| {
        if r.connecting {
            return None;
        }
        r.connecting = true;
        if kind == ConnectKind::Auto {
            r.auto_reconnect = true;
        }
        Some(r.info.clone())
    })
    .flatten();
    let Some(info) = go else { return };
    if kind != ConnectKind::Auto {
        show_screen(Screen::Connecting, None);
    }
    thread::spawn(move || {
        let outcome = connect_worker(&info, kind);
        on_main(move || finish_connect(outcome));
    });
}

fn connect_worker(info: &BundleInfo, kind: ConnectKind) -> Outcome {
    if kind == ConnectKind::Auto {
        // Re-read the file every 2 s (and on activation) until a live shell writes a valid
        // one. The window never brings dreamcontext back by itself: Quit is respected.
        loop {
            match try_launch(info) {
                Attempt::Ok(lw) => return Outcome::Connected(lw),
                Attempt::Backend(e) => return Outcome::Show(Screen::BackendError, Some(e)),
                Attempt::Unreachable => {}
            }
            let (lock, cv) = &WAKE;
            let mut woke = lock.lock().unwrap();
            if !*woke {
                woke = cv.wait_timeout(woke, Duration::from_secs(2)).unwrap().0;
            }
            *woke = false;
            drop(woke);
            if with_auto_cancelled() {
                return Outcome::Show(Screen::Closed, None);
            }
        }
    }
    match try_launch(info) {
        Attempt::Ok(lw) => return Outcome::Connected(lw),
        Attempt::Backend(e) => return Outcome::Show(Screen::BackendError, Some(e)),
        Attempt::Unreachable => {}
    }
    let alive = shell_alive(&info.app_bundle_id);
    let reach = model::first_reach(alive);
    if reach == FirstReach::OpenShellThenPoll {
        log("dreamcontext is not running: opening it in the background");
        let _ = std::process::Command::new("/usr/bin/open")
            .args(["-g", "-b", &info.app_bundle_id, "--args", "--background"])
            .status();
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(500));
        match try_launch(info) {
            Attempt::Ok(lw) => return Outcome::Connected(lw),
            Attempt::Backend(e) => return Outcome::Show(Screen::BackendError, Some(e)),
            Attempt::Unreachable => {}
        }
    }
    match reach {
        FirstReach::OpenShellThenPoll => Outcome::Show(Screen::CouldNotOpen, None),
        FirstReach::PollOnly => Outcome::Show(Screen::ReopenDreamcontext, None),
    }
}

/// Asked from the worker thread; a cross-thread read of a main-thread flag goes through a
/// synchronous hop so it is never torn.
fn with_auto_cancelled() -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(move || {
        let cancelled = with(|r| !r.auto_reconnect).unwrap_or(true);
        let _ = tx.send(cancelled);
    });
    rx.recv_timeout(Duration::from_secs(5)).unwrap_or(false)
}

fn try_launch(info: &BundleInfo) -> Attempt {
    let Some(file) = read_server_file() else {
        return Attempt::Unreachable;
    };
    // The token goes out only when the shell itself is alive: a stale file from a power
    // cut (or a reused pid) must not hand it to whatever listens on that port now.
    if !shell_alive(&info.app_bundle_id) {
        return Attempt::Unreachable;
    }
    let body = serde_json::json!({ "projectRoot": info.project_root, "slug": info.slug }).to_string();
    let res = http::send(&http::Request {
        port: file.port,
        method: "POST",
        path: "/api/apps/launch-window",
        bearer: Some(&file.launch_token),
        content_type: Some("application/json"),
        body: body.as_bytes(),
        timeout: Duration::from_secs(25),
    });
    match res {
        Ok(r) if r.status == 200 => match model::parse_launch_window(&r.body) {
            Ok(lw) if lw.state == "error" => Attempt::Backend(lw.last_error.unwrap_or_else(|| "backend error".into())),
            Ok(mut lw) => {
                lw.dashboard_port = file.port;
                Attempt::Ok(lw)
            }
            Err(e) => {
                log(&e);
                Attempt::Unreachable
            }
        },
        // A stale token (a newer server) or a server that is still booting.
        Ok(r) if r.status == 401 || r.status == 403 || r.status == 404 || r.status == 503 => Attempt::Unreachable,
        Ok(r) => {
            let msg = serde_json::from_slice::<serde_json::Value>(&r.body)
                .ok()
                .and_then(|v| {
                    v.get("lastError")
                        .or_else(|| v.get("error"))
                        .and_then(|e| e.as_str())
                        .map(|s| s.chars().take(400).collect::<String>())
                })
                .unwrap_or_else(|| format!("HTTP {}", r.status));
            Attempt::Backend(msg)
        }
        Err(_) => Attempt::Unreachable,
    }
}

fn finish_connect(outcome: Outcome) {
    with(|r| {
        r.connecting = false;
        r.auto_reconnect = false;
    });
    match outcome {
        Outcome::Show(screen, detail) => {
            *HEARTBEAT.lock().unwrap() = None;
            show_screen(screen, detail);
        }
        Outcome::Connected(lw) => {
            let generation = with(|r| {
                r.generation += 1;
                r.conn = Some((lw.gateway_port, lw.runner_token.clone()));
                r.dashboard_port = Some(lw.dashboard_port);
                r.hb_failures = 0;
                r.rev = None;
                if let Some(t) = &lw.title {
                    r.window.setTitle(&NSString::from_str(t));
                }
                r.generation
            })
            .unwrap_or(0);
            *HEARTBEAT.lock().unwrap() = Some((generation, lw.gateway_port, lw.runner_token.clone()));
            apply_theme(lw.theme);
            if lw.state == "stopped" {
                show_screen(Screen::Stopped, None);
            } else {
                load_app(&lw.url);
            }
        }
    }
}

fn read_server_file() -> Option<model::ServerFile> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let path = home.join(".dreamcontext").join("desktop-server.json");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .ok()?;
    let meta = file.metadata().ok()?; // fstat on the open descriptor
    let me = unsafe { libc::getuid() };
    if !model::server_file_meta_ok(meta.file_type().is_file(), meta.uid(), me, meta.mode()) {
        return None;
    }
    let mut raw = String::new();
    use std::io::Read;
    (&file).take(64 * 1024).read_to_string(&mut raw).ok()?;
    model::parse_server_file(&raw)
}

/// Is the dreamcontext SHELL running? Measured by its bundle id, never by the pid in the
/// file (that pid is the Node child, and goes stale or is reused after a power cut).
fn shell_alive(bundle_id: &str) -> bool {
    let apps = NSRunningApplication::runningApplicationsWithBundleIdentifier(&NSString::from_str(bundle_id));
    apps.iter().any(|a| !a.isTerminated())
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────

fn heartbeat_loop() {
    loop {
        thread::sleep(Duration::from_secs(2));
        let current = HEARTBEAT.lock().unwrap().clone();
        let Some((generation, port, token)) = current else { continue };
        let res = http::send(&http::Request {
            port,
            method: "POST",
            path: "/__dc/runner/heartbeat",
            bearer: Some(&token),
            content_type: Some("application/json"),
            body: b"{}",
            timeout: Duration::from_secs(5),
        });
        let beat = match res {
            Ok(r) if r.status == 200 => model::parse_heartbeat(&r.body),
            _ => None,
        };
        on_main(move || on_heartbeat(generation, beat));
    }
}

fn on_heartbeat(generation: u64, beat: Option<model::Heartbeat>) {
    enum Next {
        Nothing,
        Closed,
        Stopped,
        Resume,
        Snapshot(String),
    }
    let mut theme = None;
    let next = with(|r| {
        if generation != r.generation {
            return Next::Nothing;
        }
        let Some(beat) = beat else {
            r.hb_failures += 1;
            if r.hb_failures >= model::HEARTBEAT_FAILS_TO_CLOSED && r.screen != Some(Screen::Closed) {
                return Next::Closed;
            }
            return Next::Nothing;
        };
        r.hb_failures = 0;
        if beat.theme != r.theme {
            theme = Some(beat.theme);
        }
        if beat.state == "stopped" {
            if r.screen != Some(Screen::Stopped) {
                return Next::Stopped;
            }
        } else if r.screen == Some(Screen::Stopped) {
            // The owner pressed Launch in dreamcontext: get a fresh enter code.
            return Next::Resume;
        }
        match r.rev {
            Some(old) if old != beat.rev => r.pending_reload = true,
            _ => {}
        }
        r.rev = Some(beat.rev);
        match beat.snapshot {
            Some(id) => Next::Snapshot(id),
            None => Next::Nothing,
        }
    })
    .unwrap_or(Next::Nothing);
    if let Some(t) = theme {
        apply_theme(t);
    }
    match next {
        Next::Nothing => reload_if_seen(),
        Next::Closed => {
            *HEARTBEAT.lock().unwrap() = None;
            with(|r| r.conn = None);
            show_screen(Screen::Closed, None);
            spawn_connect(ConnectKind::Auto);
        }
        Next::Stopped => show_screen(Screen::Stopped, None),
        Next::Resume => spawn_connect(ConnectKind::Manual),
        Next::Snapshot(id) => {
            reload_if_seen();
            snapshot(id, Instant::now() + Duration::from_secs(8));
        }
    }
}

fn wake_reconnect() {
    let (lock, cv) = &WAKE;
    *lock.lock().unwrap() = true;
    cv.notify_all();
}

/// POST /__dc/runner/stop, synchronously and briefly: the window is closing or the app is
/// quitting, and the backend lease should end now rather than at its TTL.
fn send_stop() {
    let conn = with(|r| {
        if r.stop_sent {
            return None;
        }
        r.stop_sent = true;
        r.conn.clone()
    })
    .flatten();
    if let Some((port, token)) = conn {
        let _ = http::send(&http::Request {
            port,
            method: "POST",
            path: "/__dc/runner/stop",
            bearer: Some(&token),
            content_type: Some("application/json"),
            body: b"{}",
            timeout: Duration::from_millis(800),
        });
    }
}

fn send_start_then_connect() {
    let conn = with(|r| r.conn.clone()).flatten();
    show_screen(Screen::Connecting, None);
    thread::spawn(move || {
        if let Some((port, token)) = conn {
            let _ = http::send(&http::Request {
                port,
                method: "POST",
                path: "/__dc/runner/start",
                bearer: Some(&token),
                content_type: Some("application/json"),
                body: b"{}",
                timeout: Duration::from_secs(5),
            });
        }
        on_main(|| spawn_connect(ConnectKind::Manual));
    });
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

fn snapshot(id: String, deadline: Instant) {
    enum Step {
        Wait,
        Fail(&'static str),
        Take,
    }
    let step = with(|r| {
        let settled = r.screen.is_none() && r.settled_at.is_some_and(|t| t.elapsed() >= Duration::from_millis(300));
        if !settled {
            return if Instant::now() < deadline { Step::Wait } else { Step::Fail("snapshot_failed") };
        }
        if !r.window.isVisible() && !r.window.isMiniaturized() {
            return Step::Fail("window_hidden");
        }
        Step::Take
    })
    .unwrap_or(Step::Fail("snapshot_failed"));
    match step {
        Step::Wait => {
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(100));
                on_main(move || snapshot(id, deadline));
            });
        }
        Step::Fail(code) => post_snapshot(id, Err(code)),
        Step::Take => {
            let id2 = id.clone();
            let handler = RcBlock::new(move |image: *mut NSImage, _err: *mut NSError| {
                let png = unsafe { image.as_ref() }.and_then(png_bytes);
                match png {
                    Some(bytes) => post_snapshot(id2.clone(), Ok(bytes)),
                    None => post_snapshot(id2.clone(), Err("snapshot_failed")),
                }
            });
            let started = with(|r| unsafe {
                r.webview.takeSnapshotWithConfiguration_completionHandler(None, &handler);
            });
            if started.is_none() {
                post_snapshot(id, Err("snapshot_failed"));
            }
        }
    }
}

fn png_bytes(image: &NSImage) -> Option<Vec<u8>> {
    let tiff = image.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let props = NSDictionary::new();
    let png: Retained<NSData> = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
    Some(png.to_vec())
}

fn post_snapshot(id: String, result: Result<Vec<u8>, &'static str>) {
    let conn = with(|r| r.conn.clone()).flatten();
    let Some((port, token)) = conn else { return };
    thread::spawn(move || {
        let path = format!("/__dc/runner/snapshot/{id}");
        let (ctype, body) = match result {
            Ok(png) => ("image/png", png),
            Err(code) => ("application/json", serde_json::json!({ "error": code }).to_string().into_bytes()),
        };
        let _ = http::send(&http::Request {
            port,
            method: "POST",
            path: &path,
            bearer: Some(&token),
            content_type: Some(ctype),
            body: &body,
            timeout: Duration::from_secs(10),
        });
    });
}

// ─── Delegates ───────────────────────────────────────────────────────────────

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerAppDelegate"]
    struct AppDelegate;

    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl NSApplicationDelegate for AppDelegate {
        #[unsafe(method(applicationShouldTerminateAfterLastWindowClosed:))]
        fn should_terminate_after_last_window_closed(&self, _app: &NSApplication) -> bool {
            // No windowless live runner: a lingering one would turn the next `open` into a
            // bare Reopen that drops `--args` and shows nothing.
            true
        }

        #[unsafe(method(applicationWillTerminate:))]
        fn will_terminate(&self, _n: &NSNotification) {
            // Cmd-Q may end the app without closing the window first.
            send_stop();
        }

        #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
        fn should_handle_reopen(&self, _app: &NSApplication, _has_visible: bool) -> bool {
            bring_forward();
            true
        }

        #[unsafe(method(applicationDidBecomeActive:))]
        fn did_become_active(&self, _n: &NSNotification) {
            wake_reconnect();
            reload_if_seen();
        }

        #[unsafe(method(applicationDidUnhide:))]
        fn did_unhide(&self, _n: &NSNotification) {
            reload_if_seen();
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerWindowDelegate"]
    struct WindowDelegate;

    unsafe impl NSObjectProtocol for WindowDelegate {}

    unsafe impl NSWindowDelegate for WindowDelegate {
        #[unsafe(method(windowWillClose:))]
        fn will_close(&self, _n: &NSNotification) {
            send_stop();
        }

        #[unsafe(method(windowDidDeminiaturize:))]
        fn did_deminiaturize(&self, _n: &NSNotification) {
            reload_if_seen();
        }

        #[unsafe(method(windowDidChangeOcclusionState:))]
        fn did_change_occlusion(&self, _n: &NSNotification) {
            reload_if_seen();
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerMessageHandler"]
    struct MessageHandler;

    unsafe impl NSObjectProtocol for MessageHandler {}

    unsafe impl WKScriptMessageHandler for MessageHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _ucc: &WKUserContentController, message: &WKScriptMessage) {
            let name = unsafe { message.name() }.to_string();
            let frame = unsafe { message.frameInfo() };
            if !unsafe { frame.isMainFrame() } {
                return;
            }
            let body = unsafe { message.body() };
            let Some(text) = body.downcast_ref::<NSString>().map(|s| s.to_string()) else {
                return;
            };
            match name.as_str() {
                "dcCopy" => {
                    // Only the app's own page, on its gateway origin, may write the pasteboard.
                    let origin = unsafe { frame.securityOrigin() };
                    let (proto, host, port) = unsafe { (origin.protocol().to_string(), origin.host().to_string(), origin.port()) };
                    let ok = with(|r| {
                        r.screen.is_none()
                            && r.conn.as_ref().is_some_and(|(p, _)| proto == "http" && host == "127.0.0.1" && port == *p as isize)
                    })
                    .unwrap_or(false);
                    if ok {
                        let pb = NSPasteboard::generalPasteboard();
                        pb.clearContents();
                        unsafe {
                            pb.setString_forType(&NSString::from_str(&text), NSPasteboardTypeString);
                        }
                    }
                }
                "dcRunner" => {
                    // Honoured only while the runner's own screen is up (an app page cannot
                    // press these buttons for the owner).
                    let screen = with(|r| r.screen).flatten();
                    match (screen, text.as_str()) {
                        (Some(Screen::Stopped), "start") => send_start_then_connect(),
                        (Some(Screen::Closed), "reconnect") => {
                            with(|r| r.auto_reconnect = false);
                            wake_reconnect();
                            // Let the auto loop notice it was cancelled, then connect as the owner asked.
                            thread::spawn(|| {
                                thread::sleep(Duration::from_millis(50));
                                on_main(|| {
                                    let busy = with(|r| r.connecting).unwrap_or(true);
                                    if busy {
                                        thread::spawn(|| {
                                            thread::sleep(Duration::from_millis(400));
                                            on_main(|| spawn_connect(ConnectKind::Manual));
                                        });
                                    } else {
                                        spawn_connect(ConnectKind::Manual);
                                    }
                                });
                            });
                        }
                        (Some(Screen::CouldNotOpen | Screen::ReopenDreamcontext | Screen::BackendError), "reconnect") => {
                            spawn_connect(ConnectKind::Manual)
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }
);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerNavDelegate"]
    struct NavDelegate;

    unsafe impl NSObjectProtocol for NavDelegate {}

    unsafe impl WKNavigationDelegate for NavDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_action(
            &self,
            _webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let policy = navigation_action_policy(action);
            handler.call((policy,));
        }

        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(
            &self,
            _webview: &WKWebView,
            response: &WKNavigationResponse,
            handler: &block2::Block<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            let download = unsafe { !response.canShowMIMEType() } || is_attachment(&*unsafe { response.response() });
            handler.call((if download { WKNavigationResponsePolicy::Download } else { WKNavigationResponsePolicy::Allow },));
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_became_download(&self, _w: &WKWebView, _a: &WKNavigationAction, download: &WKDownload) {
            adopt_download(download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_became_download(&self, _w: &WKWebView, _r: &WKNavigationResponse, download: &WKDownload) {
            adopt_download(download);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, _w: &WKWebView, _n: Option<&WKNavigation>) {
            with(|r| {
                if r.screen.is_none() {
                    r.settled_at = Some(Instant::now());
                }
            });
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn content_died(&self, webview: &WKWebView) {
            log("web content process ended: reloading");
            unsafe {
                webview.reload();
            }
        }
    }
);

fn navigation_action_policy(action: &WKNavigationAction) -> WKNavigationActionPolicy {
    if unsafe { action.shouldPerformDownload() } {
        return WKNavigationActionPolicy::Download;
    }
    let url = unsafe { action.request() }
        .URL()
        .and_then(|u| u.absoluteString())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let target = unsafe { action.targetFrame() };
    let (gw, internal, dash) = with(|r| (r.conn.as_ref().map(|(p, _)| *p), r.screen.is_some(), r.dashboard_port)).unwrap_or((None, false, None));
    match target {
        // A subframe: the app's own origin or an embedded dreamcontext screen, nothing else.
        // The embed's CSP says the same; this holds whatever a page or a frame inside it does.
        Some(f) if !unsafe { f.isMainFrame() } => {
            if model::subframe_allowed(&url, gw, dash) {
                WKNavigationActionPolicy::Allow
            } else {
                log("a subframe navigation outside the app and dreamcontext was refused");
                WKNavigationActionPolicy::Cancel
            }
        }
        // target=_blank / window.open: the same rule, but nothing opens a second window.
        None => {
            match model::decide_navigation(&url, gw, false) {
                NavDecision::Allow => {
                    let u = url.clone();
                    on_main(move || load_app(&u));
                }
                NavDecision::OpenExternally => open_externally(&url),
                NavDecision::Deny => {}
            }
            WKNavigationActionPolicy::Cancel
        }
        Some(_) => match model::decide_navigation(&url, gw, internal) {
            NavDecision::Allow => WKNavigationActionPolicy::Allow,
            NavDecision::OpenExternally => {
                open_externally(&url);
                WKNavigationActionPolicy::Cancel
            }
            NavDecision::Deny => WKNavigationActionPolicy::Cancel,
        },
    }
}

fn open_externally(url: &str) {
    if let Some(u) = NSURL::URLWithString(&NSString::from_str(url)) {
        NSWorkspace::sharedWorkspace().openURL(&u);
    }
}

fn is_attachment(resp: &NSURLResponse) -> bool {
    let Some(http) = resp.downcast_ref::<NSHTTPURLResponse>() else {
        return false;
    };
    http.valueForHTTPHeaderField(&NSString::from_str("Content-Disposition"))
        .map(|v| v.to_string().trim().to_ascii_lowercase().starts_with("attachment"))
        .unwrap_or(false)
}

fn adopt_download(download: &WKDownload) {
    with(|r| unsafe {
        download.setDelegate(Some(ProtocolObject::from_ref(&*r.download_delegate)));
    });
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerDownloadDelegate"]
    struct DownloadDelegate;

    unsafe impl NSObjectProtocol for DownloadDelegate {}

    unsafe impl WKDownloadDelegate for DownloadDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn destination(
            &self,
            _download: &WKDownload,
            _response: &NSURLResponse,
            suggested: &NSString,
            handler: &block2::Block<dyn Fn(*const NSURL)>,
        ) {
            match download_destination(&suggested.to_string()) {
                Some(path) => {
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                    handler.call((Retained::as_ptr(&url),));
                }
                None => handler.call((std::ptr::null(),)),
            }
        }

        #[unsafe(method(downloadDidFinish:))]
        fn finished(&self, _download: &WKDownload) {}

        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn failed(&self, _download: &WKDownload, _error: &NSError, _resume: Option<&NSData>) {
            log("a download failed");
        }
    }
);

fn download_destination(suggested: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("HOME").map(PathBuf::from)?.join("Downloads");
    let base = model::download_basename(suggested);
    for n in 1..1000 {
        let candidate = dir.join(model::numbered_name(&base, n));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return Some(candidate);
        }
    }
    None
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "DCAppRunnerUiDelegate"]
    struct UiDelegate;

    unsafe impl NSObjectProtocol for UiDelegate {}

    unsafe impl WKUIDelegate for UiDelegate {
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(&self, _w: &WKWebView, message: &NSString, _f: &WKFrameInfo, handler: &block2::Block<dyn Fn()>) {
            if let Some(a) = panel_alert(message) {
                a.addButtonWithTitle(&NSString::from_str("OK"));
                a.runModal();
            }
            handler.call(());
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(&self, _w: &WKWebView, message: &NSString, _f: &WKFrameInfo, handler: &block2::Block<dyn Fn(Bool)>) {
            let ok = match panel_alert(message) {
                Some(a) => {
                    a.addButtonWithTitle(&NSString::from_str("OK"));
                    a.addButtonWithTitle(&NSString::from_str("İptal"));
                    a.runModal() == NSAlertFirstButtonReturn
                }
                None => false,
            };
            handler.call((Bool::new(ok),));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(
            &self,
            _w: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            _f: &WKFrameInfo,
            handler: &block2::Block<dyn Fn(*mut NSString)>,
        ) {
            let mtm = self.mtm();
            let Some(a) = panel_alert(prompt) else {
                handler.call((null_mut(),));
                return;
            };
            let field = NSTextField::initWithFrame(NSTextField::alloc(mtm), NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)));
            if let Some(d) = default_text {
                field.setStringValue(d);
            }
            a.setAccessoryView(Some(&field));
            a.addButtonWithTitle(&NSString::from_str("OK"));
            a.addButtonWithTitle(&NSString::from_str("İptal"));
            if a.runModal() == NSAlertFirstButtonReturn {
                let value = field.stringValue();
                handler.call((Retained::as_ptr(&value) as *mut NSString,));
            } else {
                handler.call((null_mut(),));
            }
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            _w: &WKWebView,
            params: &WKOpenPanelParameters,
            _f: &WKFrameInfo,
            handler: &block2::Block<dyn Fn(*const NSArray<NSURL>)>,
        ) {
            // Typed as Option: AppKit can hand back nil, and a nil-checked panic would
            // abort the whole runner (desktop/src-tauri/src/open_panel_guard.rs).
            let panel: Option<Retained<NSOpenPanel>> = unsafe { msg_send![NSOpenPanel::class(), openPanel] };
            let Some(panel) = panel else {
                handler.call((std::ptr::null(),));
                return;
            };
            panel.setCanChooseFiles(true);
            unsafe {
                panel.setAllowsMultipleSelection(params.allowsMultipleSelection());
                panel.setCanChooseDirectories(params.allowsDirectories());
            }
            if panel.runModal() == NSModalResponseOK {
                let urls: Option<Retained<NSArray<NSURL>>> = unsafe { msg_send![&*panel, URLs] };
                match urls {
                    Some(u) => handler.call((Retained::as_ptr(&u),)),
                    None => handler.call((std::ptr::null(),)),
                }
            } else {
                handler.call((std::ptr::null(),));
            }
        }

        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _w: &WKWebView,
            _c: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _f: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            // One window per app: a gateway URL loads here, the rest goes to the browser.
            let url = unsafe { action.request() }
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let gw = with(|r| r.conn.as_ref().map(|(p, _)| *p)).flatten();
            match model::decide_navigation(&url, gw, false) {
                NavDecision::Allow => on_main(move || load_app(&url)),
                NavDecision::OpenExternally => open_externally(&url),
                NavDecision::Deny => {}
            }
            None
        }
    }
);

fn panel_alert(message: &NSString) -> Option<Retained<NSAlert>> {
    let a = new_alert()?;
    let title = with(|r| r.info.name.clone()).unwrap_or_default();
    a.setMessageText(&NSString::from_str(&title));
    a.setInformativeText(message);
    Some(a)
}

