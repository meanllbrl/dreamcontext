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
 * Running the hooks, not a copy of their logic, is what keeps Claude's output byte-identical: the
 * Claude path never changes, and the Codex path prints the very same text.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { resolveContextRoot } from '../context-path.js';
import type { AppContext } from './stdio.js';

export type HookName = 'session-start' | 'user-prompt-submit' | 'stop';

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
    return out;
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
      stop_hook_active: false,
    };
    const run = this.run;
    this.stops = this.stops.then(() => run('stop', input, { cwd: this.o.cwd, env: this.env, timeoutMs: STOP_HOOK_TIMEOUT_MS })).catch(() => undefined);
  }

  /** Wait (bounded) for the last turn's session record. */
  async drain(ms = 10_000): Promise<void> {
    await Promise.race([this.stops, new Promise((r) => setTimeout(r, ms).unref?.())]);
  }
}
