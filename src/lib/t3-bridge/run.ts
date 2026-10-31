/**
 * A headless Codex run (plan r5 §6, W4 Lane B): one thread, one turn, every approval declined,
 * and one JSON document on stdout in the shape `claude -p --output-format json` prints, so the
 * automation runner's parser, cost record and limit switch read it unchanged.
 *
 * It drives the same `runBridgeStdio` a chat pane uses, over an in-memory pipe: same adapter, same
 * policy, same brain. `dreamcontext t3-run`; the server and the runner never load this file.
 */
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { estimateGptCostUsd } from '../model-facts.js';
import { BrainContext } from './context.js';
import { findCodexRollout } from './codex-threads.js';
import { NO_ENV_GATE, codexEnvGateReady } from './env-gate.js';
import { HEADLESS_ENVELOPES, type HeadlessSurface } from './headless-envelope.js';
import { codexCachedModels, codexDefaultModel } from './registry.js';
import { runBridgeStdio, type StdioDeps } from './stdio.js';
import type { WireFrame } from './to-wire.js';

export interface T3RunOptions {
  cwd: string;
  prompt: string;
  surface: HeadlessSurface;
  model?: string;
  effort?: string;
  account?: string;
  resume?: string;
  extraRoot?: string[];
}

const DECLINED = 'This run has nobody to approve that. Finish without it, and say what you could not do.';

/** `write` and the fakes stand in for stdout and Codex in tests. */
export interface RunDeps extends Partial<Pick<StdioDeps, 'clientFactory' | 'runtimePolicyOverride' | 'home' | 'listMcp'>> {
  readonly write?: (line: string) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly brain?: StdioDeps['brain'] | null;
  /** Tests stand in for the `.env` gate check. */
  readonly envGate?: boolean;
}

/** How long the document's run may take to close once the turn is over. */
const CLOSE_LIMIT_MS = 10_000;

export async function runT3Headless(o: T3RunOptions, deps: RunDeps = {}): Promise<number> {
  const envelope = HEADLESS_ENVELOPES[o.surface];
  const print = deps.write ?? ((line: string) => { process.stdout.write(line); });
  const say = (doc: Record<string, unknown>, code: number): number => { print(JSON.stringify(doc) + '\n'); return code; };
  const fail = (result: string): Record<string, unknown> => ({ type: 'result', subtype: 'error_during_execution', is_error: true, result, session_id: null, total_cost_usd: 0, num_turns: 0, duration_ms: 0, permission_denials: [], dc_tool: 'codex' });
  if (!envelope?.codex) return say(fail(`${o.surface} runs on Claude only. ${envelope?.why ?? ''}`.trim()), 1);

  if (!(deps.envGate ?? codexEnvGateReady(o.cwd, deps.home))) return say(fail(NO_ENV_GATE), 1);

  const env = deps.env ?? process.env;
  const model = o.model || codexDefaultModel() || codexCachedModels()[0]?.id || 'gpt-5.5';
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
    const usage = r.dc_turn_usage as { input?: number; cached?: number; output?: number } | undefined;
    say({
      type: 'result',
      subtype: r.subtype,
      is_error: r.is_error === true,
      result: r.result,
      session_id: r.session_id ?? thread,
      // An estimate at list prices: a ChatGPT login pays by its plan, not by the token.
      total_cost_usd: usage ? estimateGptCostUsd(model, usage) : null,
      num_turns: Math.max(1, replies),
      duration_ms: Date.now() - started,
      permission_denials: denials,
      dc_tool: 'codex',
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
      const req = frame.request as { subtype?: unknown; tool_name?: unknown } | undefined;
      if (req?.subtype !== 'can_use_tool') return;
      denials.push({ tool_name: req.tool_name ?? '' });
      input.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: DECLINED } } }) + '\n');
      return;
    }
    if (frame.type === 'system' && frame.subtype === 'bridge_error' && typeof frame.message === 'string') bridgeError = frame.message;
    if (frame.type === 'assistant') replies += 1;
    if (frame.type === 'result' && !frame.dc_synthetic && !result) { result = frame; finish(frame); closed(); input.end(); }
  };

  input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: o.prompt }] } }) + '\n');
  const brain = deps.brain !== undefined ? deps.brain : envelope.brain ? new BrainContext({ cwd: o.cwd, env }) : null;
  const code = await Promise.race([closeLimit, runBridgeStdio(
    {
      tool: 'codex',
      cwd: o.cwd,
      model,
      ...(o.effort ? { effort: o.effort } : {}),
      mode: envelope.codex,
      paneId: '',
      ...(o.resume ? { resume: o.resume } : {}),
      extraRoots: o.extraRoot ?? [],
      ...(o.account ? { account: o.account } : {}),
      ...(envelope.strict ? { strictMcp: true } : {}),
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
        (brain as BrainContext | null)?.turnEnded?.(session.nativeThreadId, findCodexRollout(session.nativeThreadId, deps.home ? join(deps.home, '.codex') : undefined), typeof frame.result === 'string' ? frame.result : '');
      },
    },
  )]);
  const r = result;
  if (!r || !printed) return say({ ...fail(bridgeError || 'Codex ended before the turn did.'), session_id: thread || null, duration_ms: Date.now() - started }, code || 1);
  return r.is_error === true ? 1 : 0;
}
