// The web view's own file chooser (`<input type="file">`), made nil-safe.
//
// WHY THIS EXISTS (crash report 2026-10-28, desktop 0.36.0): clicking a file input aborted the
// whole app — SIGABRT on the main thread, under
// `WebKit::UIDelegate::UIClient::runOpenPanel`. That callback lands in wry 0.55's
// `WryWebViewUIDelegate`, which calls `NSOpenPanel::openPanel(mtm)` and `-URLs` through
// objc2-app-kit bindings typed NON-NULL. `+[NSOpenPanel openPanel]` does return nil in the wild
// (the panel is backed by a helper service a long-lived process can lose), objc2 panics on that
// nil, and with `panic = "abort"` in Cargo.toml the panic is the app's death. It is the same
// chain `pick_paths` in lib.rs was written against (rfd, 2026-08); only the web view's path to
// the panel was still unguarded.
//
// wry is a dependency, so instead of forking it this replaces the ONE method on its delegate
// class at runtime with an implementation that reads the panel as `Option`, always answers
// WebKit exactly once (a nil panel = a plain message and a cancelled pick, which the page
// already handles), and presents the panel as a sheet on the web view's own window like
// `pick_paths` does.
//
// WHICH CLASS (2026-11-10, an App's logo picker in Settings): the first version looked the class
// up by the name `WryWebViewUIDelegate`. objc2 0.6 never registers that name: a `define_class!`
// without `#[name]` is registered as `wry::wkwebview::class::wry_web_view_ui_delegate::
// WryWebViewUIDelegate0.55.1`, so the lookup found nothing on every page load and the guard
// was never in place. Nothing said so; the composer only stopped crashing because it moved to
// `pick_paths`. The class is now read from the live web view itself (`-UIDelegate`), on every
// page load of every web view (Tauri's app-wide `on_page_load` in lib.rs), so no name, no wry
// version and no new window can slip past it.

use std::ptr::null;

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{ffi, msg_send, sel, ClassType};
use objc2_app_kit::{NSAlert, NSModalResponse, NSModalResponseOK, NSOpenPanel, NSWindow};
use objc2_foundation::{NSArray, NSString, NSURL};

/// WebKit's completion handler: an array of picked URLs, or nil for "cancelled".
type OpenPanelHandler = Block<dyn Fn(*const NSArray<NSURL>)>;

type OpenPanelMethod =
    unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &AnyObject, *const AnyObject, *const OpenPanelHandler);

fn open_panel_sel() -> Sel {
    sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:)
}

fn guarded_imp() -> Imp {
    // SAFETY: an `Imp` is an untyped function pointer; the runtime calls it with exactly the
    // arguments `OpenPanelMethod` names (self, _cmd, four object pointers, the last a block).
    unsafe { std::mem::transmute::<OpenPanelMethod, Imp>(run_open_panel) }
}

/// Guard the file chooser of `webview` (a `WKWebView`): swap the open-panel method of the class
/// its `-UIDelegate` actually is for [`run_open_panel`]. Idempotent and cheap; returns whether
/// the guard is in place. Called on every page load of every web view, so a window built by any
/// builder, today or later, is covered before its page can show a file input.
pub fn install_on(webview: &AnyObject) -> bool {
    // SAFETY: `-UIDelegate` is a plain WKWebView getter; nil reads as a null pointer.
    let delegate: *mut AnyObject = unsafe { msg_send![webview, UIDelegate] };
    match unsafe { delegate.as_ref() } {
        Some(delegate) => install_on_class(delegate.class()),
        None => false, // no delegate: WebKit shows no panel at all, nothing to guard
    }
}

fn install_on_class(cls: &AnyClass) -> bool {
    let name = open_panel_sel();
    let ours = guarded_imp();
    // SAFETY: plain Objective-C runtime calls on a registered class. The replacement takes the
    // same arguments as the method it replaces, so reusing the original's type encoding
    // describes it exactly.
    unsafe {
        let method = ffi::class_getInstanceMethod(cls, name);
        if method.is_null() {
            return false; // a delegate that never shows a panel: nothing to guard
        }
        // Re-swapping the same implementation on a later page load is a no-op.
        let types = ffi::method_getTypeEncoding(method);
        ffi::class_replaceMethod(cls as *const AnyClass as *mut AnyClass, name, ours, types);
    }
    true
}

/// `+[NSOpenPanel openPanel]` read as `Option` — the nil objc2's typed binding would panic on.
fn open_panel() -> Option<Retained<NSOpenPanel>> {
    unsafe { msg_send![NSOpenPanel::class(), openPanel] }
}

