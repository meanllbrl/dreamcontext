// The microphone, opened natively — so a take starts the instant the hotkey goes down.
//
// ── Why the webview no longer opens the microphone itself ──────────────────────
// The owner's first words were lost on every hotkey take (2026-10-13: "ilk kelimelerim
// kayboluyor"). The WebKit path could not start sooner than this chain, all of it AFTER the
// key was already down: the Carbon edge reaches the notch, the panel animates open (opening
// the mic in the same tick froze that resize for seconds, so it waited), then `getUserMedia`
// activates WebKit's audio session (1.6 s measured on 2026-09-28), then the graph is wired.
// Only then did the first sample land. Here the stream is opened from the hotkey handler
// itself, before the webview has even heard about the press, and every sample since then is
// kept until the webview claims the take.
//
// Two more things come with it, both measured against the owner's own Handy recordings:
// - The audio is the RAW device. WebKit only gave a usable level with its voice-call chain on
//   (echo cancellation + noise suppression + AGC, one switch on macOS), so that is what
//   whisper was hearing. Handy feeds whisper the raw device at the same low level
//   (peak RMS ~0.015) and transcribes it well.
// - Samples are delivered on CoreAudio's real-time thread, not on the webview's main thread.
//   A ScriptProcessorNode drops input whenever the page is busy rendering — mid-sentence.
//
// The stream lives on its own thread (a cpal stream is not `Send` on every host), which also
// drives the live level the listening overlay draws (`mic://level`, ~30 Hz).
//
// ── Lifecycle ──────────────────────────────────────────────────────────────────
// `start_for_hotkey` (Rust, on Pressed) opens an UNCLAIMED take. The composer's `mic_take_begin`
// claims it (or opens a fresh one for a mic-button press). `mic_take_end` stops the stream and
// hands the samples over; `mic_take_cancel` drops them. An unclaimed take is dropped a few
// seconds after the key is released (a tap only opens the panel), and every take is capped,
// so the macOS microphone indicator can never be left lit by a take nobody owns.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tauri::{AppHandle, Emitter, Runtime};

/// The live level, emitted to every window while a take is open.
pub const LEVEL_EVENT: &str = "mic://level";
/// How often the level is published.
const LEVEL_TICK: Duration = Duration::from_millis(33);
/// A take nobody claimed is dropped this long after the key is released.
const UNCLAIMED_GRACE: Duration = Duration::from_secs(4);
/// No take runs longer than this, owned or not.
const MAX_TAKE: Duration = Duration::from_secs(10 * 60);
/// `u32::MAX` in the timing atomics means "not yet".
const NOT_YET: u32 = u32::MAX;

