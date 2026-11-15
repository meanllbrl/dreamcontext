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

/// Is `path` one of the app's own launchers (`~/.dreamcontext/bin/**`, e.g. the CLI launcher
/// `bin/cli/dreamcontext` the server writes on its own Node)? Those are `#!/bin/sh` files that
/// exec THIS app's node: never a global npm CLI. Once one is on the rc PATH, `command -v
/// dreamcontext` answers it, and taking it for the global CLI would run a shell script as a Node
/// entry on the next launch (fresh-Mac gap, 2026-11-15). Compared on the path as found and on
/// its realpath, so a symlink into the folder counts too.
pub(crate) fn is_app_launcher(path: &Path, home: &Path) -> bool {
    let root = home.join(".dreamcontext").join("bin");
    let real_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(&root) || real.starts_with(&root) || real.starts_with(&real_root)
}

/// The global CLI out of a login shell's `which -a dreamcontext`: every line that is an absolute
/// path to an existing file, in PATH order, the first that is not one of the app's launchers.
/// Every match, not `command -v`'s first: once the launcher folder leads the rc PATH, the first
/// answer is always the launcher and would hide a real npm install behind it (review r2). Lines
/// an interactive rc prints are skipped, not mistaken for the answer.
pub(crate) fn pick_global_cli(which_output: &str, home: Option<&Path>) -> Option<String> {
    which_output
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('/'))
        .filter(|l| Path::new(l).is_file())
        .find(|l| home.map_or(true, |h| !is_app_launcher(Path::new(l), h)))
        .map(str::to_string)
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


// ─── C3′ CLI identity (plan npmsiz-beta), shared vectors: assets/cli-precedence-vectors.json ───
//
// Identity comes from realpaths only, never from an inherited variable. The caller resolves the
// realpaths (forward slashes); these functions only compare strings, so Rust and TS answer the
// same vectors byte for byte. A linked checkout runs as itself; otherwise the app's CLI runs; no
// version is compared across kinds. Only an npm global ever re-execs, and only once.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // W3 wires the callers; W2 lands the rule and its vectors
pub(crate) enum CliKind { AppCopy, AppBundle, NpmGlobal, LinkedCheckout, NotInstall }

#[allow(dead_code)]
impl CliKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CliKind::AppCopy => "app-copy",
            CliKind::AppBundle => "app-bundle",
            CliKind::NpmGlobal => "npm-global",
            CliKind::LinkedCheckout => "linked-checkout",
            CliKind::NotInstall => "not-install",
        }
    }
}

/// `~/.dreamcontext/app-cli.json`, already parsed.
#[allow(dead_code)]
pub(crate) struct AppCliRecord<'a> { pub version: &'a str, pub node: &'a str, pub entry: &'a str }

/// What one process looks like: its entry and node realpaths, and the facts around them.
#[allow(dead_code)]
pub(crate) struct CliFacts<'a> {
    pub windows: bool,
    pub home: &'a str,
    pub entry: &'a str,
    pub exec: &'a str,
    /// `name` in the package.json two levels above the entry, when one exists.
    pub pkg_name: Option<&'a str>,
    pub record: Option<AppCliRecord<'a>>,
    /// Windows: our uninstall key's `InstallLocation` (no default-folder fallback).
    pub install_location: Option<&'a str>,
}

fn norm(p: &str, windows: bool) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if windows { s.to_lowercase() } else { s }
}

