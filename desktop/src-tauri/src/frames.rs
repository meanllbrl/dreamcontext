// `set_frames`: move and resize one or more windows as ONE atomic frame, or as one eased
// AppKit animation group (all windows together).
//
// ── Why this exists ─────────────────────────────────────────────────────────────
// Tauri's `setSize` and `setPosition` are two IPCs, and tao dispatches each to the main
// queue separately, so the old-position/new-size frame is visible between them; a window
// popped out of the notch or tiled beside others jumped through several frames. Here the
// whole rect lands in a single `setFrame:display:` — or, animated, in one
// `NSAnimationContext` group driven by the window's `animator()` proxy. NEVER
// `setFrame:display:animate:YES`: that one runs its own modal loop and blocks the main
// thread for the whole duration.
//
// ── The contract (shared with dashboard/src/lib/windowFrames.ts) ─────────────────
// - Validation and label resolution happen BEFORE any AppKit call: one bad number or one
//   unknown label => Err and no window moved (all-or-nothing), so the TS fallback that
//   re-applies every item is always safe.
// - It ALWAYS resolves: on the group's completion handler, immediately for animate_ms 0,
//   or at a hard deadline (animate_ms + 250ms), which force-applies the final frames.
// - Per-label generation: a newer call targeting a label supersedes every older one for
//   that label. Everything a call does after it starts — the deadline's force-apply, the
//   min-size preset, skipping a closed window — happens only while the label's generation
//   is still the call's own. So the LAST requested frame always wins.
// - Min size is a PRESET (keep / window-seat / clear), never caller-chosen dimensions:
//   `WindowSeat` resolves here to assistant.rs's WINDOW_MIN_W/H. It lands after the frame,
//   so a pill-sized window is never grown to the minimum before it moves.
//
// All generation, spam and validation logic is pure (`FrameGens`, `validate`,
// `to_appkit_frame`) and unit-tested below; the AppKit half only calls into it on the
// main thread, so the bookkeeping never races the completion handlers.

use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

/// Cap on one call's items — a tile of every open project stays far below it.
pub const MAX_ITEMS: usize = 16;
/// Longest animation a caller can ask for.
pub const MAX_ANIMATE_MS: u32 = 600;
/// Slack past the animation before the deadline force-applies the final frames.
const DEADLINE_SLACK_MS: u64 = 250;
/// A second animated call on one label within this window runs instantly instead.
const SPAM_WINDOW: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MinPreset {
    /// Leave the window's min size as it is (the key omitted).
    #[default]
    Keep,
    /// The popped-out Assistant's minimum (WINDOW_MIN_W x WINDOW_MIN_H).
    WindowSeat,
    /// No minimum (the notch seat).
    Clear,
}

/// One window's target: logical px, top-left origin (Tauri's LogicalPosition coordinates).
#[derive(Debug, Clone, Deserialize)]
pub struct FrameItem {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub min: MinPreset,
}

/// Managed state: the per-label generations and spam bookkeeping.
#[derive(Default)]
pub struct FramesState(pub Mutex<FrameGens>);

// ─── Pure logic ────────────────────────────────────────────────────────────────

/// Every number finite, every size >= 1, at most MAX_ITEMS; returns animate_ms clamped
/// to [0, MAX_ANIMATE_MS].
pub fn validate(items: &[FrameItem], animate_ms: u32) -> Result<u32, String> {
    if items.len() > MAX_ITEMS {
        return Err(format!("set_frames takes at most {MAX_ITEMS} windows, got {}", items.len()));
    }
    for it in items {
        if ![it.x, it.y, it.width, it.height].iter().all(|n| n.is_finite()) {
            return Err(format!("set_frames: non-finite frame for window '{}'", it.label));
        }
        if it.width < 1.0 || it.height < 1.0 {
            return Err(format!("set_frames: window '{}' needs a size of at least 1x1", it.label));
        }
    }
    Ok(animate_ms.min(MAX_ANIMATE_MS))
}

/// A plain rect, so the coordinate flip is testable without AppKit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Top-left-origin logical rect -> AppKit's bottom-left-origin frame, flipped around the
/// primary display's height exactly as tao does (`y_appkit = H - y - height`), so the frame
/// we set never disagrees with tao's own read-back (which the notch's heal guard compares).
pub fn to_appkit_frame(r: Rect, primary_height: f64) -> Rect {
    Rect { x: r.x, y: primary_height - r.y - r.height, width: r.width, height: r.height }
}

