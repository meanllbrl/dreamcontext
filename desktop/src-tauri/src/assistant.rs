// The dreamcontext Assistant's native half: the NOTCH window and the GLOBAL HOTKEY.
//
// ── Why the hotkey lives in Rust ─────────────────────────────────────────────
// The removed Sleepy notch registered its shortcut from JS and got ONE event per press
// (`sleepy:toggle`). Hold-to-talk needs BOTH edges — press starts recording, release
// stops it — and it needs them while ANOTHER app is focused. Carbon's hotkey API (what
// `global-hotkey` wraps on macOS) delivers `kEventHotKeyPressed` AND
// `kEventHotKeyReleased`, and the plugin surfaces them as `ShortcutState::Pressed` /
// `Released` to a Rust handler. That handler forwards each edge to the notch webview as
// `assistant://hotkey` — the only window that listens.
//
// The chord comes from `~/.dreamcontext/assistant/config.json` (written by the Launcher
// wizard), is registered at boot and re-registered by `assistant_apply_hotkey`, which
// returns the REAL registration result so the wizard can say "that chord is taken".
// No config → nothing is registered (a hotkey pressed before the assistant exists does
// nothing).
//
// ── Why the notch is an NSPanel ───────────────────────────────────────────────
// A non-activating panel takes keystrokes WITHOUT deactivating the app the owner was in,
// and dismissing it never surfaces the dreamcontext main window. Pinned (never a branch):
// `tauri-nspanel` rev acb3ec1c. The webview inside is the SPA at `?assistant=1`, which
// mounts the same ChatPane + Composer on the `__assistant__` vault. COLLAPSE IS A
// VISIBILITY/SIZE CHANGE, NEVER A DESTROY: the chat socket inside is the relay's only
// channel, so the panel is hidden or shrunk, and never closed.
//
// ── Pop out ─────────────────────────────────────────────────────────────────────
// The SAME panel can leave the notch seat and float as a normal-sized, resizable window
// (and dock back): the webview emits `assistant://seat`, `apply_seat` changes the level,
// the resizable mask and the shadow (the min size travels with the frame in `set_frames`,
// src/frames.rs). Still one webview, one socket, one
// `claude`.
//
// ── Autostart ──────────────────────────────────────────────────────────────────
// `tauri-plugin-autostart` (LaunchAgent) launches the app with `--autostart`; such a
// launch opens ONLY the notch (see `host_dashboard`'s `open_launcher`). The notch can
// open project windows itself (its capability grants webview-window creation).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, WebviewUrl};
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelBuilder, PanelLevel, StyleMask};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const NOTCH_LABEL: &str = "assistant";
/// Collapsed pill — the webview resizes itself between this and the expanded panel.
const PILL_W: f64 = 300.0;
const PILL_H: f64 = 38.0;
/// Popped out, the window can be resized by its edges down to this (logical px). Applied by
/// `set_frames` (src/frames.rs) as the `window-seat` min preset, after the frame lands.
pub(crate) const WINDOW_MIN_W: f64 = 420.0;
pub(crate) const WINDOW_MIN_H: f64 = 360.0;
/// The notch webview asks to change seats with this event: `{ "seat": "notch" | "window" }`.
pub const SEAT_EVENT: &str = "assistant://seat";

/// Above the menu bar, so the notch seat's y=0 is honoured (a normal window is pushed below it).
fn notch_level() -> i64 {
    PanelLevel::MainMenu.value() + 1
}

tauri_panel! {
    panel!(AssistantPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

/// State the hotkey handler and the commands share.
pub struct AssistantState {
    pub port: u16,
    /// The chord currently registered (so a re-apply unregisters exactly it).
    pub current: Mutex<Option<Shortcut>>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn assistant_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".dreamcontext").join("assistant"))
}

/// The hidden vault exists (the wizard's `POST /api/assistant/create` ran).
pub fn assistant_exists() -> bool {
    assistant_dir().map(|d| d.join("_dream_context").is_dir()).unwrap_or(false)
}

