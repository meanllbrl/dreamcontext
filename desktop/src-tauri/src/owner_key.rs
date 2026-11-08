// The key that proves a request came from the owner's own window (src/server/owner-key.ts).
//
// A header proves nothing to a server on loopback: any process here can forge Origin, Host and
// Sec-Fetch-Site. So the shell mints a key per launch, hands it to the server down stdin (a pipe,
// never the environment every agent inherits) and to the notch's page over IPC, the barrier a
// loopback client cannot reach. Only `POST /api/assistant/answer` asks for it.

use tauri::{AppHandle, Manager, Url, Webview};

/// The one window that answers a permission over the owner route.
const OWNER_WINDOW: &str = "assistant";

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

/// The app's own server, port included. The capability's remote scope allows every loopback
/// port, and a card or a redirect can put another one in a window.
pub(crate) fn is_app_page(url: &Url, port: u16) -> bool {
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
    if webview.label() != OWNER_WINDOW || !is_app_page(&url, port) {
        return Err("only the app's own notch holds the owner key".to_string());
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