#[derive(Debug, Default)]
struct LabelState {
    gen: u64,
    /// When this label last STARTED an animation (downgraded calls do not record).
    last_animated_start: Option<Instant>,
}

/// A started call's claim on a label: valid while the label's generation is still `gen`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub label: String,
    pub gen: u64,
}

/// Per-label generations. Kept for the app's lifetime (never reset when a window closes),
/// so a window re-created under the same label is a new generation's business only.
#[derive(Debug, Default)]
pub struct FrameGens {
    labels: HashMap<String, LabelState>,
}

impl FrameGens {
    /// Start a call: bump the generation of every label it targets and decide how long it
    /// animates.
    ///
    /// Spam bound — NOTE: this 50ms rule bounds ANIMATION GROUPS, not the IPC call rate.
    /// An animated call arriving within 50ms of one of its labels' previous ANIMATED start
    /// runs with animate_ms = 0 (one atomic setFrame, same generation bookkeeping), so at
    /// most one animation group per label per 50ms exists and there is no "busy" error.
    /// Only a call that actually animates records its start, so animation resumes as soon
    /// as a burst ends. A raw flood of calls costs the same as today's already-granted
    /// set-size / set-position — an accepted, unchanged baseline.
    pub fn begin(&mut self, labels: &[&str], animate_ms: u32, now: Instant) -> (u32, Vec<Ticket>) {
        let spammed = animate_ms > 0
            && labels.iter().any(|l| {
                self.labels
                    .get(*l)
                    .and_then(|s| s.last_animated_start)
                    .is_some_and(|t| now.saturating_duration_since(t) < SPAM_WINDOW)
            });
        let ms = if spammed { 0 } else { animate_ms };
        let mut tickets = Vec::with_capacity(labels.len());
        for l in labels {
            let s = self.labels.entry((*l).to_string()).or_default();
            // A label listed twice in one call gets one bump; the later item wins its frame.
            if !tickets.iter().any(|t: &Ticket| t.label == *l) {
                s.gen += 1;
                tickets.push(Ticket { label: (*l).to_string(), gen: s.gen });
            }
            if ms > 0 {
                s.last_animated_start = Some(now);
            }
        }
        (ms, tickets)
    }

    /// Still this call's label? (Nothing newer has targeted it since.)
    pub fn is_current(&self, t: &Ticket) -> bool {
        self.labels.get(&t.label).is_some_and(|s| s.gen == t.gen)
    }
}

// ─── AppKit half ───────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayPixelsHigh(display: u32) -> usize;
}

/// The height tao flips around: `CGDisplay::main().pixels_high()` (tao 0.35.3,
/// platform_impl/macos/util/mod.rs `bottom_left_to_top_left` / `window_position`) —
/// CGDisplayPixelsHigh of CGMainDisplayID, used as-is.
#[cfg(target_os = "macos")]
fn primary_height() -> f64 {
    unsafe { CGDisplayPixelsHigh(CGMainDisplayID()) as f64 }
}

#[cfg(target_os = "macos")]
fn apply_min<R: Runtime>(w: &tauri::WebviewWindow<R>, min: MinPreset) {
    use crate::assistant::{WINDOW_MIN_H, WINDOW_MIN_W};
    let size = match min {
        MinPreset::Keep => return,
        MinPreset::WindowSeat => Some(tauri::Size::Logical(tauri::LogicalSize::new(WINDOW_MIN_W, WINDOW_MIN_H))),
        MinPreset::Clear => None,
    };
    let _ = w.set_min_size(size);
}

/// The live window for `label`, but only if it is still the SAME NSWindow the call
/// started with (`ptr`) — a closed or closed-and-recreated window is skipped.
#[cfg(target_os = "macos")]
fn same_window<R: Runtime>(app: &AppHandle<R>, label: &str, ptr: usize) -> Option<tauri::WebviewWindow<R>> {
    let w = app.get_webview_window(label)?;
    match w.ns_window() {
        Ok(p) if p as usize == ptr => Some(w),
        _ => None,
    }
}

/// Frames we need for one item, resolved on the main thread.
#[cfg(target_os = "macos")]
struct Target {
    item: FrameItem,
    ticket: Ticket,
    ptr: usize,
    frame: objc2_foundation::NSRect,
}

