/**
 * The brain for a bridge chat (Track T W3, plan r5 §4a). Claude gets it from its hooks; a Codex
 * chat has none of ours, so the bridge child runs the SAME hook commands — `dreamcontext hook
 * <name> --format codex` — and hands what they print to Codex:
 *
 *   - session start (startup, resume, after an Eco `/clear`): the snapshot, kept as the stable
 *     `dreamcontext-brain` app-context entry;
 *   - every owner turn: `user-prompt-submit` (recall, sleep line, patterns, AI Team…) as the
 *     `dreamcontext-prompt` entry, beside the snapshot;
 *   - every finished turn: `stop`, with the Codex rollout as the transcript, so sleep records,
 *     scores and later distills the session like a Claude one (codex-rollout.ts).
 *
 * App context is UNTRUSTED `additionalContext` (CodexAdapterV2 sends `kind: "untrusted"`): never
 * developer instructions (those carry only our chat-surface briefing), never owner text in the
 * thread. The snapshot rides every turn so T3's restore after a compaction (it re-injects the LAST
 * turn's app context) always includes it; Codex itself re-sends app context only when it changes.
 *
 * Codex cuts every app-context entry down to 1,000 of its tokens (4,000 BYTES of value, the middle
 * goes; measured on 0.164.0: no ceiling on the sum, 40 entries of 3,900 bytes all arrived), so
 * {@link fitCodexContext} splits a long entry into several untrusted entries before the turn starts.
 *
 * ANTIGRAVITY IS THE EXCEPTION (owner's decision, 2026-11-01): ACP has no untrusted context channel,
 * so there the brain rides in the user message, after the owner's words ({@link contextInWords}).
 * The model cannot tell it from what the owner typed by channel, only by its tags. A very long
 * message carries it first ({@link wordsWithContext}): the agent loses the end of one.
 *
 * Running the hooks, not a copy of their logic, is what keeps Claude's output byte-identical: the
 * Claude path never changes, and the Codex path prints the very same text.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { resolveContextRoot } from '../context-path.js';
import type { AppContext } from './stdio.js';

export type HookName = 'session-start' | 'user-prompt-submit' | 'stop' | 'post-tool-use' | 'pre-compact';

/** Runs one hook, returns its stdout; null = it did not finish (timed out, or failed printing nothing). Injectable for tests. */
export type HookRunner = (name: HookName, input: Record<string, unknown>, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string | null>;

/** A hook that would block the owner's turn longer than this is skipped for that turn. */
export const PROMPT_HOOK_TIMEOUT_MS = 15_000;
export const SESSION_HOOK_TIMEOUT_MS = 15_000;
export const STOP_HOOK_TIMEOUT_MS = 45_000;

/**
 * Env the hook child must NOT inherit from the bridge child:
 *   - DREAMCONTEXT_CONTEXT_BY: it would silence the very hooks we run (it is meant for a project's
 *     opt-in `.codex/hooks.json` inside a bridge session);
 *   - DREAMCONTEXT_CHAT_TAB: the bridge names the tab itself (tab-title.ts); the hook's own title
 *     nudge and stop-block would ask twice;
 *   - DREAMCONTEXT_AGENT_STATUS_FILE: the chat server reads the pane's state from its frames.
 */
const STRIPPED_ENV = ['DREAMCONTEXT_CONTEXT_BY', 'DREAMCONTEXT_CHAT_TAB', 'DREAMCONTEXT_AGENT_STATUS_FILE'];

export function hookEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of STRIPPED_ENV) delete out[k];
  return out;
}

/** Below Codex's 4,000 bytes per entry, with room to spare if it counts a little differently. */
export const CODEX_ENTRY_MAX_BYTES = 3_800;

/**
 * Cut `text` into parts of at most `maxBytes` UTF-8 bytes that join back to exactly `text`: at the
 * last `## ` section that fits, else the last line, else the last whole character.
 */
