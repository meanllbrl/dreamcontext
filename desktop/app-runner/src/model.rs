//! The runner's pure half: everything that decides, parses or validates without touching
//! AppKit. Kept apart so `cargo test` proves the contract on any machine.
//!
//! Contract (plan r19, "Kontrat"): the bundle carries `Resources/dreamcontext-app.json`;
//! the dreamcontext shell's Node child writes `~/.dreamcontext/desktop-server.json`; the
//! runner trades the file's `launchToken` for a one-time gateway URL plus a `runnerToken`,
//! then heartbeats the gateway every 2 s.

use serde_json::Value;

/// `Contents/Resources/dreamcontext-app.json`, stamped by `src/lib/apps/bundle.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct BundleInfo {
    pub project_root: String,
    pub vault: String,
    pub slug: String,
    pub name: String,
    /// The dreamcontext SHELL's bundle id. The only place the runner learns it from:
    /// never from desktop-server.json, which anyone running as the owner can write.
    pub app_bundle_id: String,
}

pub fn parse_bundle_info(raw: &str) -> Result<BundleInfo, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("bundle info is not JSON: {e}"))?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("bundle info: unknown schema".into());
    }
    let s = |k: &str| -> Result<String, String> {
        v.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("bundle info: missing {k}"))
    };
    let info = BundleInfo {
        project_root: s("projectRoot")?,
        vault: s("vault")?,
        slug: s("slug")?,
        name: s("name")?,
        app_bundle_id: s("appBundleId")?,
    };
    if !is_slug(&info.slug) {
        return Err("bundle info: bad slug".into());
    }
    if !is_bundle_id(&info.app_bundle_id) {
        return Err("bundle info: bad appBundleId".into());
    }
    Ok(info)
}

/// The app slug grammar shared with `src/lib/apps/manifest.ts`.
pub fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// The runner's "post one notification" mode. The gateway finds this flag in the binary before
/// it uses it: an older runner would ignore the flag and open a window instead.
pub const NOTIFY_FLAG: &str = "--dc-notify-1";
pub const NOTIFY_MAX_BYTES: u64 = 16 * 1024;
/// Kept in the binary for that search: the optimiser turns the comparison in main() into
/// immediates, and the string goes (measured on the release build).
#[used]
static NOTIFY_CAPABILITY: [u8; 13] = *b"--dc-notify-1";

#[derive(Debug, PartialEq, Eq)]
pub struct NotifyPayload {
    pub title: String,
    pub body: String,
    /// A name from /System/Library/Sounds; None is silent.
    pub sound: Option<String>,
}

pub fn parse_notify_payload(raw: &str) -> Result<NotifyPayload, String> {
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("payload is not JSON: {e}"))?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (title, body) = (text("title"), text("body"));
    if title.is_empty() || body.is_empty() {
        return Err("payload: title and body are required".into());
    }
    let sound = match v.get("sound") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric()) => Some(s.clone()),
        Some(_) => return Err("payload: bad sound".into()),
    };
    Ok(NotifyPayload { title, body, sound })
}

/// A reverse-DNS bundle id: letters, digits, dots and dashes only (it goes into `open -b`).
pub fn is_bundle_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.contains('.')
        && !s.starts_with(['.', '-'])
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
}

/// `~/.dreamcontext/desktop-server.json` once its bytes were read through the checks in
/// [`server_file_meta_ok`].
#[derive(Debug, Clone, PartialEq)]
pub struct ServerFile {
    pub port: u16,
    pub launch_token: String,
}

pub fn parse_server_file(raw: &str) -> Option<ServerFile> {
    let v: Value = serde_json::from_str(raw).ok()?;
    if v.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let port = v.get("port").and_then(Value::as_u64).filter(|p| *p > 0 && *p <= 65535)? as u16;
    let token = v.get("launchToken").and_then(Value::as_str)?;
    if token.len() < 32 || token.len() > 256 || !token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    Some(ServerFile { port, launch_token: token.to_string() })
}

/// The file is trusted only when it is a plain file (opened `O_NOFOLLOW`), owned by the
/// runner's own uid, and mode exactly 0600. The token is sent only after this holds AND
/// the shell is alive (`NSRunningApplication`).
pub fn server_file_meta_ok(is_regular: bool, file_uid: u32, my_uid: u32, mode: u32) -> bool {
    is_regular && file_uid == my_uid && (mode & 0o777) == 0o600
}

