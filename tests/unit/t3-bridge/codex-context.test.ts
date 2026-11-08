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
import { BrainContext, CODEX_ENTRY_MAX_BYTES, fitCodexContext, hookContext, hookEnv, splitContextText, type HookRunner } from '../../../src/lib/t3-bridge/context.js';
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

describe('a long entry reaches Codex whole (Codex cuts each entry at 4,000 bytes)', () => {
  const section = (i: number): string => `\n## Section ${i}\n\n${'- şarkı öğretmeni satırı 🦊\n'.repeat(40)}`;
  const doc = '# Snapshot' + [1, 2, 3, 4, 5, 6, 7].map(section).join('');

  it('no part passes the limit and the parts join back to the exact text', () => {
    for (const text of [doc, 'x'.repeat(20_000), '🦊'.repeat(5_000), 'ş'.repeat(9_001), `a\n${'b'.repeat(9_000)}`]) {
      const parts = splitContextText(text);
      expect(parts.length).toBeGreaterThan(1);
      for (const p of parts) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(CODEX_ENTRY_MAX_BYTES);
      expect(parts.join('')).toBe(text);
      expect(parts.every((p) => p.length > 0 && !p.includes('\uFFFD'))).toBe(true);
    }
  });

  it('cuts at a section when one fits, so a part opens with its heading', () => {
    for (const p of splitContextText(doc).slice(1)) expect(p.startsWith('\n## Section')).toBe(true);
  });

  it('counts bytes, not characters', () => {
    expect(splitContextText('ş'.repeat(2_000))).toHaveLength(2);
    expect(splitContextText('x'.repeat(CODEX_ENTRY_MAX_BYTES))).toHaveLength(1);
    expect(splitContextText('')).toEqual(['']);
  });

  it('an entry that fits is untouched; a long one keeps its key and gets padded siblings in Codex order', () => {
    expect(fitCodexContext([{ key: 'dreamcontext-brain', text: SNAP }])).toEqual([{ key: 'dreamcontext-brain', text: SNAP }]);
    const fitted = fitCodexContext([{ key: 'dreamcontext-brain', text: 'x'.repeat(40_000) }]);
    expect(fitted.length).toBeGreaterThanOrEqual(10);
    expect(fitted[0]!.key).toBe('dreamcontext-brain');
    expect(fitted[1]!.key).toBe('dreamcontext-brain-02');
    expect(fitted[9]!.key).toBe('dreamcontext-brain-10');
    const keys = fitted.map((e) => e.key);
    expect([...keys].sort()).toEqual(keys);
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
  const replay = async (additionalContext: Record<string, { kind: string; value: string }>, snapshot?: string) => {
    const f = loadFixture('tool_call_read_only_on_request');
    // The recorded turn/start, edited to expect our two entries. The replay refuses any other frame.
    const start = f.transcript.entries.find((e) => e.type === 'expect_outbound' && (e.frame as { method?: string }).method === 'turn/start') as { frame: { params: Record<string, unknown> } };
    start.frame.params.additionalContext = additionalContext;
    const calls: Array<{ name: string; input: Record<string, unknown>; env: NodeJS.ProcessEnv }> = [];
    const runner = fakeRunner(calls);
    const run: HookRunner = async (name, hookInput, o) => (snapshot && name === 'session-start' ? (await runner(name, hookInput, o), codexAnswer('SessionStart', snapshot)) : runner(name, hookInput, o));
    const brain = new BrainContext({ cwd: f.workspace, env: {}, run });
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
  };

  it('turn/start sends exactly the snapshot and the prompt hook as untrusted additionalContext, and no frame shows them', async () => {
    await replay({
      'dreamcontext-brain': { kind: 'untrusted', value: `${SNAP} (startup)` },
      'dreamcontext-prompt': { kind: 'untrusted', value: RECALL },
    });
  }, 40_000);

  it('a snapshot over the limit goes out in parts, every part untrusted, none in a frame the chat draws', async () => {
    const long = `${SNAP}\n## Rules\n${'- kural satırı\n'.repeat(130)}\n## Memory\n${'- anı satırı\n'.repeat(130)}`;
    const parts = splitContextText(long);
    expect(parts).toHaveLength(2);
    await replay({
      'dreamcontext-brain': { kind: 'untrusted', value: parts[0]! },
      'dreamcontext-brain-02': { kind: 'untrusted', value: parts[1]! },
      'dreamcontext-prompt': { kind: 'untrusted', value: RECALL },
    }, long);
  }, 40_000);
});

describe('what a Codex chat is told about itself', () => {
  it('says dreamcontext, not Claude and not T3', async () => {
    const { codexLaunchArgs } = await import('../../../src/lib/t3-bridge/launch.js');
    const dir = mkdtempSync(join(tmpdir(), 'dc-codex-id-'));
    writeFileSync(join(dir, 'brief.md'), 'SURFACE');
    const args = codexLaunchArgs({ briefingFile: join(dir, 'brief.md') });
    expect(args).toContain('You are Codex, running inside dreamcontext');
    expect(args).toContain('You are not Claude');
    expect(args).toContain('SURFACE');
    expect(args).not.toMatch(/T3/);
  });
});
