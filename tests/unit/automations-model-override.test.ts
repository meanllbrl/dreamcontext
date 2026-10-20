/**
 * The AI Team's temporary model (A8): the owner picks a model for ONE message. It is checked
 * against the one model list, reaches that message's spawn argv and nothing else, and a
 * scheduled fire never carries it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const runAutomation = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/automations/runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/automations/runner.js')>();
  // Pass-through by default; the route tests swap in a double.
  runAutomation.mockImplementation(real.runAutomation);
  return { ...real, runAutomation };
});
const resumeWithMessage = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/automations/verdict.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/lib/automations/verdict.js')>();
  resumeWithMessage.mockImplementation(real.resumeWithMessage);
  return { ...real, resumeWithMessage };
});

const { buildClaudeArgs, buildContinueArgs, spawnModel } = await import('../../src/lib/automations/runner.js');
const { buildResumeArgs } = await import('../../src/lib/automations/verdict.js');
const { agentModelChoices, parseModelOverride } = await import('../../src/lib/agents/model-choices.js');
const { BASE_MODEL_OPTIONS, modelOptionsFrom } = await import('../../src/lib/model-list.js');
const { handleAutomationsSay, handleAutomationsThreadReply } = await import('../../src/server/routes/automations.js');
const { currentAutomationJob, startAutomationReplyJob } = await import('../../src/server/automation-job.js');
const { createAgent } = await import('../../src/lib/agents/store.js');
const { createAutomation } = await import('../../src/lib/automations/store.js');
const { readThread } = await import('../../src/lib/automations/threads.js');
const { tickProject } = await import('../../src/lib/automations/tick.js');
type Manifest = import('../../src/lib/automations/types.js').AutomationManifest;
type SpawnImpl = import('../../src/lib/automations/runner.js').SpawnImpl;

const NOW = new Date('2026-10-20T09:00:00.000Z');
let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

const manifest = (model: string | null, effort: 'low' | 'high' | null) =>
  ({ model, effort } as unknown as Manifest);

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function req(body: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
}

async function settled(slug: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const job = currentAutomationJob(contextRoot, slug);
    if (job && job.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-model-override-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-model-override-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('the one model list', () => {
  it('is the base aliases plus the CLI\'s cached extras, deduped by alias', () => {
    expect(modelOptionsFrom(null).map((m) => m.id)).toEqual(BASE_MODEL_OPTIONS.map((m) => m.id));
    const withExtras = modelOptionsFrom({
      additionalModelOptionsCache: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }, { value: 'kestrel-1', label: 'Kestrel' }],
    });
    expect(withExtras.map((m) => m.id)).toEqual(['opus', 'sonnet', 'haiku', 'fable', 'kestrel-1']);
  });

  it('agentModelChoices reads the extras from this machine\'s ~/.claude.json', () => {
    expect(agentModelChoices(fakeHome).models).not.toContain('kestrel-1');
    writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ additionalModelOptionsCache: [{ value: 'kestrel-1' }] }));
    const choices = agentModelChoices(fakeHome);
    expect(choices.models).toContain('kestrel-1');
    expect(choices.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('parseModelOverride', () => {
  const choices = { models: ['opus', 'sonnet'], efforts: ['low', 'high'] as ('low' | 'high')[] } as ReturnType<typeof agentModelChoices>;

  it('absent, null and empty mean no override', () => {
    expect(parseModelOverride({}, choices)).toEqual({ ok: true, override: null });
    expect(parseModelOverride({ model: null, effort: '' }, choices)).toEqual({ ok: true, override: null });
    expect(parseModelOverride(null, choices)).toEqual({ ok: true, override: null });
  });

  it('a listed model and effort pass, alone or together', () => {
    expect(parseModelOverride({ model: 'sonnet' }, choices)).toEqual({ ok: true, override: { model: 'sonnet', effort: null } });
    expect(parseModelOverride({ effort: 'low' }, choices)).toEqual({ ok: true, override: { model: null, effort: 'low' } });
    expect(parseModelOverride({ model: 'opus', effort: 'high' }, choices)).toEqual({ ok: true, override: { model: 'opus', effort: 'high' } });
  });

  it('anything off the list is refused, never dropped', () => {
    for (const body of [{ model: 'gpt-9' }, { model: 'opus --dangerously' }, { model: 42 }, { effort: 'max' }, { effort: true }]) {
      expect(parseModelOverride(body, choices).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('the override reaches the argv of one spawn', () => {
  it('buildClaudeArgs: override wins field by field; absent is the manifest exactly', () => {
    const m = manifest('opus', 'high');
    expect(buildClaudeArgs(m, 'p')).toEqual(buildClaudeArgs(m, 'p', null, null));
    const plain = buildClaudeArgs(m, 'p');
    expect(plain.slice(plain.indexOf('--model'))).toEqual(['--model', 'opus', '--effort', 'high']);
    const both = buildClaudeArgs(m, 'p', null, { model: 'sonnet', effort: 'low' });
    expect(both.slice(both.indexOf('--model'))).toEqual(['--model', 'sonnet', '--effort', 'low']);
    const effortOnly = buildClaudeArgs(m, 'p', null, { model: null, effort: 'low' });
    expect(effortOnly.slice(effortOnly.indexOf('--model'))).toEqual(['--model', 'opus', '--effort', 'low']);
    // A manifest with no model gets one only from the override.
    expect(buildClaudeArgs(manifest(null, null), 'p')).not.toContain('--model');
    expect(spawnModel(manifest(null, null), { model: 'haiku', effort: null })).toEqual({ model: 'haiku', effort: null });
  });

  it('the account-switch continue and a reply\'s resume carry it too', () => {
    const m = manifest('opus', null);
    const cont = buildContinueArgs(m, 'sess-1', null, { model: 'sonnet', effort: null });
    expect(cont.slice(0, 2)).toEqual(['--resume', 'sess-1']);
    expect(cont[cont.indexOf('--model') + 1]).toBe('sonnet');
    const resume = buildResumeArgs(m, 'sess-1', 'p', null, { model: 'haiku', effort: 'low' });
    expect(resume.slice(resume.indexOf('--model'))).toEqual(['--model', 'haiku', '--effort', 'low']);
    expect(buildResumeArgs(m, 'sess-1', 'p')).toContain('opus');
  });

  it('a real run with an override spawns claude on that model; without one, on the manifest\'s', async () => {
    const m = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', days: 'daily', at: '09:00', prompt: 'Hi.', model: 'opus' });
    const { approveAutomation } = await import('../../src/lib/automations/registry.js');
    approveAutomation(projectRoot, m, NOW, fakeHome);
    const argvOf = async (override?: { model: string | null; effort: null }) => {
      const stdout = new EventEmitter();
      const child = Object.assign(new EventEmitter(), { pid: 4242, stdout, stderr: new EventEmitter(), kill: () => {} });
      const spawn = vi.fn(() => child);
      const run = runAutomation(contextRoot, 'digest', {
        now: () => NOW, home: fakeHome, spawnImpl: spawn as unknown as SpawnImpl, notify: () => {}, force: true,
        ...(override ? { override } : {}),
      });
      await new Promise((r) => setTimeout(r, 20));
      stdout.emit('data', Buffer.from(JSON.stringify({ session_id: 's', result: 'ok', is_error: false, permission_denials: [] })));
      child.emit('close', 0);
      await run;
      return spawn.mock.calls[0][1] as string[];
    };
    const withOverride = await argvOf({ model: 'sonnet', effort: null });
    expect(withOverride[withOverride.indexOf('--model') + 1]).toBe('sonnet');
    const plain = await argvOf();
    expect(plain[plain.indexOf('--model') + 1]).toBe('opus');
  });
});

describe('the routes', () => {
  beforeEach(() => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    runAutomation.mockReset();
    runAutomation.mockResolvedValue({
      slug: 'scout', status: 'ok', outputPath: null, error: null, durationMs: 1, event: null, cache: null,
      denials: 0, costUsd: null, reviewCardId: null,
    });
  });

  it('say: an unknown model is 400 bad_model, and nothing is written or run', async () => {
    const r = makeRes();
    await handleAutomationsSay(req({ slug: 'scout', text: 'Hello', model: 'gpt-9' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('bad_model');
    expect(readThread(contextRoot, 'scout')).toHaveLength(0);
    expect(runAutomation).not.toHaveBeenCalled();
  });

  it('say: a listed model rides into that run, and only that run', async () => {
    const r = makeRes();
    await handleAutomationsSay(req({ slug: 'scout', text: 'Hello', model: 'sonnet', effort: 'low' }), r.res, {}, contextRoot);
    expect(r.status()).toBe(200);
    await settled('scout');
    expect(runAutomation.mock.calls[0][2]).toMatchObject({ ask: 'Hello', override: { model: 'sonnet', effort: 'low' } });

    const r2 = makeRes();
    await handleAutomationsSay(req({ slug: 'scout', text: 'Again' }), r2.res, {}, contextRoot);
    await settled('scout');
    expect(runAutomation.mock.calls[1][2]).not.toHaveProperty('override');
  });

  it('reply: an unknown effort is 400 bad_model', async () => {
    const r = makeRes();
    await handleAutomationsThreadReply(
      req({ text: 'More', runId: NOW.toISOString(), effort: 'turbo' }), r.res, { slug: 'scout' }, contextRoot,
    );
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('bad_model');
  });

  it('reply job: the override reaches the resume\'s options', async () => {
    resumeWithMessage.mockReset();
    resumeWithMessage.mockResolvedValue({ status: 'ok', error: null, result: 'fine', costUsd: null });
    startAutomationReplyJob(contextRoot, 'scout', {
      runId: NOW.toISOString(), text: 'More', entryId: 'e1', home: fakeHome, override: { model: 'haiku', effort: null },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resumeWithMessage.mock.calls[0][3]).toMatchObject({ override: { model: 'haiku', effort: null } });
  });

  it('a scheduled tick never carries an override', async () => {
    createAutomation(contextRoot, { slug: 'morning', title: 'Morning', agent: 'scout', days: 'daily', at: '08:00' });
    const seen: Record<string, unknown>[] = [];
    await tickProject(projectRoot, {
      now: new Date(2026, 9, 20, 9, 0),
      home: fakeHome,
      runImpl: async (_root, slug, opts) => {
        seen.push({ slug, ...(opts as Record<string, unknown>) });
        return { slug, status: 'ok', outputPath: null, error: null, durationMs: 0, event: null, cache: null, denials: 0, costUsd: null, reviewCardId: null };
      },
    });
    expect(seen.map((s) => s.slug)).toContain('morning');
    for (const s of seen) expect(s).not.toHaveProperty('override');
  });
});