/// The eased timing function, looked up by name so no QuartzCore binding crate is needed.
#[cfg(target_os = "macos")]
fn ease_in_ease_out() -> Option<objc2::rc::Retained<objc2::runtime::AnyObject>> {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;
    let cls = AnyClass::get(c"CAMediaTimingFunction")?;
    let name = objc2_foundation::NSString::from_str("easeInEaseOut");
    unsafe { msg_send![cls, functionWithName: &*name] }
}

/// Land every frame NOW, in one zero-duration animation group through `animator()`.
/// Not a plain `setFrame:display:`: that does NOT cancel an `animator()` frame animation
/// already in flight on the window — the older animation keeps running and, when it ends,
/// lands ITS target, so the last requested frame would lose. A zero-duration animator
/// frame retargets (cancels) it and holds. Synchronous on the main thread; never
/// `setFrame:display:animate:YES`.
#[cfg(target_os = "macos")]
fn land_now(frames: &[(&objc2_app_kit::NSWindow, objc2_foundation::NSRect)]) {
    use block2::StackBlock;
    use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext};
    if frames.is_empty() {
        return;
    }
    let changes = StackBlock::new(|ctx: NonNull<NSAnimationContext>| {
        // SAFETY: AppKit hands the block the live current context for this group.
        unsafe { ctx.as_ref() }.setDuration(0.0);
        for (win, frame) in frames {
            win.animator().setFrame_display(*frame, true);
        }
    });
    NSAnimationContext::runAnimationGroup(&changes);
}

