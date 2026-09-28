---
id: know_617UQXUc
name: patterns/a-button-in-the-desktop-app-does-nothing-when-clicked
description: >-
  A browser dialog primitive (confirm, alert, prompt) is a silent no-op inside
  the desktop app's WKWebView, so every button gated on one reads as dead while
  working perfectly in a browser tab. Ship the dialog in JS the dashboard itself
  serves, never behind a separately-installed binary, and ban the primitive with
  a unit test.
tags:
  - 'kind:pattern'
  - 'layer:frontend'
  - 'topic:desktop'
  - 'domain:correctness'
pinned: false
date: '2026-09-26'
---

# A button in the desktop app does nothing when clicked

## Why This Exists

Three times now, a button that works in a browser tab has read as **dead inside the desktop
app**, and each time the first guess was the wrong layer.

- **2026-08-17 / 2026-08-24, `window.confirm`.** wry's `WKUIDelegate` implements exactly three
  methods (file-upload panel, media-capture permission, `window.open`) and NONE of WebKit's
  JavaScript panel methods. WebKit's contract for a delegate without
  `runJavaScriptConfirmPanelWithMessage:` is to show nothing and **return false** — so every
  `if (!window.confirm(…)) return;` is an unconditional early return in the app. Sixteen
  confirm-gated buttons were affected (task delete, version delete, objective delete, hard sync
  refresh, scheduler off, remove-from-launcher).
- **2026-09-26, `alert()`.** Same delegate, same absence. The Plan→Develop hand-off reported a
  not-ready task through `alert()`, so the refusal was invisible and the button read as broken.

## The Pattern

1. **Treat every browser dialog primitive as absent in this shell.** `confirm`, `alert` and
   `prompt` are not "unstyled" here, they are **no-ops that return the falsy default**. A refusal
   delivered through one is a refusal nobody ever sees.
2. **Ship the dialog in JS the dashboard itself serves.** `dashboard/src/lib/confirmDialog.ts`
   (`showWebviewConfirm` / `confirmAction`) builds an `alertdialog` from plain DOM, styled off the
   design tokens, focus-restoring, with Escape/backdrop/Cancel all resolving false (fails closed).
3. **Never make a confirmation depend on a separately-shipped binary.** This is the real lesson of
   the second regression. The first fix routed through a native `invoke('confirm_dialog')` NSAlert;
   the Tauri shell is installed by hand while the dashboard is served by the CLI and updates on its
   own cadence, so anyone who upgraded only the npm package landed straight back on the dead
   button. A native sheet may be *preferred*, but the JS dialog must be the fallback a rejection
   falls through to — never `window.confirm`.
4. **Ban the primitive with a unit test, not a convention.**
   `tests/unit/no-window-confirm.test.ts` forbids `window.confirm` in every dashboard file (and, as
   of 2026-09-26, `alert()` too), strips comments before matching so the docs may quote the broken
   call, and also asserts the fallback still EXISTS — a guard that only forbids would pass if
   someone deleted the browser path entirely.
5. **Chromium cannot see this bug.** `window.confirm` genuinely works in Chromium, which is exactly
   why it shipped twice. A runtime verify must drive the app's OWN dialog
   (`[data-confirm-dialog|accept|cancel]`), never Playwright's `page.on('dialog')`, and should fake
   a stale shell (`__TAURI_INTERNALS__.invoke` rejecting "command not found") to prove the fallback.

## The Generalisation

The class is wider than dialogs: **a web API this webview does not have has to be supplied
natively or in our own JS** — the same shape as the missing `Notification` (polyfilled by the
notification plugin) and the clipboard that re-decodes UTF-8 as Mac Roman. When a UI element
"silently does nothing" only in the app, suspect a missing platform API before suspecting the
handler, and check whether the fix you are about to write depends on a binary that ships on a
different cadence than the code calling it.

## Sources

- Task `window-confirm-is-dead-in-the-desktop-webview-so-every-confirm-gated-button-silently-does-nothing` (v0.24.0, reopened and closed 2026-08-24)
- Commit `f22dae76` — *fix(chat): the develop button says why it refuses instead of looking dead*
- `knowledge/features/in-app-agent-terminal.md` (the 2026-09-26 changelog entry)
