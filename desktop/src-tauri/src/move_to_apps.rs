//! "Move to Applications?" (owner, 15 Nov: install must be very simple).
//!
//! A first-time Mac user often double-clicks the app inside the DMG window, or opens it in
//! Downloads. From there it runs from a path that is gone after this run (the mounted DMG, or
//! macOS's randomised App Translocation copy), so nothing it records can last, and the in-app
//! updater cannot replace it. At launch, before the server starts, the app asks once per launch
//! with a native alert; "Move" copies the bundle into /Applications (or ~/Applications when
//! /Applications is not writable), replaces an older copy there (the old one goes to the Trash),
//! takes the download mark off the copy (the bundle already passed Gatekeeper to run at all),
//! sends a Downloads original to the Trash, and relaunches the copy. "Not now" runs as before.
//! Any failure says so in one sentence and runs as before. Nothing here runs outside a `.app`.
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::app_manifest::{bundle_of, is_ephemeral, is_install_location};

/// Where the running bundle sits, when it is a place to offer the move from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin { Dmg, Translocated, Downloads }

pub(crate) fn offer_from(app: &Path, home: &Path) -> Option<Origin> {
    if is_install_location(app, home) { return None; }
    let s = app.to_string_lossy();
    if s.contains("/AppTranslocation/") { return Some(Origin::Translocated); }
    if is_ephemeral(app) { return Some(Origin::Dmg); }
    if app.starts_with(home.join("Downloads")) { return Some(Origin::Downloads); }
    None
}

/// The folder the copy goes into: /Applications when writable, else ~/Applications.
pub(crate) fn target_dir(system_writable: bool, home: &Path) -> PathBuf {
    if system_writable { PathBuf::from("/Applications") } else { home.join("Applications") }
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".dreamcontext-probe-{}", std::process::id()));
    match std::fs::create_dir(&probe) {
        Ok(()) => { let _ = std::fs::remove_dir(&probe); true }
        Err(_) => false,
    }
}

/// A Trash path for `name` that does not exist yet.
fn trash_slot(home: &Path, name: &str) -> PathBuf {
    let trash = home.join(".Trash");
    let mut p = trash.join(name);
    let mut n = 1;
    while p.symlink_metadata().is_ok() {
        p = trash.join(format!("{} {n}.app", name.trim_end_matches(".app")));
        n += 1;
    }
    p
}

/// Copy `app` into `dir` under its own name, through a temp folder in `dir`, so the final name
/// only ever holds a whole bundle. An existing bundle there goes to the Trash first.
pub(crate) fn install_copy(app: &Path, dir: &Path, home: &Path) -> Result<PathBuf, String> {
    let name = app.file_name().ok_or("no bundle name")?.to_string_lossy().into_owned();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_dir() { return Err("the Applications folder is not a plain folder".into()); }
    let dst = dir.join(&name);
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let ok = Command::new("/usr/bin/ditto").arg(app).arg(&tmp).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err("copying the app failed".into());
    }
    // The copy is not a fresh download: this very bundle already passed Gatekeeper to run.
    let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&tmp).status();
    if dst.symlink_metadata().is_ok() {
        let slot = trash_slot(home, &name);
        if let Err(e) = std::fs::create_dir_all(home.join(".Trash")).and_then(|_| std::fs::rename(&dst, &slot)) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("the older copy could not be moved to the Trash: {e}"));
        }
    }
    std::fs::rename(&tmp, &dst).map_err(|e| { let _ = std::fs::remove_dir_all(&tmp); e.to_string() })?;
    Ok(dst)
}

fn turkish() -> bool {
    Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLanguages"]).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().nth(1).unwrap_or("").trim().trim_matches(|c| c == '"' || c == ',').starts_with("tr"))
        .unwrap_or(false)
}

pub(crate) struct AlertCopy { pub title: &'static str, pub body: &'static str, pub move_label: &'static str, pub later: &'static str, pub failed: &'static str }

pub(crate) fn copy(tr: bool) -> AlertCopy {
    if tr {
        AlertCopy {
            title: "dreamcontext Uygulamalar klasörüne taşınsın mı?",
            body: "Şu an indirme penceresinden çalışıyor. Uygulamalar klasöründe kalıcı olur ve kendini güncelleyebilir.",
            move_label: "Uygulamalar'a taşı",
            later: "Şimdi değil",
            failed: "Taşınamadı. dreamcontext'i Uygulamalar klasörüne sürükleyip oradan açabilirsin.",
        }
    } else {
        AlertCopy {
            title: "Move dreamcontext to your Applications folder?",
            body: "It is running from the download window. In Applications it stays put and can update itself.",
            move_label: "Move to Applications",
            later: "Not now",
            failed: "It could not be moved. Drag dreamcontext into your Applications folder and open it from there.",
        }
    }
}

/// Ask, and move when the owner says so. Returns true when the moved copy was opened, in which
/// case this process should exit at once. Must run on the main thread (setup does).
#[cfg(target_os = "macos")]
pub(crate) fn offer(home: &Path) -> bool {
    use objc2::rc::Retained;
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn};
    use objc2_foundation::NSString;

