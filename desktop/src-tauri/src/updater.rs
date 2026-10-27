//! In-app updates. A Developer ID release installed from the DMG has no CLI behind it, so
//! the app keeps itself current: it reads `latest.json` from the latest GitHub release,
//! verifies the update's minisign signature against the pubkey in tauri.conf.json, and
//! replaces the bundle on disk. The running app is never restarted under the user; the new
//! version starts the next time they open it, and a banner says so.
//!
//! Windows cannot replace a running exe: tauri's install starts the NSIS installer and ends
//! the process on the spot. So on Windows the update is only downloaded and verified in the
//! background, then parked, and the installer runs when the user quits the app
//! (`install_parked_on_exit`, from lib.rs on `RunEvent::Exit`). It does not reopen the app.
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
pub(crate) fn compiled_in() -> bool {
    option_env!("DREAMCONTEXT_UPDATER") == Some("1")
}

fn home_dir() -> Option<PathBuf> {
    // Windows names the home folder USERPROFILE; HOME is only set by shells like Git Bash.
    #[cfg(windows)]
    return crate::node_runtime::home_dir();
    #[cfg(not(windows))]
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Mac mode (src/lib/handsfree/mac/session.ts `MacState`) keeps
/// `~/.dreamcontext/handsfree-mac/state.json` with `on: true` and the desktop server's
/// `serverPid` while a phone drives this Mac through the tunnel, and removes it on Return. No
/// update lands under a live session. A crash leaves `on: true` behind until the next server
/// boot repairs it, so a state whose server is provably gone (`kill(pid, 0)` says ESRCH) does
/// not hold the update: no phone drives a Mac through a server that is dead. Everything else
/// fails CLOSED and blocks it: a state file that exists but cannot be read or is not a JSON
/// object, `on: true` without a positive integer `serverPid` (nothing proves it stale), and a
/// pid that answers, even one reused by another process since (the next boot clears that).
fn mac_mode_allows_update(home: &Path) -> bool {
    let file = home.join(".dreamcontext").join("handsfree-mac").join("state.json");
    let raw = match std::fs::read_to_string(&file) {
        Ok(raw) => raw,
        Err(_) => return !file.exists(),
    };
    let state = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(state)) => state,
        _ => return false,
    };
    if state.get("on").and_then(|on| on.as_bool()) != Some(true) {
        return true;
    }
    // 0 and negatives are never asked: kill(0, …) is our process group, kill(-1, …) every process.
    let server_pid = state
        .get("serverPid")
        .and_then(|p| p.as_u64())
        .and_then(|p| i32::try_from(p).ok())
        .filter(|p| *p > 0);
    match server_pid {
        Some(pid) => !pid_alive(pid),
        None => false,
    }
}

/// True unless the process is provably gone. Signal 0 sends nothing, it only checks; EPERM
/// means the process exists under another user, so only ESRCH means dead.
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return true;
    }
    // SAFETY: kill with signal 0 delivers no signal; it reads no memory of ours.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

/// No liveness probe off unix: assume the server is alive, so the update stays held.
#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    true
}

/// The marker `dreamcontext app auto-update off` writes (src/cli/commands/app.ts). A
/// Finder-launched app never sees the variables a shell exports, so this file is the opt-out
/// it can honour.
const AUTO_UPDATE_OFF_MARKER: &str = "app-auto-update-off";

fn persisted_opt_out(home: &Path) -> bool {
    home.join(".dreamcontext").join(AUTO_UPDATE_OFF_MARKER).exists()
}

/// The same opt-outs the CLI's background app update honours: the persisted one, and the
/// variables for an app started from a shell.
fn opted_out(home: Option<&Path>) -> bool {
    let off = |k: &str| std::env::var(k).map(|v| v == "0").unwrap_or(false);
    off("DREAMCONTEXT_APP_AUTO_UPDATE") || off("DREAMCONTEXT_VERSION_CHECK") || home.is_some_and(persisted_opt_out)
}

