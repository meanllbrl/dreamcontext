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
/// Told to the notch webview when a mouse button goes down anywhere outside the OPEN panel.
pub const OUTSIDE_CLICK_EVENT: &str = "assistant://outside-click";
/// Told to the notch webview when the pointer enters or leaves the notch (`{ "inside": bool }`).
pub const HOVER_EVENT: &str = "assistant://hover";
/// The notch asks for Esc while it is open in the notch seat (`{ "on": bool }`), and lets it go
/// when it folds. Summoned over another app the panel never becomes key, so a keydown never
/// reaches the webview; a key MONITOR would need an Accessibility grant. A Carbon hotkey needs
/// none, but it takes Esc from every app while held, so it is held only while the notch is open.
pub const ESCAPE_GRAB_EVENT: &str = "assistant://escape-grab";
/// Told to the notch webview when the grabbed Esc is pressed.
pub const ESCAPE_EVENT: &str = "assistant://escape";
/// Taller than any collapsed pill (the camera housing is ~38 px): below this the panel is closed
/// and a click elsewhere has nothing to dismiss, so it is not reported.
const OPEN_MIN_H: f64 = 100.0;

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
    /// The owner's off switch (the Launcher card). Absent = on: every config written before
    /// the switch existed belongs to an assistant the owner set up and was using.
    #[serde(default = "on")]
    enabled: bool,
}

fn on() -> bool {
    true
}

fn read_cfg() -> Result<Option<Cfg>, String> {
    let Some(dir) = assistant_dir() else { return Ok(None) };
    let Ok(raw) = std::fs::read_to_string(dir.join("config.json")) else { return Ok(None) };
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("config.json is malformed: {e}"))
}

/// The assistant exists AND the owner has not switched it off. Everything that would put
/// the notch on screen or grab the hotkey asks this, not `assistant_exists`. A malformed
/// config counts as on, so a typo never silently hides an assistant the owner relies on.
pub fn assistant_enabled() -> bool {
    assistant_exists() && read_cfg().ok().flatten().map(|c| c.enabled).unwrap_or(true)
}

/// The notch is on screen: the assistant is on, OR it was never created. Without an assistant
/// the notch is still the notification center (finished chats, permissions, automation posts,
/// account notices), just with no conversation and no hotkey (owner, 2026-10-08). Only the
/// owner's off switch on an assistant they created takes it away.
pub fn notch_wanted() -> bool {
    !assistant_exists() || assistant_enabled()
}

/// Parse the config's physical `KeyboardEvent.code` + modifier names into a Shortcut.
/// A chord without a modifier is refused — it would fire on every keystroke in every app.
fn shortcut_from_config() -> Result<Option<(Shortcut, String)>, String> {
    let Some(cfg) = read_cfg()? else { return Ok(None) };
    if !cfg.enabled {
        return Ok(None);
    }
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

fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Hold or release Esc for the open notch (see `ESCAPE_GRAB_EVENT`). Idempotent.
fn set_escape_grab<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let gs = app.global_shortcut();
    let sc = escape_shortcut();
    if on && !gs.is_registered(sc) {
        let _ = gs.register(sc);
    } else if !on && gs.is_registered(sc) {
        let _ = gs.unregister(sc);
    }
}

