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
 * `clipboardStrategyOrder` and stops at the first strategy that succeeds. The synchronous first
 * strategy on web (`exec-command`) still runs inside the caller's user gesture because the async
 * body doesn't `await` before reaching it.
 *
 * Returns a promise resolving to `true` if a strategy actually wrote the clipboard, `false` if
 * every strategy failed. Callable fire-and-forget (the promise may be ignored) — but on total
 * failure it `console.warn`s so a regression to "silently copies nothing" is at least observable,
 * and callers that want to surface a toast can await the result.
 */
export function copyPreservingUnicode(text: string): Promise<boolean> {
  return runClipboardStrategies(text, clipboardStrategyOrder(isDesktopShell())).then((ok) => {
    if (!ok) console.warn('[clipboard] copy failed: no clipboard strategy succeeded');
    return ok;
  });
}

async function runClipboardStrategies(text: string, order: ClipboardStrategy[]): Promise<boolean> {
  for (const strategy of order) {
    try {
      if (strategy === 'tauri') {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(text);
        return true;
      }
      if (strategy === 'exec-command') {
        if (copyViaExecCommand(text)) return true;
        continue; // execCommand reported failure — try the next strategy
      }
      if (strategy === 'navigator') {
        // Known to mangle non-ASCII in the WKWebView; reached only as a last resort on web,
        // or on desktop if the native clipboard AND the OS pipeline both failed. Guard the API's
        // presence explicitly: `navigator.clipboard?.writeText()` returns `undefined` (not a
        // rejection) when the API is absent, so awaiting it would otherwise report a false success.
        if (!navigator.clipboard) continue;
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // This strategy threw — fall through to the next one in the order.
    }
  }
  return false;
}
