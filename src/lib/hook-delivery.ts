/**
 * Getting hook output to the model whole.
 *
 * Claude Code replaces ONE hook's output past HARNESS_PERSIST_CHAR_LIMIT with a 2KB preview, and
 * nothing reads the file it saves. The limit is per hook, so the three context events each get
 * their own way to stay under it:
 *
 *   - SessionStart: the snapshot is cut into up to SESSION_START_PARTS pieces. `hook session-start`
 *     prints the first and leaves the rest here; a `hook session-start-part <n>` per piece, running
 *     beside it, waits for its file and prints it. Under one hook's ceiling the output is byte for
 *     byte what it always was, and the part hooks print nothing.
 *   - UserPromptSubmit: one hook, cut down by {@link fitPromptContext}, must-not-miss lines first.
 *   - SubagentStart: one hook, its ladder and hard cap in snapshot.ts.
 *
 * Claude only. A Codex hook has its own limit and its own splitter (t3-bridge/context.ts).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveContextRoot } from './context-path.js';
import { HOOK_OUTPUT_MAX_CHARS, SESSION_START_PARTS } from './snapshot-budget.js';

/** The hook subcommand that prints one later piece of the snapshot. */
export const SESSION_START_PART_HOOK = 'session-start-part';

/** A part hook gives up before its 10 s hook timeout, so a dead main hook costs one wait, never an error. */
export const PART_WAIT_MS = 8_000;
const PART_POLL_MS = 40;
/** The main hook and its part hooks start together, so a file older than this is a previous run's. */
const PART_FRESH_MS = 3_000;
/** Part files live for one session start; anything this old was never collected. */
const PART_FILE_TTL_MS = 60 * 60 * 1000;

/**
 * Print everything, whatever the pipe does. A hook process exits right after this, and stdout on
 * a pipe can be non-blocking, so a plain write can leave the tail behind.
 */
export function writeStdoutSync(text: string): void {
  const buf = Buffer.from(text, 'utf-8');
  let off = 0;
  for (let tries = 0; off < buf.length && tries < 1000; tries++) {
    try { off += writeSync(1, buf, off); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') return; }
  }
}

/**
 * The session moved out of the brain's folder (a code worktree, with the brain isolated from the
 * code): the hook runs in that folder and finds no `_dream_context/`, so it used to end silently
 * and the agent got nothing. CLAUDE_PROJECT_DIR is where the session started, and where the
 * settings that started this hook live. Measured 2026-11-01 on Claude Code 2.1.316; about 750 of 1,800
 * sub-agents in ten days of transcripts got no briefing this way.
 *
 * Returns the line that tells the agent, when the hook had to move: the agent's own `dreamcontext`
 * commands still run in the code folder, and there they fail with "_dream_context/ not found".
 */
/**
 * The brain a tool hook (Pre/PostToolUse) reads, WITHOUT moving the process: the hook's cwd first,
 * else the session's project dir. A Super child works in a code worktree with no brain, and its
 * tool hooks run there: measured 2026-11-08, every nudge a child ever got came from
 * UserPromptSubmit (which falls back like this), none from PostToolUse.
 */
export function hookContextRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const here = resolveContextRoot();
    if (here) return here;
  } catch { /* the folder is gone */ }
  const dir = env.CLAUDE_PROJECT_DIR;
  if (!dir) return null;
  try { return resolveContextRoot(dir); } catch { return null; }
}

export function enterHookProject(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (resolveContextRoot()) return null;
  } catch { /* the folder is gone: the project dir is the only place left to look */ }
  const dir = env.CLAUDE_PROJECT_DIR;
  if (!dir) return null;
  try {
    if (!resolveContextRoot(dir)) return null;
    process.chdir(dir);
    return `Your working folder has no brain. This project's brain is at ${dir}: run dreamcontext commands from there (\`cd ${dir} && dreamcontext …\`).`;
  } catch {
    return null; // an unreadable project dir leaves the hook where it was, which ends silently
  }
}

// ─── SessionStart parts ─────────────────────────────────────────────────────

/**
 * Are the part hooks in this project's settings? Without them, what is not printed is lost.
 * `projectRoot` is the project whose settings started the hook, so inside a hook that is
 * CLAUDE_PROJECT_DIR ({@link hookSettingsRoot}), not the brain the hook happens to stand in.
 */