/// The global-shortcut plugin, with the Rust-side handler that forwards BOTH edges.
pub fn shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            // The open notch's Esc (never the summoning chord: that one needs a modifier).
            if shortcut.id() == escape_shortcut().id() {
                if matches!(event.state(), ShortcutState::Pressed) {
                    let _ = app.emit_to(NOTCH_LABEL, ESCAPE_EVENT, serde_json::json!({}));
                }
                return;
            }
            let state = match event.state() {
                ShortcutState::Pressed => "pressed",
                ShortcutState::Released => "released",
            };
            log_edge(state);
            // Idempotent: a summon shows the notch if hidden; the webview ignores a Pressed
            // that arrives while it is already recording.
            if state == "pressed" && assistant_enabled() {
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
        // `focused(false)`, not the builder's `no_activate(true)`: that one flips the app's
        // activation policy to Prohibited while the window is built, and macOS hides EVERY
        // window of a Prohibited app — the opening screen or the Launcher blinked out for
        // ~300ms and came back. Not focusing the new window is all that is needed to not
        // steal focus.
        // `disable_drag_drop_handler`: with Tauri's handler on, a file dragged from Finder is
        // swallowed natively and the page never sees `dragenter`/`drop`, so the notch could
        // neither open under a dragged file nor take it (every other window is built with
        // `dragDropEnabled: false` for the same reason, lib/desktop.ts).
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .skip_taskbar(true)
                .shadow(false)
                .always_on_top(true)
                .focused(false)
                .disable_drag_drop_handler()
        })
        .add_style_mask(StyleMask::empty().nonactivating_panel())
        .transparent(true)
        .has_shadow(false)
        .hides_on_deactivate(false)
        .works_when_modal(true)
        .build()
        .map_err(|e| format!("could not build the notch: {e}"))?;
    prevent_activation(app);
    panel.show();
    Ok(())
}

/// tauri-nspanel turns an already-built NSWindow into a panel and sets `nonactivatingPanel`
/// on its style mask AFTER creation. AppKit then treats the panel as non-activating, but the
/// window server's own flag is only set when the mask is given at init, so the two disagree:
/// after the owner clicks a notch row, a project window brought forward could be key in an
/// app that never became active, and its page stayed unfocused (no caret, no typing) through
/// every click (~/.dreamcontext/logs/focus-diag.log, 2026-10-04). The private
/// `_setPreventsActivation:` sets the window-server flag to match. Skipped when AppKit does not
/// answer it.
fn prevent_activation<R: Runtime>(app: &AppHandle<R>) {
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, sel};
        let Some(w) = h.get_webview_window(NOTCH_LABEL) else { return };
        let Ok(ptr) = w.ns_window() else { return };
        let win = ptr as *mut AnyObject;
        if win.is_null() {
            return;
        }
        // SAFETY: the notch's live NSWindow, on the main thread; the selector is checked
        // before it is sent.
        unsafe {
            let can: bool = msg_send![win, respondsToSelector: sel!(_setPreventsActivation:)];
            if can {
                let _: () = msg_send![win, _setPreventsActivation: true];
            }
            crate::page_focus::diag_line(&format!("[assistant] window-server prevents-activation set: {can}"));
        }
    });
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

/// One faint trackpad tap with a notch notification (owner, 2026-10-04: "a minimal vibration,
/// like haptic feedback"), and with `sound`, the notification's tick.
///
/// A Mac has no vibration motor: the only haptic is the Force Touch trackpad, felt only while a
/// finger rests on it. `NSHapticFeedbackManager` performs ONLY for the active app, and the notch
/// is a non-activating panel of an app that is usually NOT in front, so its taps were dropped
/// (owner, 2026-10-04: "the haptic does not come"). The trackpad's actuator is driven directly
/// instead (MultitouchSupport, loaded at run time; see `actuate_trackpad`), with AppKit as the
/// fallback when that framework is missing.
///
/// The tick is a system sound for the same reason: the webview's WebAudio context stays
/// suspended until the notch is clicked once (autoplay policy), so the first notifications
/// after launch were silent. A native sound has no such gate.
#[tauri::command]
pub fn assistant_haptic(sound: Option<bool>) {
    if sound == Some(true) {
        play_tick();
    }
    if actuate_trackpad() {
        return;
    }
    use objc2_app_kit::{
        NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime, NSHapticFeedbackPerformer,
    };
    NSHapticFeedbackManager::defaultPerformer()
        .performFeedbackPattern_performanceTime(NSHapticFeedbackPattern::Generic, NSHapticFeedbackPerformanceTime::Now);
}

