//! In-app updates. A Developer ID release installed from the DMG has no CLI behind it, so
//! the app keeps itself current: it reads `latest.json` from the latest GitHub release,
//! verifies the update's minisign signature against the pubkey in tauri.conf.json, and
//! replaces the bundle on disk. The running app is never restarted under the user; the new
//! version starts the next time they open it, and a banner says so.
//!
//! Identity is why this is safe for macOS permissions: every release carries the same
//! Developer ID requirement (`anchor apple generic` + the team), so an update is the same
//! app to TCC and keeps its file, microphone and automation grants.

use std::path::{Path, PathBuf};
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

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Mac mode (src/lib/handsfree/mac/session.ts) keeps `~/.dreamcontext/handsfree-mac/state.json`
/// with `on: true` while a phone drives this Mac through the tunnel, and removes it on Return
/// (the next boot repairs a crashed run's file). No update lands under a live session. Fails
/// CLOSED: a state file that exists but cannot be read, or is not a JSON object, blocks it.
fn mac_mode_allows_update(home: &Path) -> bool {
    let file = home.join(".dreamcontext").join("handsfree-mac").join("state.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return !file.exists(),
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(state)) => state.get("on").and_then(|on| on.as_bool()) != Some(true),
        _ => false,
    }
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
            // Asked every round: Mac mode starts and ends while the app stays open.
            let allowed = home_dir().as_deref().map_or(true, mac_mode_allows_update);
            // Once a new bundle is on disk, checking again would fetch it a second time:
            // this process still reports the old version until it is reopened.
            if allowed && check_and_install(&app).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dc-updater-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".dreamcontext").join("handsfree-mac")).unwrap();
        dir
    }

    fn mac_state(home: &Path, raw: &str) {
        std::fs::write(home.join(".dreamcontext").join("handsfree-mac").join("state.json"), raw).unwrap();
    }

    #[test]
    fn mac_mode_on_blocks_the_update() {
        let h = home("on");
        mac_state(&h, r#"{"on":true,"serverPid":4242,"url":"https://orbit.example"}"#);
        assert!(!mac_mode_allows_update(&h));
    }

    #[test]
    fn no_mac_state_or_mac_mode_off_allows_it() {
        let h = home("off");
        assert!(mac_mode_allows_update(&h));
        mac_state(&h, r#"{"on":false,"serverPid":4242}"#);
        assert!(mac_mode_allows_update(&h));
    }

    #[test]
    fn an_unreadable_mac_state_fails_closed() {
        let h = home("bad");
        mac_state(&h, "{\"on\": tr");
        assert!(!mac_mode_allows_update(&h));
        mac_state(&h, "[]");
        assert!(!mac_mode_allows_update(&h));
        std::fs::remove_file(h.join(".dreamcontext").join("handsfree-mac").join("state.json")).unwrap();
        std::fs::create_dir(h.join(".dreamcontext").join("handsfree-mac").join("state.json")).unwrap();
        assert!(!mac_mode_allows_update(&h));
    }

    #[test]
    fn the_retired_cloud_trip_state_no_longer_decides() {
        let h = home("cloud");
        std::fs::create_dir_all(h.join(".dreamcontext").join("handsfree")).unwrap();
        std::fs::write(h.join(".dreamcontext").join("handsfree").join("state.json"), r#"{"phase":"away"}"#).unwrap();
        assert!(mac_mode_allows_update(&h));
    }
}