    let Ok(exe) = std::env::current_exe() else { return false };
    let Some(app) = bundle_of(&exe) else { return false };
    let Some(from) = offer_from(&app, home) else { return false };
    let text = copy(turkish());
    let alert: Option<Retained<NSAlert>> = unsafe { msg_send![NSAlert::class(), new] };
    let Some(alert) = alert else { return false };
    alert.setMessageText(&NSString::from_str(text.title));
    alert.setInformativeText(&NSString::from_str(text.body));
    alert.addButtonWithTitle(&NSString::from_str(text.move_label));
    alert.addButtonWithTitle(&NSString::from_str(text.later));
    if alert.runModal() != NSAlertFirstButtonReturn {
        crate::applog::log(&format!("[move] {from:?}: the owner chose not now"));
        return false;
    }
    let dir = target_dir(writable(Path::new("/Applications")), home);
    match install_copy(&app, &dir, home) {
        Ok(dst) => {
            crate::applog::log(&format!("[move] {from:?}: copied {} to {}", app.display(), dst.display()));
            if from == Origin::Downloads {
                let slot = trash_slot(home, &app.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                let _ = std::fs::rename(&app, slot);
            }
            Command::new("/usr/bin/open").arg("-n").arg(&dst).status().map(|s| s.success()).unwrap_or(false)
        }
        Err(e) => {
            crate::applog::log(&format!("[move] {from:?}: failed: {e}"));
            let fail: Option<Retained<NSAlert>> = unsafe { msg_send![NSAlert::class(), new] };
            if let Some(fail) = fail {
                fail.setMessageText(&NSString::from_str(text.failed));
                fail.runModal();
            }
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offered_from_the_dmg_translocation_and_downloads_only() {
        let home = Path::new("/Users/example-user");
        assert_eq!(offer_from(Path::new("/Volumes/dreamcontext/dreamcontext-beta.app"), home), Some(Origin::Dmg));
        assert_eq!(offer_from(Path::new("/private/var/folders/x/T/AppTranslocation/AB/d/dreamcontext-beta.app"), home), Some(Origin::Translocated));
        assert_eq!(offer_from(Path::new("/Users/example-user/Downloads/dreamcontext-beta.app"), home), Some(Origin::Downloads));
        assert_eq!(offer_from(Path::new("/Users/example-user/Downloads/x/dreamcontext-beta.app"), home), Some(Origin::Downloads));
        assert_eq!(offer_from(Path::new("/Applications/dreamcontext-beta.app"), home), None);
        assert_eq!(offer_from(Path::new("/Users/example-user/Applications/dreamcontext-beta.app"), home), None);
        assert_eq!(offer_from(Path::new("/Users/example-user/code/dreamcontext-beta.app"), home), None, "a developer's build elsewhere is left alone");
    }

    #[test]
    fn the_target_falls_back_to_the_users_applications() {
        let home = Path::new("/Users/example-user");
        assert_eq!(target_dir(true, home), PathBuf::from("/Applications"));
        assert_eq!(target_dir(false, home), PathBuf::from("/Users/example-user/Applications"));
    }

    #[test]
    fn both_languages_have_every_line_and_no_em_dash() {
        for tr in [true, false] {
            let c = copy(tr);
            for s in [c.title, c.body, c.move_label, c.later, c.failed] {
                assert!(!s.is_empty());
                assert!(!s.contains('\u{2014}'), "no em dashes in user copy: {s}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn install_copy_replaces_an_older_copy_and_trashes_it() {
        let root = std::env::temp_dir().join(format!("dc-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let src = root.join("Volumes/d/dreamcontext-beta.app");
        std::fs::create_dir_all(src.join("Contents")).unwrap();
        std::fs::write(src.join("Contents/new"), "new").unwrap();
        let apps = home.join("Applications");
        std::fs::create_dir_all(apps.join("dreamcontext-beta.app/Contents")).unwrap();
        std::fs::write(apps.join("dreamcontext-beta.app/Contents/old"), "old").unwrap();
        let dst = install_copy(&src, &apps, &home).unwrap();
        assert_eq!(dst, apps.join("dreamcontext-beta.app"));
        assert_eq!(std::fs::read_to_string(dst.join("Contents/new")).unwrap(), "new");
        assert!(!dst.join("Contents/old").exists());
        assert!(home.join(".Trash/dreamcontext-beta.app/Contents/old").exists(), "the older copy is in the Trash");
        assert!(src.join("Contents/new").exists(), "the source is left as it was");
        // No temp folder is left beside it.
        let leftovers: Vec<_> = std::fs::read_dir(&apps).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().contains(".tmp-")).collect();
        assert!(leftovers.is_empty());
        // A symlinked Applications folder is refused.
        let link = home.join("LinkedApps");
        std::os::unix::fs::symlink(&apps, &link).unwrap();
        assert!(install_copy(&src, &link, &home).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
