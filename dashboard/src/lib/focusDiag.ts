/**
 * The composer focus probe. Owner, 2026-10-04: after a chat was opened from the notch, the
 * project window's composer could not be clicked into until something re-rendered it. The
 * cause was not visible from code, so a landing ARMS this probe for two minutes: it writes the
 * page's focus state at landing and, for the next few presses, what was under the pointer, the
 * composer field there (disabled, inert, pointer-events) and where focus went after the press.
 * Lines go to ~/.dreamcontext/logs/focus-diag.log through the shell (`focus_diag`,
 * desktop/src-tauri/src/page_focus.rs), next to the shell's own first-responder lines.
 *
 * Outside the desktop app, or on a shell without the command, every call is a silent no-op.
 */
import { isDesktop } from './desktop';

const ARMED_MS = 120_000;
const MAX_PRESSES = 12;

let disarm: (() => void) | null = null;

function describe(el: Element | null): string {
  if (!el) return 'none';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${cls}`;
}

function write(line: string): void {
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('focus_diag', { line });
    } catch { /* an older shell: nowhere to write */ }
  })();
}

function fieldAt(x: number, y: number): HTMLTextAreaElement | null {
  for (const ta of Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.chat-cmp-input'))) {
    const r = ta.getBoundingClientRect();
    if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return ta;
  }
  return null;
}

function focusState(): string {
  return `hasFocus=${document.hasFocus()} visible=${document.visibilityState} active=${describe(document.activeElement)}`;
}

/**
 * The remedy the probe found the need for: a press in a page that believes it is NOT focused
 * asks the shell to activate the app (`page_wants_focus`, desktop/src-tauri/src/page_focus.rs).
 * The 2026-10-04 log had nine presses on the composer, each landing on the field itself, with
 * `document.hasFocus()` false before and after every one: the window was key, its app was not
 * active, and AppKit does not activate an app for a click on a window that is already key. A
 * press while focused costs nothing. Installed once per window; returns the disposer.
 */
export function healUnfocusedPresses(): () => void {
  if (!isDesktop()) return () => {};
  const onDown = () => {
    if (document.hasFocus()) return;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('page_wants_focus');
      } catch { /* an older shell: nothing to ask */ }
    })();
  };
  document.addEventListener('pointerdown', onDown, true);
  return () => document.removeEventListener('pointerdown', onDown, true);
}

/** Arm the probe for the next two minutes (re-arming restarts it). */
export function armFocusDiag(reason: string): void {
  if (!isDesktop()) return;
  disarm?.();
  write(`armed (${reason}) ${focusState()}`);
  window.setTimeout(() => write(`+1.5s ${focusState()}`), 1500);
  let presses = 0;
  const onDown = (e: PointerEvent) => {
    presses += 1;
    const top = document.elementFromPoint(e.clientX, e.clientY);
    const ta = fieldAt(e.clientX, e.clientY);
    const field = ta
      ? ` field: disabled=${ta.disabled} inert=${!!ta.closest('[inert]')} pe=${getComputedStyle(ta).pointerEvents} topIsField=${top === ta}`
      : ' field: none under the press';
    write(`press ${presses} target=${describe(e.target as Element | null)} top=${describe(top)}${field} before: ${focusState()}`);
    window.setTimeout(() => write(`press ${presses} +80ms ${focusState()}`), 80);
    if (presses >= MAX_PRESSES) disarm?.();
  };
  document.addEventListener('pointerdown', onDown, true);
  const timer = window.setTimeout(() => disarm?.(), ARMED_MS);
  disarm = () => {
    document.removeEventListener('pointerdown', onDown, true);
    window.clearTimeout(timer);
    disarm = null;
  };
}
