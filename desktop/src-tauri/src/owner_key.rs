// The key that proves a request came from the owner's own window (src/server/owner-key.ts).
//
// A header proves nothing to a server on loopback: any process here can forge Origin, Host and
// Sec-Fetch-Site. So the shell mints a key per launch, hands it to the server down stdin (a pipe,
// never the environment every agent inherits) and to the owner's own pages over IPC, the barrier
// a loopback client cannot reach. Every decision made in the owner's name asks for it: the
// notch's permission answer, and the Apps page's Share, install, update, settings and uninstall.
//
// WHO may call the command is decided twice. Tauri's ACL checks the CALLING FRAME's origin (the
// IPC request's Origin, or the posting frame's URL), and the `owner-key` capability is added at
// runtime scoped to the server's exact port (`grant`), so a web card's frame on another loopback
// port is refused before the command runs, even inside a project window. No static capability
// carries `allow-owner-key`: theirs allow every loopback port. The command then checks the window
// label and its top URL, a second fence for the case the frame check alone would miss.

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, Webview};

/// The capability that lets the owner's own pages call `owner_key`, added once the port is known.
const OWNER_CAPABILITY: &str = "owner-key";
const OWNER_WINDOWS: [&str; 3] = ["assistant", "main", "vault-*"];

/// The windows that draw the owner's own pages: the notch, the Launcher and every project
/// window (the Apps page opens in the last two). The inbox, the viewer, the checklist and any
/// other window never hold the key. Before 2026-11-08 only the notch did, so the owner's own
/// Share click on his Apps page was refused as "not the owner".
fn is_owner_window(label: &str) -> bool {
    label == "assistant" || label == "main" || label.starts_with("vault-")
}

pub(crate) struct OwnerKey(pub(crate) String);

/// 256 random bits as hex.
pub(crate) fn mint() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("Could not mint the owner key: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// `--disable-sigusr1` landed in Node 22.14 and 23.7; an older Node refuses to boot on it.
pub(crate) fn node_can_disable_sigusr1((major, minor, _): (u32, u32, u32)) -> bool {
    major >= 24 || (major == 23 && minor >= 7) || (major == 22 && minor >= 14)
}

/// The origins a calling frame may have: the app's own server, port included. A web card's
/// frame on another loopback port, or any other host, is not the app.
fn owner_scope(port: u16) -> [String; 2] {
    [format!("http://127.0.0.1:{port}"), format!("http://localhost:{port}")]
}

/// Let the owner's own windows ask for the key, from frames on the app's own origin only.
/// Called once, right after the server answered on `port`.
pub(crate) fn grant(app: &AppHandle, port: u16) -> Result<(), String> {
    let mut cap = CapabilityBuilder::new(OWNER_CAPABILITY)
        .local(false)
        .windows(OWNER_WINDOWS)
        .permission("allow-owner-key");
    for url in owner_scope(port) {
        cap = cap.remote(url);
    }
    app.add_capability(cap).map_err(|e| format!("Could not scope the owner key: {e}"))
}

/// The window's top page is the app's own server, port included. A redirect or a link can put
/// another page in a window; the frame check of `grant` covers frames inside it.
fn is_app_page(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(port)
}

/// The app's own server by its literal address only. The server listens on 127.0.0.1, so a
/// `localhost` page could resolve to `[::1]:<port>`, which another local process may hold; the
/// commands that act in the owner's name (Telegram confirms, the sealed snapshot) accept no such page.
pub(crate) fn is_own_server_page(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

#[tauri::command]
pub(crate) fn owner_key(app: AppHandle, webview: Webview) -> Result<String, String> {
    let port = app.try_state::<crate::DashboardPort>().map(|p| p.0).ok_or("the server is not up yet")?;
    let url = webview.url().map_err(|e| e.to_string())?;
    if !is_owner_window(webview.label()) || !is_app_page(&url, port) {
        return Err("only the app's own windows hold the owner key".to_string());
    }
    Ok(app.try_state::<OwnerKey>().ok_or("no owner key")?.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(url: &str) -> bool {
        is_app_page(&Url::parse(url).unwrap(), 4173)
    }

    #[test]
    fn only_the_apps_own_origin_is_the_app() {
        assert!(page("http://127.0.0.1:4173/assistant"));
        assert!(page("http://localhost:4173/"));
        assert!(!page("http://127.0.0.1:5173/"));
        assert!(!page("https://127.0.0.1:4173/"));
        assert!(!page("http://evil.test:4173/"));
    }

    #[test]
    fn only_a_frame_on_the_apps_own_origin_may_call_the_command() {
        use std::str::FromStr;
        use tauri::utils::acl::RemoteUrlPattern;
        let scope: Vec<RemoteUrlPattern> = owner_scope(4173).iter().map(|s| RemoteUrlPattern::from_str(s).unwrap()).collect();
        let allowed = |u: &str| scope.iter().any(|p| p.test(&Url::parse(u).unwrap()));
        // The app's page, as the IPC request's Origin and as a posting frame's full URL.
        for ok in ["http://127.0.0.1:4173", "http://127.0.0.1:4173/", "http://localhost:4173/?vault=acme&tab=apps", "http://127.0.0.1:4173/assistant"] {
            assert!(allowed(ok), "{ok}");
        }
        // A web card on another loopback port, the session proxy, any other host or scheme.
        for no in ["http://127.0.0.1:5173/", "http://localhost:5173", "http://127.0.0.1:41733/", "https://127.0.0.1:4173/", "http://evil.test:4173/", "http://127.0.0.2:4173/"] {
            assert!(!allowed(no), "{no}");
        }
        // Every window the command answers is in the capability, and nothing else is.
        for w in OWNER_WINDOWS {
            assert!(w == "vault-*" || is_owner_window(w), "{w}");
        }
        assert!(is_owner_window("vault-acme"));
    }

    #[test]
    fn the_owners_pages_hold_the_key_and_no_other_window_does() {
        for owner in ["assistant", "main", "vault-acme-storefront", "vault-a"] {
            assert!(is_owner_window(owner), "{owner}");
        }
        for other in ["inbox", "viewer-1", "checklist-x", "splash", "node-setup", "assistant-x", "mainx", "vault", ""] {
            assert!(!is_owner_window(other), "{other}");
        }
    }

    #[test]
    fn the_owner_commands_accept_the_literal_loopback_only() {
        let own = |u: &str| is_own_server_page(&Url::parse(u).unwrap(), 4173);
        assert!(own("http://127.0.0.1:4173/?vault=x"));
        assert!(!own("http://localhost:4173/"));
        assert!(!own("http://[::1]:4173/"));
        assert!(!own("http://127.0.0.1:5173/"));
    }

    #[test]
    fn the_inspector_flag_goes_only_to_a_node_that_knows_it() {
        for old in [(18, 20, 0), (20, 19, 0), (22, 13, 1), (23, 6, 0)] {
            assert!(!node_can_disable_sigusr1(old));
        }
        for new in [(22, 14, 0), (22, 16, 0), (23, 7, 0), (24, 1, 0)] {
            assert!(node_can_disable_sigusr1(new));
        }
    }

    #[test]
    fn a_key_is_256_random_bits() {
        let a = mint().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, mint().unwrap());
    }
}
