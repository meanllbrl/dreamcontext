// Which dreamcontext CLI the shell runs: the global npm install or the copy bundled in the app.
//
// The app is a thin shell: the window, the server and the version the user sees all come from
// the CLI it starts. The global CLI auto-upgrades through npm, so it normally wins. But the
// in-app updater replaces only the bundle, and a bundle that always deferred to an older global
// CLI kept showing the old version after every in-app update (0.32.0 users on a 0.35.0 shell).
// So a bundled copy that is strictly NEWER than the global one runs instead; the server then
// upgrades the global CLI (src/server/self-update-job.ts) and the next launch is back on it.

use std::path::Path;

/// The version in the package.json of the dreamcontext package a CLI entry belongs to. The
/// entry may be the npm bin symlink (`<prefix>/bin/dreamcontext`) or `dist/index.js` itself;
/// either way the package is two levels above the real `dist/index.js`. None when it cannot be
/// read or is not the dreamcontext package.
pub(crate) fn cli_version(entry: &Path) -> Option<String> {
    let real = std::fs::canonicalize(entry).unwrap_or_else(|_| entry.to_path_buf());
    let pkg = real.parent()?.parent()?.join("package.json");
    let raw = std::fs::read_to_string(pkg).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if v.get("name")?.as_str()? != "dreamcontext" {
        return None;
    }
    v.get("version")?.as_str().map(str::to_string)
}

fn strictly_newer(a: &str, b: &str) -> bool {
    crate::node_runtime::version_at_least(a, b) && !crate::node_runtime::version_at_least(b, a)
}

/// Windows: is the global CLI STRICTLY newer than the one bundled in the app? Only then does it
/// win: an older global (0.28.0 there) predates the Windows fixes the bundled one carries.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn prefer_global(global_version: Option<&str>, bundled_version: &str) -> bool {
    match global_version {
        Some(g) => strictly_newer(g, bundled_version),
        None => false,
    }
}

/// macOS/Linux: does the bundled copy beat the global CLI? Only when the global version is
/// known and the bundled one is strictly newer. Equal or unreadable keeps the global CLI, the
/// canonical source (it carries node-pty and the recall model; the bundle carries neither).
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn bundled_beats_global(global_version: Option<&str>, bundled_version: &str) -> bool {
    match global_version {
        Some(g) => strictly_newer(bundled_version, g),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_global_only_when_strictly_newer() {
        assert!(!prefer_global(None, "0.31.0"));
        assert!(!prefer_global(Some("0.28.0"), "0.31.0"));
        assert!(!prefer_global(Some("0.31.0"), "0.31.0"));
        assert!(prefer_global(Some("0.32.0"), "0.31.0"));
        assert!(prefer_global(Some("0.31.10"), "0.31.9"));
    }

    #[test]
    fn bundled_beats_global_only_when_strictly_newer_and_known() {
        assert!(bundled_beats_global(Some("0.32.0"), "0.35.0"));
        assert!(bundled_beats_global(Some("0.35.9"), "0.35.10"));
        assert!(!bundled_beats_global(Some("0.35.0"), "0.35.0"));
        assert!(!bundled_beats_global(Some("0.36.0"), "0.35.0"));
        assert!(!bundled_beats_global(None, "0.35.0"));
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_version_through_the_npm_bin_symlink() {
        let root = std::env::temp_dir().join(format!("dc-cli-choice-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let pkg = root.join("lib/node_modules/dreamcontext");
        std::fs::create_dir_all(pkg.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::write(pkg.join("dist/index.js"), "").unwrap();
        std::fs::write(pkg.join("package.json"), r#"{"name":"dreamcontext","version":"0.32.0"}"#).unwrap();
        let bin = root.join("bin/dreamcontext");
        std::os::unix::fs::symlink("../lib/node_modules/dreamcontext/dist/index.js", &bin).unwrap();
        assert_eq!(cli_version(&bin).as_deref(), Some("0.32.0"));
        assert_eq!(cli_version(&pkg.join("dist/index.js")).as_deref(), Some("0.32.0"));
        // Another package's manifest is not a dreamcontext version.
        std::fs::write(pkg.join("package.json"), r#"{"name":"other","version":"9.9.9"}"#).unwrap();
        assert_eq!(cli_version(&bin), None);
        assert_eq!(cli_version(&root.join("missing")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