struct Active {
    id: u64,
    claimed: bool,
    started: Instant,
    stop: Sender<()>,
    thread: Option<JoinHandle<()>>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: Arc<AtomicU32>,
    /// ms from `started` to the stream playing, and to the first delivered sample.
    opened_ms: Arc<AtomicU32>,
    first_sample_ms: Arc<AtomicU32>,
    error: Arc<Mutex<Option<String>>>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(0);

fn ms_since(t: Instant) -> u32 {
    t.elapsed().as_millis().min((NOT_YET - 1) as u128) as u32
}

/// Mix one interleaved callback buffer down to mono and append it.
fn append_mono(out: &Arc<Mutex<Vec<f32>>>, level: &AtomicU32, data: &[f32], channels: usize) {
    let ch = channels.max(1);
    let frames = data.len() / ch;
    if frames == 0 {
        return;
    }
    let mut sum_sq = 0.0f32;
    if let Ok(mut buf) = out.lock() {
        buf.reserve(frames);
        for f in 0..frames {
            let mut s = 0.0f32;
            for c in 0..ch {
                s += data[f * ch + c];
            }
            let v = s / ch as f32;
            sum_sq += v * v;
            buf.push(v);
        }
    }
    level.store((sum_sq / frames as f32).sqrt().to_bits(), Ordering::Relaxed);
}

/// Open the default input and run it until told to stop. Runs on the take's own thread.
fn run_stream<R: Runtime>(
    app: AppHandle<R>,
    started: Instant,
    stop: mpsc::Receiver<()>,
    samples: Arc<Mutex<Vec<f32>>>,
    rate: Arc<AtomicU32>,
    opened_ms: Arc<AtomicU32>,
    first_sample_ms: Arc<AtomicU32>,
    error: Arc<Mutex<Option<String>>>,
) {
    let fail = |msg: String| {
        if let Ok(mut e) = error.lock() {
            *e = Some(msg);
        }
    };
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return fail("no input device".into());
    };
    let supported = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => return fail(format!("input config: {e}")),
    };
    let config = supported.config();
    let channels = config.channels as usize;
    rate.store(config.sample_rate, Ordering::Relaxed);
    let level = Arc::new(AtomicU32::new(0));

    let on_error = |e: cpal::Error| eprintln!("[mic] stream error: {e}");
    let stream = {
        let (samples, level, first) = (samples.clone(), level.clone(), first_sample_ms.clone());
        let mark_first = move || {
            if first.load(Ordering::Relaxed) == NOT_YET {
                first.store(ms_since(started), Ordering::Relaxed);
            }
        };
        match supported.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
                config,
                move |data, _| {
                    mark_first();
                    append_mono(&samples, &level, data, channels);
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
                config,
                move |data, _| {
                    mark_first();
                    let f: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    append_mono(&samples, &level, &f, channels);
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
                config,
                move |data, _| {
                    mark_first();
                    let f: Vec<f32> = data.iter().map(|&s| s as f32 / 2_147_483_648.0).collect();
                    append_mono(&samples, &level, &f, channels);
                },
                on_error,
                None,
            ),
            other => return fail(format!("unsupported sample format {other:?}")),
        }
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => return fail(format!("open input: {e}")),
    };
    if let Err(e) = stream.play() {
        return fail(format!("start input: {e}"));
    }
    opened_ms.store(ms_since(started), Ordering::Relaxed);

    loop {
        match stop.recv_timeout(LEVEL_TICK) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {
                if started.elapsed() > MAX_TAKE {
                    break;
                }
                let l = f32::from_bits(level.load(Ordering::Relaxed));
                let _ = app.emit(LEVEL_EVENT, l);
            }
        }
    }
    drop(stream); // releases the device: the macOS mic indicator goes out here
}

/// Open a take. The caller holds the lock.
fn open<R: Runtime>(app: &AppHandle<R>, slot: &mut Option<Active>, claimed: bool) -> u64 {
    let id = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let started = Instant::now();
    let (tx, rx) = mpsc::channel();
    let samples = Arc::new(Mutex::new(Vec::with_capacity(48_000 * 30)));
    let rate = Arc::new(AtomicU32::new(0));
    let opened_ms = Arc::new(AtomicU32::new(NOT_YET));
    let first_sample_ms = Arc::new(AtomicU32::new(NOT_YET));
    let error = Arc::new(Mutex::new(None));
    let thread = {
        let (app, samples, rate, opened, first, error) =
            (app.clone(), samples.clone(), rate.clone(), opened_ms.clone(), first_sample_ms.clone(), error.clone());
        std::thread::Builder::new()
            .name("dc-mic".into())
            .spawn(move || run_stream(app, started, rx, samples, rate, opened, first, error))
            .ok()
    };
    *slot = Some(Active { id, claimed, started, stop: tx, thread, samples, rate, opened_ms, first_sample_ms, error });
    id
}

/// Stop the take's stream and wait for the device to be released.
fn close(mut a: Active) -> Active {
    let _ = a.stop.send(());
    if let Some(t) = a.thread.take() {
        let _ = t.join();
    }
    a
}

/// The hotkey went down: start listening NOW, before the webview has heard of the press.
/// A press while a take is already open (the toggle-mode stop press, a key repeat) changes
/// nothing — the webview decides what that press means.
pub fn start_for_hotkey<R: Runtime>(app: &AppHandle<R>) {
    let Ok(mut slot) = ACTIVE.lock() else { return };
    if slot.is_some() {
        return;
    }
    open(app, &mut slot, false);
}

