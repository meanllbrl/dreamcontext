// The owner's native yes for everything that lets a Telegram bot act for him.
//
// A header proves nothing on loopback (src/owner_key.rs): any process here can write Origin and
// Sec-Fetch-Site, and the project window never holds the owner key (only the notch does). So the
// four steps that hand a bot real power are confirmed HERE, in the shell:
//
//   - `confirm_telegram_binding(pairingId)`: a pending pairing becomes a live binding (B4, X2);
//   - `confirm_telegram_forward(forwardRequestId)`: a routine's results also go to its bot (W3, Y4);
//   - `start_telegram_creation(creationId)`: a one-tap bot creation goes live (X3, Z1), no dialog,
//     the owner's tap in Telegram's own create window is the confirmation;
//   - `start_telegram_readopt(readoptId)`: a bot made earlier is bound again (AA2, AB).
//
// Every command takes ONLY a server-minted id (Z1): the page mints it with its own vault header,
// the server fixes every value under it, and Rust calls vault-agnostic routes (AA1). Rust shows
// what the SERVER says the id means, cleaned of control and bidi characters, and posts back exactly
// what it showed with the owner key. The key is sent only while the server child this shell started
// is alive, so a server someone else put on the port never receives it.
//
// Caller contract, every command: the calling webview is an app page (`main` or `vault-*`, served
// by the app's own server, `owner_key::is_own_server_page`, 127.0.0.1 only); the id is 22 base64url characters; one call
// in flight across all four (a second while one is open is refused); every URL is built from fixed
// segments plus the checked id. macOS only: elsewhere binding is unavailable, never an in-page
// dialog (lib.rs `confirm_dialog` off macOS).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, Url, Webview};

/// The fixed route segments (AA1). Vault-agnostic prefixes: Rust sends no vault header.
const PAIRING: &str = "/api/telegram-pairing/";
const FORWARD: &str = "/api/telegram-forward/";
const CREATION: &str = "/api/telegram-creation/";
const READOPT: &str = "/api/telegram-readopt/";
/// The manager pairing's target in a `PairingPreview` (it cannot be a member slug).
const MANAGER_TARGET: &str = "@manager";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_CAP: u64 = 64 * 1024;
/// What a cleaned label may keep (a Telegram name is at most 64; a project name stays readable).
const LABEL_MAX: usize = 80;

