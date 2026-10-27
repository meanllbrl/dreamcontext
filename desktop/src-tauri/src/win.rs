// Windows-only pieces of the desktop shell.
//
// - A Job Object holds the dashboard server, so its whole tree (node, every `claude`, every
//   hook) dies with the app: on a normal quit, and on a crash or a Task Manager kill too,
//   because the OS closes our last handle to the job and KILL_ON_JOB_CLOSE does the rest.
//   Windows has no process groups to signal (src/lib.rs `reap_server` on unix).
// - `~/.dreamcontext/app.json` is written on every launch. The CLI's `hook ensure-dashboard`
//   (every published version) reads it as "the desktop app owns the dashboard" and stops
//   spawning its own detached server on each Claude session — the console flashes and the
//   second, non-desktop server behind "chat sometimes missing".
// - CLI resolution prefers the bundled CLI over an older global one (`prefer_global` in
//   src/cli_choice.rs, shared with macOS).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// The job, as a usize (a HANDLE is a raw pointer, which a static cannot hold). 0 = none.
static JOB: OnceLock<usize> = OnceLock::new();

fn job() -> HANDLE {
    *JOB.get_or_init(|| unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return 0;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        // BREAKAWAY_OK: a child that asks to leave (CREATE_BREAKAWAY_FROM_JOB) may, so nothing
        // that must outlive the app is forced to die with it.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        job as usize
    }) as HANDLE
}

/// Put the server into the job. Best-effort: on failure the exit hook's `child.kill()` is
/// all that remains, as before. The handle is never closed by us — process exit closes it.
pub(crate) fn contain(child: &std::process::Child) {
    use std::os::windows::io::AsRawHandle;
    let job = job();
    if job.is_null() {
        return;
    }
    unsafe {
        AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
    }
}

/// Kill everything in the job now (the app is quitting).
pub(crate) fn terminate_tree() {
    if let Some(&job) = JOB.get() {
        if job != 0 {
            unsafe {
                TerminateJobObject(job as HANDLE, 1);
            }
        }
    }
}

/// Write `<home>\.dreamcontext\app.json` in the CLI's `AppManifest` shape
/// (src/cli/commands/app.ts). Left alone when it already names this exe and version.
pub(crate) fn write_app_manifest(home: &Path) {
    let Ok(exe) = std::env::current_exe() else { return };
    let exe = plain_path(&exe.to_string_lossy());
    let version = env!("CARGO_PKG_VERSION");
    let file = home.join(".dreamcontext").join("app.json");
    if let Ok(raw) = std::fs::read_to_string(&file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            let same = v.get("path").and_then(|p| p.as_str()) == Some(exe.as_str())
                && v.get("version").and_then(|p| p.as_str()) == Some(version);
            if same {
                return;
            }
        }
    }
    let installed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let manifest = serde_json::json!({
        "version": version,
        "path": exe,
        "installedAt": installed_at,
        "source": "local",
    });
    let Ok(text) = serde_json::to_string_pretty(&manifest) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&file, format!("{text}\n"));
}

/// The npm-global CLI entry, if installed: `%APPDATA%\npm\node_modules\dreamcontext\dist\index.js`.
pub(crate) fn global_cli_entry() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let entry = PathBuf::from(appdata).join("npm").join("node_modules").join("dreamcontext").join("dist").join("index.js");
    entry.exists().then_some(entry)
}

/// Strip the verbatim prefix (`\\?\`) `resource_dir` can carry, so node gets a normal path.
pub(crate) fn plain_path(p: &str) -> String {
    p.strip_prefix(r"\\?\").unwrap_or(p).to_string()
}

/// `<home>\.dreamcontext\logs\desktop-server.log`, opened for append (rotated past 5 MiB).
/// The server's stdout/stderr go here: a console-less app has nowhere else to put them.
pub(crate) fn server_log(home: &Path) -> Option<std::fs::File> {
    let dir = home.join(".dreamcontext").join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("desktop-server.log");
    if std::fs::metadata(&file).map(|m| m.len() > 5 * 1024 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("desktop-server.log.1"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(file).ok()
}

/// A second launch (single-instance) brings the running app forward instead.
pub(crate) fn focus_existing(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    if let Some(port) = app.try_state::<crate::DashboardPort>().map(|p| p.0) {
        let _ = crate::open_launcher_window(app, port);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_path_strips_only_the_verbatim_prefix() {
        assert_eq!(plain_path(r"\\?\C:\x\dist\index.js"), r"C:\x\dist\index.js");
        assert_eq!(plain_path(r"C:\x"), r"C:\x");
    }
}
