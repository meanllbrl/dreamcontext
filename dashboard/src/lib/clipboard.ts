/**
 * UTF-8-safe clipboard writes for the desktop shell AND the plain web dashboard.
 *
 * WHY THIS EXISTS — issue #171 (regression of task `agent-terminal-rendering-readability-polish`):
 * In the packaged macOS Tauri app's WKWebView, `navigator.clipboard.writeText()` re-decodes the
 * string's UTF-8 bytes as Mac Roman — Ş (`C5 9E`) → "≈û", ü (`C3 BC`) → "√º", ı → "ƒ±", ş → "≈ü".
 * The on-screen terminal text is fine (buffer code points are correct); only the clipboard WRITE
 * mangles. The earlier fix routed copies through a hidden `<textarea>` + `document.execCommand('copy')`
 * (the OS's native text-copy pipeline). That `execCommand` primary degraded in a newer WKWebView and
 * the code silently fell through to the mangling `navigator.clipboard.writeText` fallback — the
 * regression. The durable fix: on the desktop shell, write via the Tauri clipboard plugin (Rust-side
 * OS clipboard), which bypasses the WKWebView JS clipboard entirely and round-trips UTF-8 correctly.
 * The browser paths remain for the plain web dashboard, which has no WKWebView bug.
 */

export type ClipboardStrategy = 'tauri' | 'exec-command' | 'navigator';

/** The Turkish signature string from issue #171 — a copy of this must arrive byte-identical. */
export const TURKISH_COPY_FIXTURE = 'Şimdi düzenli şekilde güncellemek için yaptığım';

/**
 * Ordered clipboard strategies for the given environment — the FIRST that succeeds wins.
 *
 * Desktop (WKWebView): the native OS clipboard is the only encoding-safe path, so `tauri` MUST be
 * first and the mangling `navigator` path must never be reached before an encoding-safe one.
 * Web: there is no WKWebView bug, so use the OS pipeline (`exec-command`) then the async API.
 *
 * Pure and side-effect-free so the copy contract is unit-testable without a DOM or a live clipboard.
 */
export function clipboardStrategyOrder(isDesktop: boolean): ClipboardStrategy[] {
  return isDesktop
    ? ['tauri', 'exec-command', 'navigator']
    : ['exec-command', 'navigator'];
}

/** True only inside the Tauri v2 webview (the desktop shell). Mirrors `isDesktop()` in ./desktop,
 *  inlined here so this module stays free of any top-level browser/Tauri import (node-safe). */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined'
    && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** Copy via a hidden `<textarea>` + `execCommand('copy')` (native OS pipeline). Synchronous, so it
 *  runs inside the user gesture. Returns whether the copy actually happened. */
function copyViaExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Write `text` to the clipboard preserving Unicode (Turkish ç/ğ/ı/İ/Ü/Ş, → — …). Walks
 * `clipboardStrategyOrder` and stops at the first strategy that succeeds. Fire-and-forget: the
 * synchronous first strategy on web (`exec-command`) still runs inside the caller's user gesture
 * because the async body doesn't `await` before reaching it.
 */
export function copyPreservingUnicode(text: string): void {
  void runClipboardStrategies(text, clipboardStrategyOrder(isDesktopShell()));
}

async function runClipboardStrategies(text: string, order: ClipboardStrategy[]): Promise<void> {
  for (const strategy of order) {
    try {
      if (strategy === 'tauri') {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
        return;
      }
      if (strategy === 'exec-command') {
        if (copyViaExecCommand(text)) return;
        continue; // execCommand reported failure — try the next strategy
      }
      if (strategy === 'navigator') {
        // Known to mangle non-ASCII in the WKWebView; reached only as a last resort on web,
        // or on desktop if the native clipboard AND the OS pipeline both failed.
        await navigator.clipboard?.writeText(text);
        return;
      }
    } catch {
      // This strategy threw — fall through to the next one in the order.
    }
  }
}