/// One Telegram confirm or start at a time, app-wide.
static IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Holds the one slot until dropped, so every return path frees it.
struct Slot;
impl Slot {
    fn take() -> Result<Slot, String> {
        IN_FLIGHT
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Slot)
            .map_err(|_| "busy".to_string())
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

/// 128-bit, base64url, no padding: the shape every server-minted id has (`PAIRING_ID_RE`).
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A project window: the Launcher (`main`) or a vault window. Never the notch, a viewer, a
/// checklist or the snapshot window.
pub(crate) fn caller_label_ok(label: &str) -> bool {
    label == "main" || label.strip_prefix("vault-").is_some_and(|rest| !rest.is_empty())
}

/// The whole caller contract as one pure check, so the tests cover exactly what runs.
pub(crate) fn precheck(label: &str, url: &Url, port: u16, id: &str) -> Result<(), String> {
    if !caller_label_ok(label) || !crate::owner_key::is_own_server_page(url, port) {
        return Err("only the app's own project window can ask for this".into());
    }
    if !valid_id(id) {
        return Err("malformed id".into());
    }
    Ok(())
}

/// Bidi and invisible characters removed (an RTL override must not reorder the alert), control
/// characters turned into spaces, whitespace
/// collapsed, cut to a readable length.
pub(crate) fn clean_label(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| !is_bidi_or_invisible(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(LABEL_MAX).collect()
}

fn is_bidi_or_invisible(c: char) -> bool {
    matches!(c,
        '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}'
        | '\u{FEFF}' | '\u{E0000}'..='\u{E007F}')
}

/// `@name` for a username-looking label, the label as is otherwise.
fn at(name: &str) -> String {
    let n = clean_label(name);
    if n.is_empty() {
        return "?".into();
    }
    if n.starts_with('@') { n } else { format!("@{n}") }
}

// ─── Alert texts (W7, X2, Y4, AB) ─────────────────────────────────────────────

/// What the binding alert says, by target. A member's display name and its global flag are read
/// when the preview carries them (`targetLabel`, `global`), else the slug stands in.
pub(crate) fn binding_text(p: &Value) -> Option<(String, String)> {
    let target = p.get("target")?.as_str()?;
    let user = clean_label(p.get("userLabel")?.as_str()?);
    let user_id = p.get("userId")?.as_i64()?;
    let bot = at(p.get("botUsername")?.as_str()?);
    let project = clean_label(p.get("projectName").and_then(Value::as_str).unwrap_or(""));
    let who = format!("Telegram kullanıcısı {} (id {user_id})", if user.is_empty() { "?".into() } else { user });
    let body = if target == MANAGER_TARGET {
        format!("{who} bu Mac'in Telegram yöneticisi olsun mu?\n\nBot: {bot}")
    } else if target == "super" {
        format!("{who} bu projenin Super'ine bağlansın mı?\n\nProje: {project}\nBot: {bot}")
    } else {
        let name = p
            .get("targetLabel")
            .and_then(Value::as_str)
            .map(clean_label)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| clean_label(target));
        let global = p.get("global").and_then(Value::as_bool).unwrap_or(false);
        let scope = if global { " (tüm projelerde)" } else { "" };
        format!("{who} {name} üyesine{scope} bağlansın mı?\n\nProje: {project}\nBot: {bot}")
    };
    Some(("Telegram bağlansın mı?".into(), body))
}

pub(crate) fn forward_text(p: &Value) -> Option<(String, String)> {
    let project = clean_label(p.get("projectName")?.as_str()?);
    let routine = clean_label(p.get("routineTitle")?.as_str()?);
    let bot = at(p.get("botUsername")?.as_str()?);
    Some((
        "Rutin sonuçları Telegram'a gitsin mi?".into(),
        format!("{project} · {routine} sonuçları {bot} botuna da gitsin mi?"),
    ))
}

pub(crate) fn readopt_text(p: &Value) -> Option<(String, String)> {
    let project = clean_label(p.get("projectName")?.as_str()?);
    let target = clean_label(p.get("target")?.as_str()?);
    let bot = at(p.get("botUsername")?.as_str()?);
    let target = if target == "super" { "Super".to_string() } else { target };
    Some((
        "Bot yeniden bağlansın mı?".into(),
        format!("{project} · {target} için {bot} yeniden bağlansın mı?"),
    ))
}

// ─── HTTP/1.0 to the app's own server ─────────────────────────────────────────

/// The request bytes, from fixed parts only. `key` goes only on a POST.
pub(crate) fn build_request(method: &str, path: &str, port: u16, body: Option<&str>, key: Option<&str>) -> String {
    let mut req = format!(
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nSec-Fetch-Site: same-origin\r\nAccept: application/json\r\nConnection: close\r\n"
    );
    if let Some(k) = key {
        req.push_str(&format!("X-Dreamcontext-Owner-Key: {k}\r\n"));
    }
    match body {
        Some(b) => req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}", b.len())),
        None => req.push_str("\r\n"),
    }
    req
}

/// Status and JSON body of a capped HTTP/1.x answer; an unreadable one is an error.
pub(crate) fn parse_response(raw: &[u8]) -> Result<(u16, Value), String> {
    let text = std::str::from_utf8(raw).map_err(|_| "unreadable answer".to_string())?;
    let (head, body) = text.split_once("\r\n\r\n").ok_or("truncated answer")?;
    let status_line = head.lines().next().ok_or("no status")?;
    if !status_line.starts_with("HTTP/1.") {
        return Err("not an HTTP answer".into());
    }
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status code")?;
    let json = if body.trim().is_empty() { Value::Null } else { serde_json::from_str(body.trim()).unwrap_or(Value::Null) };
    Ok((status, json))
}

fn http(port: u16, method: &str, path: &str, body: Option<&str>, key: Option<&str>) -> Result<(u16, Value), String> {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|e| format!("server unreachable: {e}"))?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).map_err(|e| e.to_string())?;
    stream
        .write_all(build_request(method, path, port, body, key).as_bytes())
        .map_err(|e| format!("could not send: {e}"))?;
    let mut raw = Vec::new();
    stream.take(RESPONSE_CAP).read_to_end(&mut raw).map_err(|e| format!("could not read: {e}"))?;
    parse_response(&raw)
}

