// dreamcontext desktop shell — finding a usable Node, and installing a private one.
//
// The dashboard server is Node, so without a usable Node the app has nothing to show. A
// Finder-launched app also has no shell PATH, so `node` is resolved from an ordered list of
// candidates, each one asked for its version: an old Node (the server needs 18+) used to be
// accepted and then crash the server, which the user saw as a 15 s timeout and an error.
//
// When no candidate is usable, the shell installs a PRIVATE Node for dreamcontext alone,
// never touching the user's own. Layout under `~/.dreamcontext/node/`:
//
//   <version>/        the official build, unpacked (bin/node, bin/npm, lib/node_modules/npm)
//   <version>/etc/npmrc   `prefix=<home>/.dreamcontext/npm-global`, so global npm packages
//                     (the dreamcontext CLI) live OUTSIDE the version folder and survive a
//                     pin bump
//   current -> <version>  the stable path every caller and shell profile names
//
// The archive is the exact file pinned in `assets/runtime-pins.json` (version, sha256, size),
// downloaded https-only and checked byte for byte before anything is unpacked. Nothing is
// ever written through a symlink: a linked `~/.dreamcontext` or `~/.dreamcontext/node` is
// refused, and every move inside the folder renames entries rather than following them.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The dashboard server's floor (package.json `engines.node`).
pub(crate) const MIN_NODE_MAJOR: u32 = 18;

/// The single source of the pinned build: the same file the CLI and install.sh read.
const PINS_JSON: &str = include_str!("../../../assets/runtime-pins.json");

const MIB: u64 = 1024 * 1024;
/// How long a candidate gets to answer `--version` before it counts as unusable.
const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// The login-shell lookup sources the user's profile, which can be slow on a cold start.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the download loop reports progress and checks for a cancel.
const PROGRESS_TICK: Duration = Duration::from_millis(200);