/// Start the background check loop. A no-op in any build CI did not mark.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !compiled_in() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            // Asked every round: the opt-out and Mac mode both change while the app stays open.
            let home = home_dir();
            let opted = opted_out(home.as_deref());
            let mac_mode_ok = home.as_deref().map_or(true, mac_mode_allows_update);
            let allowed = !opted && mac_mode_ok;
            if opted {
                crate::applog::log("[updater] skipped: app auto-update is turned off");
            } else if !mac_mode_ok {
                crate::applog::log("[updater] held: Mac mode is on");
            }
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
            Ok(None) => {
                crate::applog::log(&format!("[updater] checked: {} is the latest", app.package_info().version));
                return false;
            }
            Err(e) => {
                crate::applog::log(&format!("[updater] check failed: {e}"));
                return false;
            }
        },
        Err(e) => {
            crate::applog::log(&format!("[updater] unavailable: {e}"));
            return false;
        }
    };
    let version = update.version.clone();
    crate::applog::log(&format!("[updater] {version} is available; downloading"));
    #[cfg(not(windows))]
    {
        if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
            crate::applog::log(&format!("[updater] {version} failed to install: {e}"));
            return false;
        }
        crate::applog::log(&format!("[updater] {version} installed; it starts on the next launch"));
        let _ = app
            .notification()
            .builder()
            .title(format!("dreamcontext-beta {version} is ready"))
            .body("Quit and reopen the app to start the new version.")
            .show();
    }
    #[cfg(windows)]
    {
        // `download` verifies the minisign signature; only a verified installer is parked.
        let bytes = match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => bytes,
            Err(e) => {
                crate::applog::log(&format!("[updater] {version} failed to download: {e}"));
                return false;
            }
        };
        match PARKED.lock() {
            Ok(mut parked) => *parked = Some((update, bytes)),
            Err(_) => return false,
        }
        crate::applog::log(&format!("[updater] {version} downloaded; it installs when the app quits"));
        let _ = app
            .notification()
            .builder()
            .title(format!("dreamcontext-beta {version} is ready"))
            .body("It installs when you quit the app; reopen it to start the new version.")
            .show();
    }
    true
}

/// Windows: the verified installer `check_and_install` downloaded, waiting for the user to quit.
#[cfg(windows)]
static PARKED: std::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>> = std::sync::Mutex::new(None);

/// Windows: this exit is an `AppHandle::restart()` (lib.rs sees its ExitRequested first).
#[cfg(windows)]
static RESTARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Remember that the app is restarting, not quitting, so a parked install reopens it.
pub fn note_restart() {
    #[cfg(windows)]
    RESTARTING.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Windows: run the parked installer now that the app is quitting. tauri starts it (passive:
/// a progress bar, no wizard; per-user, so no UAC) and ends this process before tauri's own
/// restart step. A quit stays a quit (`restart_after_install(false)`: the installer does not
/// reopen the app the user just closed); a restart is carried out by the installer instead.
/// Called after the dashboard server is reaped. A no-op when nothing is parked, and off Windows.
pub fn install_parked_on_exit() {
    #[cfg(windows)]
    {
        let parked = PARKED.lock().ok().and_then(|mut parked| parked.take());
        if let Some((update, bytes)) = parked {
            let version = update.version.clone();
            let reopen = RESTARTING.load(std::sync::atomic::Ordering::Relaxed);
            if let Err(e) = update.restart_after_install(reopen).install(bytes) {
                crate::applog::log(&format!("[updater] {version} failed to start its installer: {e}"));
            }
        }
    }
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
        // A live server: this test process.
        let me = std::process::id();
        mac_state(&h, &format!(r#"{{"on":true,"serverPid":{me},"url":"https://orbit.example"}}"#));
        assert!(!mac_mode_allows_update(&h));
        // A process of another user (launchd as root): EPERM still means alive.
        mac_state(&h, r#"{"on":true,"serverPid":1}"#);
        assert!(!mac_mode_allows_update(&h));
    }

    #[cfg(unix)]
    #[test]
    fn mac_mode_left_on_by_a_dead_server_allows_it() {
        let h = home("dead");
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap(); // reaped: kill(pid, 0) now says ESRCH
        mac_state(&h, &format!(r#"{{"on":true,"serverPid":{pid},"url":"https://orbit.example"}}"#));
        assert!(mac_mode_allows_update(&h));
    }

    #[test]
    fn mac_mode_on_without_a_provable_server_pid_fails_closed() {
        let h = home("nopid");
        for raw in [
            r#"{"on":true}"#,
            r#"{"on":true,"serverPid":null}"#,
            r#"{"on":true,"serverPid":"4242"}"#,
            r#"{"on":true,"serverPid":0}"#,
            r#"{"on":true,"serverPid":-1}"#,
            r#"{"on":true,"serverPid":4242.5}"#,
            r#"{"on":true,"serverPid":4294967296}"#,
        ] {
            mac_state(&h, raw);
            assert!(!mac_mode_allows_update(&h), "{raw} must block the update");
        }
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

    #[test]
    fn the_cli_marker_opts_out() {
        let h = home("optout");
        assert!(!persisted_opt_out(&h));
        std::fs::write(h.join(".dreamcontext").join(AUTO_UPDATE_OFF_MARKER), "").unwrap();
        assert!(persisted_opt_out(&h));
    }
}