/// The notification tick: a quiet system sound.
fn play_tick() {
    use objc2_app_kit::NSSound;
    use objc2_foundation::NSString;
    if let Some(snd) = NSSound::soundNamed(&NSString::from_str("Tink")) {
        snd.setVolume(0.35);
        snd.play();
    }
}

/// Tap the built-in trackpad through its actuator (MultitouchSupport.framework, private, the
/// way HapticKey does it), which works whichever app is in front. Loaded with `dlopen`, so a
/// macOS without it just returns false. Actuation 1 is the lightest click.
fn actuate_trackpad() -> bool {
    use std::ffi::{c_void, CStr};
    type CreateDefault = unsafe extern "C" fn() -> *const c_void;
    type GetDeviceId = unsafe extern "C" fn(*const c_void, *mut u64) -> i32;
    type CreateActuator = unsafe extern "C" fn(u64) -> *const c_void;
    type OpenClose = unsafe extern "C" fn(*const c_void) -> i32;
    type Actuate = unsafe extern "C" fn(*const c_void, i32, u32, f32, f32) -> i32;
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    const PATH: &CStr = c"/System/Library/PrivateFrameworks/MultitouchSupport.framework/MultitouchSupport";
    unsafe {
        let lib = libc::dlopen(PATH.as_ptr(), libc::RTLD_LAZY);
        if lib.is_null() {
            return false;
        }
        let sym = |name: &CStr| libc::dlsym(lib, name.as_ptr());
        let (cd, gid, ca, op, ac, cl) = (
            sym(c"MTDeviceCreateDefault"),
            sym(c"MTDeviceGetDeviceID"),
            sym(c"MTActuatorCreateFromDeviceID"),
            sym(c"MTActuatorOpen"),
            sym(c"MTActuatorActuate"),
            sym(c"MTActuatorClose"),
        );
        if [cd, gid, ca, op, ac, cl].iter().any(|p| p.is_null()) {
            return false;
        }
        let create_default: CreateDefault = std::mem::transmute(cd);
        let get_id: GetDeviceId = std::mem::transmute(gid);
        let create_actuator: CreateActuator = std::mem::transmute(ca);
        let open: OpenClose = std::mem::transmute(op);
        let actuate: Actuate = std::mem::transmute(ac);
        let close: OpenClose = std::mem::transmute(cl);
        let device = create_default();
        if device.is_null() {
            return false;
        }
        let mut id: u64 = 0;
        let ok_id = get_id(device, &mut id) == 0 && id != 0;
        CFRelease(device);
        if !ok_id {
            return false;
        }
        let actuator = create_actuator(id);
        if actuator.is_null() {
            return false;
        }
        let mut done = false;
        if open(actuator) == 0 {
            done = actuate(actuator, 1, 0, 0.0, 2.0) == 0;
            close(actuator);
        }
        CFRelease(actuator);
        done
    }
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

/// The owner's off switch, applied natively AFTER the server wrote `enabled` to config.json.
/// Off: the notch is hidden (not closed; tauri-nspanel panels are not safely destroyable, and
/// the next launch never builds it), the chord is released so the keys go back to other apps,
/// and the Login Item is removed (a login that opens nothing is worse than none). On: seat the
/// notch and register the chord again. The Login Item stays off; the wizard's step turns it on.
#[tauri::command]
pub fn assistant_set_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<HotkeyStatus, String> {
    // Told first, so a seat change already in flight in the webview cannot show it again.
    let _ = app.emit_to(NOTCH_LABEL, "assistant://enabled", serde_json::json!({ "enabled": enabled }));
    if enabled {
        ensure_notch(&app)?;
        return Ok(apply_hotkey(&app));
    }
    if let Ok(panel) = app.get_webview_panel(NOTCH_LABEL) {
        panel.hide();
    }
    // A notch hidden while open never folds, so it would never let Esc go.
    set_escape_grab(&app, false);
    let _ = app.autolaunch().disable();
    Ok(apply_hotkey(&app))
}

/// Show the notch (after the wizard's "Wake up"), registering the hotkey too.
#[tauri::command]
pub fn assistant_wake<R: Runtime>(app: AppHandle<R>) -> Result<HotkeyStatus, String> {
    // A notch already up without an assistant (notifications only) is not rebuilt; this tells
    // it the assistant now exists, so it loads it and starts the conversation.
    let _ = app.emit_to(NOTCH_LABEL, "assistant://enabled", serde_json::json!({ "enabled": true }));
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

/// Boot: remember the port; register the hotkey if the assistant is on, and seat the notch
/// whenever it is wanted (`notch_wanted`: also with no assistant at all).
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
    let handle = app.clone();
    app.listen(ESCAPE_GRAB_EVENT, move |event| {
        let on = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .and_then(|v| v.get("on").and_then(|b| b.as_bool()));
        if let Some(on) = on {
            set_escape_grab(&handle, on);
        }
    });
    let h = app.clone();
    let _ = app.run_on_main_thread(move || watch_outside_clicks(&h));
    let h = app.clone();
    let _ = app.run_on_main_thread(move || watch_hover(&h));
    if assistant_enabled() {
        let _ = apply_hotkey(app);
    }
    if notch_wanted() {
        let _ = ensure_notch(app);
    }
}

// ── Click outside ──────────────────────────────────────────────────────────────────
// The webview used to collapse on `onFocusChanged(false)`. But the notch is a NON-ACTIVATING
// panel: summoned by the hotkey while another app is in front, it never becomes key, so it never
// loses focus either, and a click elsewhere left it open. Mouse-down monitors see the click
// whether or not the panel ever had focus: the global one for clicks in other apps (mouse events
// need no Accessibility grant, unlike keys), the local one for dreamcontext's own windows. Both
// only REPORT a click outside the open panel; the webview decides (a popped-out window ignores it).

/// True when a mouse-down at `p` (screen coords) should be reported: the panel is on screen,
/// open (taller than a pill) and `p` is outside its frame.
fn is_outside_open_panel(visible: bool, frame: objc2_foundation::NSRect, p: objc2_foundation::NSPoint) -> bool {
    if !visible || frame.size.height < OPEN_MIN_H {
        return false;
    }
    let inside = p.x >= frame.origin.x
        && p.x <= frame.origin.x + frame.size.width
        && p.y >= frame.origin.y
        && p.y <= frame.origin.y + frame.size.height;
    !inside
}

/// Main thread only (the monitors call back on it).
fn report_if_outside<R: Runtime>(app: &AppHandle<R>) {
    use objc2_app_kit::{NSEvent, NSWindow};
    let Some(w) = app.get_webview_window(NOTCH_LABEL) else { return };
    let Ok(ptr) = w.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // SAFETY: the notch's live NSWindow (a tauri-nspanel NSPanel), read on the main thread.
    let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    if is_outside_open_panel(win.isVisible(), win.frame(), NSEvent::mouseLocation()) {
        let _ = app.emit_to(NOTCH_LABEL, OUTSIDE_CLICK_EVENT, ());
    }
}

/// Install both monitors once, for the app's lifetime (the tokens are never removed).
fn watch_outside_clicks<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    let mask = NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown | NSEventMask::OtherMouseDown;

    let g = app.clone();
    let global = RcBlock::new(move |_e: NonNull<NSEvent>| report_if_outside(&g));
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global));

    let l = app.clone();
    let local = RcBlock::new(move |e: NonNull<NSEvent>| -> *mut NSEvent {
        report_if_outside(&l);
        e.as_ptr() // pass the event on untouched
    });
    // SAFETY: the handler returns the event it was given, so every click is still delivered.
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) });
}

