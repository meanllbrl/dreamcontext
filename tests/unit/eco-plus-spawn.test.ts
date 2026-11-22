/**
 * Eco Plus at the spawn sites (plan eco-plus D3/D4/D5, K3/K5/K6, criteria 3, 4, 7, 8): the chat
 * spawn lowers by the model's SOURCE, the Super re-resolves its saved model with a live
 * `set_model` before an idle turn, the `<super-models>` block rides once per change, and the
 * runner / auto-sleep / builder sites lower only their argv.
 *
 * Every spawn site that runs a model, and whether Eco Plus reaches it:
 *   tagged: agent-chat startChatSession (chat, child, member, app, Super, member Super, headless
 *     Super through it), automations/runner buildClaudeArgs + codexArgs (tool passed),
 *     automations/verdict resume (manifest `saved`), auto-sleep-runner (Claude argv),
 *     builder-sessions base + fresh lane (builderLineageModel), the Agent/Task hook (sub-agents).
 *   known untagged: peer-delivery.ts, cross-tool-ask.ts (short, their caller passes the model);
 *     plugin agents and definitions outside the project's and ~/.claude/agents (left as they are).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/eco-plus-spawn-home-`);
});

const spawned: Array<{ child: FakeChild; script: string; env: Record<string, string | undefined> }> = [];

class FakeChild extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 4251;
}

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: vi.fn((_shell: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
      const child = new FakeChild();
      const script = process.platform === 'win32' && args?.[0] === '-p'
        ? `exec claude ${args.map((x) => `"${x}"`).join(' ')}`
        : String(args?.[1] ?? '');
      spawned.push({ child, script, env: opts?.env ?? {} });
      return child as unknown as import('node:child_process').ChildProcess;
    }),
  };
});
vi.mock('../../src/lib/claude-accounts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-accounts.js')>();
  return { ...real, listClaudeAccounts: vi.fn(() => []) };
});
vi.mock('../../src/lib/claude-limit-rejections.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-limit-rejections.js')>();
  return { ...real, readAccountRejections: vi.fn(() => ({})) };
});
vi.mock('../../src/lib/claude-usage-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/claude-usage-probe.js')>();
  const probe = vi.fn(async () => ({ status: 'healthy-unmeasured', reason: 'test' }));
  return { ...real, probeAccountUsage: probe, probeAccountForDecision: probe };
});

const { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
const { tmpdir, homedir } = await import('node:os');
const { join } = await import('node:path');
const { startChatSession } = await import('../../src/server/routes/agent-chat.js');
const { _resetChatRegistry } = await import('../../src/lib/assistant/chat-registry.js');
const { SUPER_STATE_REL, readSuperState, resetSuperIndex } = await import('../../src/lib/super/store.js');
const { emptySuperState } = await import('../../src/lib/super/types.js');
const { _resetSuperInbox } = await import('../../src/lib/super/inbox.js');
const { buildClaudeArgs, spawnModel } = await import('../../src/lib/automations/runner.js');
const { autoSleepModelArgs } = await import('../../src/lib/auto-sleep-runner.js');
const { builderLineageModel, builderRunModel } = await import('../../src/lib/builder-spawn.js');
const { manifestHash } = await import('../../src/lib/automations/registry.js');
const { currentAutoSleepFingerprint } = await import('../../src/lib/auto-sleep.js');
const { SUPER_BRIEF_REV } = await import('../../src/lib/super/types.js');
const { ECO_PLUS_KEEP_ENV } = await import('../../src/lib/eco-plus.js');
const { ecoPlusInEffect } = await import('../../src/lib/context-watch.js');

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
}

const SUPER = '11111111-2222-4333-8444-555555555555';
let project: string;
let root: string;

const setEco = (ecoPlus: boolean) => {
  mkdirSync(join(homedir(), '.dreamcontext'), { recursive: true });
  writeFileSync(join(homedir(), '.dreamcontext', 'agent-ui.json'), JSON.stringify({ ecoMode: true, ecoPlus }));
};

async function superRecord(): Promise<void> {
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  await readSuperState(root);
}

function start(o: { sessionId?: string; mode?: string; model?: string; modelSource?: 'saved' | 'default' | 'pick' | 'resume'; resumeId?: string }) {
  const ws = new FakeWs();
  startChatSession(ws as unknown as import('ws').WebSocket, project, {
    bypass: false, sessionId: o.sessionId ?? '', resumeId: o.resumeId ?? '', model: o.model ?? '', effort: '', initialPrompt: '', deferPrompt: false,
    account: '', mode: (o.mode ?? 'basic') as never, vault: 'acme', ...(o.modelSource ? { modelSource: o.modelSource } : {}),
  });
  return { ws, ...spawned[spawned.length - 1]! };
}
const argvOf = (script: string): string[] => [...script.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]!);
const modelOf = (script: string): string | null => { const a = argvOf(script); const i = a.indexOf('--model'); return i >= 0 ? a[i + 1]! : null; };
function briefingOf(script: string): string {
  const a = argvOf(script);
  const i = a.indexOf('--append-system-prompt-file');
  return i >= 0 ? readFileSync(a[i + 1]!, 'utf-8') : '';
}
const frames = (child: FakeChild): Array<Record<string, unknown>> => child.stdin.write.mock.calls
  .map(([chunk]) => { try { return JSON.parse(String(chunk)) as Record<string, unknown>; } catch { return null; } })
  .filter((f): f is Record<string, unknown> => !!f);
const userTexts = (child: FakeChild): string[][] => frames(child).filter((f) => f.type === 'user')
  .map((f) => ((f.message as { content: Array<{ text: string }> }).content).map((b) => b.text));
const setModels = (child: FakeChild): string[] => frames(child)
  .filter((f) => f.type === 'control_request' && (f.request as { subtype?: string }).subtype === 'set_model')
  .map((f) => (f.request as { model: string }).model);
const owner = (ws: FakeWs, text: string) => ws.emit('message', JSON.stringify({ type: 'user', text }));
const lastUser = (child: FakeChild): string[] => { const f = userTexts(child); return f[f.length - 1] ?? []; };
const models = (texts: string[]) => texts.filter((t) => t.startsWith('<super-models'));
function transcript(id: string, systemPrompt: string, extra: string[] = []): void {
  const dir = join(homedir(), '.claude', 'projects', 'x');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), [JSON.stringify({ type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt } }), ...extra].join('\n') + '\n');
}

beforeEach(() => {
  spawned.length = 0;
  project = mkdtempSync(join(tmpdir(), 'eco-plus-spawn-proj-'));
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  setEco(false);
});
afterEach(() => {
  while (spawned.length) spawned.shift()!.child.emit('close', 0);
  _resetSuperInbox();
  rmSync(project, { recursive: true, force: true });
  rmSync(join(homedir(), '.claude'), { recursive: true, force: true });
  rmSync(join(homedir(), '.dreamcontext'), { recursive: true, force: true });
});

describe('a chat spawn lowers by source (criterion 3)', () => {
  it('Eco Plus on: saved/default heavy → sonnet; a pick, a resume and an untagged URL are kept', () => {
    setEco(true);
    expect(modelOf(start({ model: 'opus', modelSource: 'saved' }).script)).toBe('sonnet');
    expect(modelOf(start({ model: '', modelSource: 'saved' }).script)).toBe('sonnet');
    expect(modelOf(start({ model: '', modelSource: 'default' }).script)).toBe('sonnet');
    expect(modelOf(start({ model: 'opus', modelSource: 'pick' }).script)).toBe('opus');
    expect(modelOf(start({ model: 'opus', modelSource: 'resume' }).script)).toBe('opus');
    expect(modelOf(start({ model: 'opus' }).script)).toBe('opus');
    expect(modelOf(start({ model: 'haiku', modelSource: 'saved' }).script)).toBe('haiku');
    const log = readFileSync(join(homedir(), '.dreamcontext', 'eco-plus-lowered.jsonl'), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(3);
    expect(JSON.parse(log[0]!)).toMatchObject({ site: 'chat', from: 'opus', to: 'sonnet' });
  });

  it('an untagged spawn with no model at all is the CLI default: lowered', () => {
    setEco(true);
    expect(modelOf(start({ model: '' }).script)).toBe('sonnet');
    expect(modelOf(start({ model: '', modelSource: 'resume' }).script)).toBe('sonnet');
  });

  it('a spawn kept on Opus marks its tree; a lowered or off spawn clears the marker (review r1)', () => {
    setEco(true);
    expect(start({ model: 'opus', modelSource: 'pick' }).env[ECO_PLUS_KEEP_ENV]).toBe('1');
    expect(start({ model: 'claude-opus-5-5', modelSource: 'resume' }).env[ECO_PLUS_KEEP_ENV]).toBe('1');
    expect(start({ model: 'opus', modelSource: 'saved' }).env[ECO_PLUS_KEEP_ENV]).toBeUndefined();
    expect(start({ model: 'sonnet', modelSource: 'pick' }).env[ECO_PLUS_KEEP_ENV]).toBeUndefined();
    setEco(false);
    expect(start({ model: 'opus', modelSource: 'pick' }).env[ECO_PLUS_KEEP_ENV]).toBeUndefined();
  });

  it('Eco Plus off: every case is today\'s argv', () => {
    expect(modelOf(start({ model: 'opus', modelSource: 'saved' }).script)).toBe('opus');
    expect(modelOf(start({ model: '', modelSource: 'saved' }).script)).toBeNull();
    expect(modelOf(start({ model: 'opus', modelSource: 'pick' }).script)).toBe('opus');
  });
});

describe('the Super (criteria 3, 7, 8)', () => {
  it('spawns sonnet under Eco Plus whatever the tag, with the eco=plus table in its prompt; off = opus, no block', { timeout: 30_000 }, async () => {
    await superRecord();
    setEco(true);
    const on = start({ sessionId: SUPER, mode: 'super', model: 'opus', modelSource: 'pick' });
    expect(modelOf(on.script)).toBe('sonnet');
    expect(briefingOf(on.script)).toContain('<super-models eco=plus>');
    on.child.emit('close', 0);
    spawned.length = 0;
    setEco(false);
    const off = start({ sessionId: SUPER, mode: 'super', model: 'opus' });
    expect(modelOf(off.script)).toBe('opus');
    expect(briefingOf(off.script)).not.toContain('<super-models');
  });

  it('a live Super switches with set_model before its next idle turn, and the block rides once per change', { timeout: 30_000 }, async () => {
    await superRecord();
    const { ws, child } = start({ sessionId: SUPER, mode: 'super', model: 'opus' });
    owner(ws, 'hello');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(1), { timeout: 10_000 });
    expect(models(lastUser(child))).toEqual([]);
    expect(setModels(child)).toEqual([]);
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    setEco(true);
    owner(ws, 'next');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(2), { timeout: 10_000 });
    expect(setModels(child)).toEqual(['sonnet']);
    expect(models(lastUser(child))).toHaveLength(1);
    expect(models(lastUser(child))[0]).toContain('<super-models eco=plus>');
    // set_model went in BEFORE the turn.
    const order = frames(child).map((f) => f.type);
    expect(order.lastIndexOf('control_request')).toBeLessThan(order.lastIndexOf('user'));
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    owner(ws, 'again');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(3), { timeout: 10_000 });
    expect(models(lastUser(child))).toEqual([]);
    expect(setModels(child)).toEqual(['sonnet']);
    // A compaction drops what a turn delivered: the current block rides again.
    child.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    owner(ws, 'after compaction');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(4), { timeout: 10_000 });
    expect(models(lastUser(child))[0]).toContain('eco=plus');
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    setEco(false);
    owner(ws, 'off again');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(5), { timeout: 10_000 });
    expect(setModels(child)).toEqual(['sonnet', 'opus']);
    expect(models(lastUser(child))[0]).toContain('<super-models eco=off>');
  });

  it('a message during a turn switches nothing: the next idle turn does, once', { timeout: 30_000 }, async () => {
    await superRecord();
    const { ws, child } = start({ sessionId: SUPER, mode: 'super', model: 'opus' });
    owner(ws, 'a long job');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(1), { timeout: 10_000 });
    setEco(true);
    owner(ws, 'while it runs');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(2), { timeout: 10_000 });
    expect(setModels(child)).toEqual([]);
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    child.stdout.emit('data', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n');
    owner(ws, 'now idle');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(3), { timeout: 10_000 });
    expect(setModels(child)).toEqual(['sonnet']);
  });

  it('a resumed Super holding off gets eco=plus once; one born under Eco Plus and resumed with it off gets eco=off', { timeout: 30_000 }, async () => {
    await superRecord();
    transcript(SUPER, 'Super briefing without a model block');
    setEco(true);
    const a = start({ sessionId: '', resumeId: SUPER, mode: 'super', model: 'opus' });
    owner(a.ws, 'hi');
    await vi.waitFor(() => expect(userTexts(a.child)).toHaveLength(1), { timeout: 10_000 });
    expect(models(lastUser(a.child)).filter((t) => t.includes('eco=plus'))).toHaveLength(1);
    a.child.emit('close', 0);
    spawned.length = 0;
    transcript(SUPER, 'Super briefing\n<super-models eco=plus>\ntable\n</super-models>');
    setEco(false);
    const b = start({ sessionId: '', resumeId: SUPER, mode: 'super', model: 'opus' });
    owner(b.ws, 'hi');
    await vi.waitFor(() => expect(userTexts(b.child)).toHaveLength(1), { timeout: 10_000 });
    expect(models(lastUser(b.child)).filter((t) => t.includes('eco=off'))).toHaveLength(1);
  });

  it('a fresh Super with Eco Plus off carries no block, and the briefing revision is unchanged', { timeout: 30_000 }, async () => {
    await superRecord();
    const { ws, child } = start({ sessionId: SUPER, mode: 'super', model: 'opus' });
    owner(ws, 'hi');
    await vi.waitFor(() => expect(userTexts(child)).toHaveLength(1), { timeout: 10_000 });
    expect(models(lastUser(child))).toEqual([]);
    expect(typeof SUPER_BRIEF_REV).toBe('number');
  });
});

describe('server-side spawn sites (criteria 3, 4)', () => {
  const manifest = (model: string | null) => ({ slug: 'fox', model, effort: 'high' }) as never;

  it('an automation: manifest opus or none runs sonnet, a team ask --model opus keeps opus, Codex untouched, off = identity', () => {
    setEco(true);
    const m = (a: string[]) => { const i = a.indexOf('--model'); return i >= 0 ? a[i + 1] : null; };
    expect(m(buildClaudeArgs(manifest('opus'), 'p'))).toBe('sonnet');
    expect(m(buildClaudeArgs(manifest(null), 'p'))).toBe('sonnet');
    expect(m(buildClaudeArgs(manifest('opus'), 'p', null, { model: 'opus', effort: null }))).toBe('opus');
    expect(m(buildClaudeArgs(manifest('haiku'), 'p'))).toBe('haiku');
    expect(spawnModel(manifest('opus'), null, { tool: 'codex' }).model).toBe('opus');
    expect(spawnModel(manifest('opus'), null, { on: false }).model).toBe('opus');
    expect(spawnModel(manifest(null), null, { on: false }).model).toBeNull();
  });

  it('inside a kept tree: eco in effect is off, so the builder lineage and the hook keep opus', () => {
    setEco(true);
    const prev = process.env[ECO_PLUS_KEEP_ENV];
    try {
      delete process.env[ECO_PLUS_KEEP_ENV];
      expect(ecoPlusInEffect()).toBe(true);
      expect(builderLineageModel()).toBe('sonnet');
      process.env[ECO_PLUS_KEEP_ENV] = '1';
      expect(ecoPlusInEffect()).toBe(false);
      expect(builderLineageModel()).toBe('opus');
    } finally {
      if (prev === undefined) delete process.env[ECO_PLUS_KEEP_ENV]; else process.env[ECO_PLUS_KEEP_ENV] = prev;
    }
  });

  it('an escalated (kept) tree runs a lowered lineage on the builder default at its next fork, update or resume', () => {
    expect(builderRunModel('claude-sonnet-5-5', { [ECO_PLUS_KEEP_ENV]: '1' })).toBe('opus');
    expect(builderRunModel('sonnet', { [ECO_PLUS_KEEP_ENV]: '1' })).toBe('opus');
    expect(builderRunModel('claude-opus-5-5', { [ECO_PLUS_KEEP_ENV]: '1' })).toBe('claude-opus-5-5');
    expect(builderRunModel('claude-sonnet-5-5', {})).toBe('claude-sonnet-5-5');
    // ecoPlusInEffect reads the same env name eco-plus.ts exports.
    setEco(true);
    expect(ecoPlusInEffect(homedir(), { [ECO_PLUS_KEEP_ENV]: '1' })).toBe(false);
    expect(ecoPlusInEffect(homedir(), {})).toBe(true);
  });

  it('auto-sleep runs --model sonnet under Eco Plus only; a builder lineage starts sonnet, off opus', () => {
    expect(autoSleepModelArgs(true)).toEqual(['--model', 'sonnet']);
    expect(autoSleepModelArgs(false)).toEqual([]);
    expect(builderLineageModel(true)).toBe('sonnet');
    expect(builderLineageModel(false)).toBe('opus');
  });

  it('toggling Eco Plus moves no approval hash and no auto-sleep consent fingerprint', () => {
    const m = { slug: 'fox', id: 'a', title: 'Fox', model: 'opus', effort: 'high', prompt: 'do the job', outputInstructions: 'write it', timeoutMinutes: 10, outputDir: 'out', learning: false } as never;
    setEco(false);
    const h0 = manifestHash(m);
    const f0 = currentAutoSleepFingerprint(project);
    setEco(true);
    buildClaudeArgs(m, 'p');
    expect(manifestHash(m)).toBe(h0);
    expect(currentAutoSleepFingerprint(project)).toBe(f0);
    expect((m as { model: string }).model).toBe('opus');
  });
});
