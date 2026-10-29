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
// WebKit exactly once (a nil panel = a cancelled pick, which the page already handles), and
// presents the panel as a sheet on the web view's own window like `pick_paths` does.

use std::ffi::CStr;
use std::ptr::null;
use std::sync::atomic::{AtomicBool, Ordering};

use block2::{Block, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{ffi, msg_send, sel, ClassType};
use objc2_app_kit::{NSModalResponse, NSModalResponseOK, NSOpenPanel, NSWindow};
use objc2_foundation::{NSArray, NSURL};

/// wry's `WKUIDelegate` class (`define_class!(#[name = "WryWebViewUIDelegate"])` in wry 0.55).
const DELEGATE_CLASS: &CStr = c"WryWebViewUIDelegate";

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// WebKit's completion handler: an array of picked URLs, or nil for "cancelled".
type OpenPanelHandler = Block<dyn Fn(*const NSArray<NSURL>)>;

/// Swap wry's open-panel method for [`run_open_panel`]. Idempotent and cheap after the first
/// success; returns whether the guard is in place. wry registers its delegate class lazily (with
/// the first web view), so this is called on every page load until it finds the class.
pub fn install() -> bool {
    if INSTALLED.load(Ordering::Acquire) {
        return true;
    }
    let Some(cls) = AnyClass::get(DELEGATE_CLASS) else {
        return false; // no web view built yet
    };
    let name = sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
    // SAFETY: plain Objective-C runtime calls on a registered class. The replacement takes the
    // same arguments as the method it replaces (self, _cmd, four object pointers, the last a
    // block), so reusing the original's type encoding describes it exactly.
    unsafe {
        let original = ffi::class_getInstanceMethod(cls, name);
        if original.is_null() {
            return false; // a wry without the method: nothing to guard
        }
        let types = ffi::method_getTypeEncoding(original);
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &AnyObject, *const AnyObject, *const OpenPanelHandler),
            Imp,
        >(run_open_panel);
        ffi::class_replaceMethod(cls as *const AnyClass as *mut AnyClass, name, imp, types);
    }
    INSTALLED.store(true, Ordering::Release);
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

    type Method = unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &AnyObject, *const AnyObject, *const OpenPanelHandler);

    /// A stand-in for wry's method: the panic it would hit on a nil panel.
    unsafe extern "C-unwind" fn wry_like(_: &AnyObject, _: Sel, _: &AnyObject, _: &AnyObject, _: *const AnyObject, _: *const OpenPanelHandler) {
        panic!("unexpected NULL returned from +[NSOpenPanel openPanel]");
    }

    /// `+[NSOpenPanel openPanel]` the way it fails in the wild.
    unsafe extern "C-unwind" fn nil_panel(_: &AnyClass, _: Sel) -> *mut AnyObject {
        std::ptr::null_mut()
    }

    /// The crash, end to end without a window: AppKit hands back a nil panel, and the guarded
    /// delegate answers WebKit "cancelled" exactly once instead of panicking (which under
    /// `panic = "abort"` was the app's death).
    #[test]
    fn a_nil_open_panel_is_a_cancelled_pick_not_an_abort() {
        let name = sel!(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:);
        unsafe {
            // No delegate class yet (no web view built): nothing to guard, and it says so.
            assert!(!install());

            // Register a class under wry's name with wry's selector, panicking like wry's does.
            let base = AnyClass::get(c"NSObject").unwrap();
            let cls = ffi::objc_allocateClassPair(base, DELEGATE_CLASS.as_ptr(), 0);
            assert!(!cls.is_null());
            let imp = std::mem::transmute::<Method, Imp>(wry_like);
            assert!(ffi::class_addMethod(cls, name, imp, c"v@:@@@@?".as_ptr()).as_bool());
            ffi::objc_registerClassPair(cls);

            // Make AppKit refuse every panel.
            let meta = NSOpenPanel::class().metaclass() as *const AnyClass as *mut AnyClass;
            let nil = std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyClass, Sel) -> *mut AnyObject, Imp>(nil_panel);
            ffi::class_replaceMethod(meta, sel!(openPanel), nil, c"@@:".as_ptr());

            assert!(install());
            assert!(install(), "idempotent");

            // Call the method the way WebKit does, through the class's current implementation.
            let delegate: Retained<AnyObject> = msg_send![&*cls, new];
            let other: Retained<AnyObject> = msg_send![base, new];
            let method = ffi::class_getInstanceMethod(cls, name);
            let current: Method = std::mem::transmute(ffi::method_getImplementation(method).unwrap());

            let calls: Arc<Mutex<Vec<bool>>> = Arc::default();
            let seen = calls.clone();
            let handler = RcBlock::new(move |urls: *const NSArray<NSURL>| seen.lock().unwrap().push(urls.is_null()));
            let handler_ptr: *const OpenPanelHandler = &*handler;
            current(&delegate, name, &other, &other, null(), handler_ptr);

            assert_eq!(*calls.lock().unwrap(), vec![true], "answered once, with nil (= cancelled)");
        }
    }
}