export function splitContextText(text: string, maxBytes = CODEX_ENTRY_MAX_BYTES): string[] {
  const parts: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest) > maxBytes) {
    let bytes = 0;
    let fits = 0;
    for (const ch of rest) {
      bytes += Buffer.byteLength(ch);
      if (bytes > maxBytes) break;
      fits += ch.length;
    }
    const head = rest.slice(0, fits);
    const section = head.lastIndexOf('\n## ');
    const line = head.lastIndexOf('\n');
    const cut = section > 0 ? section : line > 0 ? line : fits;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/**
 * The entries as Codex must receive them: one that fits keeps its key, a longer one becomes `key`,
 * `key-02`, `key-03`… Each part is still a plain entry, so it stays untrusted, rides every turn and
 * comes back in T3's restore after a compaction. Numbers are padded because Codex orders entries by
 * key: `-10` must not land before `-02`.
 */
export function fitCodexContext(entries: readonly AppContext[]): AppContext[] {
  return entries.flatMap(({ key, text }) =>
    splitContextText(text).map((part, i) => ({ key: i === 0 ? key : `${key}-${String(i + 1).padStart(2, '0')}`, text: part })));
}

/** The `additionalContext` a `--format codex` hook printed, or '' (nothing, or not that shape). */
export function hookContext(stdout: string | null): string {
  const text = (stdout ?? '').trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as { hookSpecificOutput?: { additionalContext?: unknown } };
    const ctx = parsed?.hookSpecificOutput?.additionalContext;
    return typeof ctx === 'string' ? ctx : '';
  } catch {
    return '';
  }
}

/** The reason a Stop hook blocked the turn with (`{"decision":"block","reason":…}`), or null. */
export function stopBlockReason(stdout: string | null): string | null {
  for (const line of (stdout ?? '').trim().split('\n').reverse()) {
    try {
      const o = JSON.parse(line) as { decision?: unknown; reason?: unknown };
      if (o?.decision === 'block' && typeof o.reason === 'string' && o.reason.trim()) return o.reason;
    } catch { /* not that line */ }
  }
  return null;
}

