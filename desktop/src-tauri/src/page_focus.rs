// ── A window that comes forward gives its keyboard to its page ─────────────────
//
// Owner, 2026-10-04: after clicking a chat in the notch, the project window came forward but
// its composer could not be clicked into, and the page reported `document.hasFocus() ===
// false` while frontmost (so its presence report never reached the server). Making a window
// key does not move the window's FIRST RESPONDER: AppKit keeps whatever held it last, and a
// window brought forward programmatically from a non-activating panel (the notch,
// src/assistant.rs) can come up key with the responder outside the WKWebView. The page then
// believes it is unfocused and keystrokes go nowhere.
//
// So: whenever a window other than the notch becomes key, and its first responder is not the
// webview or a view inside it, the webview is made first responder (what wry's `focus()`
// does). Left alone when it already is, because resigning and re-taking it would blur the page
// and drop an open menu.
//
// `focus_diag` appends one line to ~/.dreamcontext/logs/focus-diag.log, so the next
// reproduction says what held the keyboard instead of leaving it to a guess. Capped at 256 KB
// (the file is reset, not rotated: it only has to cover one reproduction).

use std::io::Write;

use tauri::{AppHandle, Manager, Runtime};

const DIAG_CAP_BYTES: u64 = 256 * 1024;

fn diag_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".dreamcontext").join("logs").join("focus-diag.log"))
}

pub fn diag_line(line: &str) {
    let Some(path) = diag_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let too_big = std::fs::metadata(&path).map(|m| m.len() > DIAG_CAP_BYTES).unwrap_or(false);
    let file = std::fs::OpenOptions::new().create(true).append(!too_big).write(true).truncate(too_big).open(&path);
    if let Ok(mut f) = file {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let clean: String = line.chars().filter(|c| *c != '\n' && *c != '\r').take(2000).collect();
        let _ = writeln!(f, "{ts} {clean}");
    }
}

/// A page's own line for the focus log (the composer probe in `lib/focusDiag.ts`).
#[tauri::command]
pub fn focus_diag(window: tauri::Window, line: String) {
    diag_line(&format!("[{}] {}", window.label(), line));
}

/// Called on every `Focused(true)` of a window that is not the notch.
#[cfg(target_os = "macos")]
pub fn give_keyboard_to_page<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let owned = label.to_string();
    let _ = w.with_webview(move |wv| {
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2::{class, msg_send};
        let view = wv.inner() as *mut AnyObject;
        let win = wv.ns_window() as *mut AnyObject;
        if view.is_null() || win.is_null() {
            return;
        }
        // SAFETY: `with_webview` runs this on the main thread with the live WKWebView and its
        // NSWindow; every message below is a plain AppKit query or `makeFirstResponder:`.
        unsafe {
            let fr: *mut AnyObject = msg_send![win, firstResponder];
            let name = if fr.is_null() {
                "nil".to_string()
            } else {
                let cls: *const AnyClass = msg_send![fr, class];
                cls.as_ref().map(|c| c.name().to_string_lossy().into_owned()).unwrap_or_default()
            };
            let inside = !fr.is_null() && {
                let is_view: bool = msg_send![fr, isKindOfClass: class!(NSView)];
                is_view && {
                    let d: bool = msg_send![fr, isDescendantOf: view];
                    d
                }
            };
            if inside {
                diag_line(&format!("[{owned}] key; responder {name} is inside the page"));
                return;
            }
            let ok: bool = msg_send![win, makeFirstResponder: view];
            diag_line(&format!("[{owned}] key; responder was {name}, handed to the page: {ok}"));
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn give_keyboard_to_page<R: Runtime>(_app: &AppHandle<R>, _label: &str) {}