/// The refusal a page shows for a status the server sent back.
fn status_error(status: u16, json: &Value) -> String {
    let code = json.get("error").and_then(Value::as_str).unwrap_or("");
    match status {
        409 => "changed".into(),
        410 => "gone".into(),
        403 => "forbidden".into(),
        404 => "not_found".into(),
        _ if !code.is_empty() => code.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect(),
        _ => format!("http_{status}"),
    }
}

/// The owner key, only while the server child THIS shell started is still running: a key sent to
/// whatever now listens on the port could be a key handed to a stranger.
fn owner_key_while_server_lives(app: &AppHandle) -> Result<String, String> {
    let child = app
        .try_state::<std::sync::Arc<std::sync::Mutex<Option<std::process::Child>>>>()
        .ok_or("the server is not up")?;
    let alive = match child.lock() {
        Ok(mut g) => matches!(g.as_mut().map(|c| c.try_wait()), Some(Ok(None))),
        Err(_) => false,
    };
    if !alive {
        return Err("the app's server is not running".into());
    }
    Ok(app.try_state::<crate::owner_key::OwnerKey>().ok_or("no owner key")?.0.clone())
}

fn port_of(app: &AppHandle) -> Result<u16, String> {
    app.try_state::<crate::DashboardPort>().map(|p| p.0).ok_or_else(|| "the server is not up yet".to_string())
}

/// Caller contract + the slot. Returns the port and the held slot.
fn admit(app: &AppHandle, webview: &Webview, id: &str) -> Result<(u16, Slot), String> {
    let port = port_of(app)?;
    let url = webview.url().map_err(|e| e.to_string())?;
    precheck(webview.label(), &url, port, id)?;
    Ok((port, Slot::take()?))
}

/// Blocking network work off the async runtime's worker.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn window_of(app: &AppHandle, webview: &Webview) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(webview.label()).ok_or_else(|| "no window".to_string())
}

fn cancelled() -> Value {
    serde_json::json!({ "ok": false, "cancelled": true })
}

// ─── The commands ─────────────────────────────────────────────────────────────

/// A pending pairing becomes a live binding, only on the owner's click (B4).
#[tauri::command]
pub(crate) async fn confirm_telegram_binding(app: AppHandle, webview: Webview, pairing_id: String) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported".into());
    }
    let (port, _slot) = admit(&app, &webview, &pairing_id)?;
    let id = pairing_id.clone();
    let (status, preview) = blocking(move || http(port, "GET", &format!("{PAIRING}{id}"), None, None)).await?;
    if status != 200 {
        return Err(status_error(status, &preview));
    }
    let (title, body) = binding_text(&preview).ok_or("unreadable pairing")?;
    let bot_id = preview.get("botId").and_then(Value::as_i64).ok_or("unreadable pairing")?;
    let user_id = preview.get("userId").and_then(Value::as_i64).ok_or("unreadable pairing")?;
    if !native_confirm(window_of(&app, &webview)?, title, body, "Bağla").await? {
        return Ok(cancelled());
    }
    let key = owner_key_while_server_lives(&app)?;
    let shown = serde_json::json!({ "botId": bot_id, "userId": user_id }).to_string();
    let id = pairing_id;
    let (status, json) = blocking(move || http(port, "POST", &format!("{PAIRING}{id}/confirm"), Some(&shown), Some(&key))).await?;
    if status != 200 {
        return Err(status_error(status, &json));
    }
    Ok(serde_json::json!({ "ok": true }))
}

