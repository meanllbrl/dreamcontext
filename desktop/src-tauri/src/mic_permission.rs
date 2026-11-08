//! The microphone PERMISSION, asked of macOS directly (`AVCaptureDevice`).
//!
//! Why this exists: macOS asks for the microphone only when something first opens it, and the
//! composer used to hide its mic until local dictation was installed. A Mac that had never
//! recorded therefore never saw the prompt, and a Mac where the owner had once said no had no
//! way back from inside the app (owner, 2026-11-08: "izin alması için bir kere kullanmak
//! zorunda"). The composer now reads the state up front and offers the step itself:
//!  - `mic_permission`: "granted" | "prompt" | "denied" | "restricted";
//!  - `mic_permission_request`: shows the macOS prompt (only ever shown once; after a no it
//!    answers false at once) and returns whether it was granted;
//!  - `mic_open_settings`: opens System Settings › Privacy & Security › Microphone, the only
//!    way back after a no.
//!
//! The TCC service is the same one `mic.rs` (CoreAudio via cpal) and WebKit's getUserMedia hit,
//! so a grant here is a grant for every take. Off macOS every call degrades to "granted" /
//! true / no-op: those builds have no such gate.

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::sync::mpsc;
    use std::time::Duration;

    // AVCaptureDevice lives in AVFoundation; nothing else in the shell links it.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// `AVMediaTypeAudio`'s value. The constant is an `NSString *` export; its contents are
    /// documented API and have been "soun" since 10.7, so no extern static is needed.
    const MEDIA_AUDIO: &str = "soun";

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    /// AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
    pub fn status() -> &'static str {
        let Some(cls) = class() else { return "granted" };
        let media = NSString::from_str(MEDIA_AUDIO);
        let raw: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media] };
        match raw {
            0 => "prompt",
            1 => "restricted",
            2 => "denied",
            _ => "granted",
        }
    }

    pub fn request() -> bool {
        let Some(cls) = class() else { return true };
        let (tx, rx) = mpsc::channel::<bool>();
        let block = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media = NSString::from_str(MEDIA_AUDIO);
        unsafe {
            let _: () = msg_send![cls, requestAccessForMediaType: &*media, completionHandler: &*block];
        }
        // The prompt waits on the owner. Five minutes is "they walked away"; the composer reads
        // the status again on its next open either way.
        rx.recv_timeout(Duration::from_secs(300)).unwrap_or(false)
    }
}

/// Where the owner is with the microphone permission.
#[tauri::command]
pub fn mic_permission() -> &'static str {
    #[cfg(target_os = "macos")]
    return mac::status();
    #[cfg(not(target_os = "macos"))]
    return "granted";
}

/// Show the macOS prompt and wait for the answer. Async so the wait is off the main thread,
/// which is where the prompt's answer is delivered.
#[tauri::command]
pub async fn mic_permission_request() -> bool {
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(mac::request).await.unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    return true;
}

/// Open System Settings on the Microphone list. A fixed URL: the page cannot pass one in.
#[tauri::command]
pub fn mic_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}
