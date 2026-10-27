// A readable trail of the shell's update work.
//
// A Finder-started app has no terminal, so `eprintln!` reaches nobody: the in-app updater's
// "check failed" and "installed" lines vanished, and nobody could tell whether an update ever
// ran. These lines land in `~/.dreamcontext/logs/desktop-updater.log` instead (still echoed to
// stderr for `tauri dev`). The server's CLI self-update writes `self-update.log` beside it.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Past this the log is moved to `desktop-updater.log.1` and a new one starts.
const MAX_BYTES: u64 = 1024 * 1024;

pub(crate) fn updater_log_path(home: &Path) -> PathBuf {
    home.join(".dreamcontext").join("logs").join("desktop-updater.log")
}

/// Append one stamped line. Best-effort: an unwritable home only loses the line.
pub(crate) fn append(home: &Path, line: &str) {
    let file = updater_log_path(home);
    let Some(dir) = file.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    if std::fs::metadata(&file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("desktop-updater.log.1"));
    }
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{} {line}", utc_stamp(secs));
    }
}

/// Echo to stderr and append to the log under the user's home.
pub(crate) fn log(line: &str) {
    eprintln!("{line}");
    if let Some(home) = crate::node_runtime::home_dir() {
        append(&home, line);
    }
}

/// `2026-10-27T09:05:03Z` from Unix seconds (no date crate in the shell).
pub(crate) fn utc_stamp(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's days-to-civil.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_utc() {
        assert_eq!(utc_stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_stamp(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(utc_stamp(1_793_091_903), "2026-10-27T09:05:03Z");
    }

    #[test]
    fn appends_and_rotates_under_the_given_home() {
        let home = std::env::temp_dir().join(format!("dc-applog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        append(&home, "[updater] first");
        append(&home, "[updater] second");
        let text = std::fs::read_to_string(updater_log_path(&home)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().next().unwrap().ends_with(" [updater] first"));
        std::fs::write(updater_log_path(&home), vec![b'x'; (MAX_BYTES + 1) as usize]).unwrap();
        append(&home, "[updater] after rotation");
        let text = std::fs::read_to_string(updater_log_path(&home)).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(home.join(".dreamcontext/logs/desktop-updater.log.1").exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