// ── Hover ───────────────────────────────────────────────────────────────────────────
// WKWebView tracks the pointer only while its window is KEY (`NSTrackingActiveInKeyWindow`
// whenever scrollbars are the overlay kind, i.e. on a trackpad). The notch is a non-activating
// panel that is almost never key, so the page saw no `pointerenter` and the hover peek dropped
// only sometimes — never with another app in front, never under a dragged file. Same remedy as
// clicks: mouse-move monitors (no Accessibility grant for mouse events) report when the pointer
// crosses the notch's frame, and only the crossing, never every move.

static POINTER_INSIDE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Is `p` (screen coords) inside `frame` of a visible window?
fn is_inside(visible: bool, frame: objc2_foundation::NSRect, p: objc2_foundation::NSPoint) -> bool {
    visible
        && p.x >= frame.origin.x
        && p.x < frame.origin.x + frame.size.width
        && p.y >= frame.origin.y
        && p.y < frame.origin.y + frame.size.height
}

/// Main thread only (the monitors call back on it).
fn report_hover<R: Runtime>(app: &AppHandle<R>) {
    use objc2_app_kit::{NSEvent, NSWindow};
    use std::sync::atomic::Ordering;
    let Some(w) = app.get_webview_window(NOTCH_LABEL) else { return };
    let Ok(ptr) = w.ns_window() else { return };
    if ptr.is_null() {
        return;
    }
    // SAFETY: the notch's live NSWindow (a tauri-nspanel NSPanel), read on the main thread.
    let win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let inside = is_inside(win.isVisible(), win.frame(), NSEvent::mouseLocation());
    if POINTER_INSIDE.swap(inside, Ordering::Relaxed) != inside {
        let _ = app.emit_to(NOTCH_LABEL, HOVER_EVENT, serde_json::json!({ "inside": inside }));
    }
}