/// Ticking a routine: its results also go to the member's bot, only on the owner's click (W3, Y4).
#[tauri::command]
pub(crate) async fn confirm_telegram_forward(app: AppHandle, webview: Webview, forward_request_id: String) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported".into());
    }
    let (port, _slot) = admit(&app, &webview, &forward_request_id)?;
    let id = forward_request_id.clone();
    let (status, preview) = blocking(move || http(port, "GET", &format!("{FORWARD}{id}/preview"), None, None)).await?;
    if status != 200 {
        return Err(status_error(status, &preview));
    }
    let (title, body) = forward_text(&preview).ok_or("unreadable preview")?;
    let project_key = preview.get("projectKey").and_then(Value::as_str).ok_or("unreadable preview")?.to_string();
    let hash = preview.get("approvalHash").and_then(Value::as_str).ok_or("unreadable preview")?.to_string();
    if !native_confirm(window_of(&app, &webview)?, title, body, "Gönder").await? {
        return Ok(cancelled());
    }
    let key = owner_key_while_server_lives(&app)?;
    let shown = serde_json::json!({ "projectKey": project_key, "approvalHash": hash }).to_string();
    let id = forward_request_id;
    let (status, json) = blocking(move || http(port, "POST", &format!("{FORWARD}{id}/confirm"), Some(&shown), Some(&key))).await?;
    if status != 200 {
        return Err(status_error(status, &json));
    }
    Ok(serde_json::json!({ "ok": true }))
}

/// A one-tap creation goes live (X3, Z1). No dialog: the owner confirms in Telegram's own create
/// window. The answer's link is checked to be a Telegram link before the page sees it.
#[tauri::command]
pub(crate) async fn start_telegram_creation(app: AppHandle, webview: Webview, creation_id: String) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported".into());
    }
    let (port, _slot) = admit(&app, &webview, &creation_id)?;
    let key = owner_key_while_server_lives(&app)?;
    let id = creation_id;
    let (status, json) = blocking(move || http(port, "POST", &format!("{CREATION}{id}/start"), Some("{}"), Some(&key))).await?;
    if status != 200 {
        return Err(status_error(status, &json));
    }
    let link = json.get("link").and_then(Value::as_str).filter(|l| is_telegram_link(l)).ok_or("unreadable creation")?;
    let project = clean_label(json.get("projectName").and_then(Value::as_str).unwrap_or(""));
    Ok(serde_json::json!({ "ok": true, "link": link, "projectName": project }))
}

/// A bot made earlier is bound again, only on the owner's click (AA2, AB).
#[tauri::command]
pub(crate) async fn start_telegram_readopt(app: AppHandle, webview: Webview, readopt_id: String) -> Result<Value, String> {
    if !cfg!(target_os = "macos") {
        return Err("unsupported".into());
    }
    let (port, _slot) = admit(&app, &webview, &readopt_id)?;
    let id = readopt_id.clone();
    let (status, preview) = blocking(move || http(port, "GET", &format!("{READOPT}{id}/preview"), None, None)).await?;
    if status != 200 {
        return Err(status_error(status, &preview));
    }
    let (title, body) = readopt_text(&preview).ok_or("unreadable preview")?;
    let hash = preview.get("approvalHash").and_then(Value::as_str).ok_or("unreadable preview")?.to_string();
    if !native_confirm(window_of(&app, &webview)?, title, body, "Bağla").await? {
        return Ok(cancelled());
    }
    let key = owner_key_while_server_lives(&app)?;
    let shown = serde_json::json!({ "approvalHash": hash }).to_string();
    let id = readopt_id;
    let (status, json) = blocking(move || http(port, "POST", &format!("{READOPT}{id}/start"), Some(&shown), Some(&key))).await?;
    if status != 200 {
        return Err(status_error(status, &json));
    }
    Ok(serde_json::json!({ "ok": true }))
}

/// `https://t.me/…` only (the create link `t.me/newbot/<manager>/<name>?name=…`).
pub(crate) fn is_telegram_link(link: &str) -> bool {
    Url::parse(link)
        .map(|u| u.scheme() == "https" && u.host_str() == Some("t.me") && u.username().is_empty() && u.password().is_none())
        .unwrap_or(false)
}

// ─── The native alert ─────────────────────────────────────────────────────────

