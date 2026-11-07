// The key that proves a request came from the owner's own window (src/server/owner-key.ts).
//
// A header proves nothing to a server on loopback: any process here can forge Origin, Host and
// Sec-Fetch-Site. So the shell mints a key per launch, hands it to the server down stdin (a pipe,
// never the environment every agent inherits) and to the owner's own pages over IPC, the barrier
// a loopback client cannot reach. Every decision made in the owner's name asks for it: the
// notch's permission answer, and the Apps page's Share, install, update, settings and uninstall.

use tauri::{AppHandle, Manager, Url, Webview};

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

/// The app's own server, port included. The capability's remote scope allows every loopback
/// port, and a card or a redirect can put another one in a window.
fn is_app_page(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        && url.port() == Some(port)
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
    fn the_owners_pages_hold_the_key_and_no_other_window_does() {
        for owner in ["assistant", "main", "vault-acme-storefront", "vault-a"] {
            assert!(is_owner_window(owner), "{owner}");
        }
        for other in ["inbox", "viewer-1", "checklist-x", "splash", "node-setup", "assistant-x", "mainx", "vault", ""] {
            assert!(!is_owner_window(other), "{other}");
        }
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