/** The real runner: `<node> <cli> hook <name> --format codex`, JSON on stdin, no shell. */
export function cliHookRunner(node: string, cli: string): HookRunner {
  return (name, input, o) => new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string | null): void => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(node, [cli, 'hook', name, '--format', 'codex'], { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, o.timeoutMs);
    child.stdout.on('data', (c: Buffer) => { if (out.length < 400_000) out += c.toString('utf-8'); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 || out ? out : null); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * A hook here always runs in the project root, but the agent moves: its own `dreamcontext` commands
 * in a linked repo or a worktree fail with "_dream_context/ not found". Rides at the snapshot's head.
 */
export const brainPathLine = (root: string): string =>
  `This project's brain is at ${root}. From a folder with no brain (a linked repo, a worktree), run dreamcontext commands from there: \`cd ${root} && dreamcontext …\`.`;

const OUR_TAG = /<(\s*\/?\s*)(dreamcontext-)/gi;

/**
 * Past this the context leads the message. Measured on agent 1.4.1: one message of about 170,000
 * tokens came back at 145,500 with its end gone, and the snapshot behind it with it, while the
 * same words under a smaller message were answered. The owner's own words stay as typed.
 */
export const CONTEXT_FIRST_CHARS = 50_000;

/**
 * Context for a tool with no context channel: tagged blocks in the user message, after the owner's
 * words (a leading `<tag>` would hide the whole message in a reopened pane). The owner's words are
 * theirs and stay as they are. A tag of ours inside recalled text is escaped, so a note or a peer's
 * page cannot close its block and go on as if it were outside it, or open a block of its own.
 */
export function contextInWords(entries: readonly AppContext[]): string {
  return entries.map((c) => `\n\n<${c.key}>\n${c.text.replace(OUR_TAG, '&lt;$1$2')}\n</${c.key}>`).join('');
}

/** The owner's words with their context, in the order this size of message survives. */
export function wordsWithContext(text: string, entries: readonly AppContext[]): string {
  const context = contextInWords(entries);
  if (!context) return text;
  return text.length > CONTEXT_FIRST_CHARS ? `${context.trimStart()}\n\n${text}` : text + context;
}

/** The folder holding this project's brain, or null: a project without one owes no snapshot. */
function brainRoot(cwd: string): string | null {
  try {
    const root = resolveContextRoot(cwd);
    return root ? dirname(root) : null;
  } catch {
    return null;
  }
}

export interface BrainContextOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly run?: HookRunner;
  /** The CLI entry and node the real runner uses (default: this process's). */
  readonly cli?: string;
  readonly node?: string;
}

export class BrainContext {
  private readonly run: HookRunner | null;
  private readonly env: NodeJS.ProcessEnv;
  private brain = '';
  private stops: Promise<unknown> = Promise.resolve();
  private readonly said = new Set<'snapshot' | 'prompt'>();
  private owedNotice: string | null = null;
  /** What the edit checks (PostToolUse: format, type errors) said since the last owner turn. */
  private checks: string[] = [];
  /** How many of {@link checks} an earlier turn's end already weighed. */
  private checksSeen = 0;
  private edits: Promise<unknown> = Promise.resolve();
  /** The next Stop is the continuation of a block: it must not block again (Claude's `stop_hook_active`). */
  private continuing = false;
  /** Set by the bridge: the Stop hook asked the turn to go on (type errors), with its reason. */
  onStopBlock: ((reason: string) => void) | null = null;

  constructor(private readonly o: BrainContextOptions) {
    this.env = hookEnv(o.env);
    const cli = o.cli ?? (o.env.DREAMCONTEXT_CLI || process.argv[1] || '');
    this.run = o.run ?? (cli ? cliHookRunner(o.node ?? process.execPath, cli) : null);
  }

  /** Each loss reaches the owner once in a chat's life, however many turns it repeats. */
  private tell(what: 'snapshot' | 'prompt', text: string): void {
    if (this.said.has(what)) return;
    this.said.add(what);
    this.owedNotice = this.owedNotice ? `${this.owedNotice}\n\n${text}` : text;
  }

  /** What the owner must hear about lost context, once: the bridge prints it before the turn. */
  takeNotice(): string | null {
    const notice = this.owedNotice;
    this.owedNotice = null;
    return notice;
  }

  /** The snapshot the next turns carry. */
  get snapshot(): string { return this.brain; }

  /**
   * A thread opened (`startup`), was reopened (`resume`) or replaced by an Eco rotation (`clear`):
   * read the snapshot again. An empty answer keeps the previous one (a slow disk must not leave the
   * chat brainless); an Eco handoff banner the hook prints arrives inside it. A project with a brain
   * and no snapshot at all is a chat without its brain, and the owner hears so ({@link takeNotice}).
   */
  async session(source: 'startup' | 'resume' | 'clear' | 'compact', threadId: string): Promise<void> {
    if (!this.run) return;
    const out = await this.run('session-start', { hook_event_name: 'SessionStart', source, cwd: this.o.cwd, dc_tool: 'codex', ...(threadId ? { codex_thread_id: threadId } : {}) }, { cwd: this.o.cwd, env: this.env, timeoutMs: SESSION_HOOK_TIMEOUT_MS });
    const ctx = hookContext(out);
    const root = brainRoot(this.o.cwd);
    if (ctx) this.brain = root ? `${brainPathLine(root)}\n\n${ctx}` : ctx;
    else if (!this.brain && root) this.tell('snapshot', `This chat is running without the project's brain: the snapshot ${out === null ? 'did not finish' : 'came back empty'}. It is read again after /clear or in a new chat.`);
  }

  /** The app context one owner turn carries: the snapshot, plus what the prompt hook printed for it. */
  async prompt(text: string, threadId: string): Promise<AppContext[]> {
    const out: AppContext[] = [];
    if (this.brain) out.push({ key: 'dreamcontext-brain', text: this.brain });
    if (!this.run) return out;
    const printed = await this.run('user-prompt-submit', { hook_event_name: 'UserPromptSubmit', prompt: text, session_id: threadId, cwd: this.o.cwd }, { cwd: this.o.cwd, env: this.env, timeoutMs: PROMPT_HOOK_TIMEOUT_MS });
    if (printed === null) this.tell('prompt', 'Memory recall did not run for this message: the prompt hook did not finish. This note is not repeated if it happens again in this chat.');
    const ctx = hookContext(printed);
    if (ctx) out.push({ key: 'dreamcontext-prompt', text: ctx });
    const checks = this.takeChecks();
    if (checks) out.push({ key: 'dreamcontext-checks', text: checks });
    return out;
  }

  /** The edit checks owed to the next turn, once. */
  takeChecks(): string {
    const text = this.checks.join('\n\n');
    this.checks = [];
    this.checksSeen = 0;
    return text;
  }

  /**
   * The agent changed a file: the PostToolUse hook formats it and type-checks it, as it does after
   * Claude's Edit (TABLO row 11). In the background, one at a time; what it says rides the next
   * turn, and a type error still standing at the turn's end comes back through the Stop hook.
   */
  edited(threadId: string, filePath: string): void {
    if (!this.run || !threadId || !filePath) return;
    const input = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: filePath }, session_id: threadId, cwd: this.o.cwd };
    const run = this.run;
    this.edits = this.edits.then(async () => {
      const ctx = hookContext(await run('post-tool-use', input, { cwd: this.o.cwd, env: this.env, timeoutMs: STOP_HOOK_TIMEOUT_MS }));
      if (ctx && this.checks.length < 20) this.checks.push(ctx);
    }).catch(() => undefined);
  }

  /**
   * A turn ended: the Stop hook records the session for sleep, with the rollout as its transcript.
   * In the background, one at a time; {@link drain} waits for the last before the bridge exits.
   */
  turnEnded(threadId: string, rolloutPath: string | null, lastMessage: string): void {
    if (!this.run || !threadId) return;
    const input = {
      hook_event_name: 'Stop',
      session_id: threadId,
      ...(rolloutPath ? { transcript_path: rolloutPath } : {}),
      ...(lastMessage ? { last_assistant_message: lastMessage.slice(0, 4000) } : {}),
      cwd: this.o.cwd,
      stop_hook_active: this.continuing,
    };
    this.continuing = false;
    const run = this.run;
    // After this turn's edit checks: the Stop check reads what they recorded.
    const continuation = input.stop_hook_active;
    const seen = this.checksSeen;
    this.stops = this.stops.then(() => this.edits).then(async () => {
      const reason = stopBlockReason(await run('stop', input, { cwd: this.o.cwd, env: this.env, timeoutMs: STOP_HOOK_TIMEOUT_MS }));
      // Claude reads an edit check's errors in the turn that made them. Here they come after it:
      // a check that found an error sends the turn on with it, once (a continuation does not).
      // Only what this turn's own edits said: an older note already had its turn.
      const fresh = this.checks.slice(seen);
      const errors = this.onStopBlock && !continuation && fresh.some((c) => /\berror\b/i.test(c)) ? fresh.join('\n\n') : '';
      if (errors) this.checks.splice(seen);
      this.checksSeen = this.checks.length;
      const why = [errors ? `The edit checks found problems in what you changed:\n${errors}` : '', reason ?? ''].filter(Boolean).join('\n\n');
      if (why && this.onStopBlock) {
        this.continuing = true;
        this.onStopBlock(why);
      }
    }).catch(() => undefined);
  }

  /**
   * The tool is compacting (Codex says so as it starts; Antigravity only shows it after): the
   * PreCompact hook records it and digests the transcript now, so recall can bring back what the
   * compaction drops (TABLO row 28). In the background, with the session records.
   */
  compacting(threadId: string, transcriptPath: string | null, trigger: 'auto' | 'manual' = 'auto'): void {
    if (!this.run || !threadId) return;
    const input = { hook_event_name: 'PreCompact', session_id: threadId, trigger, cwd: this.o.cwd, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) };
    const run = this.run;
    this.stops = this.stops.then(() => run('pre-compact', input, { cwd: this.o.cwd, env: this.env, timeoutMs: STOP_HOOK_TIMEOUT_MS })).catch(() => undefined);
  }

  /** Wait (bounded) for the last turn's session record. */
  async drain(ms = 10_000): Promise<void> {
    await Promise.race([this.stops, new Promise((r) => setTimeout(r, ms).unref?.())]);
  }
}