/// An NSAlert sheet on the asking window. Escape, the cancel button, or a sheet that could not be
/// shown are all `false`: a confirmation that cannot be shown never reads as consent.
#[cfg(target_os = "macos")]
async fn native_confirm(window: tauri::WebviewWindow, title: String, body: String, confirm: &'static str) -> Result<bool, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSAlertFirstButtonReturn, NSAlertStyle, NSModalResponse, NSWindow};
    use objc2_foundation::NSString;

    let (tx, mut rx) = tauri::async_runtime::channel::<bool>(1);
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let Some(alert) = crate::new_alert() else {
            let _ = tx.try_send(false);
            return;
        };
        alert.setMessageText(&NSString::from_str(&title));
        alert.setInformativeText(&NSString::from_str(&body));
        alert.setAlertStyle(NSAlertStyle::Warning);
        alert.addButtonWithTitle(&NSString::from_str(confirm));
        alert.addButtonWithTitle(&NSString::from_str("Vazgeç"));
        let block_tx = tx.clone();
        let handler = RcBlock::new(move |response: NSModalResponse| {
            let _ = block_tx.try_send(response == NSAlertFirstButtonReturn);
        });
        match window.ns_window() {
            Ok(ptr) if !ptr.is_null() => {
                // SAFETY: on the main thread, and `ns_window` is this window's live NSWindow.
                let parent: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                alert.beginSheetModalForWindow_completionHandler(parent, Some(&handler));
            }
            _ => {
                let _ = tx.try_send(alert.runModal() == NSAlertFirstButtonReturn);
            }
        }
    })
    .map_err(|e| format!("could not reach the main thread: {e}"))?;
    Ok(rx.recv().await.unwrap_or(false))
}