fn is_semver(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A record is valid when its version is plain X.Y.Z and both paths sit in `bin/rt/<version>/`,
/// or (Mac) both name ONE lasting `.app` bundle (`<A>.app/Contents/Resources/runtime/bin/node` +
/// `<A>.app/Contents/Resources/dist/index.js`), absolute, never on a DMG or translocated copy.
#[allow(dead_code)]
pub(crate) fn record_valid(rec: &AppCliRecord, home: &str, windows: bool) -> bool {
    if !is_semver(rec.version) { return false; }
    // A `.` or `..` segment could climb out of bin/rt while still starting with it.
    let dotted = |p: &str| p.replace('\\', "/").split('/').any(|seg| seg == ".." || seg == ".");
    if dotted(rec.node) || dotted(rec.entry) { return false; }
    if !windows {
        if let Some(app) = rec.node.strip_suffix("/Contents/Resources/runtime/bin/node") {
            return app.starts_with('/') && app.ends_with(".app") && !app.contains('\\')
                && rec.entry == format!("{app}/Contents/Resources/dist/index.js")
                && !app.starts_with("/Volumes/") && !app.contains("/AppTranslocation/");
        }
    }
    let dir = format!("{}/.dreamcontext/bin/rt/{}/", norm(home, windows), if windows { rec.version.to_lowercase() } else { rec.version.to_string() });
    norm(rec.node, windows).starts_with(&dir) && norm(rec.entry, windows).starts_with(&dir)
}

#[allow(dead_code)]
pub(crate) fn classify(f: &CliFacts) -> CliKind {
    let w = f.windows;
    let entry = norm(f.entry, w);
    let exec = norm(f.exec, w);
    let bin = format!("{}/.dreamcontext/bin/", norm(f.home, w));
    if entry.starts_with(&bin) {
        return match &f.record {
            Some(r) if record_valid(r, f.home, w) && norm(r.entry, w) == entry && norm(r.node, w) == exec => CliKind::AppCopy,
            _ => CliKind::NotInstall,
        };
    }
    // Mac: <X>.app/Contents/Resources/dist/index.js run by that same bundle's runtime node.
    if let Some(app) = entry.strip_suffix("/contents/resources/dist/index.js").filter(|_| w)
        .or_else(|| entry.strip_suffix("/Contents/Resources/dist/index.js").filter(|_| !w)) {
        if app.ends_with(".app") {
            let node = if w { format!("{app}/contents/resources/runtime/bin/node") } else { format!("{app}/Contents/Resources/runtime/bin/node") };
            return if exec == node { CliKind::AppBundle } else { CliKind::NotInstall };
        }
    }
    if entry.contains(".app/") { return CliKind::NotInstall; }
    // Windows: <InstallLocation>/dist/index.js run by <InstallLocation>/runtime/node.exe.
    if let Some(il) = f.install_location {
        let il = norm(il, w);
        if entry.starts_with(&format!("{il}/")) {
            return if entry == format!("{il}/dist/index.js") && exec == format!("{il}/runtime/node.exe") { CliKind::AppBundle } else { CliKind::NotInstall };
        }
    }
    if entry.ends_with("/lib/node_modules/dreamcontext/dist/index.js") || (w && entry.ends_with("/npm/node_modules/dreamcontext/dist/index.js")) {
        return CliKind::NpmGlobal;
    }
    if entry.ends_with("/dist/index.js") && !entry.contains("/node_modules/") && f.pkg_name == Some("dreamcontext") {
        return CliKind::LinkedCheckout;
    }
    CliKind::NotInstall
}

/// Mac (plan npmsiz-beta C3′, owner 15 Nov: leave npm): an app that carries its own runtime runs
/// its own CLI; a global CLI outranks it only when it is a developer's linked checkout. Versions
/// are not compared across kinds (the last npm release is the bridge and stays behind the app).
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn bundle_outranks_global(has_runtime: bool, global_kind: CliKind) -> bool {
    has_runtime && global_kind != CliKind::LinkedCheckout
}

/// The kind of the global CLI the login shell found (`dreamcontext` on PATH, a symlink or the
/// entry itself), by its realpath and the package.json two levels above it.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn global_cli_kind(global: &Path, home: &str) -> CliKind {
    let real = std::fs::canonicalize(global).unwrap_or_else(|_| global.to_path_buf());
    let entry = real.to_string_lossy().into_owned();
    let pkg_name = real.parent().and_then(Path::parent).map(|d| d.join("package.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string));
    classify(&CliFacts { windows: false, home, entry: &entry, exec: "", pkg_name: pkg_name.as_deref(), record: None, install_location: None })
}

/// Does this process re-exec into the app copy? Only an npm global, only with a valid record,
/// and never when it was itself started by a re-exec (`DREAMCONTEXT_REEXEC=1`, consumed at start).
#[allow(dead_code)]
pub(crate) fn should_reexec(kind: CliKind, record_valid: bool, reexec_flag: bool) -> bool {
    kind == CliKind::NpmGlobal && record_valid && !reexec_flag
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c3_prime_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/cli-precedence-vectors.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let s = |x: &serde_json::Value| x.as_str().map(str::to_string);
        let mut n = 0;
        for c in v["classify"].as_array().unwrap() {
            let rec = c["record"].as_object().map(|r| (s(&r["version"]).unwrap(), s(&r["node"]).unwrap(), s(&r["entry"]).unwrap()));
            let (home, entry, exec) = (s(&c["home"]).unwrap(), s(&c["entry"]).unwrap(), s(&c["exec"]).unwrap());
            let (pkg, il) = (s(&c["pkgName"]), s(&c["installLocation"]));
            let facts = CliFacts {
                windows: c["os"] == "win32", home: &home, entry: &entry, exec: &exec,
                pkg_name: pkg.as_deref(),
                record: rec.as_ref().map(|(a, b, e)| AppCliRecord { version: a, node: b, entry: e }),
                install_location: il.as_deref(),
            };
            assert_eq!(classify(&facts).as_str(), c["expect"].as_str().unwrap(), "{}", c["name"]);
            n += 1;
        }
        for d in v["decide"].as_array().unwrap() {
            let kind = match d["kind"].as_str().unwrap() {
                "app-copy" => CliKind::AppCopy, "app-bundle" => CliKind::AppBundle, "npm-global" => CliKind::NpmGlobal,
                "linked-checkout" => CliKind::LinkedCheckout, _ => CliKind::NotInstall,
            };
            let re = should_reexec(kind, d["recordValid"].as_bool().unwrap(), d["reexecFlag"].as_bool().unwrap());
            assert_eq!(if re { "reexec" } else { "self" }, d["expect"].as_str().unwrap(), "{}", d["name"]);
            n += 1;
        }
        assert!(n >= 20, "the vector file lost rows: {n}");
        let mut r = 0;
        for c in v["record"].as_array().unwrap() {
            let rec = AppCliRecord { version: c["version"].as_str().unwrap(), node: c["node"].as_str().unwrap(), entry: c["entry"].as_str().unwrap() };
            assert_eq!(record_valid(&rec, c["home"].as_str().unwrap(), c["os"] == "win32"), c["expect"].as_bool().unwrap(), "{}", c["name"]);
            r += 1;
        }
        assert!(r >= 10, "the record vectors lost rows: {r}");
    }

    #[test]
    fn an_app_with_its_own_runtime_outranks_npm_but_not_a_linked_checkout() {
        assert!(bundle_outranks_global(true, CliKind::NpmGlobal));
        assert!(bundle_outranks_global(true, CliKind::NotInstall));
        assert!(!bundle_outranks_global(true, CliKind::LinkedCheckout));
        assert!(!bundle_outranks_global(false, CliKind::NpmGlobal), "an older bundle with no runtime keeps today's rule");
        let root = std::env::temp_dir().join(format!("dc-kind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let npm = root.join("prefix/lib/node_modules/dreamcontext");
        std::fs::create_dir_all(npm.join("dist")).unwrap();
        std::fs::write(npm.join("package.json"), r#"{"name":"dreamcontext"}"#).unwrap();
        std::fs::write(npm.join("dist/index.js"), "").unwrap();
        let checkout = root.join("code/dreamcontext");
        std::fs::create_dir_all(checkout.join("dist")).unwrap();
        std::fs::write(checkout.join("package.json"), r#"{"name":"dreamcontext"}"#).unwrap();
        std::fs::write(checkout.join("dist/index.js"), "").unwrap();
        let home = root.to_string_lossy().into_owned();
        assert_eq!(global_cli_kind(&npm.join("dist/index.js"), &home), CliKind::NpmGlobal);
        assert_eq!(global_cli_kind(&checkout.join("dist/index.js"), &home), CliKind::LinkedCheckout);
        #[cfg(unix)]
        {
            // `npm link`: the bin is a symlink that resolves into the checkout.
            let bin = root.join("bin-dreamcontext");
            std::os::unix::fs::symlink(checkout.join("dist/index.js"), &bin).unwrap();
            assert_eq!(global_cli_kind(&bin, &home), CliKind::LinkedCheckout);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_apps_own_launcher_is_never_the_global_cli() {
        let home = std::env::temp_dir().join(format!("dc-launcher-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let cli = home.join(".dreamcontext").join("bin").join("cli");
        std::fs::create_dir_all(&cli).unwrap();
        let launcher = cli.join("dreamcontext");
        std::fs::write(&launcher, "#!/bin/sh\n").unwrap();
        assert!(is_app_launcher(&launcher, &home));
        // The private Node's npm global is a real npm install: not a launcher.
        assert!(!is_app_launcher(&home.join(".dreamcontext").join("npm-global").join("bin").join("dreamcontext"), &home));
        assert!(!is_app_launcher(Path::new("/opt/homebrew/bin/dreamcontext"), &home));
        // `which -a` with the launcher first: the real install behind it is the one picked; rc
        // noise and a missing path are skipped; only the launcher = no global CLI.
        let npm = home.join("npm-bin");
        std::fs::create_dir_all(&npm).unwrap();
        let real = npm.join("dreamcontext");
        std::fs::write(&real, "#!/usr/bin/env node\n").unwrap();
        let out = format!("Welcome back!\n{}\n/nope/dreamcontext\n{}\n", launcher.display(), real.display());
        assert_eq!(pick_global_cli(&out, Some(&home)), Some(real.to_string_lossy().into_owned()));
        assert_eq!(pick_global_cli(&format!("{}\n", launcher.display()), Some(&home)), None);
        assert_eq!(pick_global_cli("", Some(&home)), None);
        #[cfg(unix)]
        {
            let link = home.join("dc-link");
            std::os::unix::fs::symlink(&launcher, &link).unwrap();
            assert!(is_app_launcher(&link, &home));
        }
        let _ = std::fs::remove_dir_all(&home);
    }

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
