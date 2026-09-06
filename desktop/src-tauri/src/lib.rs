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
//    Rust commands reach the remote-served (loopback) pages only when a
//    permission in permissions/ names them AND a capability grants it — see
//    `pick_paths` / permissions/pick-paths.toml. Anything ungranted is blocked.
// 6. Kill the Node child on APP EXIT (not per-window) so no orphan survives.
//
// CRASH-SAFETY: any startup failure shows an explanatory error window instead
// of panicking — a Finder double-click must never silently abort.

use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, RunEvent, TitleBarStyle,
    WebviewUrl, WebviewWindowBuilder,
};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::{msg_send, ClassType};
use objc2_app_kit::{
    NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponse, NSModalResponseOK,
    NSOpenPanel, NSWindow,
};
use objc2_foundation::{NSArray, NSString, NSURL};

// ─── Shared state ────────────────────────────────────────────────────────────

/// The Node child process, kept so it can be killed on app exit.
type ChildHandle = Arc<Mutex<Option<Child>>>;

// ─── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // The native file/folder picker is OUR command (`pick_paths`), not
        // tauri-plugin-dialog. The plugin's rfd backend aborts the whole app when
        // AppKit returns a nil open panel — see the `pick_paths` doc comment.
        // `confirm_dialog` is here for the same reason: WKWebView has no
        // `window.confirm`, so a native sheet is the only working confirmation.
        .invoke_handler(tauri::generate_handler![pick_paths, confirm_dialog])
        // Native OS clipboard so the dashboard can write UTF-8 without the WKWebView JS
        // clipboard mangling non-ASCII as Mac Roman (issue #171). Used by the in-app agent
        // terminal's copy path via @tauri-apps/plugin-clipboard-manager on the loopback origin.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Native notification banners. Registering the plugin is what injects the
        // `window.Notification` polyfill into the webview — WKWebView ships none — so
        // the dashboard's "Claude is asking" alarm has something to call. Sent from JS
        // via the permitted API (see the capability), so no custom command is needed.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Never abort on a startup problem — surface it in a window.
            match host_dashboard(app.handle().clone()) {
                Err(msg) => show_error_window(app.handle(), &msg),
                Ok(()) => {}
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

// ─── Native file / folder picker ──────────────────────────────────────────────

/// Shown when AppKit refuses to hand us an open panel. Deliberately actionable:
/// the picker is retryable, so the user's next click usually works.
const PANEL_UNAVAILABLE: &str =
    "macOS did not return a file picker. Try again — if it keeps failing, restart dreamcontext.";

/// `+[NSOpenPanel openPanel]`, WITHOUT objc2's non-null assertion.
///
/// objc2-app-kit types this as `-> Retained<NSOpenPanel>` (non-null), so its
/// generated binding panics on nil. AppKit *does* return nil in the wild — the
/// open/save panel is backed by a helper service, and a long-lived process
/// (ours survives days of sleep/wake) can find it unavailable. Because the
/// release profile builds with `panic = "abort"`, and the panic fires deep
/// inside a CFRunLoop observer callback where nothing could catch it anyway,
/// that nil used to abort the whole app the moment the user picked a file.
/// Typing the return as `Option` turns it back into an ordinary failure.
fn open_panel() -> Option<Retained<NSOpenPanel>> {
    unsafe { msg_send![NSOpenPanel::class(), openPanel] }
}

/// A fresh `NSAlert`, typed as `Option` for the same reason `open_panel` is:
/// AppKit constructors are bound as non-null, and a nil here would abort the
/// whole app under `panic = "abort"` rather than fail the one dialog.
fn new_alert() -> Option<Retained<NSAlert>> {
    unsafe { msg_send![NSAlert::class(), new] }
}

/// The panel's selected URLs as absolute paths. `-URLs` carries the same non-null
/// typing as `openPanel`, so it gets the same guard rather than a second abort.
fn panel_paths(panel: &NSOpenPanel) -> Vec<String> {
    let urls: Option<Retained<NSArray<NSURL>>> = unsafe { msg_send![panel, URLs] };
    let Some(urls) = urls else {
        return Vec::new();
    };
    urls.iter()
        .filter_map(|url| url.path().map(|p| p.to_string()))
        .collect()
}

/// Open the native macOS picker and resolve to the chosen absolute paths.
///
/// `directory` picks folders instead of files; `multiple` allows a multi-select.
/// Cancelling resolves to an empty list — only a genuine failure to present the
/// panel is an `Err`, so callers can tell "user said no" from "picker broke".
///
/// Presented as a SHEET on the window that asked for it, which is both what the
/// dialog plugin did (rfd attaches to `mainWindow`) and more precise: with
/// several vault windows open, "the main window" is a
/// guess, whereas the invoking window is not. Sheets keep the rest of the app
/// live, so this never blocks the main thread the way `runModal` would.
#[tauri::command]
async fn pick_paths(
    window: tauri::WebviewWindow,
    directory: bool,
    multiple: bool,
) -> Result<Vec<String>, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<Vec<String>, String>>(1);

    // All AppKit work — building the panel AND the completion block that reads it
    // back — happens on the main thread; nothing here crosses a thread boundary.
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let Some(panel) = open_panel() else {
            let _ = tx.try_send(Err(PANEL_UNAVAILABLE.to_string()));
            return;
        };
        panel.setCanChooseFiles(!directory);
        panel.setCanChooseDirectories(directory);
        panel.setAllowsMultipleSelection(multiple);
        panel.setResolvesAliases(true);

        let finished = panel.clone();
        let handler = RcBlock::new(move |response: NSModalResponse| {
            let paths = if response == NSModalResponseOK {
                panel_paths(&finished)
            } else {
                Vec::new() // cancelled, or the panel failed to display
            };
            // Capacity-1 channel with exactly one send — `try_send` so a wedged
            // receiver can never block the main thread.
            let _ = tx.try_send(Ok(paths));
        });

        // SAFETY: `ns_window` hands back this window's live NSWindow, and we
        // are on the main thread, so borrowing it for the call is sound.
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                let parent: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                panel.beginSheetModalForWindow_completionHandler(parent, &handler);
            }
            // No host window to hang a sheet on (shouldn't happen, but a
            // free-floating panel beats swallowing the user's click).
            _ => panel.beginWithCompletionHandler(&handler),
        }
    })
    .map_err(|e| format!("Could not reach the main thread to open the picker: {e}"))?;

    rx.recv()
        .await
        .unwrap_or_else(|| Err("The file picker closed without an answer.".to_string()))
}