// ─── Pins ───────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct PinFile {
    node: NodePins,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodePins {
    pub(crate) version: String,
    pub(crate) min_macos: String,
    pub(crate) base: String,
    pub(crate) files: HashMap<String, PinEntry>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct PinEntry {
    pub(crate) file: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

fn parse_pins(json: &str) -> Result<NodePins, String> {
    let pins = serde_json::from_str::<PinFile>(json)
        .map_err(|e| format!("runtime-pins.json is not valid: {e}"))?
        .node;
    if !pins.base.starts_with("https://") || !pins.base.ends_with('/') {
        return Err("runtime-pins.json: node.base must be an https:// folder URL".into());
    }
    if !is_version_name(&pins.version) {
        return Err("runtime-pins.json: node.version must look like 24.1.0".into());
    }
    for (key, entry) in &pins.files {
        let file_ok = !entry.file.is_empty()
            && !entry.file.contains('/')
            && !entry.file.contains("..")
            && entry.file.ends_with(".tar.gz");
        let sha_ok = entry.sha256.len() == 64 && entry.sha256.bytes().all(|b| b.is_ascii_hexdigit());
        if !file_ok || !sha_ok || entry.size == 0 {
            return Err(format!("runtime-pins.json: node.files.{key} is malformed"));
        }
    }
    Ok(pins)
}

/// The pinned Node build, parsed once. An unparsable file is a build bug, reported as an
/// ordinary setup error rather than a panic (the release profile aborts on panic).
pub(crate) fn node_pins() -> Result<&'static NodePins, SetupError> {
    static PINS: OnceLock<Result<NodePins, String>> = OnceLock::new();
    PINS.get_or_init(|| parse_pins(PINS_JSON))
        .as_ref()
        .map_err(|e| SetupError::Other(e.clone()))
}

/// The pins key for this computer, in Node's own naming.
pub(crate) fn host_key(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn pin_for_host(pins: &NodePins) -> Result<&PinEntry, SetupError> {
    host_key(std::env::consts::OS, std::env::consts::ARCH)
        .and_then(|k| pins.files.get(k))
        .ok_or_else(|| SetupError::Other("There is no Node.js build for this computer.".into()))
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NodeChoice {
    pub(crate) path: String,
    pub(crate) version: (u32, u32, u32),
    pub(crate) managed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum NodeProblem {
    Missing,
    TooOld { found: String, version: String },
}

impl NodeProblem {
    /// The setup screen's `reason`: which sentence it opens with.
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            NodeProblem::Missing => "missing",
            NodeProblem::TooOld { .. } => "too-old",
        }
    }
}

/// `v24.21.0` → (24, 21, 0). A pre-release suffix on the patch (`0-pre`) is ignored.
pub(crate) fn parse_node_version(s: &str) -> Option<(u32, u32, u32)> {
    let s = s.trim();
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_raw = parts.next()?;
    let digits: String = patch_raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    let patch = digits.parse().ok()?;
    Some((major, minor, patch))
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home);
    (path.is_absolute() && path != Path::new("/")).then_some(path)
}

pub(crate) fn managed_root(home: &Path) -> PathBuf {
    home.join(".dreamcontext").join("node")
}

pub(crate) fn managed_node_bin(home: &Path) -> PathBuf {
    managed_root(home).join("current").join("bin").join("node")
}

pub(crate) fn npm_global_dir(home: &Path) -> PathBuf {
    home.join(".dreamcontext").join("npm-global")
}

/// Run a command with a deadline; `Some(stdout)` only on a zero exit within it.
fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn probe_version(path: &str) -> Option<(u32, u32, u32)> {
    output_with_timeout(Command::new(path).arg("--version"), VERSION_PROBE_TIMEOUT)
        .and_then(|out| parse_node_version(&out))
}

/// The user's login shell's `node`: what their nvm/brew/volta setup puts first.
fn login_shell_node() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let out = output_with_timeout(Command::new(&shell).args(["-lc", "command -v node"]), SHELL_PROBE_TIMEOUT)?;
    let path = out.trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// Every place a Node may live, most-preferred first. The private copy is last: a user's own
/// working Node always wins over the one dreamcontext installed for itself.
fn candidate_paths(home: Option<&Path>) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = Vec::new();
    if let Ok(p) = std::env::var("DREAMCONTEXT_NODE") {
        out.push((p, false));
    }
    if let Some(p) = login_shell_node() {
        out.push((p, false));
    }
    out.push(("/opt/homebrew/bin/node".into(), false));
    out.push(("/usr/local/bin/node".into(), false));
    out.push(("/usr/bin/node".into(), false));
    if let Some(home) = home {
        out.push((home.join(".volta/bin/node").to_string_lossy().into_owned(), false));
        out.push((managed_node_bin(home).to_string_lossy().into_owned(), true));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|(p, _)| !p.is_empty() && seen.insert(p.clone()));
    out
}

/// Pick the first candidate whose version is at least [`MIN_NODE_MAJOR`]. Probing stops at
/// the first good one; a too-old one is remembered so the setup screen can say so.
pub(crate) fn resolve_from(
    candidates: &[(String, bool)],
    exists: impl Fn(&str) -> bool,
    probe: impl Fn(&str) -> Option<(u32, u32, u32)>,
) -> Result<NodeChoice, NodeProblem> {
    let mut too_old: Option<NodeProblem> = None;
    for (path, managed) in candidates {
        if !exists(path) {
            continue;
        }
        let Some(version) = probe(path) else { continue };
        if version.0 >= MIN_NODE_MAJOR {
            return Ok(NodeChoice { path: path.clone(), version, managed: *managed });
        }
        if too_old.is_none() {
            too_old = Some(NodeProblem::TooOld {
                found: path.clone(),
                version: format!("{}.{}.{}", version.0, version.1, version.2),
            });
        }
    }
    Err(too_old.unwrap_or(NodeProblem::Missing))
}

/// The Node the dashboard server runs on, or why there is none.
/// `DREAMCONTEXT_FORCE_NODE_SETUP=1` treats every candidate as unusable (manual testing of the
/// first-run path on a machine that has Node).
pub(crate) fn resolve_usable_node() -> Result<NodeChoice, NodeProblem> {
    if std::env::var("DREAMCONTEXT_FORCE_NODE_SETUP").as_deref() == Ok("1") {
        return Err(NodeProblem::Missing);
    }
    let home = home_dir();
    let candidates = candidate_paths(home.as_deref());
    resolve_from(&candidates, |p| Path::new(p).exists(), probe_version)
}

// ─── Managed install ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Phase {
    Downloading,
    Verifying,
    Unpacking,
    Done,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SetupError {
    Offline,
    Checksum,
    Disk,
    UnsupportedOs { need: String },
    Canceled,
    Other(String),
}