#[cfg(not(target_os = "macos"))]
async fn native_confirm(_window: tauri::WebviewWindow, _title: String, _body: String, _confirm: &'static str) -> Result<bool, String> {
    Err("unsupported".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "AbCdEfGhIjKlMnOpQrStUv";

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn an_id_is_22_base64url_characters() {
        assert!(valid_id(ID));
        assert!(valid_id("abc_DEF-0123456789abcd"));
        for bad in ["", "short", "AbCdEfGhIjKlMnOpQrStU", "AbCdEfGhIjKlMnOpQrStUvW", "AbCdEfGhIjKlMnOpQrSt/v", "AbCdEfGhIjKlMnOpQrSt=v", "../../api/telegram/x/y", "AbCdEfGhIjKlMnOpQrStü"] {
            assert!(!valid_id(bad), "{bad:?} must be refused");
        }
    }

    #[test]
    fn only_a_project_window_on_the_apps_own_page_may_ask() {
        let app = url("http://127.0.0.1:4173/");
        assert!(precheck("main", &app, 4173, ID).is_ok());
        // `localhost` can resolve to [::1], which our server does not hold.
        assert!(precheck("main", &url("http://localhost:4173/"), 4173, ID).is_err());
        assert!(precheck("vault-dreamcontext", &app, 4173, ID).is_ok());
        for label in ["assistant", "viewer-1", "checklist-x", "html-snapshot", "splash", "vault-", "inbox", "mainx"] {
            assert!(precheck(label, &app, 4173, ID).is_err(), "{label} must be refused");
        }
        // A loopback page inside a vault window that is not the app (a dev server, a card's redirect).
        assert!(precheck("vault-x", &url("http://127.0.0.1:5173/"), 4173, ID).is_err());
        assert!(precheck("vault-x", &url("https://evil.test/"), 4173, ID).is_err());
        assert!(precheck("main", &app, 4173, "nope").is_err());
    }

    #[test]
    fn a_second_call_while_one_is_open_is_refused() {
        let first = Slot::take().expect("first call admitted");
        assert_eq!(Slot::take().err().as_deref(), Some("busy"));
        drop(first);
        let again = Slot::take();
        assert!(again.is_ok(), "the slot is free once the first call ends");
    }

    #[test]
    fn labels_lose_control_and_bidi_characters() {
        assert_eq!(clean_label("mehmet\u{202E}gnp.exe"), "mehmetgnp.exe");
        assert_eq!(clean_label("a\u{0007}b\nc\u{200F}d"), "a b cd");
        assert_eq!(clean_label("  Ş  ğ  "), "Ş ğ");
        assert_eq!(clean_label(&"x".repeat(200)).chars().count(), LABEL_MAX);
    }

    #[test]
    fn the_binding_alert_names_the_target() {
        let base = json!({ "projectName": "dreamcontext", "botUsername": "nm_super_bot", "botId": 1, "userId": 48151623, "userLabel": "@mehmet" });
        let mut sup = base.clone();
        sup["target"] = json!("super");
        let (_, body) = binding_text(&sup).unwrap();
        assert!(body.starts_with("Telegram kullanıcısı @mehmet (id 48151623) bu projenin Super'ine bağlansın mı?"));
        assert!(body.contains("@nm_super_bot") && body.contains("dreamcontext"));

        let mut member = base.clone();
        member["target"] = json!("ua-manager");
        member["targetLabel"] = json!("UA Manager");
        assert!(binding_text(&member).unwrap().1.contains("UA Manager üyesine bağlansın mı?"));
        member["global"] = json!(true);
        assert!(binding_text(&member).unwrap().1.contains("UA Manager üyesine (tüm projelerde) bağlansın mı?"));

        let mut manager = base.clone();
        manager["target"] = json!(MANAGER_TARGET);
        assert!(binding_text(&manager).unwrap().1.contains("bu Mac'in Telegram yöneticisi olsun mu?"));

        let mut evil = base;
        evil["target"] = json!("super");
        evil["userLabel"] = json!("\u{202E}nimda");
        assert!(binding_text(&evil).unwrap().1.contains("kullanıcısı nimda (id"));
    }

    #[test]
    fn forward_and_readopt_alerts_say_project_routine_and_bot() {
        let (_, body) = forward_text(&json!({ "projectName": "Tilki", "routineTitle": "Günlük bütçe", "botUsername": "nm_ua_bot", "projectKey": "k", "approvalHash": "h" })).unwrap();
        assert_eq!(body, "Tilki · Günlük bütçe sonuçları @nm_ua_bot botuna da gitsin mi?");
        let (_, body) = readopt_text(&json!({ "projectName": "Tilki", "target": "super", "botUsername": "nm_tilki_bot", "approvalHash": "h" })).unwrap();
        assert_eq!(body, "Tilki · Super için @nm_tilki_bot yeniden bağlansın mı?");
        assert!(forward_text(&json!({ "projectName": "x" })).is_none());
    }

    #[test]
    fn requests_are_built_from_fixed_parts_and_the_key_rides_only_when_given() {
        let get = build_request("GET", &format!("{PAIRING}{ID}"), 4173, None, None);
        assert!(get.starts_with(&format!("GET /api/telegram-pairing/{ID} HTTP/1.0\r\n")));
        assert!(get.contains("Origin: http://127.0.0.1:4173\r\n") && get.contains("Sec-Fetch-Site: same-origin\r\n"));
        assert!(!get.to_ascii_lowercase().contains("owner-key") && !get.to_ascii_lowercase().contains("x-dreamcontext-vault"));
        let post = build_request("POST", "/x", 4173, Some("{\"a\":1}"), Some("k3y"));
        assert!(post.contains("X-Dreamcontext-Owner-Key: k3y\r\n") && post.ends_with("Content-Length: 7\r\n\r\n{\"a\":1}"));
    }

    #[test]
    fn answers_parse_and_a_broken_one_is_an_error() {
        let (s, j) = parse_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!((s, j["ok"].as_bool()), (200, Some(true)));
        let (s, _) = parse_response(b"HTTP/1.0 409 Conflict\r\n\r\n").unwrap();
        assert_eq!(s, 409);
        assert!(parse_response(b"garbage").is_err());
        assert!(parse_response(b"SSH-2.0\r\n\r\n").is_err());
        assert_eq!(status_error(409, &Value::Null), "changed");
        assert_eq!(status_error(410, &Value::Null), "gone");
        assert_eq!(status_error(500, &json!({ "error": "no_manager<script>" })), "no_managerscript");
    }

    #[test]
    fn only_a_telegram_link_reaches_the_page() {
        assert!(is_telegram_link("https://t.me/newbot/nm_dc_bot/ua_manager_x1y2_bot?name=UA+Manager"));
        for bad in ["http://t.me/x", "https://t.me.evil.test/x", "https://evil.test/t.me", "https://u:p@t.me/x", "javascript:alert(1)", "dreamcontext://x"] {
            assert!(!is_telegram_link(bad), "{bad}");
        }
    }
}
