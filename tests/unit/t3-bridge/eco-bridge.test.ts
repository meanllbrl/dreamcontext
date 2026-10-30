/**
 * Eco joins on a bridge tool (plan r5 §4d, W1 criterion 9), end to end on T3's replayed Codex:
 *
 *   a handoff record written BY THE TEST + the server's two rotation turns (`/clear`, the
 *   continue prompt) → the bridge opens a fresh native thread on the same instance, consumes the
 *   record (`consumedAt`), hands its banner to the next turn as untrusted app context, and the
 *   frames it prints carry the handoff progress run to `done` and release a Super pane's latch,
 *   counted exactly as agent-chat.ts counts them.
 *
 * And the measurement: Codex's `usedTokens` drives the same `maybeNudge` ladder Claude's hook does.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeProviderReplayNdjson, materializeReplayTranscriptWorkspace } from '@t3tools/provider-testing/replayTranscript';
import * as Effect from 'effect/Effect';
import { resolveAgentSession } from '../../../src/lib/agent-session-map.js';
import {
  maybeNudge, readHandoffRecord, renderHandoffBanner, writeHandoffRecord, type HandoffRecord,
} from '../../../src/lib/context-watch.js';
import { advanceHandoffRun, startHandoffRun, type HandoffRun } from '../../../src/lib/handoff-progress.js';
import { isRotating, startRotating, stopRotating } from '../../../src/lib/super/fresh-session.js';
import { rotationFinished } from '../../../src/server/routes/handoff-rotation.js';
import { ecoJoins } from '../../../src/lib/t3-bridge/eco.js';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';
import { replayFactory } from './replay-harness.js';

const FIXTURE = join(__dirname, '../../../src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures/simple/codex_transcript.ndjson');
const PANE = '5b2c7d1e-9a8f-4e3d-b2c1-a0f9e8d7c6b5';
const OLD_THREAD = '01a0d5eb-0000-7000-8000-00000000a01d';

let project = '';
let home = '';
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'dc-eco-bridge-'));
  home = mkdtempSync(join(tmpdir(), 'dc-eco-home-'));
  mkdirSync(join(project, '_dream_context', 'state'), { recursive: true });
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  stopRotating(PANE);
});

/**
 * T3's recorded `simple` session, reshaped for one rotation: the first thread/start answers with
 * OLD_THREAD, a second (forced-new) thread/start answers with the recorded thread, and the turn
 * on it carries the handoff banner as untrusted additional context.
 */
function rotationTranscript(workspace: string, banner: string) {
  const decoded = Effect.runSync(decodeProviderReplayNdjson(readFileSync(FIXTURE, 'utf-8')));
  const t = materializeReplayTranscriptWorkspace(decoded, workspace) as unknown as { entries: Array<{ type: string; label?: string; frame?: Record<string, unknown> }> };
  const e = t.entries;
  const start = e.findIndex((x) => x.type === 'expect_outbound' && x.label === 'thread/start');
  const startReply = e.findIndex((x, i) => i > start && x.type === 'emit_inbound' && x.label === 'thread/start');
  const turnStart = e.findIndex((x) => x.type === 'expect_outbound' && x.label === 'turn/start');
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const reply = e[startReply]!;
  const recordedThread = ((reply.frame!.result as { thread: { id: string } }).thread.id);
  const firstReply = clone(reply);
  (firstReply.frame!.result as { thread: { id: string } }).thread.id = OLD_THREAD;
  const second = clone(e[start]!); second.frame!.id = 3;
  const secondReply = clone(reply); secondReply.frame!.id = 3;
  const turn = clone(e[turnStart]!);
  turn.frame!.id = 4;
  (turn.frame!.params as Record<string, unknown>).additionalContext = { 'dreamcontext-handoff': { kind: 'untrusted', value: banner } };
  const rest = e.slice(turnStart + 1).map((x) => (x.type === 'emit_inbound' && x.label === 'turn/start' ? { ...clone(x), frame: { ...clone(x.frame!), id: 4 } } : x));
  return {
    transcript: { ...t, entries: [...e.slice(0, startReply), firstReply, second, ...e.slice(startReply + 1, turnStart).filter((x) => x.type !== 'expect_outbound'), secondReply, turn, ...rest] },
    recordedThread,
    prompt: ((e[turnStart]!.frame!.params as { input: Array<{ text: string }> }).input[0]!.text),
    turnStartParams: e[turnStart]!.frame!.params as Record<string, unknown>,
  };
}