/// `-URLs` read as `Option`, for the same reason.
fn panel_urls(panel: &NSOpenPanel) -> Option<Retained<NSArray<NSURL>>> {
    unsafe { msg_send![panel, URLs] }
}

/// Tell the user why nothing opened: a sheet on the web view's own window (the rest of the app
/// stays live), or a plain alert when the view has no window. The alert itself is read as
/// `Option` too: a nil here only loses the message, never the app.
fn say_panel_unavailable(webview: &AnyObject) {
    if cfg!(test) {
        return; // no modal alerts in unit tests
    }
    let alert: Option<Retained<NSAlert>> = unsafe { msg_send![NSAlert::class(), new] };
    let Some(alert) = alert else { return };
    alert.setMessageText(&NSString::from_str(crate::PANEL_UNAVAILABLE));
    let window: Option<Retained<NSWindow>> = unsafe { msg_send![webview, window] };
    match window {
        Some(window) => alert.beginSheetModalForWindow_completionHandler(&window, None),
        None => {
            alert.runModal();
        }
    }
}

/// The replacement for wry's `run_file_upload_panel`. Never panics, and answers `handler`
/// exactly once on every path, as WebKit requires.
unsafe extern "C-unwind" fn run_open_panel(
    _this: &AnyObject,
    _cmd: Sel,
    webview: &AnyObject,
    params: &AnyObject,
    _frame: *const AnyObject,
    handler: *const OpenPanelHandler,
) {
    let Some(handler) = handler.as_ref() else { return };
    let Some(panel) = open_panel() else {
        // AppKit refused a panel: tell the page the pick was cancelled instead of dying.
        handler.call((null(),));
        say_panel_unavailable(webview);
        return;
    };
    let multiple: Bool = msg_send![params, allowsMultipleSelection];
    let directories: Bool = msg_send![params, allowsDirectories];
    panel.setCanChooseFiles(true);
    panel.setAllowsMultipleSelection(multiple.as_bool());
    panel.setCanChooseDirectories(directories.as_bool());
    panel.setResolvesAliases(true);

    // WebKit's block lives only for this call; the sheet answers later, so keep a copy.
    let handler: RcBlock<dyn Fn(*const NSArray<NSURL>)> = handler.copy();
    let window: Option<Retained<NSWindow>> = msg_send![webview, window];
    match window {
        Some(window) => {
            let finished = panel.clone();
            let done = RcBlock::new(move |response: NSModalResponse| {
                let urls = if response == NSModalResponseOK { panel_urls(&finished) } else { None };
                handler.call((urls.as_ref().map_or(null(), |u| Retained::as_ptr(u)),));
            });
            panel.beginSheetModalForWindow_completionHandler(&window, &done);
        }
        // A web view that is not in a window yet: the blocking panel wry used, still nil-safe.
        None => {
            let urls = if panel.runModal() == NSModalResponseOK { panel_urls(&panel) } else { None };
            handler.call((urls.as_ref().map_or(null(), |u| Retained::as_ptr(u)),));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A stand-in for wry's method: the panic it would hit on a nil panel.
    unsafe extern "C-unwind" fn wry_like(_: &AnyObject, _: Sel, _: &AnyObject, _: &AnyObject, _: *const AnyObject, _: *const OpenPanelHandler) {
        panic!("unexpected NULL returned from +[NSOpenPanel openPanel]");
    }

    /// `+[NSOpenPanel openPanel]` the way it fails in the wild.
    unsafe extern "C-unwind" fn nil_panel(_: &AnyClass, _: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }

    static DELEGATE: Mutex<usize> = Mutex::new(0);

    /// The fake web view's `-UIDelegate`.
    unsafe extern "C-unwind" fn ui_delegate(_: &AnyObject, _: Sel) -> *mut AnyObject {
        *DELEGATE.lock().unwrap() as *mut AnyObject
    }

    /// The crash, end to end without a window: a web view whose delegate class carries the name
    /// objc2 0.6 really registers for wry's delegate (NOT the bare `WryWebViewUIDelegate` the
    /// first guard looked up, which left it uninstalled), AppKit hands back a nil panel, and the
    /// guarded delegate answers WebKit "cancelled" exactly once instead of panicking (which
    /// under `panic = "abort"` was the app's death).
    #[test]
    fn a_nil_open_panel_is_a_cancelled_pick_not_an_abort() {
        let name = open_panel_sel();
        unsafe {
            let base = AnyClass::get(c"NSObject").unwrap();

            // wry's delegate class, under objc2's generated runtime name, panicking like wry's.
            let cls = ffi::objc_allocateClassPair(
                base,
                c"wry::wkwebview::class::wry_web_view_ui_delegate::WryWebViewUIDelegate0.55.1".as_ptr(),
                0,
            );
            assert!(!cls.is_null());
            let imp = std::mem::transmute::<OpenPanelMethod, Imp>(wry_like);
            assert!(ffi::class_addMethod(cls, name, imp, c"v@:@@@@?".as_ptr()).as_bool());
            ffi::objc_registerClassPair(cls);

            // A web view whose `-UIDelegate` is an instance of that class.
            let wv_cls = ffi::objc_allocateClassPair(base, c"DCTestWebView".as_ptr(), 0);
            let getter = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel) -> *mut AnyObject, Imp>(ui_delegate);
            assert!(ffi::class_addMethod(wv_cls, sel!(UIDelegate), getter, c"@@:".as_ptr()).as_bool());
            ffi::objc_registerClassPair(wv_cls);
            let webview: Retained<AnyObject> = msg_send![&*wv_cls, new];
            let delegate: Retained<AnyObject> = msg_send![&*cls, new];

            // No delegate yet: nothing to guard, and it says so.
            assert!(!install_on(&webview));
            *DELEGATE.lock().unwrap() = Retained::as_ptr(&delegate) as usize;

            // Make AppKit refuse every panel.
            let meta = NSOpenPanel::class().metaclass() as *const AnyClass as *mut AnyClass;
            let nil = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyClass, Sel) -> *mut AnyObject, Imp>(nil_panel);
            ffi::class_replaceMethod(meta, sel!(openPanel), nil, c"@@:".as_ptr());

            assert!(install_on(&webview), "the class is read from the web view, whatever its name");
            assert!(install_on(&webview), "idempotent");

            // Call the method the way WebKit does, through the class's current implementation.
            let other: Retained<AnyObject> = msg_send![base, new];
            let method = ffi::class_getInstanceMethod(cls, name);
            let current: OpenPanelMethod = std::mem::transmute(ffi::method_getImplementation(method).unwrap());

            let calls: Arc<Mutex<Vec<bool>>> = Arc::default();
            let seen = calls.clone();
            let handler = RcBlock::new(move |urls: *const NSArray<NSURL>| seen.lock().unwrap().push(urls.is_null()));
            let handler_ptr: *const OpenPanelHandler = &*handler;
            current(&delegate, name, &other, &other, null(), handler_ptr);

            assert_eq!(*calls.lock().unwrap(), vec![true], "answered once, with nil (= cancelled)");
        }
    }

    /// The class guard, as a source scan of both desktop binaries: every web view is guarded by
    /// the ONE app-wide page-load hook (never per builder, so a new window cannot be forgotten),
    /// and no code anywhere opens a panel through objc2's non-null bindings.
    #[test]
    fn every_web_view_and_every_panel_goes_through_the_nil_safe_path() {
        let desktop = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut sources = Vec::new();
        for dir in ["src-tauri/src", "app-runner/src"] {
            for entry in std::fs::read_dir(desktop.join(dir)).unwrap() {
                let path = entry.unwrap().path();
                if path.extension().is_some_and(|e| e == "rs") {
                    sources.push((path.clone(), std::fs::read_to_string(&path).unwrap()));
                }
            }
        }
        assert!(sources.len() > 5, "scanned the desktop sources");
        for (path, text) in &sources {
            if path.ends_with("open_panel_guard.rs") {
                continue; // this file names them only to look for them
            }
            for typed in ["NSOpenPanel::openPanel(", "NSSavePanel::savePanel(", "NSOpenPanel::new(", "NSSavePanel::new("] {
                assert!(!text.contains(typed), "{} opens a panel through a non-null binding ({typed}); read it as Option", path.display());
            }
            assert!(
                !text.contains("WryWebViewUIDelegate"),
                "{} names wry's delegate class; the guard reads the class from the web view",
                path.display()
            );
        }
        let lib = &sources.iter().find(|(p, _)| p.ends_with("src-tauri/src/lib.rs")).unwrap().1;
        let hook = lib.find("builder.on_page_load(").expect("lib.rs installs an app-wide page-load hook");
        let hook: String = lib[hook..].chars().take(900).collect();
        assert!(
            hook.contains("open_panel_guard::install_on("),
            "the app-wide page-load hook guards every web view's file chooser"
        );
    }
}
