//! Build script: the dreamcontext App runner first (macOS), then tauri-build.
//!
//! `desktop/app-runner` is a separate crate shipped as a sidecar (`bundle.externalBin` in
//! tauri.macos.conf.json → `Contents/MacOS/app-runner`). tauri-build checks that
//! `binaries/app-runner-<TARGET>` exists, so it is built here, before `tauri_build::build()`.
//! That makes `tauri dev`, `tauri build`, a bare `cargo test` and CI take the same path.
//! The runner builds in its own target dir (a nested cargo on the outer target dir would
//! wait on the outer build's lock forever).

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    build_app_runner();
    tauri_build::build()
}

fn build_app_runner() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("apple-darwin") {
        return;
    }
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let runner_dir = manifest_dir.join("..").join("app-runner");
    for p in ["src", "Cargo.toml", "Cargo.lock"] {
        println!("cargo:rerun-if-changed={}", runner_dir.join(p).display());
    }
    let out = manifest_dir.join("binaries").join(format!("app-runner-{target}"));
    // Kept under the shell's own target dir so CI's cargo cache covers it.
    let target_dir = manifest_dir.join("target").join("app-runner");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut cmd = Command::new(cargo);
    cmd.args(["build", "--release", "--locked", "--manifest-path"])
        .arg(runner_dir.join("Cargo.toml"))
        .args(["--target", &target])
        .env("CARGO_TARGET_DIR", &target_dir);
    // The outer build's flags are for the shell, not the runner.
    for k in ["CARGO_ENCODED_RUSTFLAGS", "RUSTFLAGS", "CARGO_MAKEFLAGS", "MAKEFLAGS", "MFLAGS", "CARGO_BUILD_TARGET"] {
        cmd.env_remove(k);
    }
    let status = cmd.status().expect("could not run cargo for desktop/app-runner");
    if !status.success() {
        panic!("building desktop/app-runner failed ({status})");
    }
    let built = target_dir.join(&target).join("release").join("app-runner");
    copy_if_changed(&built, &out);
}

fn copy_if_changed(from: &Path, to: &Path) {
    let new = std::fs::read(from).unwrap_or_else(|e| panic!("app-runner binary missing at {}: {e}", from.display()));
    if std::fs::read(to).ok().as_deref() == Some(new.as_slice()) {
        return;
    }
    std::fs::create_dir_all(to.parent().unwrap()).expect("create binaries/");
    std::fs::write(to, &new).expect("copy app-runner into binaries/");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(to, std::fs::Permissions::from_mode(0o755));
    }
}
