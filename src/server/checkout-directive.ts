/**
 * Reading a session's CHECKOUT the agent DECLARED, out of its own prose.
 *
 * `worktree-frames.ts` follows the harness's `EnterWorktree`/`ExitWorktree` tools and
 * `session-transcript-cwd.ts` follows the conversation's `cwd`. Between them they cover every
 * move that MOVES the session. This module covers the one case neither can see: the session
 * is standing in one checkout and doing its real work in another.
 *
 * That is not a corner case in a split brain. The brain repo is where `claude` is spawned and
 * where every `dreamcontext` call has to run (knowledge/worktrees-and-the-brain.md), so an
 * agent working on the product often keeps its cwd there and edits the linked repo's worktree
 * by absolute path. Nothing about that is wrong, and no signal on the stream reveals it —
 * cwd never moved, no worktree tool was called. So the agent is given a way to SAY it, and
 * the shelf believes it exactly as far as the gate allows.
 *
 * ── The contract ──────────────────────────────────────────────────────────────────────
 * A `dream-view` fence in the agent's own answer, the same channel a pin travels on:
 *
 *   ```dream-view
 *   {"type":"checkout","path":"/Users/…/.claude-worktrees/kurum-roster-union"}
 *   ```
 *   ```dream-view
 *   {"type":"checkout","reset":true}
 *   ```
 *
 * `reset` returns the session to the checkout the server can observe for itself — it clears
 * the override, it does not pin the project root, so a transcript `cwd` that says otherwise
 * still wins afterwards. That is the difference between "I am no longer claiming this" and
 * "I claim the project root", and only the first is ever what an agent means.
 *
 * ── Why the server reads this and not the client ──────────────────────────────────────
 * The client parses the same fence (chatViewSpec.ts) to know not to render it, but a
 * directive applied there would be a fact that exists only while a pane is watching — and
 * the shelf's whole promise is that the checkout survives the user looking away. So the
 * authority is here, on the stream the server already parses, next to the tool frames it
 * already reads. The path is validated by `session-cwd.ts`'s gate exactly like a frame's,
 * because prose is a WEAKER source than a tool result, not a stronger one.
 */

/** A directive the caller should apply. `null` — the answer for nearly every frame — means
 *  this text said nothing about a checkout. */
export type CheckoutDirective =
  | { kind: 'set'; dir: string }
  | { kind: 'reset' };

/**
 * `dream-view` fences in a block of markdown.
 *
 * Deliberately the same shape the client's fence splitter looks for, and deliberately NOT a
 * markdown parser: an opening fence, the literal name, and everything up to the next closing
 * fence. A fence the agent left open mid-stream simply does not match, which is the correct
 * answer — an unterminated block is not a directive yet.
 */
const FENCE = /```dream-view[^\S\r\n]*\r?\n([\s\S]*?)```/g;

/** The text of every complete `text` block on an assistant frame, joined.
 *
 *  Only `type: 'assistant'` frames are read. Partial-message deltas arrive as `stream_event`
 *  frames carrying the same characters, and reading both would apply one directive twice —
 *  harmless for `set` (idempotent) and wrong for the ordering of a `set` followed by a
 *  `reset` in one answer. */
