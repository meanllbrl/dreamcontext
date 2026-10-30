/**
 * Drives a real BridgeSession against one of T3's recorded Codex app-server transcripts
 * (src/vendor/t3/.../testkit/fixtures/<scenario>/codex_transcript.ndjson), in process: T3's own
 * `layerReplay` plays the Codex side, so every frame the bridge prints came from T3's adapter.
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as CodexClient from 'effect-codex-app-server/client';
import * as CodexReplay from 'effect-codex-app-server/replay';
import { decodeProviderReplayNdjson, materializeReplayTranscriptWorkspace } from '@t3tools/provider-testing/replayTranscript';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { BridgeSession, type ClientFactory } from '../../../src/lib/t3-bridge/session.js';
import type { CodexRuntimePolicy } from '../../../src/lib/t3-bridge/policy.js';
import type { WireFrame } from '../../../src/lib/t3-bridge/to-wire.js';

const FIXTURES = join(__dirname, '../../../src/vendor/t3/apps/server/src/orchestration-v2/testkit/fixtures');

export interface Fixture {
  transcript: CodexReplay.CodexAppServerReplayTranscript;
  model: string;
  prompt: string;
  turnStart: Record<string, unknown>;
  workspace: string;
}

export function loadFixture(scenario: string): Fixture {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), `dc-t3-${scenario}-`)));
  const text = readFileSync(join(FIXTURES, scenario, 'codex_transcript.ndjson'), 'utf-8');
  const decoded = Effect.runSync(decodeProviderReplayNdjson(text));
  const transcript = materializeReplayTranscriptWorkspace(decoded, workspace) as unknown as CodexReplay.CodexAppServerReplayTranscript;
  const start = transcript.entries.find((e) => e.type === 'expect_outbound' && (e.frame as { method?: string }).method === 'turn/start');
  const params = ((start as { frame: { params: Record<string, unknown> } }).frame.params);
  const prompt = (params.input as Array<{ text: string }>)[0]!.text;
  return { transcript, model: String(params.model), prompt, turnStart: params, workspace };
}

/** The policy that makes our turn/start equal the recorded one. */
export function policyFor(f: Fixture): CodexRuntimePolicy {
  const p = f.turnStart;
  const collab = p.collaborationMode as { mode?: string } | undefined;
  const sandbox = p.sandboxPolicy as { type?: string } | undefined;
  return {
    runtimeMode: sandbox?.type === 'dangerFullAccess' ? 'full-access' : 'auto-accept-edits',
    interactionMode: collab?.mode === 'plan' ? 'plan' : 'default',
    cwd: f.workspace,
    approvalPolicy: p.approvalPolicy,
    sandboxPolicy: p.sandboxPolicy,
  };
}

export function replayFactory(transcript: CodexReplay.CodexAppServerReplayTranscript): ClientFactory {
  return {
    open: () =>
      Effect.gen(function* () {
        const ctx = yield* Layer.build(CodexReplay.layerReplay(transcript));
        return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(ctx));
      }) as never,
  };
}

export async function openReplaySession(scenario: string, extra: { mode?: string; paneId?: string } = {}) {
  const fixture = loadFixture(scenario);
  const frames: WireFrame[] = [];
  const stateRoot = mkdtempSync(join(tmpdir(), 'dc-t3-state-'));
  const session = await BridgeSession.open({
    tool: 'codex',
    cwd: fixture.workspace,
    model: fixture.model,
    mode: extra.mode ?? 'bypassPermissions',
    paneId: extra.paneId ?? `pane-${scenario}`,
    env: {},
    stateRoot,
    runtimePolicyOverride: policyFor(fixture),
    clientFactory: replayFactory(fixture.transcript),
    emit: (f) => frames.push(f),
  });
  return { session, frames, fixture, stateRoot };
}

export async function waitFor(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const isResult = (f: WireFrame) => f.type === 'result';
