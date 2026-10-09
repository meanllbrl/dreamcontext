---
id: feat_X3hCuIlS
type: feature
name: desktop-splash-screen
description: >-
  The desktop app's opening screen: a 2.6s logo-reveal clip with sound plays in
  its own transparent Tauri window while the dashboard server boots, then
  dissolves into the Launcher through a two-key, fail-open handoff.
pinned: false
date: '2026-10-04'
status: in_review
product: desktop
created: '2026-10-04'
updated: '2026-10-09'
released_version: null
tags:
  - 'topic:desktop'
  - 'topic:macos'
  - 'topic:branding'
  - 'layer:frontend'
related_tasks:
  - >-
    first-run-onboarding-detects-every-missing-piece-on-this-machine-and-installs-it-step-by-step-in-the-app-and-in-the-cli
---

## Why

Owner, 2026-10-03 (with a reference reel): *"Böyle bir dreamcontext opening screen
belirle, her açılışta kullanmak istediğim bir video istiyorum."*

A cold launch showed **nothing** for the second or three the dashboard server takes
to answer `/api/health` — `setup` blocked on that poll, so not even a window could
paint. The app's most-repeated moment was a blank desk, and the gap was already
exactly the length of a brand animation. The opening screen fills it: the wait
becomes the product's own logo reveal instead of dead time.

## User Stories

- [ ] As the owner, I see a logo animation with sound every time I open the app, so the launch feels like the product rather than a pause. *(built; the owner has not yet confirmed it on a real launch)*
- [x] As the owner, I never wait longer because of it: the clip plays *while* the server boots, not before it starts.
- [x] As the owner, the opening screen matches my Mac's appearance, so a light desk never flashes a dark card.
- [x] As the owner, a click or a key skips the rest of the clip.
- [ ] As the owner, the handoff into the Launcher is a dissolve rather than a window swap.

## Acceptance Criteria

- [x] On a cold launch the splash window opens **before** the health poll and plays while it runs: the poll moved onto a thread, since only a running event loop lets the window paint and the clip play.
- [x] The window is its own transparent, undecorated, always-on-top, centred 720×405 Tauri window (`splash` label) whose rounded card IS its shape, filled with the clip's first frame so there is no flash before the video paints.
- [x] The clip follows **macOS appearance**, not the app's theme: the dashboard's own choice lives on an origin this page cannot read, and the app theme defaults to System, so light Mac → light clip, dark Mac → dark clip.
- [x] Audio plays at half volume; if the webview refuses sound, the clip plays muted rather than not at all.
- [x] Handoff is a two-key gate: the Launcher is built **hidden** once the server answers, and shown only when (1) the splash is done — clip ended, user skipped by click/key, the clip never started within 3 s and the page showed the still instead, or the page's safety timer (the clip's length plus a second, from when it started) fired — and (2) the Launcher's page load finished. Then the Launcher is shown *first*, under the always-on-top splash, which fades (340 ms) and closes, so the app is never windowless between the two.
- [x] **Fail open on both keys:** a page that never reports and a Launcher whose load event never arrives each have a Rust-side deadline (8 s / 10 s — the splash deadline must never cut a clip that started at its 3 s limit) that turns the key anyway — a visible app with a problem beats a hidden one. A startup failure calls `abort` and drops the splash at once, after the error window exists.
- [x] A slow boot says so: once the clip has ended and the app is still coming, a quiet "Starting…" hint fades in.
- [x] `prefers-reduced-motion` shows the finished lockup still instead of the animation; a clip error or a failed fetch does the same.
- [x] A Login Item launch with the notch enabled opens no Launcher, so it gets **no splash** either.
- [x] **The clip plays, with sound, in macOS Low Power Mode** (`bf861388`): the page loads the clip and invokes `splash_play`; the shell answers with `window.eval("window.__dcSplashPlay()")`, whose `play()` counts as a user gesture. Measured in a real WKWebView under Low Power Mode, unmuted, start to `ended` (`scripts/verify/splash-webkit.sh` + `splash-webkit-probe.swift`, `tests/unit/desktop-splash.test.ts`); the owner's launch is the separate sign-off below.
- [x] The gate's successor is configurable: `open_behind(app, builder, label)` makes any hidden window the one the gate shows (default `main`), so a first run with no usable Node.js hands over to the node-setup window the same fail-open way (working tree, cargo test 42/42).
- [ ] Owner sign-off in the installed .app: the clip plays on *every* launch and the sound is audible.