/// The launch-window URL must be EXACTLY `http://127.0.0.1:<port>/__dc/enter?code=…`.
/// Returns the gateway port when it is.
pub fn enter_url_port(url: &str) -> Option<u16> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 5 {
        return None;
    }
    let after = &rest[digits.len()..];
    let code = after.strip_prefix("/__dc/enter?code=")?;
    if code.is_empty() || !code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    let port: u32 = digits.parse().ok()?;
    if port == 0 || port > 65535 {
        return None;
    }
    Some(port as u16)
}

/// Same origin as the gateway: `http://127.0.0.1:<port>` followed by `/`, `?`, `#` or nothing.
pub fn is_gateway_url(url: &str, port: u16) -> bool {
    let origin = format!("http://127.0.0.1:{port}");
    match url.strip_prefix(&origin) {
        Some(rest) => rest.is_empty() || rest.starts_with(['/', '?', '#']),
        None => false,
    }
}

/// Where a main-frame navigation goes.
#[derive(Debug, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    /// Leave the app: hand the URL to the default browser.
    OpenExternally,
    Deny,
}

pub fn decide_navigation(url: &str, gateway_port: Option<u16>, internal_page: bool) -> NavDecision {
    // The runner's own status screens load from a string (about:blank).
    if internal_page && (url == "about:blank" || url.starts_with("about:blank")) {
        return NavDecision::Allow;
    }
    if let Some(p) = gateway_port {
        if is_gateway_url(url, p) {
            return NavDecision::Allow;
        }
    }
    let lower = url.to_ascii_lowercase();
    // `dreamcontext://`: an embedded screen's "open in the main app" link. macOS routes it.
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("dreamcontext://") {
        return NavDecision::OpenExternally;
    }
    NavDecision::Deny
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
    System,
}

impl Theme {
    pub fn parse(v: Option<&str>) -> Theme {
        match v {
            Some("dark") => Theme::Dark,
            Some("light") => Theme::Light,
            _ => Theme::System,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::Dark => "dark",
            Theme::Light => "light",
            Theme::System => "system",
        }
    }
}

/// What the gateway said on `POST /__dc/runner/heartbeat`.
#[derive(Debug, Clone, PartialEq)]
pub struct Heartbeat {
    pub rev: u64,
    pub theme: Theme,
    pub state: String,
    pub snapshot: Option<String>,
}

pub fn parse_heartbeat(raw: &[u8]) -> Option<Heartbeat> {
    let v: Value = serde_json::from_slice(raw).ok()?;
    let snapshot = v
        .get("command")
        .filter(|c| c.get("type").and_then(Value::as_str) == Some("snapshot"))
        .and_then(|c| c.get("id"))
        .and_then(Value::as_str)
        .filter(|id| is_token(id))
        .map(str::to_string);
    Some(Heartbeat {
        rev: v.get("rev").and_then(Value::as_u64).unwrap_or(0),
        theme: Theme::parse(v.get("theme").and_then(Value::as_str)),
        state: v.get("state").and_then(Value::as_str).unwrap_or("running").to_string(),
        snapshot,
    })
}

/// `POST /api/apps/launch-window` answer.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchWindow {
    pub url: String,
    pub gateway_port: u16,
    pub runner_token: String,
    pub title: Option<String>,
    pub state: String,
    pub theme: Theme,
    pub last_error: Option<String>,
    /// The dashboard server's port (desktop-server.json): an embedded screen's own origin.
    pub dashboard_port: u16,
}

pub fn parse_launch_window(raw: &[u8]) -> Result<LaunchWindow, String> {
    let v: Value = serde_json::from_slice(raw).map_err(|_| "launch-window answer is not JSON".to_string())?;
    let url = v.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    let gateway_port = enter_url_port(&url).ok_or("launch-window url is not a gateway enter url")?;
    let runner_token = v
        .get("runnerToken")
        .and_then(Value::as_str)
        .filter(|t| is_token(t))
        .ok_or("launch-window answer has no runnerToken")?
        .to_string();
    Ok(LaunchWindow {
        url,
        gateway_port,
        runner_token,
        title: v.get("title").and_then(Value::as_str).map(clean_title),
        state: v.get("state").and_then(Value::as_str).unwrap_or("running").to_string(),
        theme: Theme::parse(v.get("theme").and_then(Value::as_str)),
        last_error: v.get("lastError").and_then(Value::as_str).map(|s| s.chars().take(400).collect()),
        dashboard_port: 0,
    })
}