impl SetupError {
    /// The setup screen's `error` code. A cancel is not an error the page shows.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            SetupError::Offline => "offline",
            SetupError::Checksum => "checksum",
            SetupError::Disk => "disk",
            SetupError::UnsupportedOs { .. } => "os",
            SetupError::Canceled | SetupError::Other(_) => "other",
        }
    }
}

fn io_error(e: io::Error, what: &str) -> SetupError {
    // ENOSPC (28) and EDQUOT (69 on macOS, 122 on Linux): the disk is full, not a bug.
    match e.raw_os_error() {
        Some(28) | Some(69) | Some(122) => SetupError::Disk,
        _ => SetupError::Other(format!("{what}: {e}")),
    }
}

fn check_cancel(cancel: &AtomicBool) -> Result<(), SetupError> {
    if cancel.load(Ordering::SeqCst) {
        Err(SetupError::Canceled)
    } else {
        Ok(())
    }
}

fn unix_nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// `24.21.0`
pub(crate) fn is_version_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `24.21.0` or `24.21.0.old-1760000000`: the only names pruning may ever remove.
pub(crate) fn is_prunable_name(name: &str) -> bool {
    if is_version_name(name) {
        return true;
    }
    match name.split_once(".old-") {
        Some((version, stamp)) => {
            is_version_name(version) && !stamp.is_empty() && stamp.bytes().all(|b| b.is_ascii_digit())
        }
        None => false,
    }
}

/// An existing entry at `path` must be a real folder; a symlink is refused, never followed.
fn refuse_link(path: &Path) -> Result<bool, SetupError> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => Err(SetupError::Other(format!(
            "{} is a link; dreamcontext will not install through it.",
            path.display()
        ))),
        Ok(m) if !m.is_dir() => Err(SetupError::Other(format!("{} is not a folder.", path.display()))),
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(io_error(e, "Could not inspect the install folder")),
    }
}

/// `~/.dreamcontext/node`, created when missing; refused when either level is a link.
fn prepare_root(home: &Path) -> Result<PathBuf, SetupError> {
    let dc = home.join(".dreamcontext");
    if !refuse_link(&dc)? {
        fs::create_dir(&dc).map_err(|e| io_error(e, "Could not create ~/.dreamcontext"))?;
    }
    let root = dc.join("node");
    if !refuse_link(&root)? {
        fs::create_dir(&root).map_err(|e| io_error(e, "Could not create ~/.dreamcontext/node"))?;
    }
    Ok(root)
}

/// A fresh staging folder. `create_dir` fails on an existing name, so a leftover from an
/// earlier run is never reused; the next free name is taken instead.
fn create_partial(root: &Path, pid: u32, nanos: u128) -> Result<PathBuf, SetupError> {
    for attempt in 0..16u128 {
        let dir = root.join(format!(".partial-{pid}-{}", nanos + attempt));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error(e, "Could not create a staging folder")),
        }
    }
    Err(SetupError::Other("Could not find a free staging folder name.".into()))
}

