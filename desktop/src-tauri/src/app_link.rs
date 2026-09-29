// dreamcontext desktop shell — app_link.rs
//
// The app's one external entry point: `dreamcontext://…` links. macOS hands a
// clicked link (a banner's `open dreamcontext://…`, a hook, a browser) to the
// app as RunEvent::Opened, on a cold launch and a running app alike, which is
// why no deep-link plugin is needed.
//
// The shell deliberately does NOT understand the link grammar. It only checks
// that a URL is ours (scheme, length), parks it in a take-once queue, and rings
// a payload-less doorbell. The dashboard parses, validates and routes (see
// dashboard/src/lib/appLink.ts), because only it knows which window holds which
// vault and which tab. Keeping the link out of the event payload means a
// listener in a window without the take permission hears a bell, never a link.
//
// Take-once IS the election: several windows ring at once, whoever pops a link
// routes it, and everyone else gets `None`. A webview also takes on mount, so a
// doorbell rung before any listener existed (cold launch, a launcher we just
// built) loses nothing.

use std::collections::VecDeque;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Url};

/// The only scheme the shell accepts. Anything else macOS hands us (a file
/// dropped on the Dock icon, say) is not a link and is ignored.
const APP_LINK_SCHEME: &str = "dreamcontext";

/// Same ceiling as the link grammar on both the Node writer and the dashboard
/// reader. Longer is not a link we wrote, so it is dropped whole, not trimmed.
pub const MAX_APP_LINK_LEN: usize = 4096;

/// How many unclaimed links are held. A burst of clicks while no webview is up
/// is a handful at most; the cap only exists so a runaway sender cannot grow
/// the queue without bound.
pub const MAX_PENDING_LINKS: usize = 8;

/// The doorbell. No payload: the listener answers it by calling `take_app_link`.
pub const APP_LINK_EVENT: &str = "dream://app-link";

/// Links waiting for a webview to claim them, oldest first.
#[derive(Default)]
pub struct PendingLinks(Mutex<VecDeque<String>>);

impl PendingLinks {
    /// Queue a link. When full, the OLDEST is dropped: the newest click is the
    /// one the user is looking at the screen waiting for.
    pub fn push(&self, link: String) {
        let mut queue = self.lock();
        while queue.len() >= MAX_PENDING_LINKS {
            queue.pop_front();
        }
        queue.push_back(link);
    }

    /// Pop the oldest link. Each link is handed out exactly once.
    pub fn take(&self) -> Option<String> {
        self.lock().pop_front()
    }

    /// A poisoned lock only means some thread panicked mid-push or mid-pop on a
    /// plain queue of strings; the queue itself is still valid, so recover it
    /// rather than wedge every future click.
    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<String>> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The URL as the string the dashboard will parse, or `None` when it is not
/// ours. `Url` has already lowercased the scheme and percent-encoded anything
/// non-ASCII, so the length checked here is the length the reader sees.
pub fn accept_link(url: &Url) -> Option<String> {
    if url.scheme() != APP_LINK_SCHEME {
        return None;
    }
    let raw = url.as_str();
    if raw.len() > MAX_APP_LINK_LEN {
        return None;
    }
    Some(raw.to_string())
}

/// Windows that route links: the Launcher and the project windows. The viewer,
/// the inbox, the checklist and the notch never elect themselves.
pub fn is_link_router(label: &str) -> bool {
    label == "main" || label.starts_with("vault-")
}

/// RunEvent::Opened. Queue every link that is ours, then either ring the
/// routers or, when none is open, bring up the Launcher (which takes on mount).
pub fn handle_opened(app: &AppHandle, urls: &[Url]) {
    let pending = app.state::<PendingLinks>();
    let mut accepted = 0usize;
    for link in urls.iter().filter_map(accept_link) {
        pending.push(link);
        accepted += 1;
    }
    if accepted == 0 {
        return;
    }

    let has_router = app.webview_windows().keys().any(|label| is_link_router(label));
    if has_router {
        // Nothing is shown or focused here: the window that wins the take knows
        // which window and tab the link belongs to, and raises that one.
        let rung = app.emit_filter(APP_LINK_EVENT, (), |target| match target {
            EventTarget::WebviewWindow { label } => is_link_router(label),
            _ => false,
        });
        if let Err(e) = rung {
            eprintln!("[app-link] could not ring {APP_LINK_EVENT}: {e}");
        }
        return;
    }

    // No router is open. Before the dashboard server has answered (a cold
    // launch still in setup, or a server that failed to start) there is no
    // port to point a window at; the link stays queued, and the Launcher that
    // setup builds takes it on mount.
    let Some(port) = app.try_state::<crate::DashboardPort>() else {
        return;
    };
    if let Err(e) = crate::open_launcher_window(app, port.0) {
        eprintln!("[app-link] could not open the Launcher for a link: {e}");
    }
}

/// Pop the oldest unclaimed link, or `None`. Callers loop until `None`.
#[tauri::command]
pub fn take_app_link(pending: tauri::State<'_, PendingLinks>) -> Option<String> {
    pending.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL parses")
    }

