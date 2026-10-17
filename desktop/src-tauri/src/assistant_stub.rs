// The dreamcontext Assistant off macOS: the same commands, none of the notch.
//
// The notch (src/assistant.rs) is an NSPanel seated over the menu bar, driven through
// AppKit (tauri-nspanel, NSScreen, NSEvent monitors, the trackpad actuator). None of that
// exists on Windows, so this module replaces it there. Every command keeps its name,
// arguments and JSON shape, so the dashboard's calls resolve instead of failing as
// "command not found": the ones that would show the notch answer with an honest error
// the wizard can print, and the rest are harmless no-ops.

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt as AutostartExt;

pub const NOTCH_LABEL: &str = "assistant";

/// What the wizard shows when it asks for the notch on a platform that has none.
const UNSUPPORTED: &str = "The dreamcontext Assistant notch is macOS-only for now.";

#[derive(Serialize, Clone)]
pub struct HotkeyStatus {
    ok: bool,
    chord: Option<String>,
    error: Option<String>,
}

impl HotkeyStatus {
    fn none() -> Self {
        HotkeyStatus { ok: true, chord: None, error: None }
    }
}

#[derive(Serialize)]
pub struct NotchGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    notch_height: f64,
    notch_width: f64,
}

/// No notch, so never "enabled": an autostart launch still opens the Launcher.
pub fn assistant_enabled() -> bool {
    false
}

/// The global-shortcut plugin with no handler: no chord is ever registered here.
pub fn shortcut_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new().build()
}

pub fn setup<R: Runtime>(_app: &AppHandle<R>, _port: u16) {}

/// Nothing to guard: only the macOS notch refuses to close.
pub fn guard_close<R: Runtime>(_app: &AppHandle<R>, _label: &str, _api: &tauri::CloseRequestApi) {}

/// The monitor the window is on, with no camera housing.
#[tauri::command]
pub fn assistant_geometry<R: Runtime>(window: tauri::WebviewWindow<R>) -> Result<NotchGeometry, String> {
    let m = window.current_monitor().map_err(|e| e.to_string())?.ok_or("no monitor")?;
    let scale = m.scale_factor();
    let pos = m.position().to_logical::<f64>(scale);
    let size = m.size().to_logical::<f64>(scale);
    Ok(NotchGeometry { x: pos.x, y: pos.y, width: size.width, height: size.height, scale, notch_height: 0.0, notch_width: 0.0 })
}

#[tauri::command]
pub fn assistant_haptic(_sound: Option<bool>) {}

#[tauri::command]
pub fn assistant_apply_hotkey<R: Runtime>(_app: AppHandle<R>) -> HotkeyStatus {
    HotkeyStatus::none()
}

/// The login item is cross-platform (the autostart plugin), so this one is real.
#[tauri::command]
pub fn assistant_set_autostart<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    al.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn assistant_set_enabled<R: Runtime>(_app: AppHandle<R>, enabled: bool) -> Result<HotkeyStatus, String> {
    if enabled {
        return Err(UNSUPPORTED.into());
    }
    Ok(HotkeyStatus::none())
}

#[tauri::command]
pub fn assistant_wake<R: Runtime>(_app: AppHandle<R>) -> Result<HotkeyStatus, String> {
    Err(UNSUPPORTED.into())
}
