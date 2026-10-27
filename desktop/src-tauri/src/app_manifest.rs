// macOS: `~/.dreamcontext/app.json` is written on every launch, the Mac counterpart of the
// Windows write in src/win.rs (same `AppManifest` shape, src/cli/commands/app.ts).
//
// Only `dreamcontext app install` used to write it, so an app dragged out of the DMG had none:
// `POST /api/launcher/relaunch` answered `app_not_installed`, the auto-relaunch after a CLI
// upgrade failed ("quit and reopen dreamcontext to finish updating"), and the CLI could not tell
// that the desktop app owns the dashboard. The running bundle is the truth, so it records itself.

use std::path::{Path, PathBuf};

/// The `.app` an executable in `<X>.app/Contents/MacOS/` belongs to. None for anything else
/// (`tauri dev` runs a bare binary from target/).
pub(crate) fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let app = contents.parent()?;
    if app.extension()? != "app" {
        return None;
    }
    Some(app.to_path_buf())
}

/// A path macOS hands out for one run only: the mounted DMG, or a quarantined app's randomised
/// App Translocation copy. Recording it would make the next relaunch open a path that is gone.
pub(crate) fn is_ephemeral(app: &Path) -> bool {
    let s = app.to_string_lossy();
    s.starts_with("/Volumes/") || s.contains("/AppTranslocation/")
}

/// Is `app` where an install lives: `/Applications` or `~/Applications` (the DMG's drag target and
/// `dreamcontext app install`'s default)? A bundle launched from a build folder or a worktree is
/// not: recording it would point the relaunch at that build and make the CLI treat a release
/// install as a local one (no in-app updates → a second updater downloading over it).
pub(crate) fn is_install_location(app: &Path, home: &Path) -> bool {
    let parent = app.parent();
    parent == Some(Path::new("/Applications")) || parent == Some(home.join("Applications").as_path())
}