/// Size first (cheap), then SHA-256 of every byte.
pub(crate) fn verify_archive(archive: &Path, pin: &PinEntry) -> Result<(), SetupError> {
    let len = fs::metadata(archive).map_err(|e| io_error(e, "Could not read the download"))?.len();
    if len != pin.size {
        return Err(SetupError::Checksum);
    }
    let mut file = fs::File::open(archive).map_err(|e| io_error(e, "Could not read the download"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| io_error(e, "Could not read the download"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if digest.eq_ignore_ascii_case(&pin.sha256) {
        Ok(())
    } else {
        Err(SetupError::Checksum)
    }
}

fn tar_binary() -> &'static str {
    if Path::new("/usr/bin/tar").exists() { "/usr/bin/tar" } else { "tar" }
}

/// Unpack the verified archive into `dest`, dropping Node's `node-vX-os-arch/` top folder.
fn unpack(archive: &Path, dest: &Path) -> Result<(), SetupError> {
    let status = Command::new(tar_binary())
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .arg("--strip-components=1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| io_error(e, "Could not start tar"))?;
    if status.success() {
        Ok(())
    } else {
        Err(SetupError::Other("Could not unpack Node.js.".into()))
    }
}

/// Move `unpacked` into `<root>/<version>`. Anything already at that name (a folder, a file,
/// even a link) is renamed aside first, so the rename into place never hits ENOTEMPTY and the
/// old entry is removed only by [`prune`].
fn place_version(root: &Path, unpacked: &Path, version: &str) -> Result<PathBuf, SetupError> {
    if !is_version_name(version) {
        return Err(SetupError::Other("The pinned version name is not valid.".into()));
    }
    let dest = root.join(version);
    if fs::symlink_metadata(&dest).is_ok() {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = root.join(format!("{version}.old-{stamp}"));
        fs::rename(&dest, &aside).map_err(|e| io_error(e, "Could not move the old copy aside"))?;
    }
    fs::rename(unpacked, &dest).map_err(|e| io_error(e, "Could not move Node.js into place"))?;
    Ok(dest)
}

/// Point this copy's global npm packages at `~/.dreamcontext/npm-global`.
pub(crate) fn npmrc_contents(home: &Path) -> Result<String, SetupError> {
    let prefix = npm_global_dir(home);
    let prefix = prefix
        .to_str()
        .filter(|p| !p.contains('\n') && !p.contains('\r'))
        .ok_or_else(|| SetupError::Other("The home folder path cannot be written to npm's settings.".into()))?;
    Ok(format!("prefix={prefix}\n"))
}

fn write_npmrc(version_dir: &Path, home: &Path) -> Result<(), SetupError> {
    let etc = version_dir.join("etc");
    if !refuse_link(&etc)? {
        fs::create_dir(&etc).map_err(|e| io_error(e, "Could not create etc/"))?;
    }
    let target = etc.join("npmrc");
    if fs::symlink_metadata(&target).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err(SetupError::Other("etc/npmrc is a link.".into()));
    }
    fs::write(&target, npmrc_contents(home)?).map_err(|e| io_error(e, "Could not write etc/npmrc"))
}

/// The version `current` points at now, if it is one of ours.
fn current_version(root: &Path) -> Option<String> {
    let target = fs::read_link(root.join("current")).ok()?;
    let name = target.to_str()?.to_string();
    is_version_name(&name).then_some(name)
}

/// Repoint `current` at `version` atomically: a new link under a temp name, renamed over the
/// old one. A real folder at `current` is refused rather than replaced.
fn swap_current(root: &Path, version: &str) -> Result<(), SetupError> {
    let current = root.join("current");
    if let Ok(m) = fs::symlink_metadata(&current) {
        if !m.file_type().is_symlink() {
            return Err(SetupError::Other("~/.dreamcontext/node/current is not a link.".into()));
        }
    }
    let tmp = root.join(format!(".current-{}-{}", std::process::id(), unix_nanos()));
    std::os::unix::fs::symlink(version, &tmp).map_err(|e| io_error(e, "Could not create the current link"))?;
    fs::rename(&tmp, &current).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        io_error(e, "Could not switch the current link")
    })
}

/// Remove old copies: only entries named like a version (or a version moved aside), only real
/// folders, and never one listed in `keep`. `current`, staging folders and anything else the
/// user put here are left alone. Returns the names removed.
pub(crate) fn prune(root: &Path, keep: &[String]) -> Vec<String> {
    let mut removed = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return removed };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_prunable_name(&name) || keep.iter().any(|k| k == &name) {
            continue;
        }
        let path = entry.path();
        let is_dir = fs::symlink_metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir && fs::remove_dir_all(&path).is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// `13.5` ≤ `14.2.1`: dotted numbers, missing parts read as zero.
pub(crate) fn version_at_least(have: &str, need: &str) -> bool {
    let nums = |s: &str| -> Vec<u32> { s.trim().split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (a, b) = (nums(have), nums(need));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (*a.get(i).unwrap_or(&0), *b.get(i).unwrap_or(&0));
        if x != y {
            return x > y;
        }
    }
    true
}

/// The pinned Node needs a minimum macOS. When `sw_vers` cannot answer, the install is tried.
fn check_macos(need: &str) -> Result<(), SetupError> {
    if std::env::consts::OS != "macos" {
        return Ok(());
    }
    match output_with_timeout(Command::new("/usr/bin/sw_vers").arg("-productVersion"), VERSION_PROBE_TIMEOUT) {
        Some(have) if !version_at_least(&have, need) => Err(SetupError::UnsupportedOs { need: need.to_string() }),
        _ => Ok(()),
    }
}

