/**
 * Does this keystroke stop the in-flight Chat turn?
 *
 * The TERMINAL renderer gets ⌃C for free, and deliberately so: AgentSurface's session-chord
 * handler claims exactly one Ctrl combo (⌃` for a new shell) and explicitly lets every other
 * one through, because "⌃C SIGINT / ⌃D EOF / ⌃W delete-word MUST reach the PTY, or a shell
 * session is unusable". So in a terminal tab ⌃C falls through xterm to Claude's TUI, which
 * cancels the turn itself.
 *
 * The CHAT renderer has no PTY. Its only stop affordance was the composer's ■ button — so the
 * reflex every terminal user already has ("⌃C stops it") did nothing at all here, on the one
 * surface built to be less hostile than the terminal. This rule is that reflex made explicit;
 * it resolves to the very same `session.interrupt()` the ■ button sends.
 *
 * Two things it must NOT break:
 *
 *   • COPY. On Windows/Linux ⌃C *is* the platform copy chord, so a keystroke made while text
 *     is selected is left alone — interrupting there would eat the user's copy AND kill their
 *     turn, from one keypress they meant as neither. (On macOS copy is ⌘C, so deferring costs
 *     nothing there either: ⌃C-with-a-selection is not a chord anyone presses on purpose.)
 *
 *   • An IDLE session. With no turn in flight there is nothing to stop, so ⌃C keeps whatever
 *     meaning the browser/OS gave it rather than being swallowed by a handler that then does
 *     nothing. Notably this is NOT the CLI's "⌃C clears the prompt, twice quickly exits":
 *     clearing would silently destroy a draft the composer has no undo for, and exiting has
 *     no meaning for a tab you close with ⌘W.
 */

/** The fields of a keydown this rule reads — a plain shape so tests need no real DOM event. */
export interface InterruptKeyStroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface InterruptKeyState {
  /** A turn is in flight — i.e. the composer is showing ■ Stop rather than ↑ Send. */
  busy: boolean;
  /** Text is selected on screen right now, so the keystroke is a copy (see the header). */
  hasSelection: boolean;
}

/**
 * The chord alone, independent of session state: Ctrl and nothing else, on the C key.
 *
 * Both cases of the key are accepted because CapsLock reports `'C'` with `shiftKey: false` —
 * but ⇧ itself is excluded, since ⌃⇧C is the browser's own inspector chord and not ours to
 * take. ⌘ is excluded so macOS ⌘C (copy) can never land here, and ⌥ so a ⌃⌥C binding
 * someone else owns stays theirs.
 */
export function isChatInterruptChord(e: InterruptKeyStroke): boolean {
  if (e.key !== 'c' && e.key !== 'C') return false;
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/** The whole decision: chord + "there is a turn to stop" + "this isn't a copy". */
export function shouldInterruptChat(e: InterruptKeyStroke, state: InterruptKeyState): boolean {
  if (!isChatInterruptChord(e)) return false;
  if (state.hasSelection) return false;
  return state.busy;
}
