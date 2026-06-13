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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

// ─── Shared state ────────────────────────────────────────────────────────────

/// The Node child process, kept so it can be killed on app exit.
type ChildHandle = Arc<Mutex<Option<Child>>>;

// ─── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Never abort on a startup problem — surface it in a window.
            if let Err(msg) = host_dashboard(app.handle().clone()) {
                show_error_window(app.handle(), &msg);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("dreamcontext desktop failed to start");

    app.run(|app_handle, event| {
        // Kill the Node child on app exit so no orphan process survives.
        if let RunEvent::ExitRequested { .. } = event {
            if let Some(handle) = app_handle.try_state::<ChildHandle>() {
                if let Ok(mut guard) = handle.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
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

/// Resolve the dreamcontext CLI entry (`dist/index.js`): an explicit override,
/// the bundled copy in the app's resources, or the repo's dist/ in dev.
fn resolve_cli(app: &AppHandle) -> Result<String, String> {
    if let Ok(p) = std::env::var("DREAMCONTEXT_CLI") {
        if Path::new(&p).exists() {
            return Ok(p);
        }
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
    let child: Child = Command::new(&node)
        .args([
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