/// Write `<home>/.dreamcontext/app.json` for `app` at `version`. Left alone when it already
/// names this bundle and version. For the same bundle the recorded `source` and `installedAt`
/// are kept (an `app install` said where it came from); a new bundle is recorded as `dmg` for a
/// CI release build (it updates itself in-app) and `local` otherwise. Returns whether it wrote.
pub(crate) fn write_app_manifest(home: &Path, app: &Path, version: &str, release_build: bool, now_ms: u64) -> std::io::Result<bool> {
    let file = home.join(".dreamcontext").join("app.json");
    let path = app.to_string_lossy().into_owned();
    let existing = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|v| v.is_object());
    let same_bundle = existing.as_ref().and_then(|v| v.get("path")).and_then(|p| p.as_str()) == Some(path.as_str());
    if same_bundle && existing.as_ref().and_then(|v| v.get("version")).and_then(|p| p.as_str()) == Some(version) {
        return Ok(false);
    }
    let kept = |key: &str| existing.as_ref().filter(|_| same_bundle).and_then(|v| v.get(key)).cloned();
    let source = kept("source")
        .filter(|s| s.is_string())
        .unwrap_or_else(|| serde_json::Value::from(if release_build { "dmg" } else { "local" }));
    let installed_at = kept("installedAt").filter(|n| n.is_u64()).unwrap_or_else(|| serde_json::Value::from(now_ms));
    let manifest = serde_json::json!({
        "version": version,
        "path": path,
        "installedAt": installed_at,
        "source": source,
    });
    let text = serde_json::to_string_pretty(&manifest).map_err(std::io::Error::other)?;
    let dir = file.parent().expect("app.json has a parent");
    std::fs::create_dir_all(dir)?;
    // tmp + rename: the CLI reads this file at any moment and must never see half of it.
    let tmp = dir.join(format!("app.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, format!("{text}\n"))?;
    std::fs::rename(&tmp, &file)?;
    Ok(true)
}

/// Record the running bundle, and say so in the updater log. A no-op outside a real `.app`.
pub(crate) fn record_launch(home: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let Some(app) = bundle_of(&exe) else { return };
    if is_ephemeral(&app) {
        crate::applog::log(&format!("[app.json] not recorded: {} is a one-run path (DMG or App Translocation)", app.display()));
        return;
    }
    if !is_install_location(&app, home) {
        crate::applog::log(&format!("[app.json] not recorded: {} is not in /Applications or ~/Applications", app.display()));
        return;
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let version = env!("CARGO_PKG_VERSION");
    match write_app_manifest(home, &app, version, crate::updater::compiled_in(), now_ms) {
        Ok(true) => crate::applog::log(&format!("[app.json] recorded {} {version}", app.display())),
        Ok(false) => {}
        Err(e) => crate::applog::log(&format!("[app.json] could not be written: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dc-app-manifest-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(home: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(home.join(".dreamcontext/app.json")).unwrap()).unwrap()
    }

    #[test]
    fn finds_the_bundle_of_its_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/dreamcontext-beta.app/Contents/MacOS/dreamcontext-beta")),
            Some(PathBuf::from("/Applications/dreamcontext-beta.app"))
        );
        assert_eq!(bundle_of(Path::new("/repo/desktop/src-tauri/target/debug/dreamcontext-beta")), None);
        assert_eq!(bundle_of(Path::new("/x/Contents/MacOS/bin")), None);
    }

    #[test]
    fn one_run_paths_are_ephemeral() {
        assert!(is_ephemeral(Path::new("/Volumes/dreamcontext-beta/dreamcontext-beta.app")));
        assert!(is_ephemeral(Path::new(
            "/private/var/folders/ab/T/AppTranslocation/1234-5678/d/dreamcontext-beta.app"
        )));
        assert!(!is_ephemeral(Path::new("/Applications/dreamcontext-beta.app")));
        assert!(!is_ephemeral(Path::new("/Users/me/Applications/dreamcontext-beta.app")));
    }

    #[test]
    fn only_an_applications_folder_is_an_install() {
        let home = Path::new("/Users/me");
        assert!(is_install_location(Path::new("/Applications/dreamcontext-beta.app"), home));
        assert!(is_install_location(Path::new("/Users/me/Applications/dreamcontext-beta.app"), home));
        assert!(!is_install_location(
            Path::new("/Users/me/projects/dreamcontext/desktop/src-tauri/target/release/bundle/macos/dreamcontext-beta.app"),
            home
        ));
        assert!(!is_install_location(Path::new("/Applications/Tools/dreamcontext-beta.app"), home));
        assert!(!is_install_location(Path::new("/Users/other/Applications/dreamcontext-beta.app"), home));
    }

    #[test]
    fn a_dmg_install_without_a_manifest_gets_one() {
        let h = home("fresh");
        let app = Path::new("/Applications/dreamcontext-beta.app");
        assert!(write_app_manifest(&h, app, "0.36.0", true, 42).unwrap());
        let v = read(&h);
        assert_eq!(v["path"], "/Applications/dreamcontext-beta.app");
        assert_eq!(v["version"], "0.36.0");
        assert_eq!(v["source"], "dmg");
        assert_eq!(v["installedAt"], 42);
        // A local build records itself as local.
        let h2 = home("fresh-local");
        assert!(write_app_manifest(&h2, app, "0.36.0", false, 1).unwrap());
        assert_eq!(read(&h2)["source"], "local");
    }

    #[test]
    fn the_same_bundle_and_version_is_left_alone() {
        let h = home("same");
        let app = Path::new("/Applications/dreamcontext-beta.app");
        write_app_manifest(&h, app, "0.36.0", true, 42).unwrap();
        assert!(!write_app_manifest(&h, app, "0.36.0", true, 99).unwrap());
        assert_eq!(read(&h)["installedAt"], 42);
    }

    #[test]
    fn an_in_app_update_bumps_the_version_and_keeps_source() {
        let h = home("bump");
        std::fs::create_dir_all(h.join(".dreamcontext")).unwrap();
        std::fs::write(
            h.join(".dreamcontext/app.json"),
            r#"{"version":"0.32.0","path":"/Applications/dreamcontext-beta.app","installedAt":7,"source":"github"}"#,
        )
        .unwrap();
        assert!(write_app_manifest(&h, Path::new("/Applications/dreamcontext-beta.app"), "0.36.0", true, 99).unwrap());
        let v = read(&h);
        assert_eq!(v["version"], "0.36.0");
        assert_eq!(v["source"], "github");
        assert_eq!(v["installedAt"], 7);
    }

    #[test]
    fn another_bundle_or_a_broken_manifest_is_replaced() {
        let h = home("other");
        std::fs::create_dir_all(h.join(".dreamcontext")).unwrap();
        std::fs::write(
            h.join(".dreamcontext/app.json"),
            r#"{"version":"0.30.0","path":"/Users/me/Applications/dreamcontext-beta.app","installedAt":7,"source":"github"}"#,
        )
        .unwrap();
        write_app_manifest(&h, Path::new("/Applications/dreamcontext-beta.app"), "0.36.0", true, 99).unwrap();
        let v = read(&h);
        assert_eq!(v["path"], "/Applications/dreamcontext-beta.app");
        assert_eq!(v["source"], "dmg");
        assert_eq!(v["installedAt"], 99);
        std::fs::write(h.join(".dreamcontext/app.json"), "{not json").unwrap();
        assert!(write_app_manifest(&h, Path::new("/Applications/dreamcontext-beta.app"), "0.36.0", false, 5).unwrap());
        assert_eq!(read(&h)["source"], "local");
    }
}