/// May a SUBFRAME load this URL? Only the app's gateway, the dashboard (an embedded screen), and
/// the documents a frame holds without a fetch. Whatever a frame on screen draws, a page it
/// navigates to elsewhere would carry what it read off this machine in its URL, with no click.
pub fn subframe_allowed(url: &str, gateway_port: Option<u16>, dashboard_port: Option<u16>) -> bool {
    if url == "about:blank" || url == "about:srcdoc" {
        return true;
    }
    let inner = url.strip_prefix("blob:").unwrap_or(url);
    [gateway_port, dashboard_port].into_iter().flatten().filter(|p| *p != 0).any(|p| is_gateway_url(inner, p))
}

fn is_token(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// A window title: no control characters, one line, 60 characters (the manifest rule).
pub fn clean_title(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(60).collect()
}

/// When the first connection cannot reach the server, what to do (plan r19 "Runner durum
/// makinesi"). A running window NEVER takes this path: it only ever re-reads the file.
#[derive(Debug, PartialEq, Eq)]
pub enum FirstReach {
    /// No shell: `open -g -b <id> --args --background`, then poll 20 s.
    OpenShellThenPoll,
    /// The shell is alive: `open` would only send Reopen to a dead port; just poll.
    PollOnly,
}

pub fn first_reach(shell_alive: bool) -> FirstReach {
    if shell_alive {
        FirstReach::PollOnly
    } else {
        FirstReach::OpenShellThenPoll
    }
}

/// Heartbeats that failed in a row before the window says "Dreamcontext kapandı".
pub const HEARTBEAT_FAILS_TO_CLOSED: u32 = 3;

/// A suggested download name reduced to a safe basename inside ~/Downloads.
pub fn download_basename(suggested: &str) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let trimmed = cleaned.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "download".to_string()
    } else {
        trimmed.chars().take(200).collect()
    }
}

/// `name.ext` → `name (2).ext` for the n-th collision.
pub fn numbered_name(base: &str, n: u32) -> String {
    if n <= 1 {
        return base.to_string();
    }
    match base.rfind('.') {
        Some(i) if i > 0 => format!("{} ({n}){}", &base[..i], &base[i..]),
        _ => format!("{base} ({n})"),
    }
}

pub fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// The runner's own screens: connecting, closed, stopped, failed. A button posts its
/// action to the `dcRunner` handler, honoured only while one of these screens is up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Connecting,
    /// Dreamcontext went away under an open window. Never calls `open`.
    Closed,
    /// The owner stopped the backend (`stoppedByOwner`).
    Stopped,
    /// First connection: no shell and `open` did not bring it up in 20 s.
    CouldNotOpen,
    /// First connection: the shell is alive but its server never answered.
    ReopenDreamcontext,
    /// launch-window answered with a backend error.
    BackendError,
}

impl Screen {
    pub fn text(self) -> (&'static str, &'static str, Option<(&'static str, &'static str)>) {
        match self {
            Screen::Connecting => ("Bağlanıyor…", "Dreamcontext'e bağlanılıyor.", None),
            Screen::Closed => (
                "Dreamcontext kapandı",
                "Dreamcontext yeniden açılınca bu pencere kendiliğinden bağlanır.",
                Some(("Yeniden bağlan", "reconnect")),
            ),
            Screen::Stopped => (
                "Durduruldu",
                "Bu app'in arka ucu durduruldu.",
                Some(("Başlat", "start")),
            ),
            Screen::CouldNotOpen => (
                "Dreamcontext açılamadı",
                "Dreamcontext'i başlatmayı denedik ama yanıt gelmedi.",
                Some(("Yeniden dene", "reconnect")),
            ),
            Screen::ReopenDreamcontext => (
                "Dreamcontext'i yeniden aç",
                "Dreamcontext açık ama sunucusu yanıt vermiyor. Dreamcontext'ten çıkıp yeniden aç.",
                Some(("Yeniden dene", "reconnect")),
            ),
            Screen::BackendError => (
                "App başlatılamadı",
                "Arka uç hata verdi.",
                Some(("Yeniden dene", "reconnect")),
            ),
        }
    }
}

