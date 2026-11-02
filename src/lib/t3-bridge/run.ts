/**
 * A headless run on Codex or Antigravity (plan r5 §6, W4 Lane B; night lane 2): one thread, one
 * turn, and one JSON document on stdout in the shape `claude -p --output-format json` prints, so
 * the automation runner's parser, cost record and limit switch read it unchanged.
 *
 * It drives the same `runBridgeStdio` a chat pane uses, over an in-memory pipe: same adapter, same
 * policy, same brain. `dreamcontext t3-run`; the server and the runner never load this file.
 *
 * Who answers an approval (headless-envelope.ts):
 *  - Codex: nobody, on a writing surface: every approval is declined; the sandbox is the reach. A
 *    read-only surface allows a plain read command (Codex reads through its shell), nothing else.
 *  - Antigravity `write`: the bridge, once the write gate proved it ran (`unattended`), exactly as
 *    for a Super child. What it leaves to the owner is refused, since there is no owner.
 *  - Antigravity `read`: this file. No edit, and a command only when it is a plain read.
 */
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { estimateGptCostUsd } from '../model-facts.js';
import { BrainContext } from './context.js';
import { findCodexRollout } from './codex-threads.js';
import { NO_ENV_GATE, codexEnvGateReady } from './env-gate.js';
import { HEADLESS_ENVELOPES, envelopeMode, envelopeRefusal, isPlainReadCommand, type HeadlessSurface, type HeadlessTool } from './headless-envelope.js';
import { writeAntigravityTranscript } from '../antigravity-conversation.js';
import { codexCachedModels, codexDefaultModel } from './registry.js';
import { runBridgeStdio, type StdioDeps } from './stdio.js';
import type { WireFrame } from './to-wire.js';

export interface T3RunOptions {
  cwd: string;
  prompt: string;
  surface: HeadlessSurface;
  /** Absent = Codex. */
  tool?: HeadlessTool;
  model?: string;
  effort?: string;
  account?: string;
  resume?: string;
  extraRoot?: string[];
}

const DECLINED = 'This run has nobody to approve that. Finish without it, and say what you could not do.';
const READ_ONLY = 'Refused: this run is read-only. Edits are refused. A command runs only when every program in it reads (cat, head, ls, grep, find, sed -n, printf, git log/diff/show/status, dreamcontext memory recall / tasks list), alone or chained with &&, |, ;, and with no redirect, $ or backtick. Retry with reads only.';

/** What a read-only Antigravity run allows: reads, searches and plain read commands. Nothing that writes. */
export function readOnlyAllows(toolName: string, input: unknown): boolean {
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS') return true;
  if (toolName !== 'Bash') return false;
  const command = (input && typeof input === 'object' ? (input as { command?: unknown }).command : null);
  return typeof command === 'string' && isPlainReadCommand(command);
}

/** `write` and the fakes stand in for stdout and Codex in tests. */
export interface RunDeps extends Partial<Pick<StdioDeps, 'clientFactory' | 'runtimePolicyOverride' | 'home' | 'listMcp'>> {
  readonly write?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly brain?: StdioDeps['brain'] | null;
  /** Tests stand in for the `.env` gate check. */
  readonly envGate?: boolean;
  /** Tests stand in for the Antigravity transcript Stop reads. */
  readonly transcriptOf?: (thread: string) => string | null;
}

/**
 * Antigravity answers an account out of quota with a normal reply, not an error (measured on agent
 * 1.4.1, 2026-11-02: "Usage Limit Reached … Your limit will reset in 6 days, 18 hours."). A run
 * must not read that as work done: it is a limit, with the reset when the text names one.
 */