/// Install both monitors once, for the app's lifetime (the tokens are never removed). Dragged
/// moves count too: a file dragged from Finder is a held button, not a plain move.
fn watch_hover<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    let mask = NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged;

    let g = app.clone();
    let global = RcBlock::new(move |_e: NonNull<NSEvent>| report_hover(&g));
    std::mem::forget(NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global));

    let l = app.clone();
    let local = RcBlock::new(move |e: NonNull<NSEvent>| -> *mut NSEvent {
        report_hover(&l);
        e.as_ptr() // pass the event on untouched
    });
    // SAFETY: the handler returns the event it was given, so every move is still delivered.
    std::mem::forget(unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) });
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    const OPEN: NSRect = NSRect { origin: NSPoint { x: 610.0, y: 520.0 }, size: NSSize { width: 580.0, height: 560.0 } };

    #[test]
    fn a_click_outside_the_open_panel_is_reported() {
        assert!(is_outside_open_panel(true, OPEN, NSPoint::new(250.0, 100.0)));
        assert!(is_outside_open_panel(true, OPEN, NSPoint::new(1191.0, 700.0)));
    }

    #[test]
    fn a_click_inside_the_panel_is_not() {
        assert!(!is_outside_open_panel(true, OPEN, NSPoint::new(900.0, 800.0)));
        assert!(!is_outside_open_panel(true, OPEN, NSPoint::new(610.0, 520.0)));
    }

    #[test]
    fn hover_is_inside_a_visible_frame_only() {
        let pill = NSRect::new(NSPoint::new(659.0, 1042.0), NSSize::new(300.0, 38.0));
        assert!(is_inside(true, pill, NSPoint::new(700.0, 1060.0)));
        assert!(!is_inside(true, pill, NSPoint::new(959.0, 1060.0)));
        assert!(!is_inside(true, pill, NSPoint::new(700.0, 1000.0)));
        assert!(!is_inside(false, pill, NSPoint::new(700.0, 1060.0)));
    }

    #[test]
    fn a_closed_pill_or_a_hidden_panel_reports_nothing() {
        let pill = NSRect::new(NSPoint::new(659.0, 1042.0), NSSize::new(481.0, 38.0));
        assert!(!is_outside_open_panel(true, pill, NSPoint::new(250.0, 100.0)));
        assert!(!is_outside_open_panel(false, OPEN, NSPoint::new(250.0, 100.0)));
    }
}