function assistantText(frame: Record<string, unknown>): string {
  if (frame.type !== 'assistant') return '';
  const message = frame.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The checkout directive `frame` carries, or `null`.
 *
 * The LAST directive in one answer wins: an agent that sets a checkout and then resets it in
 * the same message means the reset, and reading the first would leave the session holding a
 * claim its author had already withdrawn.
 *
 * Never throws. Malformed JSON, a `path` that is not a string, an empty path, a payload that
 * is an array and a `type` this module does not own all resolve to "nothing to apply" — the
 * client's parser is what tells the USER a block was malformed, and duplicating that here
 * would put two different complaints about one fence on two different surfaces.
 */
export function readCheckoutDirective(frame: Record<string, unknown>): CheckoutDirective | null {
  const text = assistantText(frame);
  if (!text.includes('dream-view')) return null; // the cheap reject, taken by nearly every frame

  let found: CheckoutDirective | null = null;
  FENCE.lastIndex = 0;
  for (let m = FENCE.exec(text); m !== null; m = FENCE.exec(text)) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const obj = parsed as Record<string, unknown>;
    if (obj.type !== 'checkout') continue;

    // `reset` is checked FIRST so `{"reset":true,"path":"…"}` — a contradiction — resolves to
    // the safe half. Withdrawing a claim can never point the shelf anywhere wrong; honouring
    // the path of a payload that also asked to reset can.
    if (obj.reset === true) { found = { kind: 'reset' }; continue; }

    const dir = typeof obj.path === 'string' ? obj.path.trim() : '';
    if (dir) found = { kind: 'set', dir };
  }
  return found;
}

// ─── What the user is told ───────────────────────────────────────────────────────────

/**
 * The sentence for a claim the gate ACCEPTED, or REFUSED (`facts === null`).
 *
 * Both arms are shown, and that asymmetry is the point: a silent refusal leaves an agent
 * repeating a claim nobody applied, and leaves a user reading a shelf that quietly disagrees
 * with the answer above it. The refusal names the rule rather than the path — the path is
 * already in the message the agent just wrote.
 */
export function describeCheckoutClaim(
  dir: string,
  facts: { branch: string | null; worktree: boolean; worktreeName: string | null } | null,
): string {
  if (!facts) {
    return `That checkout was not applied: ${dir} is not a checkout of this project or of a repo linked to it. The shelf still shows the checkout this session is standing in.`;
  }
  const where = facts.worktree && facts.worktreeName ? `worktree ${facts.worktreeName}` : dir;
  return facts.branch
    ? `The shelf now reads this session as working in ${where}, on branch ${facts.branch}.`
    : `The shelf now reads this session as working in ${where}, on a detached HEAD.`;
}

/** The sentence for a withdrawn claim. It does not promise a destination, because a reset
 *  does not choose one — the transcript's own `cwd` answers next, and it may well be the
 *  same directory the claim named. */
export function describeCheckoutReset(): string {
  return 'Checkout claim withdrawn — the shelf is back to reading this session’s own working directory.';
}

// ─── Where the WRITES are going ──────────────────────────────────────────────────────

/**
 * The tools whose frames mean "a file on disk just changed", and the input field each one
 * carries the path in.
 *
 * Deliberately writes only. `Read`, `Grep` and `Glob` say where an agent LOOKED, and looking
 * into another checkout is ordinary — a session comparing two implementations reads across
 * three repos and works in one. A write is the thing that makes the shelf's answer wrong.
 *
 * `Bash` is not here either, and cannot be: `git commit`, `sed -i` and a redirect all write,
 * and the path is inside a shell string this module would have to parse. A miss is the safe
 * failure for a WARNING (it stays quiet), where a wrong parse would put another repo's name
 * on the chip.
 */
const WRITE_TOOLS: Record<string, string[]> = {
  Edit: ['file_path'],
  Write: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

/**
 * Every absolute path this frame reports a WRITE to. Empty for the overwhelming majority.
 *
 * Read off `tool_use` blocks — the CALL, not the result — because the path is in the input
 * there and a failed write is still a write the agent aimed at this checkout. Overcounting a
 * refused edit is invisible in a warning that only ever compares one directory to another;
 * missing the successful ones is not.
 */
export function readEditPaths(frame: Record<string, unknown>): string[] {
  if (frame.type !== 'assistant') return [];
  const message = frame.message;
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  const paths: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
    const fields = WRITE_TOOLS[block.name];
    if (!fields) continue;
    const input = block.input;
    if (!input || typeof input !== 'object') continue;
    for (const field of fields) {
      const value = (input as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.startsWith('/')) paths.push(value);
    }
  }
  return paths;
}