export function antigravityQuotaReply(text: unknown, now: number = Date.now()): { resetsAtMs: number | null } | null {
  if (typeof text !== 'string' || text.length > 600) return null;
  if (!/^\s*usage limit reached\b/i.test(text) && !/\breached your current quota for this period\b/i.test(text)) return null;
  const m = text.match(/reset in ((?:\d+\s*(?:days?|hours?|minutes?)[,\s]*(?:and\s+)?)+)/i);
  if (!m) return { resetsAtMs: null };
  const unit = { day: 86_400_000, hour: 3_600_000, minute: 60_000 } as const;
  let ms = 0;
  for (const [, n, u] of m[1]!.matchAll(/(\d+)\s*(day|hour|minute)s?/gi)) ms += Number(n) * unit[u!.toLowerCase() as keyof typeof unit];
  return { resetsAtMs: ms > 0 ? now + ms : null };
}

/** How long the document's run may take to close once the turn is over. */
const CLOSE_LIMIT_MS = 10_000;

export async function runT3Headless(o: T3RunOptions, deps: RunDeps = {}): Promise<number> {
  const tool: HeadlessTool = o.tool === 'antigravity' ? 'antigravity' : 'codex';
  const label = tool === 'antigravity' ? 'Antigravity' : 'Codex';
  const mode = envelopeMode(o.surface, tool);
  const print = deps.write ?? ((line: string) => { process.stdout.write(line); });
  const say = (doc: Record<string, unknown>, code: number): number => { print(JSON.stringify(doc) + '\n'); return code; };
  const fail = (result: string): Record<string, unknown> => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result, session_id: null, total_cost_usd: 0, num_turns: 0, duration_ms: 0, permission_denials: [], dc_tool: tool });
  if (!mode) return say(fail(`${o.surface} runs on Claude only. ${envelopeRefusal(o.surface, tool)}`.trim()), 1);
  const envelope = HEADLESS_ENVELOPES[o.surface];
  // Antigravity's own gate (its PreToolUse hook) is laid out by the bridge as the session opens and
  // proved per request (session.ts); Codex's is the project's trusted hooks.json, checked here.
  if (tool === 'codex' && !(deps.envGate ?? codexEnvGateReady(o.cwd, deps.home, undefined, o.account))) return say(fail(NO_ENV_GATE), 1);
  // A read-only surface reads on both tools: Codex reads through its shell, so a declined command
  // would leave it blind. A plain read is allowed. The bridge cannot tell Codex's first ask from its
  // ask to retry outside the sandbox (the frame carries the command only), so the gate is what
  // holds: a command it allows only reads, and a read outside the read-only sandbox is the same
  // read (that sandbox already reads the whole disk). Nothing that writes or reaches the network
  // passes isPlainReadCommand, sandboxed or not.
  const readOnly = (tool === 'antigravity' && mode === 'read') || (tool === 'codex' && mode === 'default');

  const env = deps.env ?? process.env;
  // Antigravity: '' = the account's own default model.
  const model = tool === 'antigravity' ? (o.model ?? '') : o.model || codexDefaultModel() || codexCachedModels()[0]?.id || 'gpt-5.5';
  const started = Date.now();
  const input = new PassThrough();
  const denials: unknown[] = [];
  let result = null as WireFrame | null;
  let bridgeError = '';
  let thread = '';
  /** Replies the model wrote: a run with more than one did work a resume can continue. */
  let replies = 0;
  let printed = false;
  /** The document goes out the moment the turn ends: a slow close must not cost the result. */
  const finish = (r: WireFrame): void => {
    printed = true;
    const quota = tool === 'antigravity' && !r.dc_limit ? antigravityQuotaReply(r.result) : null;
    if (quota) r = { ...r, subtype: 'error_during_execution', is_error: true, dc_limit: quota.resetsAtMs ? { resetsAtMs: quota.resetsAtMs } : {} };
    const usage = r.dc_turn_usage as { input?: number; cached?: number; output?: number } | undefined;
    say({
      type: 'result',
      subtype: r.subtype,
      is_error: r.is_error === true,
      result: r.result,
      session_id: r.session_id ?? thread,
      // An estimate at list prices: a ChatGPT login pays by its plan, not by the token.
      total_cost_usd: usage && tool === 'codex' ? estimateGptCostUsd(model, usage) : null,
      num_turns: Math.max(1, replies),
      duration_ms: Date.now() - started,
      permission_denials: denials,
      dc_tool: tool,
      ...(usage ? { usage: { input_tokens: usage.input ?? 0, cache_read_input_tokens: usage.cached ?? 0, output_tokens: usage.output ?? 0 } } : {}),
      ...(r.dc_limit ? { dc_limit: r.dc_limit } : {}),
    }, 0);
  };
  let closed: () => void = () => undefined;
  const closeLimit = new Promise<number>((resolve) => { closed = () => { setTimeout(() => resolve(result?.is_error === true ? 1 : 0), CLOSE_LIMIT_MS).unref(); }; });
  const onFrame = (line: string): void => {
    let frame: WireFrame;
    try { frame = JSON.parse(line) as WireFrame; } catch { return; }
    if (typeof frame.session_id === 'string' && frame.session_id) thread = frame.session_id;
    if (frame.type === 'control_request') {
      const req = frame.request as { subtype?: unknown; tool_name?: unknown; input?: unknown } | undefined;
      if (req?.subtype !== 'can_use_tool') return;
      const name = typeof req.tool_name === 'string' ? req.tool_name : '';
      const allow = readOnly && readOnlyAllows(name, req.input);
      if (!allow) denials.push({ tool_name: name, tool_input: req.input ?? {} });
      const response = allow ? { behavior: 'allow' } : { behavior: 'deny', message: readOnly ? READ_ONLY : DECLINED };
      input.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } }) + '\n');
      return;
    }
    if (frame.type === 'system' && frame.subtype === 'bridge_error' && typeof frame.message === 'string') bridgeError = frame.message;
    if (frame.type === 'assistant') replies += 1;
    if (frame.type === 'result' && !frame.dc_synthetic && !result) {
      result = tool === 'antigravity' && antigravityQuotaReply(frame.result) ? { ...frame, is_error: true } : frame;
      finish(frame); closed(); input.end();
    }
  };

  input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: o.prompt }] } }) + '\n');
  const brain = deps.brain !== undefined ? deps.brain : envelope.brain ? new BrainContext({ cwd: o.cwd, env }) : null;
  const transcriptOf = deps.transcriptOf ?? ((thread: string) => tool === 'antigravity'
    ? writeAntigravityTranscript(thread, o.account || 'primary', deps.home ? { home: deps.home } : {})
    : findCodexRollout(thread, deps.home ? join(deps.home, '.codex') : undefined));
  const code = await Promise.race([closeLimit, runBridgeStdio(
    {
      tool,
      cwd: o.cwd,
      model,
      ...(o.effort ? { effort: o.effort } : {}),
      // Antigravity always asks; `write` is answered by the gate-proved bridge, `read` here.
      mode: tool === 'antigravity' ? 'default' : mode,
      paneId: '',
      ...(o.resume ? { resume: o.resume } : {}),
      extraRoots: o.extraRoot ?? [],
      ...(o.account ? { account: o.account } : {}),
      ...(envelope.strict ? { strictMcp: true } : {}),
      ...(tool === 'antigravity' && mode === 'write' ? { unattended: true } : {}),
    },
    {
      input,
      write: onFrame,
      env,
      handleSignals: true,
      ...(deps.home ? { home: deps.home } : {}),
      ...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}),
      ...(deps.listMcp ? { listMcp: deps.listMcp } : {}),
      ...(deps.runtimePolicyOverride ? { runtimePolicyOverride: deps.runtimePolicyOverride } : {}),
      ...(brain ? { brain } : {}),
      onResult: (session, frame) => {
        (brain as BrainContext | null)?.turnEnded?.(session.nativeThreadId, transcriptOf(session.nativeThreadId), typeof frame.result === 'string' ? frame.result : '');
      },
    },
  )]);
  const r = result;
  if (!r || !printed) return say({ ...fail(bridgeError || `${label} ended before the turn did.`), session_id: thread || null, duration_ms: Date.now() - started }, code || 1);
  return r.is_error === true ? 1 : 0;
}