pub fn screen_html(screen: Screen, app_name: &str, detail: Option<&str>, theme: Theme) -> String {
    let (title, body, button) = screen.text();
    let detail = detail
        .map(|d| format!("<pre>{}</pre>", html_escape(d)))
        .unwrap_or_default();
    let button = button
        .map(|(label, action)| {
            format!(
                "<button onclick=\"window.webkit.messageHandlers.dcRunner.postMessage('{action}')\">{}</button>",
                html_escape(label)
            )
        })
        .unwrap_or_default();
    let spinner = if screen == Screen::Connecting { "<div class=\"spin\"></div>" } else { "" };
    format!(
        r#"<!doctype html><html data-theme="{theme}" lang="tr"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>
:root{{--bg:#f7f7fb;--fg:#1d1b26;--mut:#6b6880;--acc:#6d4aff}}
@media (prefers-color-scheme:dark){{:root{{--bg:#16151c;--fg:#ecebf3;--mut:#9a97ad;--acc:#9d85ff}}}}
html[data-theme=dark]{{--bg:#16151c;--fg:#ecebf3;--mut:#9a97ad;--acc:#9d85ff}}
html[data-theme=light]{{--bg:#f7f7fb;--fg:#1d1b26;--mut:#6b6880;--acc:#6d4aff}}
html,body{{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}}
main{{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;box-sizing:border-box;text-align:center}}
h1{{font-size:18px;font-weight:600;margin:0}} p{{margin:0;color:var(--mut);max-width:420px}}
small{{color:var(--mut)}} pre{{max-width:520px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--mut);font-size:12px}}
button{{margin-top:8px;padding:8px 16px;border-radius:8px;border:0;background:var(--acc);color:#fff;font:inherit;cursor:pointer}}
.spin{{width:22px;height:22px;border-radius:50%;border:2px solid var(--mut);border-top-color:var(--acc);animation:s 0.9s linear infinite}}
@keyframes s{{to{{transform:rotate(360deg)}}}}
</style></head><body><main>{spinner}<small>{app}</small><h1>{title}</h1><p>{body}</p>{detail}{button}</main></body></html>"#,
        theme = theme.as_str(),
        app = html_escape(app_name),
        title = html_escape(title),
        body = html_escape(body),
    )
}

/// The script every app page gets at document start: the dreamcontext theme on `<html>`
/// and `window.dcRunner.copy` (OS pasteboard, no Mac Roman mangling).
pub fn page_bootstrap_script(theme: Theme) -> String {
    format!(
        "(function(){{try{{document.documentElement.setAttribute('data-theme','{t}');}}catch(e){{}}\
window.dcRunner=Object.freeze({{theme:'{t}',copy:function(t){{window.webkit.messageHandlers.dcCopy.postMessage(String(t));}}}});}})();",
        t = theme.as_str()
    )
}

/// Live theme change on an already-loaded page.
pub fn theme_change_script(theme: Theme) -> String {
    format!(
        "try{{document.documentElement.setAttribute('data-theme','{t}');window.dispatchEvent(new CustomEvent('dc-theme',{{detail:'{t}'}}));}}catch(e){{}}",
        t = theme.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subframes_stay_on_the_two_origins() {
        let ok = |u: &str| subframe_allowed(u, Some(5100), Some(4000));
        assert!(ok("http://127.0.0.1:5100/x"));
        assert!(ok("http://127.0.0.1:4000/?embed=chat"));
        assert!(ok("about:srcdoc"));
        assert!(ok("about:blank"));
        assert!(ok("blob:http://127.0.0.1:4000/abc"));
        assert!(!ok("https://attacker.example/?d=SECRET"));
        assert!(!ok("http://127.0.0.1:4001/"));
        assert!(!ok("http://127.0.0.1:40000/"));
        assert!(!ok("http://localhost:4000/"));
        assert!(!ok("http://127.0.0.1:4000.evil.example/"));
        assert!(!ok("http://127.0.0.1:4000@evil.example/"));
        assert!(!ok("data:text/html,x"));
        assert!(!ok("javascript:alert(1)"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("about:blank#x"));
        assert!(!ok("blob:https://evil.example/abc"));
        assert!(!subframe_allowed("http://127.0.0.1:0/", Some(0), Some(0)));
    }

    #[test]
    fn notify_payload() {
        let p = parse_notify_payload(r#"{"title":"Yük","body":"b","sound":"Glass"}"#).unwrap();
        assert_eq!(p, NotifyPayload { title: "Yük".into(), body: "b".into(), sound: Some("Glass".into()) });
        assert_eq!(parse_notify_payload(r#"{"title":"t","body":"b"}"#).unwrap().sound, None);
        assert!(parse_notify_payload(r#"{"title":"t","body":"b","sound":"../x"}"#).is_err());
        assert!(parse_notify_payload(r#"{"title":"t","body":"b","sound":true}"#).is_err());
        assert!(parse_notify_payload(r#"{"title":"","body":"b"}"#).is_err());
        assert!(parse_notify_payload("nope").is_err());
    }

    const INFO: &str = r#"{"schema":1,"projectRoot":"/Users/a/acme","vault":"acme","slug":"meta-ads","name":"Meta Ads","appBundleId":"com.dreamcontext.beta"}"#;

    #[test]
    fn bundle_info_parses_and_rejects() {
        let i = parse_bundle_info(INFO).unwrap();
        assert_eq!(i.slug, "meta-ads");
        assert_eq!(i.app_bundle_id, "com.dreamcontext.beta");
        assert!(parse_bundle_info(&INFO.replace("\"schema\":1", "\"schema\":2")).is_err());
        assert!(parse_bundle_info(&INFO.replace("meta-ads", "Meta Ads")).is_err());
        assert!(parse_bundle_info(&INFO.replace("com.dreamcontext.beta", "x; rm -rf")).is_err());
        assert!(parse_bundle_info("{}").is_err());
    }

    #[test]
    fn server_file_needs_schema_port_and_token() {
        let tok = "a".repeat(43);
        let ok = format!(r#"{{"schema":1,"pid":12,"port":4173,"launchToken":"{tok}","appBundleId":"x.y"}}"#);
        assert_eq!(parse_server_file(&ok), Some(ServerFile { port: 4173, launch_token: tok.clone() }));
        assert!(parse_server_file(&ok.replace("\"schema\":1", "\"schema\":9")).is_none());
        assert!(parse_server_file(&ok.replace("4173", "0")).is_none());
        assert!(parse_server_file(&ok.replace(&tok, "short")).is_none());
        assert!(parse_server_file(&ok.replace(&tok, &format!("{}\\n", "b".repeat(40)))).is_none());
    }

    #[test]
    fn server_file_meta_gate() {
        assert!(server_file_meta_ok(true, 501, 501, 0o100600));
        assert!(!server_file_meta_ok(false, 501, 501, 0o600), "symlink/dir refused");
        assert!(!server_file_meta_ok(true, 0, 501, 0o600), "someone else's file refused");
        assert!(!server_file_meta_ok(true, 501, 501, 0o644), "group/world readable refused");
    }

    #[test]
    fn enter_url_is_exact() {
        assert_eq!(enter_url_port("http://127.0.0.1:51234/__dc/enter?code=abcDEF_-123"), Some(51234));
        for bad in [
            "http://localhost:51234/__dc/enter?code=a",
            "https://127.0.0.1:51234/__dc/enter?code=a",
            "http://127.0.0.1:51234/__dc/enter?code=",
            "http://127.0.0.1:51234/__dc/enter?code=a&next=//evil",
            "http://127.0.0.1:51234@evil.com/__dc/enter?code=a",
            "http://127.0.0.1:99999/__dc/enter?code=a",
            "http://127.0.0.1:/__dc/enter?code=a",
            "http://127.0.0.1:51234/x/__dc/enter?code=a",
        ] {
            assert_eq!(enter_url_port(bad), None, "{bad}");
        }
    }

    #[test]
    fn navigation_rules() {
        assert_eq!(decide_navigation("http://127.0.0.1:5000/x", Some(5000), false), NavDecision::Allow);
        assert_eq!(decide_navigation("http://127.0.0.1:5000", Some(5000), false), NavDecision::Allow);
        assert_eq!(decide_navigation("http://127.0.0.1:50001/x", Some(5000), false), NavDecision::OpenExternally);
        assert_eq!(decide_navigation("http://127.0.0.1:5000.evil.com/", Some(5000), false), NavDecision::OpenExternally);
        assert_eq!(decide_navigation("https://graph.facebook.com/", Some(5000), false), NavDecision::OpenExternally);
        assert_eq!(decide_navigation("dreamcontext://project/acme/page/agents", Some(5000), false), NavDecision::OpenExternally);
        assert_eq!(decide_navigation("file:///etc/passwd", Some(5000), false), NavDecision::Deny);
        assert_eq!(decide_navigation("javascript:alert(1)", Some(5000), false), NavDecision::Deny);
        assert_eq!(decide_navigation("about:blank", Some(5000), false), NavDecision::Deny);
        assert_eq!(decide_navigation("about:blank", None, true), NavDecision::Allow);
    }

    #[test]
    fn heartbeat_parse() {
        let h = parse_heartbeat(br#"{"rev":4,"lastError":null,"theme":"dark","state":"running","command":{"id":"abc_1","type":"snapshot"}}"#).unwrap();
        assert_eq!(h, Heartbeat { rev: 4, theme: Theme::Dark, state: "running".into(), snapshot: Some("abc_1".into()) });
        let h = parse_heartbeat(br#"{"rev":1,"state":"stopped","command":{"id":"../x","type":"snapshot"}}"#).unwrap();
        assert_eq!(h.snapshot, None, "an id that is not a token is ignored");
        assert_eq!(h.theme, Theme::System);
        assert!(parse_heartbeat(b"<html>").is_none());
    }

    #[test]
    fn launch_window_parse() {
        let tok = "r".repeat(43);
        let ok = format!(r#"{{"url":"http://127.0.0.1:6001/__dc/enter?code=c0de","runnerToken":"{tok}","title":"Meta\nAds","state":"running","theme":"light"}}"#);
        let lw = parse_launch_window(ok.as_bytes()).unwrap();
        assert_eq!(lw.gateway_port, 6001);
        assert_eq!(lw.title.as_deref(), Some("MetaAds"));
        assert_eq!(lw.theme, Theme::Light);
        assert!(parse_launch_window(ok.replace("127.0.0.1:6001", "evil.com").as_bytes()).is_err());
        assert!(parse_launch_window(ok.replace(&tok, "").as_bytes()).is_err());
    }

    #[test]
    fn first_reach_never_opens_a_live_shell() {
        assert_eq!(first_reach(true), FirstReach::PollOnly);
        assert_eq!(first_reach(false), FirstReach::OpenShellThenPoll);
    }

    #[test]
    fn download_names() {
        assert_eq!(download_basename("../../.ssh/id_rsa"), "id_rsa");
        assert_eq!(download_basename(".bashrc"), "bashrc");
        assert_eq!(download_basename("a\\b\\rapor.csv"), "rapor.csv");
        assert_eq!(download_basename(""), "download");
        assert_eq!(download_basename("x\u{0}y.txt"), "xy.txt");
        assert_eq!(numbered_name("rapor.csv", 2), "rapor (2).csv");
        assert_eq!(numbered_name("README", 3), "README (3)");
        assert_eq!(numbered_name("a.csv", 1), "a.csv");
    }

    #[test]
    fn screens_escape_and_carry_buttons() {
        let html = screen_html(Screen::BackendError, "<b>App</b>", Some("<script>x</script>"), Theme::Dark);
        assert!(html.contains("&lt;b&gt;App&lt;/b&gt;"));
        assert!(html.contains("&lt;script&gt;x&lt;/script&gt;"));
        assert!(!html.contains("<script>x"));
        assert!(html.contains("data-theme=\"dark\""));
        assert!(screen_html(Screen::Stopped, "a", None, Theme::System).contains("postMessage('start')"));
        assert!(screen_html(Screen::Closed, "a", None, Theme::System).contains("postMessage('reconnect')"));
        assert!(!screen_html(Screen::Connecting, "a", None, Theme::System).contains("<button"));
    }

    #[test]
    fn bootstrap_sets_theme() {
        assert!(page_bootstrap_script(Theme::Dark).contains("'data-theme','dark'"));
        assert!(theme_change_script(Theme::Light).contains("'light'"));
    }
}
