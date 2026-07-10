// dreamcontext desktop shell — lib.rs
//
// Architecture (v0.8.0 — multi-vault beta):
//
// 1. Resolve node (absolute path — a Finder-launched .app has NO shell PATH).
// 2. Resolve the dreamcontext CLI (bundled into the app's resources, or via
//    DREAMCONTEXT_CLI for dev).
// 3. Pick a free loopback port; spawn `node <cli> dashboard --port N --no-open
//    --launcher` directly via std::process (NOT the IPC shell API, so an
//    absolute node path isn't blocked by the shell capability scope). The server
//    boots vault-agnostic — each window pins its own vault via ?vault=.
// 4. Poll GET /api/health until ready, then open the LAUNCHER window at the port.
// 5. Each project opens in its OWN window via the built-in WebviewWindow JS API
//    (core:webview:allow-create-webview-window), pinned to ?vault=<name>. Custom
//    Rust commands are blocked by the ACL on the remote-served (loopback) pages.
// 6. Kill the Node child on APP EXIT (not per-window) so no orphan survives.
//
// CRASH-SAFETY: any startup failure shows an explanatory error window instead
// of panicking — a Finder double-click must never silently abort.

use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Listener, Manager, RunEvent, TitleBarStyle,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_nspanel::{
    cocoa::appkit::{NSMainMenuWindowLevel, NSWindowCollectionBehavior},
    ManagerExt, WebviewWindowExt,
};

// ─── CoreGraphics FFI (cursor position for notch hover-to-open) ───────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}
type CGDirectDisplayID = u32;
type CGEventRef = *mut std::ffi::c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> CGDirectDisplayID;
    fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
    fn CGEventCreate(source: *mut std::ffi::c_void) -> CGEventRef;
    fn CGEventGetLocation(event: CGEventRef) -> CGPoint;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const std::ffi::c_void);
}

// ─── Shared state ────────────────────────────────────────────────────────────

/// The Node child process, kept so it can be killed on app exit.
type ChildHandle = Arc<Mutex<Option<Child>>>;

/// The loopback port the dashboard server bound to — stored so the Sleepy panel
/// (built lazily, on first hotkey press) can load `…/?capture=1` from it.
struct ServerPort(u16);

/// Webview label of the Sleepy notch panel.
const SLEEPY_LABEL: &str = "sleepy";
/// Logical size of the Sleepy window. Wider/taller than the visible black panel
/// so the transparent margin holds the drop shadow + the notch flare; only the
/// panels paint. The black mass is centered, so centering the window centers it
/// on the notch.
const SLEEPY_W: f64 = 560.0;
const SLEEPY_H: f64 = 560.0;
/// macOS `NSWindowStyleMaskNonactivatingPanel` (1 << 7). Set as the panel's sole
/// style mask → borderless + can become key WITHOUT activating the app, so the
/// user types into Sleepy while their editor/browser stays the active app.
const NS_NONACTIVATING_PANEL_MASK: i32 = 1 << 7;
/// The always-on companion that perches just left of the physical notch.
const PERCH_LABEL: &str = "sleepy-perch";
const PERCH_W: f64 = 56.0;
/// Fallback perch height when the notch geometry can't be read (≈ menu-bar height).
const PERCH_H: f64 = 38.0;
/// Half-width of the physical notch (logical px) — the perch tucks to its left.
const NOTCH_HALF_W: f64 = 100.0;
/// Notch hotspot: cursor within this many logical px of the screen's top edge…
const NOTCH_HOTSPOT_TOP_PX: f64 = 6.0;
/// …and within this half-width of screen-center counts as "at the notch".
const NOTCH_HOTSPOT_HALF_W: f64 = 130.0;
/// Below this depth (or beyond the body half-width) the cursor has clearly left a
/// hover-opened panel, so it auto-closes (unless the user has clicked into it).
const HOVER_KEEPALIVE_H: f64 = 300.0;