/// The hotkey came up. If nobody has claimed the take by the end of the grace, it was a tap
/// that only opened the panel: drop it so the microphone is released.
pub fn hotkey_released() {
    let id = match ACTIVE.lock() {
        Ok(slot) => match slot.as_ref() {
            Some(a) if !a.claimed => a.id,
            _ => return,
        },
        Err(_) => return,
    };
    std::thread::spawn(move || {
        std::thread::sleep(UNCLAIMED_GRACE);
        let taken = match ACTIVE.lock() {
            Ok(mut slot) => {
                let unclaimed = matches!(slot.as_ref(), Some(a) if a.id == id && !a.claimed);
                if unclaimed { slot.take() } else { None }
            }
            Err(_) => None,
        };
        if let Some(a) = taken {
            close(a);
        }
    });
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicBegin {
    id: u64,
    /// How long this take has already been listening (a hotkey take started at the press).
    since_ms: u32,
}

/// Claim the open take, or open one. The composer calls this where it used to call
/// `getUserMedia`.
#[tauri::command]
pub fn mic_take_begin<R: Runtime>(app: AppHandle<R>) -> Result<MicBegin, String> {
    let mut slot = ACTIVE.lock().map_err(|_| "mic state poisoned".to_string())?;
    if let Some(a) = slot.as_mut() {
        if let Some(e) = a.error.lock().ok().and_then(|e| e.clone()) {
            // The hotkey's open failed; drop it and try once more for this claim.
            let dead = slot.take();
            drop(slot);
            if let Some(d) = dead {
                close(d);
            }
            eprintln!("[mic] retrying after: {e}");
            let mut slot = ACTIVE.lock().map_err(|_| "mic state poisoned".to_string())?;
            let id = open(&app, &mut slot, true);
            return Ok(MicBegin { id, since_ms: 0 });
        }
        a.claimed = true;
        return Ok(MicBegin { id: a.id, since_ms: ms_since(a.started) });
    }
    let id = open(&app, &mut slot, true);
    Ok(MicBegin { id, since_ms: 0 })
}

/// Stop the take and hand its samples over, as ONE binary body (no base64, no JSON array):
///   u32 sample rate | u32 opened ms | u32 first-sample ms | u32 wall ms | f32 samples…
/// all little-endian; `opened`/`first-sample` are u32::MAX when they never happened.
#[tauri::command]
pub fn mic_take_end(id: u64) -> Result<tauri::ipc::Response, String> {
    let taken = {
        let mut slot = ACTIVE.lock().map_err(|_| "mic state poisoned".to_string())?;
        let ours = matches!(slot.as_ref(), Some(a) if a.id == id);
        if ours { slot.take() } else { None }
    };
    let Some(a) = taken else { return Err("no such take".into()) };
    let wall = ms_since(a.started);
    let a = close(a);
    if let Some(e) = a.error.lock().ok().and_then(|e| e.clone()) {
        return Err(e);
    }
    let samples = a.samples.lock().map(|mut s| std::mem::take(&mut *s)).unwrap_or_default();
    let mut out = Vec::with_capacity(16 + samples.len() * 4);
    for v in [
        a.rate.load(Ordering::Relaxed),
        a.opened_ms.load(Ordering::Relaxed),
        a.first_sample_ms.load(Ordering::Relaxed),
        wall,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(out))
}

/// Drop a take without handing anything over: the given id, or (no id) the hotkey's take
/// nobody has claimed.
#[tauri::command]
pub fn mic_take_cancel(id: Option<u64>) {
    let taken = match ACTIVE.lock() {
        Ok(mut slot) => {
            let ours = match (slot.as_ref(), id) {
                (Some(a), Some(want)) => a.id == want,
                // No id: only the hotkey's UNCLAIMED take — never one a composer is recording.
                (Some(a), None) => !a.claimed,
                _ => false,
            };
            if ours { slot.take() } else { None }
        }
        Err(_) => None,
    };
    if let Some(a) = taken {
        close(a);
    }
}
