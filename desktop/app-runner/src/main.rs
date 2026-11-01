//! dreamcontext app-runner: the window a dreamcontext App opens in.
//!
//! Each app gets its own small `.app` bundle (`src/lib/apps/bundle.ts`) whose executable is
//! this binary, so the app has its own Dock icon, name and Cmd-Tab entry. The runner holds
//! one WKWebView on the app's gateway (`http://127.0.0.1:<gw>`), keeps the backend lease
//! alive with a heartbeat, and never relaunches dreamcontext from a running window.
//! Plan: dreamcontext-apps plan r19, "Kontrat" and "W1".

mod http;
mod model;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
mod notify;

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::args().nth(1).as_deref() == Some(model::NOTIFY_FLAG) {
        notify::run();
    }
    #[cfg(target_os = "macos")]
    mac::run();
    #[cfg(not(target_os = "macos"))]
    {
        eprintln!("dreamcontext app-runner runs on macOS only");
        std::process::exit(2);
    }
}
