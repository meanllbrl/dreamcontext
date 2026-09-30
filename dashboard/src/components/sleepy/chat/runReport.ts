/**
 * The RUN card's PURE half: the output tail it keeps, and the message it posts back into the
 * conversation when the command exits.
 *
 * Its own file, with no React and no xterm imports, for the same reason `lib/chatViewSpec.ts`
 * has one: this is the part worth testing, and the root test runner cannot import a module
 * that reaches xterm (which wants a browser `self` at load time). See
 * `tests/unit/chat-run-card.test.ts`.
 */

/** How much of the output is kept for the report handed back to the agent. */
const TAIL_MAX_LINES = 40;
const TAIL_MAX_CHARS = 6000;

/**
 * Strip ANSI/OSC sequences — for the TAIL ONLY. The terminal renders the real bytes; the
 * agent gets text it can read instead of a screen recording. Also folds a bare CR (a
 * progress bar redrawing its own line) into a newline, so a spinner does not arrive as one
 * 4,000-character line.
 */
export function stripAnsi(input: string): string {
  return input
    // OSC strings (window titles, hyperlinks) FIRST, terminated by BEL or ST. Before the CSI
    // rule, not after: that rule's terminator class includes letters, so run first it would
    // bite a chunk out of the middle of an OSC payload and leave the rest as text.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    // CSI / SS3 / two-char escapes, and the 8-bit CSI byte.
    .replace(/[\x1b\x9b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    // Anything left that is not a newline or a tab is a control byte nobody can read.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Keep the tail bounded WHILE the command runs, so a chatty build cannot grow a string the
 *  size of its own log — and so what the agent gets stays a tail. Trimmed to twice the cap
 *  here and to the cap exactly in {@link finishTail}, so a multi-byte chunk boundary can
 *  never cost the last line. */
export function appendTail(current: string, chunk: string): string {
  const next = (current + stripAnsi(chunk)).slice(-TAIL_MAX_CHARS * 2);
  return next.split('\n').slice(-TAIL_MAX_LINES * 2).join('\n');
}

/** The tail as it goes into the report: blank edges dropped, capped both ways. */
export function finishTail(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  return lines.slice(-TAIL_MAX_LINES).join('\n').slice(-TAIL_MAX_CHARS);
}

export interface RunOutcome {
  /** null when the process ended without reporting one — see `InlineTerminal`'s close path. */
  code: number | null;
  tail: string;
  seconds: number;
}

/** The message posted back into the conversation. Exported for its unit test — what this
 *  hands the agent is the whole handshake, and it is the kind of string that rots. */
export function buildRunReport(
  command: string,
  outcome: RunOutcome,
  opts: { includeOutput: boolean },
): string {
  const status = outcome.code === null
    ? 'ended without reporting an exit code (the terminal was closed or the bridge dropped)'
    : `exit ${outcome.code}`;
  const lines = [
    '[ran in chat]',
    `$ ${command}`,
    `${status} · ${outcome.seconds}s`,
  ];
  if (!opts.includeOutput) {
    lines.push('The user chose not to share this command\'s output. Work from the exit code alone, and ask if you need something from it.');
  } else if (outcome.tail.trim()) {
    lines.push('', 'Output (tail):', '```', outcome.tail, '```');
  } else {
    lines.push('', 'It printed nothing.');
  }
  return lines.join('\n');
}


/**
 * Fit a run report into a host with a hard length cap — an agent thread's reply is at most
 * 2,000 characters (`THREAD_TEXT_MAX_CHARS`, server-enforced) where the chat's is not capped,
 * and a refused report is a command that ran and never said so. The OUTPUT TAIL gives way,
 * from its oldest lines, because the head (the command, the exit code) is what the agent
 * cannot work without and the newest output is where an error is. Anything that is not a
 * report with an output block is cut hard at the cap.
 */
export function fitRunReport(report: string, maxChars: number): string {
  if (report.length <= maxChars) return report;
  const open = '\nOutput (tail):\n```\n';
  const at = report.indexOf(open);
  const close = '\n```';
  if (at >= 0 && report.endsWith(close)) {
    const head = report.slice(0, at + open.length);
    const tail = report.slice(at + open.length, report.length - close.length);
    const marker = '…\n';
    const room = maxChars - head.length - close.length - marker.length;
    if (room > 0) return head + marker + tail.slice(-room) + close;
  }
  return report.slice(0, maxChars);
}