/// Present a native confirmation sheet and resolve to what the user chose.
///
/// WHY THIS EXISTS: `window.confirm()` does not work in this app AT ALL, and it
/// fails silently. wry's `WKUIDelegate` implements exactly three methods — the
/// file-upload panel, the media-capture prompt, and `window.open` — and none of
/// the JavaScript panel methods. WebKit's contract is that a delegate without
/// `runJavaScriptConfirmPanelWithMessage:` shows NO dialog and returns `false`,
/// so every `if (!window.confirm(…)) return;` in the dashboard is a dead button
/// in the desktop app while working perfectly in a browser tab. Tauri injects no
/// shim either. Same class as the missing `Notification` (polyfilled by the
/// notification plugin) and the clipboard that re-decodes UTF-8 as Mac Roman: a
/// web API this webview simply does not have, which has to be supplied natively.
///
/// Presented as a SHEET on the invoking window, like `pick_paths`, so it never
/// blocks the main thread the way `runModal` would, and so it hangs off the
/// window that actually asked rather than a guessed "main" one.
///
/// The first button added is the default and returns `NSAlertFirstButtonReturn`,
/// so `confirm` is added before `cancel`. Cancelling — by button, by Escape, or
/// because the sheet could not be presented — is `false`: a confirmation that
/// cannot be shown must never read as consent.
#[tauri::command]
async fn confirm_dialog(
    window: tauri::WebviewWindow,
    title: String,
    body: Option<String>,
    confirm_label: Option<String>,
    cancel_label: Option<String>,
    destructive: Option<bool>,
) -> Result<bool, String> {
    let (tx, mut rx) = tauri::async_runtime::channel::<Result<bool, String>>(1);

    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let Some(alert) = new_alert() else {
            let _ = tx.try_send(Err("Could not present the confirmation.".to_string()));
            return;
        };
        alert.setMessageText(&NSString::from_str(&title));
        if let Some(text) = body.as_deref().filter(|t| !t.is_empty()) {
            alert.setInformativeText(&NSString::from_str(text));
        }
        alert.setAlertStyle(if destructive.unwrap_or(false) {
            NSAlertStyle::Critical
        } else {
            NSAlertStyle::Warning
        });
        alert.addButtonWithTitle(&NSString::from_str(
            confirm_label.as_deref().unwrap_or("OK"),
        ));
        alert.addButtonWithTitle(&NSString::from_str(
            cancel_label.as_deref().unwrap_or("Cancel"),
        ));

        // Cloned because the no-window fallback below answers on the same
        // channel, and the block has to own its sender.
        let block_tx = tx.clone();
        let handler = RcBlock::new(move |response: NSModalResponse| {
            let _ = block_tx.try_send(Ok(response == NSAlertFirstButtonReturn));
        });

        // SAFETY: `ns_window` hands back this window's live NSWindow, and we are
        // on the main thread, so borrowing it for the call is sound.
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                let parent: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                alert.beginSheetModalForWindow_completionHandler(parent, Some(&handler));
            }
            // No host window to hang a sheet on. `runModal` is app-modal and
            // blocking, but we are already on the main thread with nothing to
            // return to, and a swallowed click is worse than a modal one.
            _ => {
                let _ = tx.try_send(Ok(alert.runModal() == NSAlertFirstButtonReturn));
            }
        }
    })
    .map_err(|e| format!("Could not reach the main thread to confirm: {e}"))?;

    rx.recv()
        .await
        .unwrap_or_else(|| Err("The confirmation closed without an answer.".to_string()))
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
    // Fast path: the path resolved on a previous launch. The interactive login shell
    // below costs ~1s of a cold zshrc (nvm etc.) BEFORE any window exists, and the
    // answer is stable across launches (npm upgrades keep the same bin symlink). A
    // cached path that no longer exists (node version switch, uninstall) falls
    // through to the shell and is rewritten.
    if let Some(cached) = read_cli_path_cache() {
        if Path::new(&cached).exists() {
            return Some(cached);
        }
    }
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
    write_cli_path_cache(&path);
    Some(path)
}

/// `~/.dreamcontext/desktop-cli-path` — one line, the last shell-resolved CLI path.
fn cli_path_cache_file() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    if home.is_empty() {
        return None;
    }
    Some(Path::new(&home).join(".dreamcontext").join("desktop-cli-path"))
}

fn read_cli_path_cache() -> Option<String> {
    let file = cli_path_cache_file()?;
    let raw = std::fs::read_to_string(file).ok()?;
    let line = raw.lines().next()?.trim();
    if line.is_empty() {
        return None;
    }
    Some(line.to_string())
}

fn write_cli_path_cache(path: &str) {
    if let Some(file) = cli_path_cache_file() {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, format!("{path}\n"));
    }
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
        // Where the bundled Sleepy mascot clips live (Resources/sleepy/*.mp4), so
        // the dashboard can serve them for the Sleep page and the debt tracker.
        // Desktop-only (never shipped to npm). Absent → those surfaces draw no mascot.
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