#[derive(serde::Deserialize)]
struct HotkeyCfg {
    code: String,
    mods: Vec<String>,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(serde::Deserialize)]
struct Cfg {
    hotkey: Option<HotkeyCfg>,
}

/// Parse the config's physical `KeyboardEvent.code` + modifier names into a Shortcut.
/// A chord without a modifier is refused — it would fire on every keystroke in every app.
fn shortcut_from_config() -> Result<Option<(Shortcut, String)>, String> {
    let Some(dir) = assistant_dir() else { return Ok(None) };
    let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else { return Ok(None) };
    let cfg: Cfg = serde_json::from_str(&raw).map_err(|e| format!("config.json is malformed: {e}"))?;
    let Some(h) = cfg.hotkey else { return Ok(None) };
    let code: Code = h.code.parse().map_err(|_| format!("unknown key code {}", h.code))?;
    let mut mods = Modifiers::empty();
    for m in &h.mods {
        mods |= match m.as_str() {
            "Meta" => Modifiers::SUPER,
            "Control" => Modifiers::CONTROL,
            "Alt" => Modifiers::ALT,
            "Shift" => Modifiers::SHIFT,
            other => return Err(format!("unknown modifier {other}")),
        };
    }
    if mods.is_empty() {
        return Err("a hotkey needs at least one modifier".into());
    }
    let label = format!("{}+{} ({})", h.mods.join("+"), h.code, h.mode.unwrap_or_else(|| "hold".into()));
    Ok(Some((Shortcut::new(Some(mods), code), label)))
}

#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    ok: bool,
    chord: Option<String>,
    error: Option<String>,
}

/// (Re)register the chord from config. Returns the honest result — a chord another app
/// already owns fails HERE, and the wizard shows it.
pub fn apply_hotkey<R: Runtime>(app: &AppHandle<R>) -> HotkeyStatus {
    let gs = app.global_shortcut();
    if let Some(state) = app.try_state::<AssistantState>() {
        if let Ok(mut cur) = state.current.lock() {
            if let Some(old) = cur.take() {
                let _ = gs.unregister(old);
            }
        }
    }
    let status = match shortcut_from_config() {
        Ok(None) => HotkeyStatus { ok: true, chord: None, error: None },
        Err(e) => HotkeyStatus { ok: false, chord: None, error: Some(e) },
        Ok(Some((sc, label))) => match gs.register(sc) {
            Ok(()) => {
                if let Some(state) = app.try_state::<AssistantState>() {
                    if let Ok(mut cur) = state.current.lock() {
                        *cur = Some(sc);
                    }
                }
                HotkeyStatus { ok: true, chord: Some(label), error: None }
            }
            Err(e) => HotkeyStatus { ok: false, chord: Some(label), error: Some(format!("hotkey unavailable: {e}")) },
        },
    };
    log_edge(&match (&status.chord, &status.error) {
        (Some(c), None) => format!("registered {c}"),
        (_, Some(e)) => format!("unregistered: {e}"),
        (None, None) => "no hotkey configured".into(),
    });
    let _ = app.emit_to(NOTCH_LABEL, "assistant://hotkey-status", status.clone());
    status
}

/// The name of the app in front when an edge fired — the S1 spike's evidence that the
/// press and release were caught while ANOTHER app was focused.
fn frontmost_app_name() -> String {
    use objc2_app_kit::NSWorkspace;
    let ws = NSWorkspace::sharedWorkspace();
    ws.frontmostApplication()
        .and_then(|a| a.localizedName())
        .map(|n| n.to_string())
        .unwrap_or_else(|| "?".into())
}