## Constraints & Decisions
<!-- LIFO: newest decision at top -->

- **[2026-10-08]** The splash's successor is not always the Launcher: when no usable Node.js (18 or newer) is found, the two-key gate hands over to the node-setup window (splash::open_behind with a successor label), which installs a private Node.js and then hands over to the Launcher the same way. Startup errors also reuse that window (error mode) instead of a separate error page. See [[first-run-onboarding]].
- **[2026-10-04] The shell starts the clip, not the page.** Low Power Mode blocks gesture-less video entirely, so a page that autoplays shows a silent still on a battery-saving Mac. A play started from the shell's `evaluateJavaScript` counts as a user gesture; the page's 3 s no-start fallback (still image) stays as the fail-open path if the shell never answers.

- **[2026-10-04] The opening screen may never become a reason to wait.** It exists to cover a gap the app already had, so every path out of it is fail-open: two Rust deadlines, a page-side fallback timer, click/key skip, a still-frame fallback, and an `abort` for a failed startup. Nothing on the splash path can hold a window back for more than its deadline.
- **[2026-10-04] It follows the Mac, not the app.** The splash paints before the dashboard exists, on an origin that cannot read the app's theme preference, so `prefers-color-scheme` is the only honest signal. The app's theme defaults to System, so the two agree in the normal case; a hand-pinned opposite theme will see the other clip, and that is accepted.
- **[2026-10-04] The clip is served from a blob URL.** WebKit's media loader wants byte-range responses and the app's custom-scheme asset handler does not give them; fetching the file and handing the webview a blob is what makes it seekable and playable.
- **[2026-10-04] The handoff shows the Launcher first, then fades the splash.** Closing the splash before the Launcher is visible would leave a windowless instant; the splash stays always-on-top so the exchange reads as a dissolve.
- **[2026-10-04] The logo is the icon source, not `logo.png`.** The animation is rebuilt from the vector fit of the app icon's own 1024px source (`desktop/src-tauri/icon-source.png`): `logo.png` bakes its glow into a grey plate, and `favicon.svg` is an older, different drawing. The vector was fitted numerically to the PNG's alpha mask (IoU ≥ 0.987 per piece) rather than eyeballed, so the pieces can animate separately and still land on the real mark.

## Technical Details