export function sessionStartPartsInstalled(projectRoot: string): boolean {
  const commands: string[] = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const settings = JSON.parse(readFileSync(join(projectRoot, '.claude', name), 'utf-8')) as {
        hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: unknown }> }> };
      };
      commands.push(...(settings.hooks?.SessionStart ?? []).flatMap((g) => g.hooks ?? []).map((h) => String(h.command ?? '')));
    } catch { /* absent or unreadable */ }
  }
  for (let n = 2; n <= SESSION_START_PARTS; n++) {
    if (!commands.some((c) => c.includes(`hook ${SESSION_START_PART_HOOK} ${n}`))) return false;
  }
  return true;
}

/** The project whose settings started this hook; `fallback` when the harness did not say. */
export function hookSettingsRoot(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_PROJECT_DIR || fallback;
}

const partFrame = (n: number, total: number): string =>
  `_Project context, part ${n} of ${total}, continued._\n\n`;
const partFooter = (next: number, total: number): string =>
  `\n\n_Project context continues in part ${next} of ${total}, delivered beside this one. If it is not in your context, run \`dreamcontext snapshot\`._\n`;

/** What the frames above can add to a part; {@link splitHookOutput} leaves room for it. */
const FRAME_RESERVE_CHARS = 200;

/** Where to cut `text` at or under `max`: a section start, else a line end, else a whole character. */
function cutPoint(text: string, max: number, sections = true): number {
  const head = text.slice(0, max);
  const section = sections ? head.lastIndexOf('\n## ') : -1;
  // A section start early in the window would waste the rest of the part.
  if (section >= max * 0.7) return section;
  const line = head.lastIndexOf('\n');
  if (line > 0) return line;
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/**
 * Cut one hook's output into at most `parts` pieces of at most `max` chars each, in reading
 * order, so the must-not-miss lines at the top are in the piece that always arrives. What does not
 * fit in the last piece is dropped with a line that says so: a named cut, never a blind preview.
 */
export function splitHookOutput(text: string, parts: number = SESSION_START_PARTS, max: number = HOOK_OUTPUT_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const usable = Math.max(1, max - FRAME_RESERVE_CHARS);
  const cut = (sections: boolean): { chunks: string[]; rest: string } => {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 0 && chunks.length < parts) {
      if (rest.length <= usable) { chunks.push(rest); rest = ''; break; }
      const at = cutPoint(rest, usable, sections);
      chunks.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n+/, '');
    }
    return { chunks, rest };
  };
  // Cutting at section starts reads best, but each such cut can leave up to 30% of a part empty:
  // three parts then carry ~20,000 chars, not ~28,800. When that would drop text, cut at lines.
  let { chunks, rest } = cut(true);
  if (rest.length > 0) ({ chunks, rest } = cut(false));
  const total = chunks.length;
  return chunks.map((chunk, i) => {
    const head = i === 0 ? '' : partFrame(i + 1, total);
    if (i < total - 1) return `${head}${chunk}${partFooter(i + 2, total)}`;
    if (rest.length === 0) return `${head}${chunk}`;
    return `${head}${chunk}\n\n_${rest.length.toLocaleString('en-US')} more chars did not fit. \`dreamcontext snapshot\` prints all of it._\n`;
  });
}

function partsDir(home: string): string {
  return join(home, '.dreamcontext', 'hook-parts');
}

function partFile(sessionId: string, n: number, home: string): string {
  return join(partsDir(home), `${sessionId.replace(/[^\w-]/g, '')}.${n}.txt`);
}

/**
 * Leave pieces 2..SESSION_START_PARTS for the part hooks. Every slot gets a file, empty when
 * there is no such piece: a part hook that finds nothing waits out its whole timeout, and that wait
 * would hold up the session's start. The content is project context, so owner-only.
 */
export function writeSessionStartParts(sessionId: string, later: readonly string[], home: string = homedir()): void {
  const dir = partsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > PART_FILE_TTL_MS) rmSync(file, { force: true });
    }
  } catch { /* housekeeping is never allowed to cost a session */ }
  for (let n = 2; n <= SESSION_START_PARTS; n++) {
    const file = partFile(sessionId, n, home);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, later[n - 2] ?? '', { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, file);
  }
}

/** Wait for piece `n` of this session's start, take it and return it; '' when there is none. */
export async function takeSessionStartPart(
  sessionId: string,
  n: number,
  opts: { home?: string; waitMs?: number; pollMs?: number; startedAt?: number } = {},
): Promise<string> {
  const file = partFile(sessionId, n, opts.home ?? homedir());
  const startedAt = opts.startedAt ?? Date.now();
  const deadline = Date.now() + (opts.waitMs ?? PART_WAIT_MS);
  for (;;) {
    try {
      if (existsSync(file) && statSync(file).mtimeMs >= startedAt - PART_FRESH_MS) {
        const text = readFileSync(file, 'utf-8');
        rmSync(file, { force: true });
        return text;
      }
    } catch { /* being renamed into place, or taken: look again */ }
    if (Date.now() >= deadline) return '';
    await new Promise((r) => setTimeout(r, opts.pollMs ?? PART_POLL_MS));
  }
}