/// Opt-in diagnostic log of every hotkey edge and registration (DREAMCONTEXT_ASSISTANT_HOTKEY_LOG=1).
fn log_edge(state: &str) {
    if std::env::var("DREAMCONTEXT_ASSISTANT_HOTKEY_LOG").ok().as_deref() != Some("1") {
        return;
    }
    let Some(dir) = assistant_dir() else { return };
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("hotkey-events.log")) {
        let _ = writeln!(f, "{ms} {state} frontmost={}", frontmost_app_name());
    }
}

/// The global-shortcut plugin, with the Rust-side handler that forwards BOTH edges.
pub fn shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            let state = match event.state() {
                ShortcutState::Pressed => "pressed",
                ShortcutState::Released => "released",
            };
            log_edge(state);
            // Idempotent: a summon shows the notch if hidden; the webview ignores a Pressed
            // that arrives while it is already recording.
            if state == "pressed" {
                let _ = ensure_notch(app);
            }
            let _ = app.emit_to(NOTCH_LABEL, "assistant://hotkey", serde_json::json!({ "state": state }));
        })
        .build()
}

/// Build (once) and show the notch panel, seated at the top centre of the monitor the
/// cursor is on. A second call just shows it.
pub fn ensure_notch<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Ok(panel) = app.get_webview_panel(NOTCH_LABEL) {
        panel.show();
        return Ok(());
    }
    let port = app.try_state::<AssistantState>().map(|s| s.port).ok_or("assistant state missing")?;
    let url = format!("http://127.0.0.1:{port}/?assistant=1").parse().map_err(|e| format!("bad url: {e}"))?;

    let (x, y) = seat_for(app, PILL_W);
    let panel = PanelBuilder::<R, AssistantPanel<R>>::new(app, NOTCH_LABEL)
        .url(WebviewUrl::External(url))
        .title("dreamcontext Assistant")
        .size(tauri::Size::Logical(tauri::LogicalSize::new(PILL_W, PILL_H)))
        .position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)))
        .level(PanelLevel::Custom(notch_level() as i32))
        .collection_behavior(
            CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().stationary(),
        )
        .with_window(|w| w.decorations(false).transparent(true).skip_taskbar(true).shadow(false).always_on_top(true))
        .add_style_mask(StyleMask::empty().nonactivating_panel())
        .no_activate(true)
        .transparent(true)
        .has_shadow(false)
        .hides_on_deactivate(false)
        .works_when_modal(true)
        .build()
        .map_err(|e| format!("could not build the notch: {e}"))?;
    panel.show();
    Ok(())
}

/// Top-centre of the monitor under the cursor (falls back to the primary), in logical px,
/// for a window `w` wide. y is 0 — the panel's level puts it over the menu bar.
fn seat_for<R: Runtime>(app: &AppHandle<R>, w: f64) -> (f64, f64) {
    let mon = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    match mon {
        Some(m) => {
            let scale = m.scale_factor();
            let pos = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            (pos.x + (size.width - w) / 2.0, pos.y)
        }
        None => (0.0, 0.0),
    }
}

#[derive(Serialize)]
pub struct NotchGeometry {
    /// The monitor the notch sits on, logical px.
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    /// Height of the camera housing (the menu-bar safe-area inset), 0 without a notch.
    notch_height: f64,
    /// Width of the camera housing, 0 without a notch.
    notch_width: f64,
}

/// Where the notch is on the monitor the panel is on — so the webview can size its pill
/// to the camera housing, or fall back to a top-centre pill when there is none.
#[tauri::command]
pub fn assistant_geometry<R: Runtime>(window: tauri::WebviewWindow<R>) -> Result<NotchGeometry, String> {
    let m = window.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    let (notch_width, notch_height) = notch_of_screen_at(pos.x, size.width);
    Ok(NotchGeometry { x: pos.x, y: pos.y, width: size.width, height: size.height, scale, notch_height, notch_width })
}

