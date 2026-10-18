//! In-app updates. A Developer ID release installed from the DMG has no CLI behind it, so
//! the app keeps itself current: it reads `latest.json` from the latest GitHub release,
//! verifies the update's minisign signature against the pubkey in tauri.conf.json, and
//! replaces the bundle on disk. The running app is never restarted under the user; the new
//! version starts the next time they open it, and a banner says so.
//!
//! Identity is why this is safe for macOS permissions: every release carries the same
//! Developer ID requirement (`anchor apple generic` + the team), so an update is the same
//! app to TCC and keeps its file, microphone and automation grants.

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// First check after launch: late enough that the server and windows are up first.
const FIRST_CHECK: Duration = Duration::from_secs(60);
/// Then every six hours for an app that stays open for days.
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Only a CI release build updates itself: the workflow compiles with
/// `DREAMCONTEXT_UPDATER=1`. A local build would otherwise replace itself with the published
/// release the first time it checked.
fn compiled_in() -> bool {
    option_env!("DREAMCONTEXT_UPDATER") == Some("1")
}

/// The hands-free trip state (src/lib/handsfree/trip-state.ts). While the laptop is not
/// `home`, the cloud machine runs this laptop's exact build, so nothing may update it. Fails
/// CLOSED like the CLI does: a state file that exists but cannot be read blocks the update.
fn handsfree_home() -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return true };
    let file = home.join(".dreamcontext").join("handsfree").join("state.json");
    let Ok(raw) = std::fs::read_to_string(&file) else { return !file.exists() };
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|v| v.get("phase").and_then(|p| p.as_str()).map(|p| p == "home"))
        .unwrap_or(false)
}

/// The same opt-out the CLI's background app update honours.
fn opted_out() -> bool {
    let off = |k: &str| std::env::var(k).map(|v| v == "0").unwrap_or(false);
    off("DREAMCONTEXT_APP_AUTO_UPDATE") || off("DREAMCONTEXT_VERSION_CHECK")
}

/// Start the background check loop. A no-op in any build CI did not mark.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !compiled_in() || opted_out() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            // Once a new bundle is on disk, checking again would fetch it a second time:
            // this process still reports the old version until it is reopened.
            if handsfree_home() && check_and_install(&app).await {
                return;
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// True when a newer version was downloaded and installed over the bundle on disk.
async fn check_and_install<R: Runtime>(app: &AppHandle<R>) -> bool {
    let update = match app.updater().map_err(|e| e.to_string()) {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => return false,
            Err(e) => {
                eprintln!("[updater] check failed: {e}");
                return false;
            }
        },
        Err(e) => {
            eprintln!("[updater] unavailable: {e}");
            return false;
        }
    };
    let version = update.version.clone();
    if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
        eprintln!("[updater] {version} failed to install: {e}");
        return false;
    }
    eprintln!("[updater] {version} installed; it starts on the next launch");
    let _ = app
        .notification()
        .builder()
        .title(format!("dreamcontext-beta {version} is ready"))
        .body("Quit and reopen the app to start the new version.")
        .show();
    true
}
