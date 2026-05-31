// dreamcontext desktop shell — lib.rs
//
// Architecture (v0.6.0, first cut):
//
// 1. Pick a free loopback port via TcpListener::bind("127.0.0.1:0").
// 2. Spawn `node <DREAMCONTEXT_CLI> dashboard --port <port> --no-open --vault <DREAMCONTEXT_VAULT>`
//    using tauri-plugin-shell. Both env vars have dev-mode defaults.
// 3. Poll GET /api/health until 200 (≤10 s) — fail loudly on timeout.
// 4. Open a native WebviewWindow pointing at http://127.0.0.1:<port>.
// 5. Kill the Node child when the window is destroyed / app exits.
//
// DOCUMENTED SHORTCUTS (follow-up tasks, not forgotten):
// - Node is a runtime prerequisite. A packaged sidecar (`bundle.externalBin`)
//   is the v1 path; the commented code below is the upgrade stub.
// - Vault is set via DREAMCONTEXT_VAULT env var. A native vault-picker reading
//   ~/.dreamcontext/vaults.json is planned for a later slice.
// - CSP is null for first cut (own loopback content). Hardening is a TODO.

use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Listener, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;

// ─── Entry point ─────────────────────────────────────────────────────────────

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Wire the updater plugin only on desktop targets.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            host_dashboard(app.handle().clone())?;
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("dreamcontext desktop failed to start");
}

// ─── Dashboard host ──────────────────────────────────────────────────────────

fn pick_free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Could not bind to a free port: {e}"))?
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("Could not read assigned port: {e}"))
}

fn poll_health(port: u16, timeout: Duration) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + timeout;
    loop {
        // A simple blocking HTTP GET using only std (avoids pulling reqwest for
        // this one-off readiness check). For v1, replace with reqwest / ureq.
        match std::net::TcpStream::connect(format!("127.0.0.1:{port}")) {
            Ok(mut stream) => {
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
            Err(_) => {}
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "Dashboard server at {url} did not become healthy within {}s",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn host_dashboard(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve configuration from environment variables (with dev-mode defaults).
    let cli_path = std::env::var("DREAMCONTEXT_CLI").unwrap_or_else(|_| {
        // Dev default: repo-relative dist/index.js (works when running `npm run tauri dev`
        // from inside the repo). Production builds must always set DREAMCONTEXT_CLI.
        let mut p = std::env::current_dir().unwrap_or_default();
        p.push("dist");
        p.push("index.js");
        p.to_string_lossy().into_owned()
    });

    let vault_path = std::env::var("DREAMCONTEXT_VAULT").unwrap_or_else(|_| {
        // Dev default: the repo root (must contain _dream_context/).
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });

    // Pick a free port (TOCTOU accepted for single-user desktop use).
    let port = pick_free_port()?;

    // Spawn the Node dashboard server via tauri-plugin-shell (shell:allow-spawn
    // capability scopes this to `node`).
    //
    // SIDECAR UPGRADE PATH (commented out — configure bundle.externalBin in tauri.conf.json
    // and set the sidecar path to the bundled Node binary for a self-contained app):
    // let (_rx, child) = app.shell().sidecar("node")?.args([...]).spawn()?;

    let (_rx, child) = app
        .shell()
        .command("node")
        .args([
            &cli_path,
            "dashboard",
            "--port",
            &port.to_string(),
            "--no-open",
            "--vault",
            &vault_path,
        ])
        .spawn()
        .map_err(|e| format!("Failed to spawn Node dashboard: {e}"))?;

    // Store the child handle so we can kill it when the window closes.
    let child_handle = Arc::new(Mutex::new(Some(child)));

    // Poll until the dashboard is ready (fail loudly — no silent errors).
    poll_health(port, Duration::from_secs(10)).map_err(|e| {
        format!("{e}\n\nMake sure Node.js is installed and DREAMCONTEXT_CLI is set.")
    })?;

    // Create the native webview window pointing at the running dashboard.
    let window_url = format!("http://127.0.0.1:{port}");
    let _window = WebviewWindowBuilder::new(
        &app,
        "main",
        WebviewUrl::External(window_url.parse()?),
    )
    .title("dreamcontext")
    .inner_size(1280.0, 800.0)
    .build()?;

    // Kill the Node child when the window is destroyed.
    let kill_on_destroy = Arc::clone(&child_handle);
    app.listen("main:destroyed", move |_| {
        if let Ok(mut guard) = kill_on_destroy.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    });

    Ok(())
}
