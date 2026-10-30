/**
 * The bridge child's stdio loop: `dreamcontext t3-chat` reads the stream-json frames our chat
 * server writes to a `claude` child and drives a BridgeSession; it prints Claude stream-json back.
 *
 * Input frames handled (exactly what agent-chat.ts writes to its child):
 *   - `user`                    → a turn, or a steer when one is running; `/clear` alone rotates
 *                                 into a fresh thread (Eco handoff, plan §4d)
 *   - `control_response`        → the owner's answer to an approval or question card
 *   - `control_request` interrupt / set_model / set_permission_mode → done, then acked
 *   - any other control_request → acked with an error (rewind, stop_task, MCP: not on this tool yet)
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeSession, type BridgeSessionOptions } from './session.js';
import { codexLaunchArgs, scrubbedCodexEnv } from './launch.js';
import type { WireFrame } from './to-wire.js';

export type AppContext = { key: string; text: string };

export interface StdioArgs {
  readonly tool: 'codex';
  readonly cwd: string;
  readonly model: string;
  readonly effort?: string;
  readonly mode: string;
  readonly paneId: string;
  readonly resume?: string;
  readonly briefingFile?: string;
  readonly extraRoots?: readonly string[];
  readonly binaryPath?: string;
}

export interface StdioDeps {
  readonly input: NodeJS.ReadableStream;
  readonly write: (line: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Tests: a replay client instead of `codex app-server`. */
  readonly clientFactory?: BridgeSessionOptions['clientFactory'];
  readonly runtimePolicyOverride?: BridgeSessionOptions['runtimePolicyOverride'];
  /** Called by `/clear` after the fresh thread opened (consumes the handoff record). What it
   *  returns rides the NEXT turn as untrusted app context (the handoff banner). */
  readonly onRotated?: (nativeThreadId: string) => AppContext[] | void;
  /** Called once the session holds its thread (records pane → thread for resume). */
  readonly onReady?: (nativeThreadId: string) => void;
  /** Called on every `result` (Eco measurement). What it returns rides the next turn. */
  readonly onResult?: (session: BridgeSession, frame: WireFrame) => AppContext[] | void;
}

const userText = (frame: Record<string, unknown>): string => {
  const msg = frame.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => b.text)
    .join('');
};

/** Run until stdin ends. Resolves with the exit code. */
export async function runBridgeStdio(args: StdioArgs, deps: StdioDeps): Promise<number> {
  const home = deps.home ?? homedir();
  // Opt-in frame trace for debugging a bridge pane (`DREAMCONTEXT_T3_DEBUG=<file>`): frame types
  // and subtypes only, never their text.
  const debugFile = deps.env.DREAMCONTEXT_T3_DEBUG;
  const trace = (dir: string, f: Record<string, unknown>): void => {
    if (!debugFile) return;
    const req = (f.request ?? f.response) as { subtype?: unknown; request_id?: unknown } | undefined;
    try { appendFileSync(debugFile, `${new Date().toISOString()} ${dir} ${String(f.type)}${f.subtype ? `/${String(f.subtype)}` : ''}${req?.subtype ? ` ${String(req.subtype)}` : ''}${req?.request_id ? ` ${String(req.request_id).slice(-12)}` : ''}\n`); } catch { /* best effort */ }
  };
  const emit = (frame: WireFrame): void => { trace('out', frame); deps.write(JSON.stringify(frame) + '\n'); };
  // A private temp folder for this process: Codex's only writable temp (plan §6).
  const privateTmp = mkdtempSync(join(tmpdir(), 'dc-codex-'));
  /** App context owed to the next turn (a handoff banner, an Eco nudge). */
  const pending: AppContext[] = [];
  const owe = (ctx: AppContext[] | void): void => { if (ctx) pending.push(...ctx); };
  let session: BridgeSession;
  try {
    session = await BridgeSession.open({
      tool: args.tool,
      cwd: args.cwd,
      model: args.model,
      ...(args.effort ? { effort: args.effort } : {}),
      mode: args.mode,
      paneId: args.paneId || randomUUID(),
      ...(args.resume ? { resumeNativeThreadId: args.resume } : {}),
      ...(args.binaryPath ? { binaryPath: args.binaryPath } : {}),
      launchArgs: codexLaunchArgs({ briefingFile: args.briefingFile }),
      env: { ...scrubbedCodexEnv(deps.env), TMPDIR: privateTmp },
      stateRoot: join(home, '.dreamcontext', 't3'),
      extraRoots: args.extraRoots ?? [],
      privateTmp,
      ...(deps.clientFactory ? { clientFactory: deps.clientFactory } : {}),
      ...(deps.runtimePolicyOverride ? { runtimePolicyOverride: deps.runtimePolicyOverride } : {}),
      emit: (frame) => {
        emit(frame);
        if (frame.type === 'result') owe(deps.onResult?.(session, frame));
      },
    });
  } catch (err) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `Codex did not start: ${String(err).slice(0, 400)}`, num_turns: 0, total_cost_usd: 0, usage: {}, dc_tool: args.tool });
    rmSync(privateTmp, { recursive: true, force: true });
    return 1;
  }
  // The thread id is known before any turn: announce it, so a reopened pane can be resumed.
  emit(session.wire.init({ dc_ready: true }));
  deps.onReady?.(session.nativeThreadId);

  const ack = (requestId: unknown, error?: string): void => {
    if (typeof requestId !== 'string') return;
    emit(error
      ? { type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }
      : { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
  };

  // One frame at a time: a steer must not race the turn it steers.
  let chain: Promise<void> = Promise.resolve();
  const handle = async (frame: Record<string, unknown>): Promise<void> => {
    trace('in ', frame);
    if (frame.type === 'user') {
      const text = userText(frame);
      if (!text) return;
      if (text.trim() === '/clear') {
        const id = await session.newThread();
        owe(deps.onRotated?.(id));
        return;
      }
      await session.send(text, session.busy ? [] : pending.splice(0));
      return;
    }
    if (frame.type === 'control_response') {
      const r = frame.response as { request_id?: unknown; response?: Record<string, unknown>; subtype?: string } | undefined;
      if (typeof r?.request_id !== 'string') return;
      const body = r.response ?? {};
      await session.answer(r.request_id, {
        behavior: r.subtype === 'error' ? 'deny' : String(body.behavior ?? 'deny'),
        updatedInput: body.updatedInput,
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
      });
      return;
    }
    if (frame.type === 'control_request') {
      const req = (frame.request ?? {}) as Record<string, unknown>;
      switch (req.subtype) {
        case 'interrupt':
          await session.interrupt();
          ack(frame.request_id);
          return;
        case 'set_model':
          if (typeof req.model === 'string' && req.model) session.setModel(req.model);
          ack(frame.request_id);
          return;
        case 'set_permission_mode':
          if (typeof req.mode === 'string') session.setMode(req.mode);
          ack(frame.request_id);
          return;
        default:
          ack(frame.request_id, `${String(req.subtype)} is not available on ${args.tool} yet`);
      }
    }
  };

  await new Promise<void>((resolve) => {
    let buf = '';
    deps.input.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: unknown;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        chain = chain.then(() => handle(obj as Record<string, unknown>)).catch((err) => {
          emit({ type: 'system', subtype: 'bridge_error', message: String(err).slice(0, 400), dc_tool: args.tool });
        });
      }
    });
    deps.input.on('end', () => resolve());
    deps.input.on('close', () => resolve());
  });
  await chain.catch(() => undefined);
  await session.close();
  rmSync(privateTmp, { recursive: true, force: true });
  return 0;
}