describe('Eco on a bridge pane', () => {
  it('rotates into a fresh thread, consumes the record, delivers the banner, and the run reaches done', async () => {
    const contextRoot = join(project, '_dream_context');
    const record: HandoffRecord = {
      task: 'acme-checkout', title: 'Checkout redesign', at: new Date().toISOString(),
      contextTokens: 190_000, fromSession: OLD_THREAD, tab: PANE, actedAt: new Date().toISOString(),
    };
    writeHandoffRecord(contextRoot, PANE, record);
    const banner = renderHandoffBanner(readHandoffRecord(contextRoot, PANE)!);
    const { transcript, recordedThread, prompt, turnStartParams } = rotationTranscript(project, banner);

    const env = { DREAMCONTEXT_TAB_SESSION: PANE };
    const eco = ecoJoins(project, env);
    const input = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const done = runBridgeStdio(
      { tool: 'codex', cwd: project, model: String(turnStartParams.model), mode: 'bypassPermissions', paneId: PANE },
      {
        input,
        write: (line) => { buf += line; let n; while ((n = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } },
        env,
        home,
        clientFactory: replayFactory(transcript as never),
        runtimePolicyOverride: { runtimeMode: 'full-access', interactionMode: 'default', cwd: project, approvalPolicy: turnStartParams.approvalPolicy, sandboxPolicy: turnStartParams.sandboxPolicy },
        onReady: (id) => eco.onReady(id),
        onRotated: (id) => eco.onRotated(id),
        onResult: (session) => eco.onResult(session.nativeThreadId, session.wire.contextTokens),
      },
    );

    // The server's side of the rotation, counted as agent-chat.ts counts it.
    const wait = async (pred: () => boolean) => { const end = Date.now() + 15_000; while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
    await wait(() => out.some((f) => f.dc_ready));
    expect(out.find((f) => f.dc_ready)!.session_id).toBe(OLD_THREAD);
    expect(resolveAgentSession(contextRoot, PANE)).toBe(OLD_THREAD);
    let run: HandoffRun = startHandoffRun({ task: record.task, title: record.title, contextTokens: 190_000, fromSession: OLD_THREAD });
    startRotating(PANE);
    let turnsInFlight = 2; // `/clear` and the continue prompt: both user frames, both open turns
    const user = (text: string) => input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
    user('/clear');
    user(prompt);
    const seen = new Set<Record<string, unknown>>();
    const pump = () => {
      for (const f of out) {
        if (seen.has(f)) continue;
        seen.add(f);
        const stageBefore = run.stage;
        const turnsBefore = turnsInFlight;
        const next = advanceHandoffRun(run, f, turnsInFlight);
        if (next) run = next;
        if (f.type === 'result' && f.parent_tool_use_id === undefined) {
          turnsInFlight = Math.max(0, turnsInFlight - 1);
          if (isRotating(PANE) && rotationFinished(stageBefore, turnsBefore)) stopRotating(PANE);
        }
      }
    };
    await wait(() => { pump(); return out.filter((f) => f.type === 'result').length >= 2; });
    input.end();
    await done;
    pump();

    const rotated = out.find((f) => f.dc_rotated)!;
    expect(rotated.session_id).toBe(recordedThread);
    expect(rotated.session_id).not.toBe(OLD_THREAD);
    expect(run.stage).toBe('done');
    expect(turnsInFlight).toBe(0);
    expect(isRotating(PANE)).toBe(false);
    expect(readHandoffRecord(contextRoot, PANE)?.consumedAt).toBeTruthy();
    expect(resolveAgentSession(contextRoot, PANE)).toBe(recordedThread);
    expect(JSON.stringify(out)).toContain('fixture simple ok');
  });

  it('measures context from Codex usedTokens on the same nudge ladder', () => {
    const contextRoot = join(project, '_dream_context');
    writeFileSync(join(contextRoot, 'state', '.config.json'), JSON.stringify({ contextHandoff: { enabled: true, nudgeAt: 3000, remindEvery: 2000 } }));
    const env = { DREAMCONTEXT_TAB_SESSION: PANE };
    const thread = '01a0d5eb-1111-7000-8000-000000000001';
    expect(maybeNudge(contextRoot, { session_id: thread, context_tokens: 1_000 }, env)).toBeNull();
    const nudge = maybeNudge(contextRoot, { session_id: thread, context_tokens: 400_000 }, env);
    expect(nudge).toBeTruthy();
    expect(ecoJoins(project, env).onResult('01a0d5eb-2222-7000-8000-000000000002', 400_000)[0]?.key).toBe('dreamcontext-context');
  });
});
