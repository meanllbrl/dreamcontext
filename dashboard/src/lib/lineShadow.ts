/**
 * Readline line-shadow transition for the embedded terminal (agentSession.ts): fold one
 * input chunk into the raw byte log of the current (unsubmitted) line. A standalone,
 * import-free module — agentSession.ts pulls in xterm (browser-only), so the pure rule
 * lives here where unit tests can load it in node.
 *
 * `Session.runCommand`'s clear-command-restore dance replays this log into a fresh
 * prompt, so the reset rules are load-bearing:
 *  • a lone Ctrl+C or Esc chunk cleared/aborted the line → empty;
 *  • any chunk ending in an UNESCAPED `\r` submitted it (a bare Enter keystroke, a
 *    composer submit) → empty — but `\\\r` is Claude's newline-without-submit
 *    continuation (the ⇧↵ remap), which stays part of the draft;
 *  • everything else (printables, backspaces, arrow/word-nav sequences, bracketed
 *    pastes) appends VERBATIM — deliberately unparsed: Claude's readline is
 *    deterministic, so replaying the exact bytes from an empty line reproduces the
 *    draft without this code understanding any editing sequence.
 * Known accepted edge: ↑-history recall replays against a shifted history after a
 * `runCommand` submission — rare, and the cost is a wrong draft, never a wrong submit.
 */
export function nextLineShadow(prev: string, data: string): string {
  if (!data) return prev;
  if (data === '\x03' || data === '\x1b') return '';
  if (data.endsWith('\r') && !data.endsWith('\\\r')) return '';
  return prev + data;
}
