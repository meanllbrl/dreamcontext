/**
 * Antigravity end to end on the bridge, against T3's fake ACP agent: a real `runBridgeStdio`, T3's
 * real `AntigravityDriver.create`, the agent as a child process. W5 criterion: memory reaches the
 * model (it is inside `session/prompt`).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../../src/lib/antigravity-accounts.js';
import { runBridgeStdio } from '../../../src/lib/t3-bridge/stdio.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const AGENT = join(ROOT, 'src/vendor/t3/apps/server/scripts/acp-mock-agent.ts');
const REGISTER = join(ROOT, 'scripts/t3-node-register.mjs');

function fakeAgent(dir: string): string {
  const bin = join(dir, 'agy_acp_server.par');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --import "${REGISTER}" "${AGENT}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(dir, 'localharness_external'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'localharness_external'), 0o755);
  return bin;
}

// The driver reaches `node:sqlite`: the bridge floor (22.16) has it, Node 20 test runs do not. W5's
// evidence is this file run on 22.16.
const nodeMajor = Number(process.versions.node.split('.')[0]);

describe.skipIf(nodeMajor < 22)('Antigravity on the bridge (fake ACP agent)', () => {
  let dir: string;
  let log: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-agy-'));
    log = join(dir, 'requests.ndjson');
    process.env.T3_ACP_ANTIGRAVITY = '1';
    process.env.T3_ACP_REQUEST_LOG_PATH = log;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  async function chat(mode: string, turn: string, account?: string) {
    const input = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    let onResult: (() => void) | null = null;
    const write = (line: string): void => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === 'result') onResult?.();
    };
    const brief = join(dir, 'brief.md');
    writeFileSync(brief, 'BRIEFING-MARKER');
    const cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    const finished = new Promise<void>((r) => { onResult = r; });
    const done = runBridgeStdio(
      { tool: 'antigravity', cwd, model: '', mode, paneId: 'pane-1', briefingFile: brief, binaryPath: fakeAgent(dir), ...(account ? { account } : {}) },
      {
        input, write, env: process.env, home: dir,
        brain: {
          session: async () => undefined,
          prompt: async () => [{ key: 'dreamcontext-memory', text: 'BRAIN-MEMORY-MARKER' }],
          drain: async () => undefined,
        },
      },
    );
    input.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: turn } })}\n`);
    await finished;
    input.end();
    return { code: await done, frames, requests: readFileSync(log, 'utf-8') };
  }

  it("puts the owner's words, the briefing and the memory in the prompt the agent receives", async () => {
    const { code, frames, requests } = await chat('auto', 'OWNER-WORDS');
    expect(code).toBe(0);
    const prompt = requests.split('\n').find((l) => l.includes('session/prompt')) ?? '';
    expect(prompt).toContain('OWNER-WORDS');
    expect(prompt).toContain('BRAIN-MEMORY-MARKER');
    expect(prompt).toContain('BRIEFING-MARKER');
    // After the owner's words: a leading tag would hide the message in a reopened pane.
    expect(prompt.indexOf('OWNER-WORDS')).toBeLessThan(prompt.indexOf('BRAIN-MEMORY-MARKER'));
    const result = frames.find((f) => f.type === 'result')!;
    expect(result.is_error).toBe(false);
    expect(result.dc_tool).toBe('antigravity');
    expect(frames.some((f) => f.type === 'system' && f.subtype === 'dc_thread' && !!f.session_id)).toBe(true);
  }, 60_000);

  it('rotates like Eco: /clear opens a fresh thread that carries the briefing again', async () => {
    const input = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    let waiters: Array<() => void> = [];
    const results = (): number => frames.filter((f) => f.type === 'result').length;
    const untilResults = (n: number): Promise<void> => new Promise((r) => {
      if (results() >= n) r(); else waiters.push(() => { if (results() >= n) r(); });
    });
    const write = (line: string): void => {
      frames.push(JSON.parse(line) as Record<string, unknown>);
      const pending = waiters; waiters = []; for (const w of pending) { w(); waiters.push(w); }
    };
    const brief = join(dir, 'brief.md');
    writeFileSync(brief, 'BRIEFING-MARKER');
    const cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    const done = runBridgeStdio(
      { tool: 'antigravity', cwd, model: '', mode: 'auto', paneId: 'pane-1', briefingFile: brief, binaryPath: fakeAgent(dir) },
      {
        input, write, env: process.env, home: dir,
        onRotated: () => [{ key: 'dreamcontext-handoff', text: 'HANDOFF-MARKER' }],
        onResult: () => [{ key: 'dreamcontext-context', text: 'NUDGE-MARKER' }],
      },
    );
    const say = (text: string): void => { input.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`); };
    say('first turn');
    await untilResults(1);
    say('/clear');
    await untilResults(2);
    say('second turn');
    await untilResults(3);
    input.end();
    expect(await done).toBe(0);
    const init = frames.find((f) => f.type === 'system' && f.subtype === 'init' && f.dc_rotated === true);
    expect(init?.session_id).toBeTruthy();
    const prompts = readFileSync(log, 'utf-8').split('\n').filter((l) => l.includes('session/prompt'));
    expect(prompts).toHaveLength(2);
    // What Eco owes the next turn: the nudge from the result, the handoff and briefing from /clear.
    for (const marker of ['NUDGE-MARKER', 'HANDOFF-MARKER', 'BRIEFING-MARKER']) expect(prompts[1]).toContain(marker);
  }, 60_000);

  it('Bypass answers for the owner, never sends yolo, and turning it off holds from the next turn', async () => {
    process.env.T3_ACP_EMIT_TOOL_CALLS = '1';
    const input = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    const write = (line: string): void => {
      const f = JSON.parse(line) as Record<string, unknown>;
      frames.push(f);
      if (f.type === 'control_request') input.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: f.request_id, response: { behavior: 'allow' } } })}\n`);
    };
    const until = async (n: number): Promise<void> => {
      for (let i = 0; i < 400 && frames.filter((f) => f.type === 'result').length < n; i++) await new Promise((r) => setTimeout(r, 50));
    };
    const cwd = join(dir, 'project');
    mkdirSync(cwd, { recursive: true });
    const done = runBridgeStdio({ tool: 'antigravity', cwd, model: '', mode: 'bypassPermissions', paneId: 'pane-1', binaryPath: fakeAgent(dir) }, { input, write, env: process.env, home: dir });
    const say = (text: string): void => { input.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`); };
    const cards = (): number => frames.filter((f) => f.type === 'control_request').length;
    say('one');
    await until(1);
    expect(cards()).toBe(0);
    input.write(`${JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'set_permission_mode', mode: 'auto' } })}\n`);
    say('two');
    await until(2);
    input.end();
    expect(await done).toBe(0);
    expect(cards()).toBeGreaterThan(0);
    expect(readFileSync(log, 'utf-8')).not.toContain('yolo');
  }, 60_000);

  it('installs when nothing is there, and says why when the install fails', async () => {
    const { ensureInstalled } = await import('../../../src/lib/t3-bridge/instance-account-cli.js');
    const Effect = await import('effect/Effect');
    const Stream = await import('effect/Stream');
    let started = 0;
    const service = (found: boolean, phase: string) => ({
      resolve: () => (found ? Effect.succeed({}) : Effect.fail(new Error('not installed'))),
      start: Effect.sync(() => { started += 1; }),
      changes: Stream.make({ phase: 'downloading', message: null }, { phase, message: phase === 'failed' ? 'Disk full.' : null }),
    }) as never;
    await Effect.runPromise(ensureInstalled(service(true, 'succeeded')));
    expect(started).toBe(0);
    await Effect.runPromise(ensureInstalled(service(false, 'succeeded')));
    expect(started).toBe(1);
    await expect(Effect.runPromise(ensureInstalled(service(false, 'failed')))).rejects.toThrow('Disk full.');
  }, 60_000);

  it('gives every account its own profile: the path our readiness reads is the one T3 writes', async () => {
    await chat('auto', 'hello');
    expect(existsSync(join(antigravityProfileDir('primary', dir), 'antigravity-acp', 'settings.json'))).toBe(true);
    await chat('auto', 'hello', 'acct-one');
    expect(existsSync(join(antigravityProfileDir('acct-one', dir), 'antigravity-acp', 'settings.json'))).toBe(true);
    expect(antigravityProfileDir('acct-one', dir)).not.toBe(antigravityProfileDir('primary', dir));
  }, 120_000);
});