/// The camera housing of the NSScreen whose frame starts at `x` (logical), from
/// `safeAreaInsets.top` and the auxiliary top areas (macOS 12+). (0, 0) without a notch.
fn notch_of_screen_at(x: f64, width: f64) -> (f64, f64) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    let Some(mtm) = MainThreadMarker::new() else { return (0.0, 0.0) };
    let screens = NSScreen::screens(mtm);
    for s in screens.iter() {
        let f = s.frame();
        if (f.origin.x - x).abs() > 1.0 || (f.size.width - width).abs() > 1.0 {
            continue;
        }
        let top = s.safeAreaInsets().top;
        if top <= 0.0 {
            return (0.0, 0.0);
        }
        let left = s.auxiliaryTopLeftArea().size.width;
        let right = s.auxiliaryTopRightArea().size.width;
        let housing = (f.size.width - left - right).max(0.0);
        return (housing, top);
    }
    (0.0, 0.0)
}

/// Re-read the config and re-register the chord; the wizard shows the result live.
#[tauri::command]
pub fn assistant_apply_hotkey<R: Runtime>(app: AppHandle<R>) -> HotkeyStatus {
    apply_hotkey(&app)
}

/// Turn the Login Item on/off (LaunchAgent). Returns the resulting state.
#[tauri::command]
pub fn assistant_set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

/// Show the notch (after the wizard's "Wake up"), registering the hotkey too.
#[tauri::command]
pub fn assistant_wake<R: Runtime>(app: AppHandle<R>) -> Result<HotkeyStatus, String> {
    ensure_notch(&app)?;
    Ok(apply_hotkey(&app))
}

/// Move the SAME panel between its two seats. Nothing is rebuilt and the webview is never
/// reloaded (its chat socket is the relay's only channel); only what makes it a notch or a
/// window changes:
/// - notch: above the menu bar, fixed size (the webview sizes it for pill / open notch);
/// - window: the normal floating level (under menus and other apps' alerts), resizable by its
///   edges with a minimum size, and a shadow so it reads as a window.
/// It stays a non-activating panel in both seats: typing into it never deactivates the app the
/// owner was in, and it never drags the Launcher forward. The webview does size and position
/// itself (its capability already grants that), and moves by `startDragging` from its top row.
fn apply_seat<R: Runtime>(app: &AppHandle<R>, window: bool) {
    use tauri_nspanel::objc2_app_kit::NSWindowStyleMask;
    let Ok(panel) = app.get_webview_panel(NOTCH_LABEL) else { return };
    panel.set_level(if window { PanelLevel::Floating.value() } else { notch_level() });
    let mask = panel.as_panel().styleMask();
    let mask = if window { mask | NSWindowStyleMask::Resizable } else { mask & !NSWindowStyleMask::Resizable };
    let _ = panel.set_style_mask(mask);
    panel.set_has_shadow(window);
    // No min size here: set while the window is still pill-sized, tao grows the frame at once
    // (a visible jump). The webview sends it with its frame instead — `set_frames` applies the
    // `window-seat` / `clear` preset after the frame lands (src/frames.rs).
}

/// Boot: remember the port; if the assistant exists, register its hotkey and seat the notch.
pub fn setup<R: Runtime>(app: &AppHandle<R>, port: u16) {
    app.manage(AssistantState { port, current: Mutex::new(None) });
    // Pop out / dock. An event rather than a command so no other file has to register it. Any
    // webview allowed to emit could send it, and the worst it can do is move the notch between
    // its two seats; the payload is parsed strictly and anything else is ignored.
    let handle = app.clone();
    app.listen(SEAT_EVENT, move |event| {
        let seat = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("seat").and_then(|s| s.as_str()).map(str::to_owned));
        let window = match seat.as_deref() {
            Some("window") => true,
            Some("notch") => false,
            _ => return,
        };
        let h = handle.clone();
        // AppKit only on the main thread.
        let _ = handle.run_on_main_thread(move || apply_seat(&h, window));
    });
    if assistant_exists() {
        let _ = apply_hotkey(app);
        let _ = ensure_notch(app);
    }
}