    #[test]
    fn accepts_only_the_dreamcontext_scheme() {
        assert_eq!(
            accept_link(&url("dreamcontext://project/demo/session/abcdef12")).as_deref(),
            Some("dreamcontext://project/demo/session/abcdef12")
        );
        assert_eq!(accept_link(&url("dreamcontext://inbox")).as_deref(), Some("dreamcontext://inbox"));
        // Url lowercases the scheme, so a shouting sender still reaches us.
        assert!(accept_link(&url("DREAMCONTEXT://inbox")).is_some());
        assert!(accept_link(&url("file:///Users/me/notes.md")).is_none());
        assert!(accept_link(&url("https://example.com/dreamcontext://inbox")).is_none());
        assert!(accept_link(&url("dreamcontextx://inbox")).is_none());
    }

    #[test]
    fn keeps_a_turkish_vault_name_percent_encoded() {
        let accepted = accept_link(&url("dreamcontext://project/Çalışma/page/sleep")).unwrap();
        // The reader decodes it; the shell must hand over what it received, encoded.
        assert!(accepted.starts_with("dreamcontext://project/"));
        assert!(accepted.contains("%C3%87al%C4%B1%C5%9Fma"));
        assert!(accepted.len() <= MAX_APP_LINK_LEN);
    }

    #[test]
    fn caps_the_length_at_the_grammar_limit() {
        let prefix = "dreamcontext://project/demo/view?path=";
        let at_cap = format!("{prefix}{}", "a".repeat(MAX_APP_LINK_LEN - prefix.len()));
        assert_eq!(at_cap.len(), MAX_APP_LINK_LEN);
        assert!(accept_link(&url(&at_cap)).is_some());

        let over = format!("{at_cap}a");
        assert!(accept_link(&url(&over)).is_none());
    }

    #[test]
    fn hands_each_link_out_once_in_arrival_order() {
        let pending = PendingLinks::default();
        pending.push("dreamcontext://inbox".to_string());
        pending.push("dreamcontext://project/a".to_string());
        assert_eq!(pending.take().as_deref(), Some("dreamcontext://inbox"));
        assert_eq!(pending.take().as_deref(), Some("dreamcontext://project/a"));
        assert_eq!(pending.take(), None);
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn drops_the_oldest_when_the_queue_is_full() {
        let pending = PendingLinks::default();
        for i in 0..MAX_PENDING_LINKS + 3 {
            pending.push(format!("dreamcontext://project/v{i}"));
        }
        let drained: Vec<String> = std::iter::from_fn(|| pending.take()).collect();
        assert_eq!(drained.len(), MAX_PENDING_LINKS);
        assert_eq!(drained.first().map(String::as_str), Some("dreamcontext://project/v3"));
        assert_eq!(
            drained.last().cloned(),
            Some(format!("dreamcontext://project/v{}", MAX_PENDING_LINKS + 2))
        );
    }

    #[test]
    fn only_the_launcher_and_project_windows_route() {
        assert!(is_link_router("main"));
        assert!(is_link_router("vault-dreamcontext"));
        for label in ["inbox", "viewer-1a2b", "checklist-x", "assistant", "error", "mainframe"] {
            assert!(!is_link_router(label), "{label} must not route links");
        }
    }
}