/// Download `url` to `dest` with the system curl: https only, redirects included, TLS 1.2+,
/// a size ceiling, progress from the growing file, and a cancel that kills the transfer.
fn curl_fetch(
    url: &str,
    dest: &Path,
    max_bytes: u64,
    progress: &dyn Fn(u64),
    cancel: &AtomicBool,
) -> Result<(), SetupError> {
    if !url.starts_with("https://") {
        return Err(SetupError::Other("Refusing a download that is not https.".into()));
    }
    let mut child = Command::new("/usr/bin/curl")
        .args(["--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--fail", "--location"])
        .args(["--silent", "--connect-timeout", "20", "--max-filesize"])
        .arg(max_bytes.to_string())
        .arg("-o")
        .arg(dest)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| io_error(e, "Could not start the download"))?;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SetupError::Canceled);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                progress(fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
                return match status.code() {
                    Some(0) => Ok(()),
                    // resolve, connect, timeout, TLS connect, empty reply, receive failure
                    Some(6) | Some(7) | Some(28) | Some(35) | Some(52) | Some(56) => Err(SetupError::Offline),
                    Some(23) => Err(SetupError::Disk),
                    Some(63) => Err(SetupError::Checksum),
                    code => Err(SetupError::Other(format!("The download failed (curl {code:?})."))),
                };
            }
            Ok(None) => {
                progress(fs::metadata(dest).map(|m| m.len()).unwrap_or(0));
                thread::sleep(PROGRESS_TICK);
            }
            Err(e) => return Err(io_error(e, "Lost track of the download")),
        }
    }
}

type Fetch<'a> = dyn Fn(&Path, &dyn Fn(u64), &AtomicBool) -> Result<(), SetupError> + 'a;

/// The whole install into `home`, with the download injected so tests can supply a local file.
pub(crate) fn install_into(
    home: &Path,
    version: &str,
    pin: &PinEntry,
    fetch: &Fetch<'_>,
    report: &dyn Fn(Phase, u64, Option<u64>),
    cancel: &AtomicBool,
) -> Result<String, SetupError> {
    let root = prepare_root(home)?;
    let partial = create_partial(&root, std::process::id(), unix_nanos())?;
    let result = (|| {
        let archive = partial.join(&pin.file);
        report(Phase::Downloading, 0, Some(pin.size));
        fetch(&archive, &|received| report(Phase::Downloading, received, Some(pin.size)), cancel)?;
        check_cancel(cancel)?;
        report(Phase::Verifying, pin.size, Some(pin.size));
        verify_archive(&archive, pin)?;
        check_cancel(cancel)?;
        report(Phase::Unpacking, pin.size, Some(pin.size));
        let unpacked = partial.join("root");
        fs::create_dir(&unpacked).map_err(|e| io_error(e, "Could not create the unpack folder"))?;
        unpack(&archive, &unpacked)?;
        let previous = current_version(&root);
        let version_dir = place_version(&root, &unpacked, version)?;
        write_npmrc(&version_dir, home)?;
        swap_current(&root, version)?;
        let node = root.join("current").join("bin").join("node");
        let node = node.to_string_lossy().into_owned();
        match probe_version(&node) {
            Some(v) if v.0 >= MIN_NODE_MAJOR => {}
            _ => return Err(SetupError::Other("The installed Node.js did not start.".into())),
        }
        let mut keep = vec![version.to_string()];
        keep.extend(previous.filter(|p| p != version));
        prune(&root, &keep);
        report(Phase::Done, pin.size, Some(pin.size));
        Ok(node)
    })();
    let _ = fs::remove_dir_all(&partial);
    result
}

