/**
 * Track T W3: a Codex chat gets the brain the way a Claude chat does, through the SAME hooks
 * (`hook … --format codex`, run by the bridge child, context.ts):
 *   - the snapshot and the per-turn prompt hook ride `turn/start` as UNTRUSTED app context
 *     (proved on T3's own replay: the recorded `turn/start` is edited to expect exactly them, and
 *     the replay refuses any other frame);
 *   - neither is in developer instructions (those carry only the chat briefing) nor in any frame
 *     the chat draws;
 *   - an Eco `/clear` reads a fresh snapshot; a steer runs no hook.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';
import { BrainContext, hookContext, hookEnv, type HookRunner } from '../../../src/lib/t3-bridge/context.js';
import { codexBrainMcpArgs, codexLaunchArgs } from '../../../src/lib/t3-bridge/launch.js';
import { loadFixture, policyFor, replayFactory } from './replay-harness.js';

const SNAP = '# Agent Context — synthetic snapshot of acme-shop';
const RECALL = '— Memory recall — checkout has three steps';
const codexAnswer = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function fakeRunner(calls: Array<{ name: string; input: Record<string, unknown>; env: NodeJS.ProcessEnv }>): HookRunner {
  return async (name, input, o) => {
    calls.push({ name, input, env: o.env });
    if (name === 'session-start') return codexAnswer('SessionStart', `${SNAP} (${String(input.source)})`);
    if (name === 'user-prompt-submit') return codexAnswer('UserPromptSubmit', RECALL);
    return '';
  };
}

describe('BrainContext (the hooks, for a bridge tool)', () => {
  it('reads the snapshot at session start and hands every turn the snapshot plus the prompt hook', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
    const b = new BrainContext({ cwd: '/p', env: { DREAMCONTEXT_CHAT_TAB: '1', DREAMCONTEXT_CONTEXT_BY: 'bridge', DREAMCONTEXT_AGENT_STATUS_FILE: '/x', DREAMCONTEXT_TAB_SESSION: 'tab-1' }, run: fakeRunner(calls) });
    await b.session('startup', 'th-1');
    const ctx = await b.prompt('how does checkout work', 'th-1');
    expect(ctx).toEqual([{ key: 'dreamcontext-brain', text: `${SNAP} (startup)` }, { key: 'dreamcontext-prompt', text: RECALL }]);
    expect(calls.map((c) => c.name)).toEqual(['session-start', 'user-prompt-submit']);
    // The hook child never inherits the guard (it would silence itself), the tab-title switch (the
    // bridge names the tab) or the status file; the pane's tab id reaches it (Eco handoff key).
    for (const c of calls) {
      expect(c.env.DREAMCONTEXT_CONTEXT_BY).toBeUndefined();
      expect(c.env.DREAMCONTEXT_CHAT_TAB).toBeUndefined();
      expect(c.env.DREAMCONTEXT_AGENT_STATUS_FILE).toBeUndefined();
      expect(c.env.DREAMCONTEXT_TAB_SESSION).toBe('tab-1');
    }
    expect(calls[1]!.input).toMatchObject({ prompt: 'how does checkout work', session_id: 'th-1' });
  });

  it('a hook that answers nothing keeps the previous snapshot; a failed prompt hook still sends the snapshot', async () => {
    let n = 0;
    const b = new BrainContext({ cwd: '/p', env: {}, run: async (name) => (name === 'session-start' && n++ === 0 ? codexAnswer('SessionStart', SNAP) : '') });
    await b.session('startup', 't');
    await b.session('clear', 't');
    expect(b.snapshot).toBe(SNAP);
    expect(await b.prompt('x', 't')).toEqual([{ key: 'dreamcontext-brain', text: SNAP }]);
  });

  it('the turn end records the session for sleep with the rollout as its transcript', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
    const b = new BrainContext({ cwd: '/p', env: {}, run: fakeRunner(calls) });
    b.turnEnded('th-9', '/home/.codex/sessions/2026/10/31/rollout-x-th-9.jsonl', 'Decided: three steps.');
    await b.drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'stop', input: { session_id: 'th-9', transcript_path: '/home/.codex/sessions/2026/10/31/rollout-x-th-9.jsonl', last_assistant_message: 'Decided: three steps.' } });
  });

  it('reads only the Codex hook shape', () => {
    expect(hookContext(codexAnswer('SessionStart', 'abc'))).toBe('abc');
    expect(hookContext('plain text')).toBe('');
    expect(hookContext('')).toBe('');
    expect(hookEnv({ A: '1', DREAMCONTEXT_CONTEXT_BY: 'bridge' })).toEqual({ A: '1' });
  });
});

describe('memory never rides developer instructions', () => {
  it('the launch args carry the briefing and the brain MCP server, never brain content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-codex-ctx-'));
    const briefing = join(dir, 'brief.md');
    writeFileSync(briefing, '# Surface: dreamcontext Chat');
    const dev = codexLaunchArgs({ briefingFile: briefing });
    expect(dev).toContain('developer_instructions');
    expect(dev).toContain('Surface: dreamcontext Chat');
    expect(dev).not.toContain(SNAP);
    // No brain in the project → no MCP server.
    expect(codexBrainMcpArgs({ node: '/n', cli: '/c', root: dir })).toBe('');
  });
});

describe('a Codex turn carries the brain as untrusted app context (T3 replay)', () => {
  it('turn/start sends exactly the snapshot and the prompt hook as untrusted additionalContext, and no frame shows them', async () => {
    const f = loadFixture('tool_call_read_only_on_request');
    // The recorded turn/start, edited to expect our two entries. The replay refuses any other frame.
    const start = f.transcript.entries.find((e) => e.type === 'expect_outbound' && (e.frame as { method?: string }).method === 'turn/start') as { frame: { params: Record<string, unknown> } };
    start.frame.params.additionalContext = {
      'dreamcontext-brain': { kind: 'untrusted', value: `${SNAP} (startup)` },
      'dreamcontext-prompt': { kind: 'untrusted', value: RECALL },
    };
    const calls: Array<{ name: string; input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
    const brain = new BrainContext({ cwd: f.workspace, env: {}, run: fakeRunner(calls) });
    const input = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const done = runBridgeStdio(
      { tool: 'codex', cwd: f.workspace, model: f.model, mode: 'bypassPermissions', paneId: 'pane-codex-ctx' },
      {
        input, env: {}, home: mkdtempSync(join(tmpdir(), 'dc-codex-ctx-home-')), brain,
        clientFactory: replayFactory(f.transcript), runtimePolicyOverride: policyFor(f),
        write: (l) => { buf += l; let n; while ((n = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, n))); buf = buf.slice(n + 1); } },
      },
    );
    const wait = async (p: () => boolean) => { const e = Date.now() + 15_000; while (!p()) { if (Date.now() > e) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
    await wait(() => out.some((x) => x.dc_ready));
    input.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: f.prompt }] } }) + '\n');
    await wait(() => out.some((x) => x.type === 'control_request'));
    const ask = out.find((x) => x.type === 'control_request')!;
    input.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: {} } } }) + '\n');
    await wait(() => out.some((x) => x.type === 'result'));
    expect(out.find((x) => x.type === 'result')).toMatchObject({ is_error: false });
    // (The recorded transcript ends with Codex's exit, which the bridge reports after the turn.)
    // Never drawn: no frame the chat reads carries the snapshot or the recall.
    expect(JSON.stringify(out)).not.toContain(SNAP);
    expect(JSON.stringify(out)).not.toContain(RECALL);
    expect(calls.map((c) => c.name)).toEqual(['session-start', 'user-prompt-submit']);
    input.end();
    await done;
  }, 40_000);
});
