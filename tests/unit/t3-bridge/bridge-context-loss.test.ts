/**
 * A bridge chat's context, when it goes missing or goes stale: a lost snapshot or hook is said once,
 * a finished compaction is read off the adapter, and the agent is told where the brain is.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BrainContext, brainPathLine, cliHookRunner, type HookRunner } from '../../../src/lib/t3-bridge/context.js';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';
import { ToWire } from '../../../src/lib/t3-bridge/to-wire.js';
import { loadFixture, policyFor, replayFactory } from './replay-harness.js';

const SNAP = '# Agent Context — synthetic snapshot of acme-shop';
const codexAnswer = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

describe('lost context is said, once', () => {
  const vault = (): string => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-brain-')));
    mkdirSync(join(dir, '_dream_context'));
    return dir;
  };
  const answer = (snapshot: string | null, prompt: string | null = ''): HookRunner =>
    async (name) => (name === 'session-start' ? snapshot : name === 'user-prompt-submit' ? prompt : '');

  it('an empty snapshot in a project with a brain says so, and only once', async () => {
    const b = new BrainContext({ cwd: vault(), env: {}, run: answer('') });
    await b.session('startup', 't');
    expect(b.takeNotice()).toContain('came back empty');
    expect(b.takeNotice()).toBeNull();
    await b.session('clear', 't');
    expect(b.takeNotice()).toBeNull();
  });

  it('a snapshot that timed out says so, in its own words', async () => {
    const b = new BrainContext({ cwd: vault(), env: {}, run: answer(null) });
    await b.session('resume', 't');
    expect(b.takeNotice()).toContain('did not finish');
  });

  it('no brain in the project is not a loss, and a kept snapshot is not one either', async () => {
    const none = new BrainContext({ cwd: mkdtempSync(join(tmpdir(), 'dc-none-')), env: {}, run: answer(null) });
    await none.session('startup', 't');
    expect(none.takeNotice()).toBeNull();
    let n = 0;
    const kept = new BrainContext({ cwd: vault(), env: {}, run: async () => (n++ === 0 ? codexAnswer('SessionStart', SNAP) : null) });
    await kept.session('startup', 't');
    await kept.session('compact', 't');
    expect(kept.takeNotice()).toBeNull();
    expect(kept.snapshot).toContain(SNAP);
  });

  it('a prompt hook that did not finish says so once; one with nothing to say does not', async () => {
    const quiet = new BrainContext({ cwd: vault(), env: {}, run: answer(codexAnswer('SessionStart', SNAP), '') });
    await quiet.session('startup', 't');
    await quiet.prompt('x', 't');
    expect(quiet.takeNotice()).toBeNull();
    const b = new BrainContext({ cwd: vault(), env: {}, run: answer(codexAnswer('SessionStart', SNAP), null) });
    await b.session('startup', 't');
    expect((await b.prompt('x', 't')).map((c) => c.key)).toEqual(['dreamcontext-brain']);
    expect(b.takeNotice()).toContain('Memory recall did not run');
    await b.prompt('y', 't');
    expect(b.takeNotice()).toBeNull();
  });

  it('the real runner tells a hook that did not finish from one that printed nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-hook-'));
    const script = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, 0o755); return p; };
    const run = (cli: string) => cliHookRunner(process.execPath, cli)('session-start', {}, { cwd: dir, env: process.env, timeoutMs: 400 });
    expect(await run(script('quiet.cjs', ''))).toBe('');
    expect(await run(script('crash.cjs', 'process.exit(3)'))).toBeNull();
    expect(await run(script('hang.cjs', 'setInterval(() => {}, 1000)'))).toBeNull();
    expect(await run(script('late.cjs', 'console.log("{}"); process.exit(3)'))).toBe('{}\n');
  });
});

describe('the compaction event', () => {
  const item = (status: string, type = 'compaction') => ({ type: 'turn_item.updated', turnItem: { type, id: 'i', status } }) as never;
  it('reads once, only for a finished compaction', () => {
    const w = new ToWire({ tool: 'antigravity', model: 'm', cwd: '/p', permissionMode: 'default' });
    expect(w.takeCompacted()).toBe(false);
    w.translate(item('running'));
    w.translate(item('failed'));
    expect(w.takeCompacted()).toBe(false);
    w.translate(item('completed'));
    expect(w.takeCompacted()).toBe(true);
    expect(w.takeCompacted()).toBe(false);
  });
});

describe('the brain-path line for a bridge tool', () => {
  it('heads the snapshot from the project root, and only where a brain exists', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dc-brain-')));
    mkdirSync(join(dir, '_dream_context'));
    const b = new BrainContext({ cwd: dir, env: {}, run: async () => codexAnswer('SessionStart', SNAP) });
    await b.session('startup', 't');
    expect(b.snapshot).toBe(`${brainPathLine(dir)}\n\n${SNAP}`);
    expect(b.snapshot).toContain(`cd ${dir} && dreamcontext`);
    const none = new BrainContext({ cwd: mkdtempSync(join(tmpdir(), 'dc-none-')), env: {}, run: async () => codexAnswer('SessionStart', 'an initializer offer') });
    await none.session('startup', 't');
    expect(none.snapshot).toBe('an initializer offer');
  });
});

describe('a Codex chat hears the same notice (T3 replay)', () => {
  it('one local line before the turn, and the turn still runs', async () => {
    const f = loadFixture('tool_call_read_only_on_request');
    const start = f.transcript.entries.find((e) => e.type === 'expect_outbound' && (e.frame as { method?: string }).method === 'turn/start') as { frame: { params: Record<string, unknown> } };
    start.frame.params.additionalContext = { 'dreamcontext-brain': { kind: 'untrusted', value: SNAP } };
    const brain = new BrainContext({ cwd: f.workspace, env: {}, run: async (name) => (name === 'session-start' ? codexAnswer('SessionStart', SNAP) : '') });
    let owed: string | null = 'NOTICE-MARKER';
    brain.takeNotice = () => { const n = owed; owed = null; return n; };
    const input = new PassThrough();
    const out: Record<string, unknown>[] = [];
    let buf = '';
    const done = runBridgeStdio(
      { tool: 'codex', cwd: f.workspace, model: f.model, mode: 'bypassPermissions', paneId: 'pane-codex-notice' },
      {
        input, env: {}, home: mkdtempSync(join(tmpdir(), 'dc-codex-notice-')), brain,
        clientFactory: replayFactory(f.transcript), runtimePolicyOverride: policyFor(f),
        write: (l) => { buf += l; let n; while ((n = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, n)) as Record<string, unknown>); buf = buf.slice(n + 1); } },
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
    const notices = out.filter((x) => JSON.stringify(x).includes('NOTICE-MARKER'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: 'assistant', message: { model: '<synthetic>' } });
    input.end();
    await done;
  }, 40_000);
});
