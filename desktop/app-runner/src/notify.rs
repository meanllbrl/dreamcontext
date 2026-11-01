//! `app-runner --dc-notify-1`: post one notification AS THIS APP, then exit.
//!
//! macOS binds a banner's icon, name, sound permission and click to the bundle that posts it, so
//! the only way a banner wears the app's icon is to be posted from the app's own bundle. The
//! gateway execs `Contents/MacOS/app-runner` directly and writes `{title, body, sound?}` on
//! stdin (never argv: a body is not for `ps`).
//!
//! `NSUserNotificationCenter`, deprecated as it is, because it is the one that works here:
//! measured on macOS 26.3, `UNUserNotificationCenter` answers "Notifications are not allowed for
//! this application" for an ad-hoc signed bundle, while this API is attributed to the bundle and
//! makes macOS ask the owner for permission. No NSApplication: no Dock tile, no focus change,
//! and a live window of the same bundle is left alone. A click launches or activates the bundle.
//! A non-zero exit means nothing was posted; the caller falls back to dreamcontext's bundle.

use std::io::Read;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{class, define_class, msg_send, AnyThread};

use crate::model;

const DELIVERY_WAIT_TICKS: u32 = 30; // 3 s at 100 ms

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "DCAppRunnerNotifyDelegate"]
    struct PresentAlways;

    impl PresentAlways {
        // Without it macOS drops the banner while the app's window is the frontmost one, which
        // is exactly where an app's own "try a notification" button is pressed.
        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn should_present(&self, _center: &AnyObject, _note: &AnyObject) -> bool {
            true
        }
    }
);

fn tick() {
    unsafe {
        let until: Retained<AnyObject> = msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: 0.1f64];
        let run_loop: Retained<AnyObject> = msg_send![class!(NSRunLoop), currentRunLoop];
        let _: () = msg_send![&*run_loop, runUntilDate: &*until];
    }
}

fn ns_string(s: &str) -> Retained<objc2_foundation::NSString> {
    objc2_foundation::NSString::from_str(s)
}

unsafe fn delivered(center: &AnyObject, id: &objc2_foundation::NSString) -> bool {
    let list: Retained<objc2_foundation::NSArray<AnyObject>> = msg_send![center, deliveredNotifications];
    list.iter().any(|n| {
        let got: Option<Retained<objc2_foundation::NSString>> = msg_send![&*n, identifier];
        got.is_some_and(|g| g.isEqualToString(id))
    })
}

fn post(p: &model::NotifyPayload) -> Result<(), String> {
    unsafe {
        let center: Option<Retained<AnyObject>> =
            msg_send![class!(NSUserNotificationCenter), defaultUserNotificationCenter];
        let center = center.ok_or("no notification center (not inside a bundle?)")?;
        let delegate: Retained<PresentAlways> = msg_send![PresentAlways::alloc(), init];
        let _: () = msg_send![&*center, setDelegate: &*delegate];

        let note: Retained<AnyObject> = msg_send![class!(NSUserNotification), new];
        let id: Retained<AnyObject> = msg_send![class!(NSUUID), UUID];
        let id: Retained<objc2_foundation::NSString> = msg_send![&*id, UUIDString];
        let _: () = msg_send![&*note, setIdentifier: &*id];
        let _: () = msg_send![&*note, setTitle: &*ns_string(&p.title)];
        let _: () = msg_send![&*note, setInformativeText: &*ns_string(&p.body)];
        if let Some(sound) = &p.sound {
            let _: () = msg_send![&*note, setSoundName: &*ns_string(sound)];
        }
        let _: () = msg_send![&*center, deliverNotification: &*note];

        // The hand-off to usernoted is asynchronous: exiting at once can lose the post. The
        // notification's own `isPresented` stays false until the owner allows the app, so the
        // proof is the delivered list, which also fills while macOS is still asking.
        for _ in 0..DELIVERY_WAIT_TICKS {
            tick();
            if delivered(&center, &id) {
                return Ok(());
            }
        }
        Err("macOS did not take the notification".into())
    }
}

pub fn run() -> ! {
    let mut raw = String::new();
    let outcome = std::io::stdin()
        .take(model::NOTIFY_MAX_BYTES)
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())
        .and_then(|_| model::parse_notify_payload(&raw))
        .and_then(|p| post(&p));
    match outcome {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("[app-runner] notify: {e}");
            std::process::exit(1);
        }
    }
}