/// Move/resize windows atomically (animate_ms 0) or in one eased animation group.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn set_frames<R: Runtime>(app: AppHandle<R>, items: Vec<FrameItem>, animate_ms: u32) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSAnimatablePropertyContainer, NSAnimationContext, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let animate_ms = validate(&items, animate_ms)?;
    if items.is_empty() {
        return Ok(());
    }
    // Resolve every label up front: an unknown one fails the call before anything is touched.
    for it in &items {
        if app.get_webview_window(&it.label).is_none() {
            return Err(format!("set_frames: no window labelled '{}'", it.label));
        }
    }

    let (tx, mut rx) = tauri::async_runtime::channel::<Result<(), String>>(1);
    // Filled on the main thread with what the deadline needs (tickets + window identity).
    let (plan_tx, mut plan_rx) = tauri::async_runtime::channel::<(u32, Vec<(FrameItem, Ticket, usize)>)>(1);

    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let app = main_app;
        // Resolve every window again, now on the main thread, before any AppKit call: a
        // window that closed in between fails the whole call (all-or-nothing).
        let mut resolved: Vec<(FrameItem, Retained<NSWindow>)> = Vec::with_capacity(items.len());
        for it in items {
            let ptr = app.get_webview_window(&it.label).and_then(|w| w.ns_window().ok()).filter(|p| !p.is_null());
            let Some(ptr) = ptr else {
                let _ = tx.try_send(Err(format!("set_frames: no window labelled '{}'", it.label)));
                return;
            };
            // SAFETY: `ns_window` is this window's live NSWindow (the notch is a tauri-nspanel
            // NSPanel, an NSWindow subclass), we are on the main thread, and retaining it keeps
            // the pointer valid (and unique) for as long as this call holds it.
            let Some(win) = (unsafe { Retained::retain(ptr as *mut NSWindow) }) else {
                let _ = tx.try_send(Err(format!("set_frames: no window labelled '{}'", it.label)));
                return;
            };
            resolved.push((it, win));
        }

        let labels: Vec<&str> = resolved.iter().map(|(it, _)| it.label.as_str()).collect();
        let (ms, tickets) = match app.state::<FramesState>().0.lock() {
            Ok(mut g) => g.begin(&labels, animate_ms, Instant::now()),
            Err(_) => {
                let _ = tx.try_send(Err("set_frames: frame state poisoned".into()));
                return;
            }
        };

        let h = primary_height();
        let targets: Vec<(Target, Retained<NSWindow>)> = resolved
            .into_iter()
            .map(|(item, win)| {
                let ticket = tickets.iter().find(|t| t.label == item.label).cloned().expect("ticket per label");
                // Tauri's size is the CONTENT size. The windows here are decorations(false)
                // (notch) or an overlay title bar (vault windows) whose content fills the
                // frame, so this is the identity — but converting keeps it right regardless.
                let size = win
                    .frameRectForContentRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(item.width, item.height)))
                    .size;
                let r = to_appkit_frame(Rect { x: item.x, y: item.y, width: size.width, height: size.height }, h);
                let frame = NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.width, r.height));
                let ptr = Retained::as_ptr(&win) as usize;
                (Target { item, ticket, ptr, frame }, win)
            })
            .collect();

        if ms == 0 {
            let frames: Vec<(&NSWindow, NSRect)> = targets.iter().map(|(t, w)| (&**w, t.frame)).collect();
            land_now(&frames);
            for (t, _) in &targets {
                if let Some(w) = app.get_webview_window(&t.item.label) {
                    apply_min(&w, t.item.min);
                }
            }
            let _ = tx.try_send(Ok(()));
            return;
        }

        let _ = plan_tx.try_send((
            ms,
            targets.iter().map(|(t, _)| (t.item.clone(), t.ticket.clone(), t.ptr)).collect(),
        ));

        let frames: Vec<(Retained<NSWindow>, NSRect)> = targets.iter().map(|(t, w)| (w.clone(), t.frame)).collect();
        let changes = RcBlock::new(move |ctx: NonNull<NSAnimationContext>| {
            // SAFETY: AppKit hands the block the live current context for this group.
            let ctx = unsafe { ctx.as_ref() };
            ctx.setDuration(ms as f64 / 1000.0);
            if let Some(f) = ease_in_ease_out() {
                let _: () = unsafe { msg_send![ctx, setTimingFunction: &*f] };
            }
            for (win, frame) in &frames {
                win.animator().setFrame_display(*frame, true);
            }
        });
        // The block keeps the original NSWindows retained until it has run, so a pointer
        // compared at the deadline can never belong to a different, re-created window.
        let done_app = app.clone();
        let done = RcBlock::new(move || {
            let current: Vec<bool> = match done_app.state::<FramesState>().0.lock() {
                Ok(g) => targets.iter().map(|(t, _)| g.is_current(&t.ticket)).collect(),
                Err(_) => vec![false; targets.len()],
            };
            for ((t, _), cur) in targets.iter().zip(current) {
                if !cur {
                    continue; // superseded: the newer call owns this label's frame and min
                }
                if let Some(w) = same_window(&done_app, &t.item.label, t.ptr) {
                    apply_min(&w, t.item.min);
                }
            }
            let _ = tx.try_send(Ok(()));
        });
        NSAnimationContext::runAnimationGroup_completionHandler(&changes, Some(&done));
    })
    .map_err(|e| format!("set_frames: could not reach the main thread: {e}"))?;

    // animate_ms 0 / an error answer immediately; an animation answers on completion.
    let budget = Duration::from_millis(animate_ms as u64 + DEADLINE_SLACK_MS);
    match tokio::time::timeout(budget, rx.recv()).await {
        Ok(Some(res)) => return res,
        Ok(None) => return Ok(()),
        Err(_) => {}
    }

    // Deadline: the completion handler never came. Force the final frames (and min preset)
    // for every label this call still owns; a superseded or closed window is left alone.
    let Ok((_, plan)) = plan_rx.try_recv() else { return Ok(()) };
    let (ftx, mut frx) = tauri::async_runtime::channel::<()>(1);
    let force_app = app.clone();
    let dispatched = app.run_on_main_thread(move || {
        let app = force_app;
        let current: Vec<bool> = match app.state::<FramesState>().0.lock() {
            Ok(g) => plan.iter().map(|(_, t, _)| g.is_current(t)).collect(),
            Err(_) => vec![false; plan.len()],
        };
        let h = primary_height();
        let mut owned = Vec::with_capacity(plan.len());
        for ((item, _, ptr), cur) in plan.iter().zip(current) {
            if !cur {
                continue;
            }
            let Some(w) = same_window(&app, &item.label, *ptr) else { continue };
            let Ok(p) = w.ns_window() else { continue };
            // SAFETY: the same live NSWindow the call started with, on the main thread.
            let win: &NSWindow = unsafe { &*(p as *const NSWindow) };
            let size = win
                .frameRectForContentRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(item.width, item.height)))
                .size;
            let r = to_appkit_frame(Rect { x: item.x, y: item.y, width: size.width, height: size.height }, h);
            owned.push((win, NSRect::new(NSPoint::new(r.x, r.y), NSSize::new(r.width, r.height)), w, item.min));
        }
        let frames: Vec<(&NSWindow, NSRect)> = owned.iter().map(|(win, f, _, _)| (*win, *f)).collect();
        land_now(&frames);
        for (_, _, w, min) in &owned {
            apply_min(w, *min);
        }
        let _ = ftx.try_send(());
    });
    if dispatched.is_ok() {
        // Bounded: a wedged main thread must never hang the caller.
        let _ = tokio::time::timeout(Duration::from_millis(DEADLINE_SLACK_MS), frx.recv()).await;
    }
    Ok(())
}