/// Install the pinned Node for this computer into `~/.dreamcontext/node`. Returns the path of
/// `current/bin/node`.
pub(crate) fn install_managed(
    report: &dyn Fn(Phase, u64, Option<u64>),
    cancel: &AtomicBool,
) -> Result<String, SetupError> {
    let home = home_dir().ok_or_else(|| SetupError::Other("The home folder is not set.".into()))?;
    let pins = node_pins()?;
    check_macos(&pins.min_macos)?;
    let pin = pin_for_host(pins)?;
    let url = format!("{}{}", pins.base, pin.file);
    let max_bytes = pin.size + MIB;
    let fetch = |dest: &Path, progress: &dyn Fn(u64), cancel: &AtomicBool| {
        curl_fetch(&url, dest, max_bytes, progress, cancel)
    };
    install_into(&home, &pins.version, pin, &fetch, report, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A scratch folder removed on drop (no tempfile crate in this workspace).
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("dc-node-rt-{tag}-{}-{}", std::process::id(), unix_nanos()));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sha256_hex(path: &Path) -> String {
        let bytes = fs::read(path).unwrap();
        Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A tar.gz shaped like Node's: `node-v24.21.0-test/bin/node`, where `node` is a script
    /// answering `--version` like the real binary.
    fn fake_node_archive(dir: &Path) -> (PathBuf, PinEntry) {
        let top = dir.join("src").join("node-v24.21.0-test").join("bin");
        fs::create_dir_all(&top).unwrap();
        let node = top.join("node");
        fs::write(&node, "#!/bin/sh\necho v24.21.0\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        let archive = dir.join("node-v24.21.0-test.tar.gz");
        let ok = Command::new(tar_binary())
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.join("src"))
            .arg("node-v24.21.0-test")
            .status()
            .unwrap()
            .success();
        assert!(ok, "building the fake archive failed");
        let pin = PinEntry {
            file: "node-v24.21.0-test.tar.gz".into(),
            sha256: sha256_hex(&archive),
            size: fs::metadata(&archive).unwrap().len(),
        };
        (archive, pin)
    }

    fn copy_fetch(src: PathBuf) -> impl Fn(&Path, &dyn Fn(u64), &AtomicBool) -> Result<(), SetupError> {
        move |dest: &Path, progress: &dyn Fn(u64), _cancel: &AtomicBool| {
            let n = fs::copy(&src, dest).map_err(|e| SetupError::Other(e.to_string()))?;
            progress(n);
            Ok(())
        }
    }

    #[test]
    fn parses_node_versions() {
        assert_eq!(parse_node_version("v24.21.0\n"), Some((24, 21, 0)));
        assert_eq!(parse_node_version("18.0.0"), Some((18, 0, 0)));
        assert_eq!(parse_node_version("v25.0.0-pre"), Some((25, 0, 0)));
        assert_eq!(parse_node_version("v1.2"), None);
        assert_eq!(parse_node_version("garbage"), None);
        assert_eq!(parse_node_version(""), None);
    }

    #[test]
    fn skips_a_too_old_node_and_takes_the_next_good_one() {
        let cands = vec![("/old".to_string(), false), ("/new".to_string(), true)];
        let probe = |p: &str| if p == "/old" { Some((16, 20, 2)) } else { Some((24, 21, 0)) };
        let got = resolve_from(&cands, |_| true, probe).unwrap();
        assert_eq!(got, NodeChoice { path: "/new".into(), version: (24, 21, 0), managed: true });
    }

    #[test]
    fn reports_too_old_when_only_old_nodes_exist_and_missing_when_none() {
        let cands = vec![("/old".to_string(), false), ("/gone".to_string(), false)];
        let err = resolve_from(&cands, |p| p == "/old", |_| Some((16, 0, 0))).unwrap_err();
        assert_eq!(err, NodeProblem::TooOld { found: "/old".into(), version: "16.0.0".into() });
        assert_eq!(err.reason(), "too-old");
        let err = resolve_from(&cands, |_| false, |_| Some((24, 0, 0))).unwrap_err();
        assert_eq!(err, NodeProblem::Missing);
        let err = resolve_from(&cands, |_| true, |_| None).unwrap_err();
        assert_eq!(err, NodeProblem::Missing);
    }

    #[test]
    fn embedded_pins_cover_every_host_key() {
        let pins = parse_pins(PINS_JSON).unwrap();
        assert!(is_version_name(&pins.version));
        assert!(version_at_least(&pins.min_macos, "11.0"));
        for key in ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] {
            let pin = pins.files.get(key).unwrap_or_else(|| panic!("missing pin {key}"));
            assert!(pin.file.contains(&pins.version) && pin.file.contains(key), "{key}: {}", pin.file);
        }
        assert_eq!(host_key("macos", "aarch64"), Some("darwin-arm64"));
        assert_eq!(host_key("macos", "x86_64"), Some("darwin-x64"));
        assert_eq!(host_key("linux", "aarch64"), Some("linux-arm64"));
        assert_eq!(host_key("windows", "x86_64"), None);
        assert!(node_pins().is_ok());
    }

    #[test]
    fn rejects_malformed_pins() {
        let bad_base = r#"{"node":{"version":"24.1.0","minMacos":"13.5","base":"http://x/","files":{}}}"#;
        assert!(parse_pins(bad_base).is_err());
        let bad_file = r#"{"node":{"version":"24.1.0","minMacos":"13.5","base":"https://x/","files":{"darwin-arm64":{"file":"../x.tar.gz","sha256":"00","size":1}}}}"#;
        assert!(parse_pins(bad_file).is_err());
    }

    #[test]
    fn checksum_and_size_mismatches_are_refused() {
        let s = Scratch::new("sha");
        let file = s.0.join("a.tar.gz");
        fs::write(&file, b"hello").unwrap();
        let good = PinEntry { file: "a.tar.gz".into(), sha256: sha256_hex(&file), size: 5 };
        assert_eq!(verify_archive(&file, &good), Ok(()));
        let wrong_sha = PinEntry { sha256: "0".repeat(64), ..good.clone() };
        assert_eq!(verify_archive(&file, &wrong_sha), Err(SetupError::Checksum));
        let wrong_size = PinEntry { size: 6, ..good };
        assert_eq!(verify_archive(&file, &wrong_size), Err(SetupError::Checksum));
    }

    #[test]
    fn an_existing_staging_folder_is_never_reused() {
        let s = Scratch::new("partial");
        let taken = s.0.join(".partial-7-100");
        fs::create_dir(&taken).unwrap();
        fs::write(taken.join("keep"), b"x").unwrap();
        let got = create_partial(&s.0, 7, 100).unwrap();
        assert_eq!(got, s.0.join(".partial-7-101"));
        assert!(taken.join("keep").exists());
    }

    #[test]
    fn an_existing_version_folder_is_moved_aside() {
        let s = Scratch::new("aside");
        fs::create_dir_all(s.0.join("24.21.0").join("lib")).unwrap();
        let unpacked = s.0.join("unpacked");
        fs::create_dir_all(unpacked.join("bin")).unwrap();
        place_version(&s.0, &unpacked, "24.21.0").unwrap();
        assert!(s.0.join("24.21.0").join("bin").exists());
        let aside: Vec<String> = fs::read_dir(&s.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("24.21.0.old-"))
            .collect();
        assert_eq!(aside.len(), 1);
        assert!(s.0.join(&aside[0]).join("lib").exists());
    }

    #[test]
    fn current_swaps_atomically_and_a_real_current_folder_is_refused() {
        let s = Scratch::new("current");
        fs::create_dir(s.0.join("24.1.0")).unwrap();
        fs::create_dir(s.0.join("24.2.0")).unwrap();
        swap_current(&s.0, "24.1.0").unwrap();
        assert_eq!(current_version(&s.0).as_deref(), Some("24.1.0"));
        swap_current(&s.0, "24.2.0").unwrap();
        assert_eq!(fs::read_link(s.0.join("current")).unwrap(), PathBuf::from("24.2.0"));

        let t = Scratch::new("current-dir");
        fs::create_dir(t.0.join("current")).unwrap();
        assert!(swap_current(&t.0, "24.2.0").is_err());
        assert!(t.0.join("current").is_dir());
    }

    #[test]
    fn npmrc_points_global_packages_outside_the_version_folder() {
        let home = Path::new("/Users/öğretmen");
        assert_eq!(npmrc_contents(home).unwrap(), "prefix=/Users/öğretmen/.dreamcontext/npm-global\n");
        assert!(npmrc_contents(Path::new("/Users/a\nb")).is_err());
    }

    #[test]
    fn pruning_removes_only_old_version_folders() {
        let s = Scratch::new("prune");
        for d in ["24.1.0", "24.2.0", "24.3.0", "24.2.0.old-123", ".partial-1-2", "notes", "24.x.0"] {
            fs::create_dir(s.0.join(d)).unwrap();
        }
        std::os::unix::fs::symlink("24.3.0", s.0.join("current")).unwrap();
        std::os::unix::fs::symlink("24.3.0", s.0.join("9.9.9")).unwrap();
        let mut removed = prune(&s.0, &["24.3.0".to_string(), "24.2.0".to_string()]);
        removed.sort();
        assert_eq!(removed, vec!["24.1.0".to_string(), "24.2.0.old-123".to_string()]);
        for kept in ["24.2.0", "24.3.0", "current", ".partial-1-2", "notes", "24.x.0", "9.9.9"] {
            assert!(fs::symlink_metadata(s.0.join(kept)).is_ok(), "{kept} was removed");
        }
        assert!(s.0.join("24.3.0").is_dir(), "a link's target must survive");
    }

    #[test]
    fn compares_macos_versions() {
        assert!(version_at_least("14.2.1", "13.5"));
        assert!(version_at_least("13.5", "13.5"));
        assert!(!version_at_least("13.4.1", "13.5"));
        assert!(!version_at_least("12.7", "13.5"));
    }

    #[test]
    fn installs_end_to_end_and_cleans_the_staging_folder() {
        let s = Scratch::new("install");
        let home = s.0.join("home");
        fs::create_dir(&home).unwrap();
        let (archive, pin) = fake_node_archive(&s.0);
        let cancel = AtomicBool::new(false);
        let phases = std::sync::Mutex::new(Vec::new());
        let report = |p: Phase, _: u64, _: Option<u64>| phases.lock().unwrap().push(p);
        let node = install_into(&home, "24.21.0", &pin, &copy_fetch(archive), &report, &cancel).unwrap();

        let root = managed_root(&home);
        assert_eq!(node, managed_node_bin(&home).to_string_lossy());
        assert_eq!(fs::read_link(root.join("current")).unwrap(), PathBuf::from("24.21.0"));
        assert_eq!(
            fs::read_to_string(root.join("24.21.0/etc/npmrc")).unwrap(),
            npmrc_contents(&home).unwrap()
        );
        assert_eq!(probe_version(&node), Some((24, 21, 0)));
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with(".partial-"))
            .collect();
        assert!(leftovers.is_empty(), "staging folder left behind");
        let seen = phases.lock().unwrap().clone();
        assert_eq!(seen.first(), Some(&Phase::Downloading));
        assert_eq!(seen.last(), Some(&Phase::Done));
    }

    #[test]
    fn a_bad_download_installs_nothing() {
        let s = Scratch::new("bad");
        let home = s.0.join("home");
        fs::create_dir(&home).unwrap();
        let (archive, pin) = fake_node_archive(&s.0);
        let wrong = PinEntry { sha256: "f".repeat(64), ..pin };
        let cancel = AtomicBool::new(false);
        let err = install_into(&home, "24.21.0", &wrong, &copy_fetch(archive), &|_, _, _| {}, &cancel).unwrap_err();
        assert_eq!(err, SetupError::Checksum);
        let root = managed_root(&home);
        assert!(fs::symlink_metadata(root.join("current")).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "staging folder left behind");
    }

    #[test]
    fn a_cancel_stops_before_anything_is_placed() {
        let s = Scratch::new("cancel");
        let home = s.0.join("home");
        fs::create_dir(&home).unwrap();
        let (archive, pin) = fake_node_archive(&s.0);
        let cancel = AtomicBool::new(true);
        let err = install_into(&home, "24.21.0", &pin, &copy_fetch(archive), &|_, _, _| {}, &cancel).unwrap_err();
        assert_eq!(err, SetupError::Canceled);
        assert_eq!(fs::read_dir(managed_root(&home)).unwrap().count(), 0);
    }

    #[test]
    fn a_linked_dreamcontext_folder_is_refused() {
        let s = Scratch::new("link");
        let home = s.0.join("home");
        let elsewhere = s.0.join("elsewhere");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, home.join(".dreamcontext")).unwrap();
        let (archive, pin) = fake_node_archive(&s.0);
        let cancel = AtomicBool::new(false);
        let err = install_into(&home, "24.21.0", &pin, &copy_fetch(archive), &|_, _, _| {}, &cancel).unwrap_err();
        assert!(matches!(err, SetupError::Other(_)));
        assert_eq!(fs::read_dir(&elsewhere).unwrap().count(), 0, "wrote through the link");
    }
}
