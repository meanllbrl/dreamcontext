/**
 * Reading a session's CHECKOUT MOVES out of the `claude` stream.
 *
 * The chat bridge already parses every stdout line as NDJSON (`agent-chat.ts`, for interrupt
 * resolution and the slash-command cache). This module is the third reader on that same loop,
 * and it answers one question: did this frame just move the session into, or out of, a git
 * worktree?
 *
 * ── Why the tool frames and not the model's prose ─────────────────────────────────────
 * The alternative was to ask the agent to announce its move in text and parse that. The
 * harness's own `EnterWorktree`/`ExitWorktree` tools make that unnecessary for the case that
 * matters: the move arrives as a STRUCTURED frame the model does not author. Prose remains the
 * fallback for a manual `git worktree add` + `cd`, which produces no frame at all — that path
 * is covered by the briefing (`chat-modes.ts`'s `WORKTREE_DECLARE`) asking the agent to pin
 * the checkout itself, not by anything here.
 *
 * ── Shapes, taken from real frames rather than assumed ────────────────────────────────
 * Captured from `~/.claude/projects/**\/*.jsonl` on 2026-08-24 (two independent sessions, two
 * different input shapes). Structure verbatim; directory names anonymised — this repo is public:
 *
 *   assistant → {"type":"tool_use","id":"toolu_01…","name":"EnterWorktree",
 *                "input":{"name":"chat-question-bubble-stop"}}
 *   assistant → {"type":"tool_use","id":"toolu_01…","name":"EnterWorktree",
 *                "input":{"path":"/Users/…/acme-webhooks"}}
 *   user      → {"type":"tool_result","tool_use_id":"toolu_01…",
 *                "content":"Created worktree at /Users/…/.claude/worktrees/chat-question-bubble-stop
 *                           on branch worktree-chat-question-bubble-stop. The session is now
 *                           working in the worktree. …"}
 *
 * Two things that decided the implementation:
 *
 *  1. **The RESULT carries the path, the CALL does not.** `input` is `{name}` in one capture
 *     and `{path}` in the other, and `{name}` is not a path at all — the tool resolves it to
 *     `<repo>/.claude/worktrees/<name>`. So the call is only used to remember an id, and the
 *     directory is read out of the result. Which is also the correct SEMANTICS: a call is an
 *     intention, a result is a move that happened.
 *  2. **"Created" and "Entered" are both real.** The first opens a new worktree, the second
 *     steps into an existing one. Either is a move.
 *
 * The transcript files also carry a `toolUseResult` sidecar with a clean `worktreePath`. It is
 * read here when present and NOT relied on: it is a transcript-writer field, and this code
 * runs against the stdout stream, where the string is the thing guaranteed to be there.
 */

/** A move the caller should apply. `null` means "this frame said nothing about a checkout",
 *  which is the answer for the overwhelming majority of frames. */
export type CheckoutMove =
  | { kind: 'enter'; dir: string }
  | { kind: 'exit' };

const WORKTREE_TOOLS: Record<string, 'enter' | 'exit'> = {
  EnterWorktree: 'enter',
  ExitWorktree: 'exit',
};

/**
 * `Created worktree at <path> on branch <branch>.` / `Entered worktree at <path> on branch …`
 *
 * Non-greedy up to ` on branch `, so a path containing the word "worktree" is fine and one
 * containing " on branch " would truncate — a filename no git repository on this machine has,
 * and the same-repository gate in `session-cwd.ts` rejects the truncation anyway rather than
 * pointing the shelf at half a path.
 */
const MOVED_TO = /worktree at (\/.+?) on branch /;

/** A tool_result's `content` is a string in the captures above, but the Anthropic message
 *  shape also permits an array of blocks. Flatten both to one string; anything else yields ''
 *  and simply matches nothing. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
      ? (b as { text: string }).text
      : ''))
    .join('\n');
}

function blocksOf(frame: Record<string, unknown>): unknown[] {
  const message = frame.message;
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

/**
 * A stateful reader over one session's frames.
 *
 * State is needed because the two halves arrive in different frames: the CALL names the tool,
 * the RESULT carries the path, and only `tool_use_id` ties them together. The map of ids in
 * flight is per-session and tiny (a worktree move is not a hot path), and an id is dropped as
 * soon as its result lands.
 *
 * Pure with respect to the filesystem: it never touches disk and never validates the path it
 * extracts. Deciding whether a directory may be pointed at is `session-cwd.ts`'s job, and
 * keeping the two apart is what lets this be tested against captured frames alone.
 */
export function createWorktreeWatcher(): (frame: Record<string, unknown>) => CheckoutMove | null {
  const inFlight = new Map<string, 'enter' | 'exit'>();

  return function observe(frame: Record<string, unknown>): CheckoutMove | null {
    const blocks = blocksOf(frame);
    if (blocks.length === 0) return null;

    let move: CheckoutMove | null = null;
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as Record<string, unknown>;

      if (block.type === 'tool_use') {
        const kind = typeof block.name === 'string' ? WORKTREE_TOOLS[block.name] : undefined;
        if (kind && typeof block.id === 'string') inFlight.set(block.id, kind);
        continue;
      }

      if (block.type !== 'tool_result') continue;
      const id = block.tool_use_id;
      if (typeof id !== 'string') continue;
      const kind = inFlight.get(id);
      if (!kind) continue;
      inFlight.delete(id);

      // A refused or failed tool did not move anything. Reporting the move anyway would put a
      // branch on the shelf for a worktree the session is not in.
      if (block.is_error === true) continue;

      if (kind === 'exit') { move = { kind: 'exit' }; continue; }

      const sidecar = frame.toolUseResult;
      const fromSidecar = sidecar && typeof sidecar === 'object'
        ? (sidecar as { worktreePath?: unknown }).worktreePath
        : undefined;
      if (typeof fromSidecar === 'string' && fromSidecar.startsWith('/')) {
        move = { kind: 'enter', dir: fromSidecar };
        continue;
      }
      const matched = MOVED_TO.exec(resultText(block.content));
      if (matched) move = { kind: 'enter', dir: matched[1] };
    }
    return move;
  };
}