// ─── UserPromptSubmit ───────────────────────────────────────────────────────

/**
 * `must` is every rule, reminder and owner-bound line; `gate` the closing "before you act" block;
 * the rest is what a turn can lose first, cheapest loss first: peers, recall, then patterns.
 */
export type PromptBlockKind = 'must' | 'gate' | 'patterns' | 'recall' | 'peers';

export interface PromptBlock {
  kind: PromptBlockKind;
  text: string;
  /** A cheaper complete render of this block (patterns: pointers instead of pasted bodies). */
  compact?: string;
}

export interface FittedPrompt {
  text: string;
  /** The full text, when even the must-not-miss lines did not fit and were cut. */
  overflow: string | null;
}

const CLIP_LINE_CHARS = [1_200, 600, 300, 160];

const joined = (blocks: readonly PromptBlock[]): string =>
  blocks.filter((b) => b.text !== '').map((b) => b.text).join('\n');

function clipLines(text: string, max: number): string {
  return text.split('\n').map((line) => {
    if (line.length <= max) return line;
    const chars = Array.from(line.slice(0, max));
    return `${chars.join('')}…`;
  }).join('\n');
}

const RECALL_CLIP_NOTE = '  (Long entries clipped to fit this turn: open the files named above for the full text.)';

/**
 * Bring one turn's output under `max`, keeping order. Long snippets are clipped first (each hit
 * keeps its path), then a pattern's pasted body becomes a pointer, then whole blocks go, peers
 * first, and `overflow` carries what went. `must` and `gate` are the last to be touched, and the
 * top of `must` the very last.
 */
export function fitPromptContext(input: readonly PromptBlock[], max: number = HOOK_OUTPUT_MAX_CHARS): FittedPrompt {
  const blocks = input.map((b) => ({ ...b }));
  const full = joined(blocks);
  if (full.length <= max) return { text: full, overflow: null };

  const clipped = new Set<PromptBlock>();
  for (const limit of CLIP_LINE_CHARS) {
    for (const b of blocks) {
      if (b.kind !== 'peers' && b.kind !== 'recall') continue;
      const next = clipLines(b.text, limit);
      if (next !== b.text) { b.text = next; clipped.add(b); }
    }
    if (joined(blocks).length + RECALL_CLIP_NOTE.length + 1 <= max) break;
  }
  const noteAt = [...clipped].find((b) => b.kind === 'recall') ?? [...clipped][0];
  if (noteAt) noteAt.text = `${noteAt.text}\n${RECALL_CLIP_NOTE}`;
  if (joined(blocks).length <= max) return { text: joined(blocks), overflow: null };

  for (const b of blocks) {
    if (b.kind === 'patterns' && b.compact !== undefined) b.text = b.compact;
  }
  if (joined(blocks).length <= max) return { text: joined(blocks), overflow: null };

  // From here a whole block goes, so the agent is told and the full text stays on disk: a decided
  // pattern that vanished without a word is the silent ignore the pattern gate exists to end.
  const room = Math.max(1, max - OVERFLOW_NOTE_RESERVE_CHARS);
  for (const kind of ['peers', 'recall', 'patterns'] as const) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.kind === kind && joined(blocks).length > room) blocks[i]!.text = '';
    }
  }
  const rest = joined(blocks);
  if (rest.length <= room) return { text: rest, overflow: full };

  // Only the lines nothing may drop are left and they are still too long (a parked first message,
  // a whole board). Keep the top and hand the agent the rest by path.
  return { text: rest.slice(0, cutPoint(rest, room)), overflow: full };
}

const OVERFLOW_NOTE_RESERVE_CHARS = 300;

/** The line that ends a cut {@link FittedPrompt}, once its full text is on disk. */
export function promptOverflowNote(path: string): string {
  return `\n\n⚠ This turn's project context was too long to deliver whole. Read ${path} in full before you act.`;
}

/** Keep a turn's full context where {@link promptOverflowNote} can name it. */
export function writePromptOverflow(sessionId: string, text: string, home: string = homedir()): string {
  const dir = partsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${sessionId.replace(/[^\w-]/g, '') || 'session'}.prompt-overflow.txt`);
  writeFileSync(file, text, { encoding: 'utf-8', mode: 0o600 });
  return file;
}
