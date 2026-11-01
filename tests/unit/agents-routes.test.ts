/**
 * `/api/agents` (src/server/routes/agents.ts). Handlers are called directly with a mock `res`
 * and a Buffer-backed req, under a fake HOME so the machine-local registry never touches the
 * developer's real one.
 *
 * WIRING (A14), mutation-tested against two mutations of `listAgentSummaries` / `summarizeAgent`:
 *  - `listAgentTargets` swapped for `listAutomations`: the scheduled `digest` then arrives as its
 *    AUTOMATION target, whose own record approves it for 'run', so `approvedToRun` flips to true
 *    and the scheduled-agent expectation fails;
 *  - `approvedForChat` computed with `'run'` instead of `'identity'`: `digest` (approved only
 *    through its binding, rule (c)) reads `approvedForChat: false` and the same test fails.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval } from '../../src/lib/automations/registry.js';
import { createAgent, getAgent, recordAgentLesson } from '../../src/lib/agents/store.js';
import { splitLegacyManifest } from '../../src/lib/agents/split.js';
import {
  handleAgentsApprove,
  handleAgentsCreate,
  handleAgentsDelete,
  handleAgentsList,
  handleAgentsShow,
  handleAgentsUpdate,
  type AgentSummary,
} from '../../src/server/routes/agents.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

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

function post(body?: unknown): IncomingMessage {
  const readable = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf-8')]);
  return Object.assign(readable, { method: 'POST', headers: { ...OWNER_PAGE_HEADERS } }) as unknown as IncomingMessage;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;
const NOW = new Date('2026-10-12T09:00:00.000Z');

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-agents-routes-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-agents-routes-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

async function list(): Promise<AgentSummary[]> {
  const { res, status, body } = makeRes();
  await handleAgentsList(getReq, res, {}, contextRoot);
  expect(status()).toBe(200);
  return body().agents as AgentSummary[];
}

function callAgent(slug: string): void {
  const m = createAutomation(contextRoot, { slug, title: `Helper ${slug}`, mode: 'call', prompt: 'Answer when asked.', review: 'agent' });
  approveAutomation(projectRoot, m, NOW);
}

describe('GET /api/agents — wiring', () => {
  it('an on-call agent approved before the split may chat AND run, unsplit and migrated', async () => {
    callAgent('helper');
    callAgent('other');
    expect(splitLegacyManifest(contextRoot, 'other', { home: fakeHome }).outcome).toBe('split');
    const agents = await list();
    expect(agents.map((a) => a.slug)).toEqual(['helper', 'other']);
    for (const a of agents) {
      expect(a).toMatchObject({ approvedForChat: true, approvedToRun: true, approvalReason: null });
    }
    expect(agents.find((a) => a.slug === 'helper')!.implicit).toBe(true);
    expect(agents.find((a) => a.slug === 'other')!.implicit).toBe(false);
  });

  it('a scheduled agent may chat through its job, not run; its job shows under usedBy', async () => {
    const digest = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '18:00' });
    approveAutomation(projectRoot, digest, NOW);
    const [a] = await list();
    expect(a).toMatchObject({ slug: 'digest', title: 'Digest', approvedForChat: true, approvedToRun: false });
    expect(a.approvalReason).not.toBeNull();
    expect(a.usedBy.automations).toEqual([
      { slug: 'digest', title: 'Digest', enabled: true, nextFireAt: expect.any(String) },
    ]);
  });

  it('an agent nobody approved is neither', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' });
    const [a] = await list();
    expect(a).toMatchObject({ slug: 'scout', approvedForChat: false, approvedToRun: false, hasCallSettings: false });
  });
});

describe('writes', () => {
  it('create grants the agent directly; show carries the prompt and the call-target review', async () => {
    const c = makeRes();
    await handleAgentsCreate(post({ title: 'Scout', prompt: 'Scout the market.' }), c.res, {}, contextRoot);
    expect(c.status()).toBe(200);
    expect(c.body().agent).toMatchObject({ slug: 'scout', approvedForChat: true, approvedToRun: true });

    const s = makeRes();
    await handleAgentsShow(getReq, s.res, { slug: 'scout' }, contextRoot);
    expect(s.status()).toBe(200);
    expect(s.body().prompt).toBe('Scout the market.');
    expect(String(s.body().review)).toContain('Scout the market.');
  });

  it('update re-stamps a direct grant, and refuses a preview truncation', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    const u = makeRes();
    await handleAgentsUpdate(post({ prompt: 'Scout the whole market.', effort: 'high' }), u.res, { slug: 'scout' }, contextRoot);
    expect(u.status()).toBe(200);
    expect(u.body().agent).toMatchObject({ effort: 'high', approvedToRun: true });

    const long = 'x'.repeat(900);
    const l = makeRes();
    await handleAgentsUpdate(post({ prompt: long }), l.res, { slug: 'scout' }, contextRoot);
    const t = makeRes();
    await handleAgentsUpdate(post({ prompt: long.slice(0, 600) }), t.res, { slug: 'scout' }, contextRoot);
    expect(t.status()).toBe(409);
    expect(t.body().error).toBe('prompt_truncated');
  });

  it('update never takes a call setting', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    const before = getRunTarget(contextRoot, 'scout', 'agent')!;
    const u = makeRes();
    await handleAgentsUpdate(post({ timeoutMinutes: 99, outputDir: 'x', review: 'output' }), u.res, { slug: 'scout' }, contextRoot);
    expect(u.status()).toBe(200);
    const after = getRunTarget(contextRoot, 'scout', 'agent')!;
    expect(after).toMatchObject({ timeoutMinutes: before.timeoutMinutes, outputDir: before.outputDir, review: before.review });
  });

  it('delete is refused while an automation runs as it, then removes it', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' });
    const d = makeRes();
    await handleAgentsDelete(post(), d.res, { slug: 'writer' }, contextRoot);
    expect(d.status()).toBe(409);
    expect(d.body()).toMatchObject({ error: 'agent_in_use', usedBy: ['daily-notes'] });

    createAgent(contextRoot, { slug: 'loner', title: 'Loner', prompt: 'Alone.' }, { approve: { now: NOW } });
    const ok = makeRes();
    await handleAgentsDelete(post(), ok.res, { slug: 'loner' }, contextRoot);
    expect(ok.status()).toBe(200);
    expect((await list()).map((a) => a.slug)).toEqual(['writer']);
  });

  it('approve grants the call target, so a scheduled agent may then run', async () => {
    const digest = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write.', days: 'daily', at: '18:00' });
    approveAutomation(projectRoot, digest, NOW);
    const a = makeRes();
    await handleAgentsApprove(post(), a.res, { slug: 'digest' }, contextRoot);
    expect(a.status()).toBe(200);
    expect(a.body().agent).toMatchObject({ approvedToRun: true });
    // The job's own record is untouched by the agent's grant.
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'digest', 'automation')!, undefined, 'run').approved).toBe(true);
  });

  it('404s an unknown or unsafe slug on every :slug route', async () => {
    for (const slug of ['nobody', '../x']) {
      const s = makeRes();
      await handleAgentsShow(getReq, s.res, { slug }, contextRoot);
      expect(s.status()).toBe(404);
      const a = makeRes();
      await handleAgentsApprove(post(), a.res, { slug }, contextRoot);
      expect(a.status()).toBe(404);
    }
  });
});

describe('the soul and the pattern', () => {
  const SOUL = 'Lead with the worst problem.\n- No praise, no softening.';

  async function show(slug: string): Promise<Record<string, unknown>> {
    const s = makeRes();
    await handleAgentsShow(getReq, s.res, { slug }, contextRoot);
    expect(s.status()).toBe(200);
    return s.body();
  }

  async function update(slug: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const u = makeRes();
    await handleAgentsUpdate(post(body), u.res, { slug }, contextRoot);
    return { status: u.status(), body: u.body() };
  }

  it('GET detail returns the full soul and the parsed pattern, newest lesson first', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout the market.', soul: SOUL, learning: true }, { approve: { now: NOW } });
    recordAgentLesson(contextRoot, 'scout', { lesson: 'Check the date first.', now: new Date('2026-10-01T09:00:00Z') });
    recordAgentLesson(contextRoot, 'scout', { lesson: 'Name the source.', now: new Date('2026-10-02T09:00:00Z') });
    const detail = await show('scout');
    expect(detail.soul).toBe(SOUL);
    expect(detail.pattern).toEqual({
      playbook: '',
      lessons: [
        { date: '2026-10-02', text: 'Name the source.' },
        { date: '2026-10-01', text: 'Check the date first.' },
      ],
    });
    expect(String(detail.review)).toContain('soul:');
  });

  it("an agent without a soul or a pattern reads soul '' and an empty pattern", async () => {
    createAgent(contextRoot, { slug: 'quiet', title: 'Quiet', prompt: 'Stay quiet.' }, { approve: { now: NOW } });
    const detail = await show('quiet');
    expect(detail.soul).toBe('');
    expect(detail.pattern).toEqual({ playbook: '', lessons: [] });
  });

  it('the list carries a one-line soul excerpt (at most 160) and the role line', async () => {
    const longSoul = `${'Be precise. '.repeat(30)}\nNever guess.`;
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: '# Scout the market\nThen report.', soul: longSoul }, { approve: { now: NOW } });
    createAgent(contextRoot, { slug: 'quiet', title: 'Quiet', prompt: 'Stay quiet.' }, { approve: { now: NOW } });
    const [quiet, scout] = await list();
    expect(scout.soulExcerpt.length).toBeLessThanOrEqual(160);
    expect(scout.soulExcerpt).not.toContain('\n');
    expect(scout.soulExcerpt.startsWith('Be precise.')).toBe(true);
    expect(scout.roleLine).toBe('Scout the market');
    expect(quiet.soulExcerpt).toBe('');
    expect(quiet.roleLine).toBe('Stay quiet.');
  });

  it('POST create with a soul writes it, and the agent is approved for run', async () => {
    const c = makeRes();
    await handleAgentsCreate(post({ title: 'Reviewer', prompt: 'Review pull requests.', soul: SOUL }), c.res, {}, contextRoot);
    expect(c.status()).toBe(200);
    expect(c.body().agent).toMatchObject({ slug: 'reviewer', approvedToRun: true });
    expect(getAgent(contextRoot, 'reviewer')?.soul).toBe(SOUL);
  });

  it("update with a soul keeps a direct grant; soul '' clears it", async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.' }, { approve: { now: NOW } });
    const set = await update('scout', { soul: SOUL });
    expect(set.status).toBe(200);
    expect(set.body.agent).toMatchObject({ approvedToRun: true });
    expect(getAgent(contextRoot, 'scout')?.soul).toBe(SOUL);
    const cleared = await update('scout', { soul: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.agent).toMatchObject({ approvedToRun: true, soulExcerpt: '' });
    expect(getAgent(contextRoot, 'scout')?.soul).toBe('');
  });

  it('refuses a non-text soul, an over-cap one and one with a "## " line with 400, writing nothing', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scout.', soul: 'Be calm.' }, { approve: { now: NOW } });
    for (const soul of [5, 'x'.repeat(2001), 'Be terse.\n## Tone\nDry.']) {
      const out = await update('scout', { soul });
      expect(out.status).toBe(400);
      expect(out.body.error).toBe('invalid');
    }
    expect(getAgent(contextRoot, 'scout')?.soul).toBe('Be calm.');
    const c = makeRes();
    await handleAgentsCreate(post({ title: 'Bad', prompt: 'P', soul: '## Flow' }), c.res, {}, contextRoot);
    expect(c.status()).toBe(400);
    expect(getAgent(contextRoot, 'bad')).toBeNull();
  });
});