- **Shell:** `desktop/src-tauri/src/splash.rs` — `open()` builds the window; `open_behind(app, builder, label)` builds any successor hidden with an `on_page_load` key and records it as `Keys.successor` (`open_launcher_behind()` is the `main` case; `node_setup.rs` uses it for the node-setup window); `splash_done` and `splash_play` are the page's IPC commands; `turn()` holds the two-key `SplashGate` (managed state), shows the successor (default `main`) and hands over exactly once; `abort()` drops it on a failed startup; `is_open()` lets `lib.rs` pick the hidden-behind-the-splash path. Deadlines: `SPLASH_DEADLINE` 8 s, `LAUNCHER_DEADLINE` 10 s, `FADE` 340 ms.
- **Page:** `desktop/src-tauri/frontend-placeholder/splash.html` (self-contained: inline CSS + script, no bundler), with `splash.mp4` / `splash-light.mp4` and `splash-still.jpg` / `splash-still-light.jpg` beside it. It reports `splash_done` on `ended`, on mousedown/keydown, from the still shown when the clip has not started within 3 s, and from a safety timer of the clip's length plus 1 s counted from when it started; if the shell's `splash_play` eval has not landed 1.2 s after the invoke resolves, the page starts the clip itself. `window.__dcSplashExit()` is called by the shell to run the fade-out class.
- **Permissions:** `desktop/src-tauri/capabilities/splash.json` + `desktop/src-tauri/permissions/splash-done.toml` scope the one IPC command to the splash window.
- **Boot order:** `lib.rs` opens the splash first and polls `/api/health` on a thread (previously the poll blocked `setup`); the Login-Item-with-notch path skips both Launcher and splash.
- **Asset origin:** the clip is `Splash-konsolidasyon` in `marketing/remotion` (chosen by the owner from three variants: pieces converging, folding, line-drawn), with a DSP-synthesised logo sting from the `marketing/gen-sfx.py` lineage; renders land in `marketing/remotion/out/splash/`.
- **Low Power Mode:** WebKit refuses every `<video>.play()` no user gesture started, muted or not (`UserGestureRequired`), and wry's `autoplay: true` does not lift it — the owner saw only the final still, silent. A script run through `-[WKWebView evaluateJavaScript:]` (what `WebviewWindow::eval` uses) DOES count as a gesture, so the page never starts its own clip: it asks with `splash_play` (granted by `allow-splash-play`, splash window only) and the shell evaluates `window.__dcSplashPlay()`.
- **Status (2026-10-09):** the splash is committed in `55c6ff92`; the Low Power Mode fix and the 8 s / 10 s deadlines in `bf861388`. The configurable successor (`open_behind`) is in the working tree with first-run onboarding. The owner has not yet confirmed playback and sound in the installed .app.

## Notes

- The original splash had no task file (one session, from an owner reference reel); the successor change is tracked by the first-run-onboarding task.
- Open question for the owner, inherited from the same session's reel work: nothing here depends on it, but the splash clip and the marketing intro now share one logo-source and alignment rule — keep them in step when either is re-rendered.
- Not in scope: a first-run / onboarding variant, a per-vault or per-theme choice inside the app, Windows/Linux shells.

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-10-09 - Reconciled with splash.rs (sleep)
- Low Power Mode criterion ticked: it landed in `bf861388` with a WebKit probe and unit tests. A criterion added and ticked for the configurable successor. `status` in_progress -> in_review: only the dissolve story and the owner's real-launch sign-off remain.
- Technical Details corrected: deadlines are 8 s / 10 s (the text still said 6 s / 8 s), the page's fallbacks are the 3 s no-start still and the length + 1 s safety timer (not 4.5 s), and `open_behind` / `Keys.successor` are described. Status line replaced.

### 2026-10-08 - Successor gate generalised
- splash.rs gained open_behind(app, builder, label) and a successor key (default main), used by the first-run-onboarding no-Node path; see [[first-run-onboarding]].
### 2026-10-04 (later) - Committed, and taught to play in Low Power Mode

- The splash landed in `55c6ff92`. The owner then saw only the final still, silent: WebKit's Low Power Mode refuses gesture-less `play()`. The working tree moves the start to the shell (`splash_play` → `window.eval`, which counts as a gesture), adds a 3 s no-start fallback, and lengthens the Rust deadlines to 8 s / 10 s so they never cut a late-starting clip.
- **PRD reconciliation:** two criteria corrected to the new timings, one added (open: uncommitted, owner launch), one decision recorded, Status line replaced. `status` stays `in_progress`.

### 2026-10-04 - Created from the built working tree

- PRD created for work that had no task and no file: an owner request ("an opening screen video on every launch") built end to end in one session — the Tauri `splash` window, its self-contained page, the light/dark clips, the two-key fail-open handoff and the boot-order change that lets a window paint during the health poll.
- Criteria ticked from the code itself (`splash.rs`, `splash.html`, `lib.rs`); the two open ones are the dissolve and the owner's real-launch check. `status: in_progress` — built, uncommitted, unverified by the owner; `released_version: null`.