/// Whether the Sleepy panel is currently shown — kept in sync by the show/hide
/// paths so the hover watcher doesn't re-trigger a visible panel.
struct PanelShown(AtomicBool);
/// Set once the user actually clicks/focuses the panel. While committed, the
/// hover watcher won't auto-close it (only Esc / click-away does).
struct PanelCommitted(AtomicBool);
/// Whether Sleepy is enabled in Settings. When false the notch is fully closed:
/// the perch is ordered out, hover-to-open is gated off, and any shown panel is
/// hidden. The launcher JS mirrors the persisted config here via `sleepy:enabled`.
/// Defaults to false (Sleepy is opt-in) so the notch never shows pre-enable.
struct PanelEnabled(AtomicBool);

// ─── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Native OS clipboard so the dashboard can write UTF-8 without the WKWebView JS
        // clipboard mangling non-ASCII as Mac Roman (issue #171). Used by the in-app agent
        // terminal's copy path via @tauri-apps/plugin-clipboard-manager on the loopback origin.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Global shortcut for the Sleepy notch quick-capture bar. The hotkey is
        // registered/unregistered from the dashboard JS via the plugin's permitted
        // API (the capability grants global-shortcut on the loopback origin), so
        // no custom Rust command is needed (those are ACL-blocked on remote pages).
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // NSPanel conversion for the Sleepy notch window (see ServerPort/SLEEPY_*).
        .plugin(tauri_nspanel::init())
        .setup(|app| {
            // Never abort on a startup problem — surface it in a window.
            match host_dashboard(app.handle().clone()) {
                Err(msg) => show_error_window(app.handle(), &msg),
                Ok(()) => {
                    // Bridge the JS-owned global hotkey to the Rust-owned notch panel.
                    // The launcher window registers the OS-wide shortcut (fires from
                    // any app, focused or not) and emits `sleepy:toggle`; the capture
                    // page emits `sleepy:hide` on Esc / click-away. Rust owns the panel
                    // because only an NSPanel can float over the focused app and take
                    // keystrokes without activating dreamcontext.
                    wire_sleepy_panel_bridge(app.handle());
                    // Open Sleepy automatically when the cursor reaches the notch.
                    spawn_notch_hover_watch(app.handle());
                    // The always-on companion that perches just left of the notch.
                    build_perch_panel(app.handle());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("dreamcontext desktop failed to start");

    app.run(|app_handle, event| {
        // Reap the dashboard server (and its whole process group) on app exit so no
        // orphan node process survives. ExitRequested fires on a normal quit;
        // Exit is the final backstop. reap_server is idempotent (the child is taken
        // out of the shared handle), so firing on both is safe.
        //
        // NOTE: this only covers exits Tauri actually observes. A force-quit / crash
        // / dev-rebuild can terminate the app WITHOUT either event firing — that path
        // is covered server-side by the parent-death watchdog (src/server/lifecycle.ts),
        // for which we pass DREAMCONTEXT_PARENT_PID at spawn.
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(handle) = app_handle.try_state::<ChildHandle>() {
                reap_server(handle.inner());
            }
        }
    });
}

/// Gracefully tear down the dashboard-server child: SIGTERM the whole process group
/// (so the node server runs its own shutdown — closing the HTTP server and killing
/// the PTYs it spawned — rather than being hard-killed mid-flight), wait briefly for
/// a clean exit, then SIGKILL the group as a fallback so a hung server can't linger.
/// Idempotent: takes the child out of the shared handle, so a second call is a no-op.
fn reap_server(handle: &ChildHandle) {
    let mut child = match handle.lock() {
        Ok(mut guard) => match guard.take() {
            Some(c) => c,
            None => return, // already reaped
        },
        Err(_) => return,
    };

    #[cfg(unix)]
    {
        // The child is its own process-group leader (process_group(0) at spawn), so
        // pgid == its pid; the negative pid signals the whole group.
        let pgid = child.id() as i32;
        unsafe {
            libc::kill(-pgid, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(1500);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited cleanly on SIGTERM
                Ok(None) => {}
                Err(_) => break,
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let _ = child.wait(); // reap the zombie
    }

    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

// ─── Resolution helpers ────────────────────────────────────────────────────

/// Find an absolute path to `node`. A Finder-launched app inherits only a
/// minimal PATH (/usr/bin:/bin), so we ask the user's login shell (which loads
/// their nvm/brew/volta/asdf setup) and fall back to common install locations.
fn find_node() -> Option<String> {
    if let Ok(p) = std::env::var("DREAMCONTEXT_NODE") {
        if Path::new(&p).exists() {
            return Some(p);
        }
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(out) = Command::new(&shell).args(["-lc", "command -v node"]).output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && Path::new(&path).exists() {
                return Some(path);
            }
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    [
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
        format!("{home}/.volta/bin/node"),
    ]
    .into_iter()
    .find(|p| Path::new(p).exists())
}

/// Resolve the GLOBALLY-installed dreamcontext CLI entry via the user's login
/// shell (`command -v dreamcontext`), same mechanism as `find_node` — a
/// Finder-launched app has no interactive PATH, so we must ask the login shell
/// which loads nvm/brew/volta. Returns the resolved JS entry path (the bin is a
/// shebang script that `node` can run directly, symlink or not).
///
/// Uses an INTERACTIVE login shell (`-ilc`), not a plain login shell (`-lc`):
/// nvm (and similar) are sourced from `~/.zshrc`, which a non-interactive shell
/// does NOT read. With `-lc` an nvm-installed `dreamcontext` is invisible, so the
/// app silently falls back to its STALE bundled dist (the dashboard never updates).
/// `-ilc` mirrors a real terminal — same fix the capture/chat pipelines already use.
fn find_global_cli() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = Command::new(&shell)
        .args(["-ilc", "command -v dreamcontext"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() || !Path::new(&path).exists() {
        return None;
    }
    Some(path)
}

/// Resolve the dreamcontext CLI entry to run.
///
/// THIN-SHELL MODEL: prefer the GLOBALLY-installed CLI over the bundled copy.
/// The global CLI auto-upgrades (npm), so the dashboard server / routes / all
/// `dist/` logic stay fresh with NO app rebuild — most updates ride the CLI and
/// never touch the .app. The bundled copy is only a first-run fallback for when
/// no global CLI is present yet. Order:
///   1. DREAMCONTEXT_CLI env (explicit dev/test override).
///   2. Global CLI (login-shell `command -v dreamcontext`) — the canonical, auto-updating source.
///   3. Bundled `dist/index.js` resource (fallback until the global CLI is installed).
///   4. Dev `<cwd>/dist/index.js` (running `npm run tauri dev` from the repo).
fn resolve_cli(app: &AppHandle) -> Result<String, String> {
    if let Ok(p) = std::env::var("DREAMCONTEXT_CLI") {
        if Path::new(&p).exists() {
            return Ok(p);
        }
    }
    if let Some(global) = find_global_cli() {
        return Ok(global);
    }
    if let Ok(res) = app.path().resource_dir() {
        let cli = res.join("dist").join("index.js");
        if cli.exists() {
            return Ok(cli.to_string_lossy().into_owned());
        }
    }
    // Dev fallback: <cwd>/dist/index.js (when running `npm run tauri dev` from the repo).
    if let Ok(cwd) = std::env::current_dir() {
        let cli = cwd.join("dist").join("index.js");
        if cli.exists() {
            return Ok(cli.to_string_lossy().into_owned());
        }
    }
    Err("The dreamcontext CLI was not found in the app bundle.\nRebuild the desktop app after `npm run build`.".to_string())
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

fn pick_free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not bind a free port: {e}"))?
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("Could not read assigned port: {e}"))
}

fn poll_health(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{port}")) {
            use std::io::{Read, Write};
            let req = format!("GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n");
            if stream.write_all(req.as_bytes()).is_ok() {
                let mut resp = String::new();
                let _ = stream.read_to_string(&mut resp);
                if resp.starts_with("HTTP/1") && resp.contains("200") {
                    return Ok(());
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "The dashboard server did not become ready within {}s.",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn host_dashboard(app: AppHandle) -> Result<(), String> {
    let node = find_node().ok_or_else(|| {
        "Node.js was not found.\n\nInstall Node 18+ (e.g. `brew install node`) and reopen dreamcontext.".to_string()
    })?;
    let cli = resolve_cli(&app)?;
    let port = pick_free_port()?;

    // Boot the server in LAUNCHER mode — vault-agnostic. Each window pins its
    // own vault via ?vault=<name> → X-Dreamcontext-Vault header.
    let mut cmd = Command::new(&node);
    cmd.args([
        cli.as_str(),
        "dashboard",
        "--port",
        &port.to_string(),
        "--no-open",
        "--launcher",
    ])
        // App-context guard: lets server-side code know it runs INSIDE the
        // desktop app (not a terminal). The dashboard uses this to suppress the
        // "run dreamcontext upgrade" nudge — in-app, updates are the app's job
        // (self-update), not a CLI instruction.
        .env("DREAMCONTEXT_DESKTOP", "1")
        // Our PID so the server can watch our liveness and exit if we die without
        // running the exit handler below (force-quit / crash / dev-rebuild). This
        // is the orphaned-dashboard-server safety net; see `startParentDeathWatch`
        // in src/server/lifecycle.ts.
        .env("DREAMCONTEXT_PARENT_PID", std::process::id().to_string())
        // Where the bundled Sleepy mascot clips live (Resources/sleepy/*.mp4),
        // so the dashboard can serve them for the notch capture bar. Desktop-only
        // (never shipped to npm). Absent → the capture bar simply shows no mascot.
        .envs(
            app.path()
                .resource_dir()
                .ok()
                .map(|d| ("DREAMCONTEXT_SLEEPY_DIR".to_string(), d.join("sleepy").to_string_lossy().into_owned())),
        );
    // Put the server in its OWN process group (it becomes the group leader, so
    // pgid == its pid). On exit we signal the whole group (`kill(-pgid, …)`) so any
    // helper the server itself spawned in-group dies with it, not just the node
    // process. See `reap_server` for the SIGTERM→SIGKILL teardown.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child: Child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start the dashboard server with node:\n  {node}\n\n{e}"))?;

    let child_handle: ChildHandle = Arc::new(Mutex::new(Some(child)));
    // Manage the child so the app-exit hook can kill it (no orphan process).
    app.manage(Arc::clone(&child_handle));
    // Remember the port so the Sleepy panel can be built on first hotkey press.
    app.manage(ServerPort(port));
    app.manage(PanelShown(AtomicBool::new(false)));
    app.manage(PanelCommitted(AtomicBool::new(false)));
    app.manage(PanelEnabled(AtomicBool::new(false)));

    if let Err(e) = poll_health(port, Duration::from_secs(15)) {
        // Tear down the (possibly half-started) child before surfacing the error.
        if let Ok(mut g) = child_handle.lock() {
            if let Some(mut c) = g.take() {
                let _ = c.kill();
            }
        }
        return Err(format!("{e}\n\nNode: {node}"));
    }

    // First window: the Launcher (no vault pinned).
    WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External(
            format!("http://127.0.0.1:{port}/")
                .parse()
                .map_err(|e| format!("Bad URL: {e}"))?,
        ),
    )
    .title("dreamcontext")
    .inner_size(1280.0, 800.0)
    // macOS: transparent title bar so the app's own header IS the title bar and
    // the traffic-light buttons float over it (no stacked double bar).
    .title_bar_style(TitleBarStyle::Overlay)
    .hidden_title(true)
    // Disable Tauri's OS-level drag/drop handler so the webview's own HTML5
    // drag-and-drop (Kanban / Eisenhower task cards) fires. With this left on
    // (the default), the native handler swallows dragover/drop events.
    .disable_drag_drop_handler()
    .build()
    .map_err(|e| format!("Could not create the window: {e}"))?;

    Ok(())
}

// ─── Sleepy notch panel ───────────────────────────────────────────────────────

/// Listen for the JS-emitted events and drive the notch panel. Panel/AppKit work
/// must run on the main thread, so each handler hops there.
///   sleepy:toggle    — hotkey: show (and grab key) if hidden, else hide.
///   sleepy:hide      — Esc / click-away: hide.
///   sleepy:committed — the panel gained focus (user clicked/typed): pin it open
///                      against the hover auto-close.
fn wire_sleepy_panel_bridge(app: &AppHandle) {
    let toggle_handle = app.clone();
    app.listen_any("sleepy:toggle", move |_event| {
        let h = toggle_handle.clone();
        let _ = toggle_handle.run_on_main_thread(move || toggle_sleepy_panel(&h));
    });

    let hide_handle = app.clone();
    app.listen_any("sleepy:hide", move |_event| {
        let h = hide_handle.clone();
        let _ = hide_handle.run_on_main_thread(move || hide_sleepy_panel(&h));
    });

    let commit_handle = app.clone();
    app.listen_any("sleepy:committed", move |_event| {
        if let Some(s) = commit_handle.try_state::<PanelCommitted>() {
            s.0.store(true, Ordering::SeqCst);
        }
    });

    // Settings toggle: the launcher mirrors the persisted `enabled` flag here.
    // Enabling shows the perch; disabling fully closes the notch (perch out + any
    // shown panel hidden). The payload is a JSON bool ("true"/"false").
    let enabled_handle = app.clone();
    app.listen_any("sleepy:enabled", move |event| {
        let enabled = event.payload().trim() == "true";
        let h = enabled_handle.clone();
        let _ = enabled_handle.run_on_main_thread(move || apply_sleepy_enabled(&h, enabled));
    });
}

/// Apply the enabled flag: store it, then either show the perch (enabled) or
/// close the notch entirely (disabled) — order the perch out and hide any shown
/// capture panel so nothing lingers at the notch.
fn apply_sleepy_enabled(app: &AppHandle, enabled: bool) {
    set_enabled(app, enabled);
    if enabled {
        show_perch(app);
    } else {
        if is_shown(app) {
            hide_sleepy_panel(app);
        }
        hide_perch(app);
    }
}

fn set_shown(app: &AppHandle, shown: bool) {
    if let Some(s) = app.try_state::<PanelShown>() {
        s.0.store(shown, Ordering::SeqCst);
    }
}
fn is_shown(app: &AppHandle) -> bool {
    app.try_state::<PanelShown>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(false)
}
fn set_committed(app: &AppHandle, v: bool) {
    if let Some(s) = app.try_state::<PanelCommitted>() {
        s.0.store(v, Ordering::SeqCst);
    }
}
fn set_enabled(app: &AppHandle, v: bool) {
    if let Some(s) = app.try_state::<PanelEnabled>() {
        s.0.store(v, Ordering::SeqCst);
    }
}
fn is_enabled(app: &AppHandle) -> bool {
    app.try_state::<PanelEnabled>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// Show the panel (building it the first time). `take_key` true → it becomes the
/// key window so the user can type immediately (hotkey/click); false → it only
/// orders to front without stealing keyboard focus (hover preview, so an
/// accidental notch brush never hijacks the user's typing).
fn show_sleepy_panel(app: &AppHandle, take_key: bool) {
    let existed = app.get_webview_panel(SLEEPY_LABEL).is_ok();
    if !existed {
        if let Err(e) = build_sleepy_panel(app) {
            eprintln!("[sleepy] panel build failed: {e}");
            return;
        }
    }
    if let Ok(panel) = app.get_webview_panel(SLEEPY_LABEL) {
        position_sleepy(app);
        if take_key {
            // Become key so the user can type immediately (commitment comes from
            // an actual click/keystroke via sleepy:committed, not from this).
            panel.show();
        } else {
            panel.order_front_regardless();
        }
    }
    set_shown(app, true);
    // The full panel covers the perch's spot — tuck the companion away.
    hide_perch(app);
    let _ = app.emit("sleepy:shown", ());
}

/// Hide the panel and reset its open/committed state.
fn hide_sleepy_panel(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(SLEEPY_LABEL) {
        panel.order_out(None);
    }
    set_shown(app, false);
    set_committed(app, false);
    // Bring the always-on companion back.
    show_perch(app);
}

/// Hotkey toggle: hide if visible, else show with key focus.
fn toggle_sleepy_panel(app: &AppHandle) {
    let visible = app
        .get_webview_panel(SLEEPY_LABEL)
        .map(|p| p.is_visible())
        .unwrap_or(false);
    if visible {
        hide_sleepy_panel(app);
    } else {
        show_sleepy_panel(app, true);
    }
}

/// Build the Sleepy webview, swizzle it to a non-activating NSPanel, float it over
/// everything (including the menu bar / over fullscreen apps, on every Space).
/// Built hidden; a show_* path orders it in.
fn build_sleepy_panel(app: &AppHandle) -> Result<(), String> {
    let port = app
        .try_state::<ServerPort>()
        .map(|p| p.0)
        .ok_or_else(|| "server port not ready".to_string())?;
    let url = format!("http://127.0.0.1:{port}/?capture=1");

    let win = WebviewWindowBuilder::new(
        app,
        SLEEPY_LABEL,
        WebviewUrl::External(url.parse().map_err(|e| format!("bad url: {e}"))?),
    )
    .inner_size(SLEEPY_W, SLEEPY_H)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(false)
    .shadow(false)
    // Build hidden + unfocused; a show_* path orders it in as a panel so the app
    // is never activated (showing a plain window would yank dreamcontext forward).
    .visible(false)
    .focused(false)
    .title("dreamcontext capture")
    .build()
    .map_err(|e| format!("window build: {e}"))?;

    let panel = win.to_panel().map_err(|_| "to_panel failed".to_string())?;

    // Borderless + non-activating: can become key without activating the app.
    panel.set_style_mask(NS_NONACTIVATING_PANEL_MASK);
    // Float above the menu bar so the black mass can sit flush under the notch.
    panel.set_level((NSMainMenuWindowLevel + 1) as i32);
    // Visible on every Space and alongside fullscreen apps; don't hide when the
    // app deactivates (it's never active to begin with).
    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary,
    );
    panel.set_hides_on_deactivate(false);
    Ok(())
}

/// Poll the cursor; when it reaches the notch, preview Sleepy (no key steal). When
/// it leaves a hover-opened panel that the user never engaged, auto-close it.
fn spawn_notch_hover_watch(app: &AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let mut hover_opened = false;
        loop {
            thread::sleep(Duration::from_millis(90));
            // Disabled → the notch is closed; hover-to-open must not fire.
            if !is_enabled(&handle) {
                hover_opened = false;
                continue;
            }
            // Current cursor, global top-left points (matches Tauri logical coords).
            let cursor = unsafe {
                let ev = CGEventCreate(std::ptr::null_mut());
                if ev.is_null() {
                    continue;
                }
                let p = CGEventGetLocation(ev);
                CFRelease(ev as *const _);
                p
            };
            let bounds = unsafe { CGDisplayBounds(CGMainDisplayID()) };
            let center_x = bounds.origin.x + bounds.size.width / 2.0;
            let dx = (cursor.x - center_x).abs();
            let at_notch =
                cursor.y <= bounds.origin.y + NOTCH_HOTSPOT_TOP_PX && dx <= NOTCH_HOTSPOT_HALF_W;
            let shown = is_shown(&handle);

            if at_notch && !shown {
                hover_opened = true;
                // Take key focus so the input is ready to type the moment it opens;
                // if the user drifts away without engaging it, the branch below
                // auto-closes it (commit only happens on a real click/keystroke).
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || show_sleepy_panel(&h, true));
            } else if hover_opened && shown {
                let committed = handle
                    .try_state::<PanelCommitted>()
                    .map(|s| s.0.load(Ordering::SeqCst))
                    .unwrap_or(false);
                let left = cursor.y > bounds.origin.y + HOVER_KEEPALIVE_H
                    || dx > SLEEPY_W / 2.0 + 24.0;
                if !committed && left && !at_notch {
                    hover_opened = false;
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || hide_sleepy_panel(&h));
                }
            }
            if !shown {
                hover_opened = false;
            }
        }
    });
}

/// Center the Sleepy window horizontally on the primary display, flush to the top
/// (y = 0) so the black mass hangs straight out of the physical notch.
fn position_sleepy(app: &AppHandle) {
    let Some(win) = app.get_webview_window(SLEEPY_LABEL) else {
        return;
    };
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let scale = monitor.scale_factor();
        let logical_w = monitor.size().width as f64 / scale;
        let x = ((logical_w - SLEEPY_W) / 2.0).max(0.0);
        let _ = win.set_position(LogicalPosition::new(x, 0.0));
    }
    // Re-assert the size in case the build clamped it.
    let _ = win.set_size(LogicalSize::new(SLEEPY_W, SLEEPY_H));
}

// ─── Perch (always-on left-of-notch companion) ────────────────────────────────

/// Build the small, persistent companion panel that sits just left of the notch
/// and shows the animated mascot when the full capture panel is closed.
fn build_perch_panel(app: &AppHandle) {
    let Some(port) = app.try_state::<ServerPort>().map(|p| p.0) else {
        return;
    };
    let url = format!("http://127.0.0.1:{port}/?perch=1");
    let Ok(parsed) = url.parse() else {
        return;
    };
    let perch_h = notch_geom().map(|(_, h)| h).unwrap_or(PERCH_H);
    let Ok(win) = WebviewWindowBuilder::new(app, PERCH_LABEL, WebviewUrl::External(parsed))
        .inner_size(PERCH_W, perch_h)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .title("dreamcontext sleepy")
        .build()
    else {
        return;
    };
    if let Ok(panel) = win.to_panel() {
        panel.set_style_mask(NS_NONACTIVATING_PANEL_MASK);
        panel.set_level((NSMainMenuWindowLevel + 1) as i32);
        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary,
        );
        panel.set_hides_on_deactivate(false);
        position_perch(app);
        // Built hidden: the perch only surfaces once the launcher mirrors an
        // `enabled: true` config via `sleepy:enabled` (Sleepy is opt-in).
    }
}

/// The notch geometry read from real hardware (`NSScreen.auxiliaryTopLeftArea`):
/// `(left_edge_x, notch_height)` in logical points. The left area's width is the
/// notch's left-edge X; its height is the menu-bar/notch height. None on a
/// notchless display.
fn notch_geom() -> Option<(f64, f64)> {
    use tauri_nspanel::cocoa::base::{id, nil};
    use tauri_nspanel::cocoa::foundation::NSRect;
    use tauri_nspanel::objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let screen: id = msg_send![class!(NSScreen), mainScreen];
        if screen == nil {
            return None;
        }
        let aux: NSRect = msg_send![screen, auxiliaryTopLeftArea];
        if aux.size.width > 1.0 && aux.size.height > 1.0 {
            Some((aux.size.width, aux.size.height))
        } else {
            None
        }
    }
}

/// Butt the perch's right edge against the notch's left edge (slight overlap so
/// the two blacks read as one shape), flush to the very top, and sized to exactly
/// the notch height so it doesn't hang below the menu bar.
fn position_perch(app: &AppHandle) {
    let Some(win) = app.get_webview_window(PERCH_LABEL) else {
        return;
    };
    let (x, h) = if let Some((notch_left, notch_h)) = notch_geom() {
        (notch_left - PERCH_W + 10.0, notch_h)
    } else if let Ok(Some(monitor)) = win.primary_monitor() {
        let logical_w = monitor.size().width as f64 / monitor.scale_factor();
        (logical_w / 2.0 - NOTCH_HALF_W - PERCH_W + 22.0, PERCH_H)
    } else {
        return;
    };
    let _ = win.set_position(LogicalPosition::new(x.max(0.0), 0.0));
    let _ = win.set_size(LogicalSize::new(PERCH_W, h));
}

fn show_perch(app: &AppHandle) {
    // Never resurface the notch while Sleepy is disabled (e.g. hide_sleepy_panel
    // calls this to restore the companion after the capture panel closes).
    if !is_enabled(app) {
        return;
    }
    if let Ok(panel) = app.get_webview_panel(PERCH_LABEL) {
        panel.order_front_regardless();
    }
}
fn hide_perch(app: &AppHandle) {
    if let Ok(panel) = app.get_webview_panel(PERCH_LABEL) {
        panel.order_out(None);
    }
}

// ─── Error window (instead of crashing) ───────────────────────────────────────

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn show_error_window(app: &AppHandle, msg: &str) {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>dreamcontext</title>\
<style>:root{{color-scheme:dark}}body{{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;\
background:#16121f;color:#ece9f1;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}}\
.card{{max-width:580px;padding:40px}}h1{{font-size:18px;margin:0 0 14px;font-weight:600}}\
pre{{white-space:pre-wrap;background:#241c33;padding:18px 20px;border-radius:12px;color:#d6c2f5;\
font-size:13px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}</style></head>\
<body><div class=\"card\"><h1>dreamcontext couldn't start</h1><pre>{}</pre></div></body></html>",
        html_escape(msg)
    );
    let path = std::env::temp_dir().join("dreamcontext-error.html");
    if std::fs::write(&path, html).is_ok() {
        let url = format!("file://{}", path.to_string_lossy());
        if let Ok(parsed) = url.parse() {
            let _ = WebviewWindowBuilder::new(app, "error", WebviewUrl::External(parsed))
                .title("dreamcontext")
                .inner_size(660.0, 460.0)
                .build();
        }
    }
}