/// Off macOS there is no AppKit animator; the frame lands as position + size.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_frames<R: Runtime>(app: AppHandle<R>, items: Vec<FrameItem>, animate_ms: u32) -> Result<(), String> {
    validate(&items, animate_ms)?;
    let mut wins = Vec::with_capacity(items.len());
    for it in &items {
        wins.push(app.get_webview_window(&it.label).ok_or_else(|| format!("set_frames: no window labelled '{}'", it.label))?);
    }
    let labels: Vec<&str> = items.iter().map(|it| it.label.as_str()).collect();
    if let Ok(mut g) = app.state::<FramesState>().0.lock() {
        g.begin(&labels, 0, Instant::now());
    }
    for (it, w) in items.iter().zip(wins) {
        let _ = w.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(it.x, it.y)));
        let _ = w.set_size(tauri::Size::Logical(tauri::LogicalSize::new(it.width, it.height)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(label: &str, x: f64, y: f64, w: f64, h: f64) -> FrameItem {
        FrameItem { label: label.into(), x, y, width: w, height: h, min: MinPreset::Keep }
    }

    #[test]
    fn appkit_frame_flips_around_the_primary_height() {
        // Primary 1117 high; a 420x360 window at the top-left sits 360 below AppKit's top.
        let r = to_appkit_frame(Rect { x: 10.0, y: 0.0, width: 420.0, height: 360.0 }, 1117.0);
        assert_eq!(r, Rect { x: 10.0, y: 757.0, width: 420.0, height: 360.0 });
    }

    #[test]
    fn appkit_frame_on_secondary_monitors() {
        // A monitor to the right: x passes through unchanged.
        let r = to_appkit_frame(Rect { x: 1728.0, y: 100.0, width: 800.0, height: 600.0 }, 1117.0);
        assert_eq!(r, Rect { x: 1728.0, y: 417.0, width: 800.0, height: 600.0 });
        // A monitor ABOVE the primary (negative top-left y) lands above the primary's top.
        let r = to_appkit_frame(Rect { x: -200.0, y: -1080.0, width: 1920.0, height: 1080.0 }, 1117.0);
        assert_eq!(r, Rect { x: -200.0, y: 1117.0, width: 1920.0, height: 1080.0 });
        // A monitor BELOW the primary lands at a negative AppKit y.
        let r = to_appkit_frame(Rect { x: 0.0, y: 1117.0, width: 300.0, height: 38.0 }, 1117.0);
        assert_eq!(r, Rect { x: 0.0, y: -38.0, width: 300.0, height: 38.0 });
    }

    #[test]
    fn validation_rejects_bad_numbers_sizes_and_counts() {
        assert!(validate(&[item("a", f64::NAN, 0.0, 10.0, 10.0)], 0).is_err());
        assert!(validate(&[item("a", 0.0, f64::INFINITY, 10.0, 10.0)], 0).is_err());
        assert!(validate(&[item("a", 0.0, 0.0, f64::NEG_INFINITY, 10.0)], 0).is_err());
        assert!(validate(&[item("a", 0.0, 0.0, 0.5, 10.0)], 0).is_err());
        assert!(validate(&[item("a", 0.0, 0.0, 10.0, 0.0)], 0).is_err());
        let many: Vec<FrameItem> = (0..17).map(|i| item(&format!("w{i}"), 0.0, 0.0, 10.0, 10.0)).collect();
        assert!(validate(&many, 0).is_err());
        assert!(validate(&many[..16], 0).is_ok());
        assert_eq!(validate(&[item("a", -5.0, -5.0, 1.0, 1.0)], 200), Ok(200));
    }

    #[test]
    fn animate_ms_is_clamped() {
        assert_eq!(validate(&[], 0), Ok(0));
        assert_eq!(validate(&[], 600), Ok(600));
        assert_eq!(validate(&[], 601), Ok(600));
        assert_eq!(validate(&[], u32::MAX), Ok(600));
    }

    #[test]
    fn min_preset_three_states_stay_distinct() {
        let absent: FrameItem = serde_json::from_str(r#"{"label":"a","x":0,"y":0,"width":1,"height":1}"#).unwrap();
        let seat: FrameItem =
            serde_json::from_str(r#"{"label":"a","x":0,"y":0,"width":1,"height":1,"min":"window-seat"}"#).unwrap();
        let clear: FrameItem =
            serde_json::from_str(r#"{"label":"a","x":0,"y":0,"width":1,"height":1,"min":"clear"}"#).unwrap();
        assert_eq!(absent.min, MinPreset::Keep);
        assert_eq!(seat.min, MinPreset::WindowSeat);
        assert_eq!(clear.min, MinPreset::Clear);
        // Dimensions are never caller-supplied: anything but the preset names is refused.
        assert!(serde_json::from_str::<FrameItem>(r#"{"label":"a","x":0,"y":0,"width":1,"height":1,"min":{"w":1,"h":1}}"#).is_err());
        assert!(serde_json::from_str::<FrameItem>(r#"{"label":"a","x":0,"y":0,"width":1,"height":1,"min":"huge"}"#).is_err());
    }

    #[test]
    fn a_superseded_call_owns_nothing_at_completion_or_deadline() {
        let mut g = FrameGens::default();
        let t0 = Instant::now();
        let (_, first) = g.begin(&["assistant"], 200, t0);
        let (_, second) = g.begin(&["assistant"], 200, t0 + Duration::from_millis(100));
        // The first call's completion handler and its deadline branch both gate on this:
        // neither the frame nor the min preset is touched for a superseded label.
        assert!(!g.is_current(&first[0]));
        assert!(g.is_current(&second[0]));
    }

    #[test]
    fn supersede_is_per_label() {
        let mut g = FrameGens::default();
        let t0 = Instant::now();
        let (_, tile) = g.begin(&["a", "b"], 200, t0);
        let (_, only_b) = g.begin(&["b"], 0, t0 + Duration::from_millis(10));
        let a = tile.iter().find(|t| t.label == "a").unwrap();
        let b = tile.iter().find(|t| t.label == "b").unwrap();
        assert!(g.is_current(a), "a is still the tile's");
        assert!(!g.is_current(b), "b now belongs to the newer call");
        assert!(g.is_current(&only_b[0]));
    }

    #[test]
    fn unknown_label_ticket_is_never_current() {
        let g = FrameGens::default();
        assert!(!g.is_current(&Ticket { label: "ghost".into(), gen: 1 }));
    }

    #[test]
    fn a_second_animated_call_within_50ms_runs_instantly() {
        let mut g = FrameGens::default();
        let t0 = Instant::now();
        assert_eq!(g.begin(&["assistant"], 200, t0).0, 200);
        let (ms, tickets) = g.begin(&["assistant"], 200, t0 + Duration::from_millis(20));
        assert_eq!(ms, 0, "downgraded, not rejected");
        assert!(g.is_current(&tickets[0]), "downgraded calls keep the generation bookkeeping");
        // The downgraded call did NOT record a start, so 50ms after the first ANIMATED start
        // animation resumes, even though the last call was only 30ms ago.
        assert_eq!(g.begin(&["assistant"], 200, t0 + Duration::from_millis(50)).0, 200);
    }

    #[test]
    fn spam_bound_is_per_label() {
        let mut g = FrameGens::default();
        let t0 = Instant::now();
        assert_eq!(g.begin(&["a"], 200, t0).0, 200);
        assert_eq!(g.begin(&["b"], 200, t0 + Duration::from_millis(10)).0, 200);
        // A group touching a label that just animated runs instantly as a whole.
        assert_eq!(g.begin(&["c", "a"], 200, t0 + Duration::from_millis(20)).0, 0);
    }

    #[test]
    fn instant_calls_never_count_as_animated_starts() {
        let mut g = FrameGens::default();
        let t0 = Instant::now();
        assert_eq!(g.begin(&["a"], 0, t0).0, 0);
        assert_eq!(g.begin(&["a"], 200, t0 + Duration::from_millis(1)).0, 200);
    }

    #[test]
    fn a_label_twice_in_one_call_is_one_generation() {
        let mut g = FrameGens::default();
        let (_, tickets) = g.begin(&["a", "a"], 0, Instant::now());
        assert_eq!(tickets.len(), 1);
        assert!(g.is_current(&tickets[0]));
    }
}
