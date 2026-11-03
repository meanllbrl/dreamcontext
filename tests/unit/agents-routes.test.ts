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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
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

  it('withRoutines: a dry run names the routines and changes nothing; the delete removes routines, then the member, revokes, and leaves a trash copy with a receipt (plan r4 F2-F5)', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    const daily = createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' });
    approveAutomation(projectRoot, daily, NOW);
    const dry = makeRes();
    await handleAgentsDelete(post({ withRoutines: true, dryRun: true }), dry.res, { slug: 'writer' }, contextRoot);
    expect(dry.status()).toBe(200);
    expect(dry.body().plan).toMatchObject({ slug: 'writer', title: 'Writer', global: false, blockers: [], routines: [{ slug: 'daily-notes', title: 'Daily notes' }] });
    expect(getAgent(contextRoot, 'writer')).not.toBeNull();
    expect(existsSync(join(contextRoot, 'automations', 'daily-notes.md'))).toBe(true);

    const del = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), del.res, { slug: 'writer' }, contextRoot);
    expect(del.status()).toBe(200);
    expect(getAgent(contextRoot, 'writer')).toBeNull();
    expect(existsSync(join(contextRoot, 'automations', 'daily-notes.md'))).toBe(false);
    // The routine's approval went with it: one re-created under the same slug is not approved.
    const again = createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', prompt: 'x', days: 'daily', at: '08:00' });
    expect(checkApproval(projectRoot, again).approved).toBe(false);
    // A trash copy with a receipt naming each file.
    const trash = join(projectRoot, String(del.body().trash));
    const receipt = JSON.parse(readFileSync(join(trash, 'receipt.json'), 'utf-8'));
    expect(receipt).toMatchObject({ member: 'writer', routines: [{ slug: 'daily-notes' }], left: [] });
    expect(receipt.files.map((f: { to: string }) => f.to)).toEqual(expect.arrayContaining([join('routines', basename(projectRoot), 'daily-notes.md')]));
    expect(existsSync(join(trash, 'routines', basename(projectRoot), 'daily-notes.md'))).toBe(true);
    expect(readFileSync(join(contextRoot, 'state', '.trash', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('withRoutines: a member whose stage cannot be stopped keeps its routines (all or nothing)', async () => {
    const { deleteMember } = await import('../../src/server/member-delete.js');
    const { superRecordPath } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    const { writeFileSync } = await import('node:fs');
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' });
    mkdirSync(join(contextRoot, 'state', '.super', 'members'), { recursive: true });
    writeFileSync(superRecordPath(contextRoot, 'm:writer'), JSON.stringify({ ...emptySuperState(), session: null, enabled: false, member: 'writer' }));
    const out = await deleteMember(contextRoot, 'writer', { stopSuper: async () => { throw new Error('stuck'); }, retireSuper: () => undefined });
    expect(out?.ok).toBe(false);
    expect(out?.left.length).toBeGreaterThan(0);
    expect(existsSync(join(contextRoot, 'automations', 'daily-notes.md'))).toBe(true);
    expect(getAgent(contextRoot, 'writer')).not.toBeNull();
  });

  it('withRoutines: an unsplit scheduled member goes with its own manifest and its grant', async () => {
    const digest = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '18:00' });
    approveAutomation(projectRoot, digest, NOW);
    const dry = makeRes();
    await handleAgentsDelete(post({ withRoutines: true, dryRun: true }), dry.res, { slug: 'digest' }, contextRoot);
    expect(dry.body().plan).toMatchObject({ routines: [], blockers: [] });
    const del = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), del.res, { slug: 'digest' }, contextRoot);
    expect(del.status()).toBe(200);
    expect(getAgent(contextRoot, 'digest')).toBeNull();
    expect(existsSync(join(contextRoot, 'automations', 'digest.md'))).toBe(false);
    const again = createAutomation(contextRoot, { slug: 'digest', title: 'Digest', prompt: 'Write the digest.', days: 'daily', at: '18:00' });
    expect(checkApproval(projectRoot, again).approved).toBe(false);
  });

  it('withRoutines: a planted trash .gitignore is overwritten with *, a symlinked one refuses the delete', async () => {
    const { writeFileSync, symlinkSync } = await import('node:fs');
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    mkdirSync(join(contextRoot, 'state', '.trash'), { recursive: true });
    symlinkSync(join(projectRoot, 'elsewhere'), join(contextRoot, 'state', '.trash', '.gitignore'));
    const refused = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), refused.res, { slug: 'writer' }, contextRoot);
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    expect(getAgent(contextRoot, 'writer')).not.toBeNull();
    expect(existsSync(join(projectRoot, 'elsewhere'))).toBe(false);
    rmSync(join(contextRoot, 'state', '.trash', '.gitignore'));
    writeFileSync(join(contextRoot, 'state', '.trash', '.gitignore'), '!*\n');
    const del = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), del.res, { slug: 'writer' }, contextRoot);
    expect(del.status()).toBe(200);
    expect(readFileSync(join(contextRoot, 'state', '.trash', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('withRoutines is refused from the phone and from outside the owner\'s page; without it the 409 stands', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    createAutomation(contextRoot, { slug: 'daily-notes', title: 'Daily notes', agent: 'writer', days: 'daily', at: '08:00' });
    const bare = Object.assign(Readable.from([Buffer.from(JSON.stringify({ withRoutines: true }))]), { method: 'POST', headers: {} }) as unknown as IncomingMessage;
    const r = makeRes();
    await handleAgentsDelete(bare, r.res, { slug: 'writer' }, contextRoot);
    expect(r.status()).toBe(403);
    expect(getAgent(contextRoot, 'writer')).not.toBeNull();
    const old = makeRes();
    await handleAgentsDelete(post(), old.res, { slug: 'writer' }, contextRoot);
    expect(old.status()).toBe(409);
  });

  it('withRoutines: refused while the member works for main (open request); its Super record and marks go to the trash and leave the index', async () => {
    const { superRecordPath, superReadMarksPath, superIndex, primeSuperIndex, resetSuperIndex } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    const { writeFileSync } = await import('node:fs');
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Write.' }, { approve: { now: NOW } });
    mkdirSync(join(contextRoot, 'state', '.super', 'members'), { recursive: true });
    const rec = (queue: unknown[]) => writeFileSync(superRecordPath(contextRoot, 'm:writer'), JSON.stringify({ ...emptySuperState(), session: 'sess-w', enabled: true, member: 'writer', queue }));
    rec([{ id: 'q-1', kind: 'request', state: 'delivered', createdAt: 1, sessionId: 'sess-main', text: 'go' }]);
    writeFileSync(superReadMarksPath(contextRoot, 'm:writer'), JSON.stringify({ since: 1, read: [], replies: [5] }));
    resetSuperIndex();
    await primeSuperIndex([contextRoot]);
    const busy = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), busy.res, { slug: 'writer' }, contextRoot);
    expect(busy.status()).toBe(409);
    expect(busy.body().error).toBe('member_working');
    expect(getAgent(contextRoot, 'writer')).not.toBeNull();
    rec([]);
    resetSuperIndex();
    await primeSuperIndex([contextRoot]);
    const del = makeRes();
    await handleAgentsDelete(post({ withRoutines: true }), del.res, { slug: 'writer' }, contextRoot);
    expect(del.status()).toBe(200);
    expect(existsSync(superRecordPath(contextRoot, 'm:writer'))).toBe(false);
    expect(existsSync(superReadMarksPath(contextRoot, 'm:writer'))).toBe(false);
    expect([...superIndex(contextRoot).keys()]).toEqual(['main']);
    const trash = join(projectRoot, String(del.body().trash));
    expect(existsSync(join(trash, 'super', basename(projectRoot), 'writer.json'))).toBe(true);
    expect(existsSync(join(trash, 'super', basename(projectRoot), 'writer.read-marks.json'))).toBe(true);
    resetSuperIndex();
  });

  it('withRoutines on a GLOBAL member: its routine in another project is named by project and removed with it', async () => {
    const { addVault } = await import('../../src/lib/vaults.js');
    const other = mkdtempSync(join(tmpdir(), 'dc-agents-routes-'));
    try {
      const otherCtx = join(other, '_dream_context');
      mkdirSync(join(otherCtx, 'automations'), { recursive: true });
      addVault('acme', projectRoot, fakeHome);
      addVault('globex', other, fakeHome);
      const c = makeRes();
      await handleAgentsCreate(post({ title: 'Critic', prompt: 'You review.', scope: 'global' }), c.res, {}, contextRoot);
      expect(c.status()).toBe(200);
      createAutomation(otherCtx, { slug: 'weekly-review', title: 'Weekly review', agent: 'critic', days: 'daily', at: '09:00' });
      const dry = makeRes();
      await handleAgentsDelete(post({ withRoutines: true, dryRun: true }), dry.res, { slug: 'critic' }, contextRoot);
      expect(dry.body().plan).toMatchObject({ global: true, routines: [{ project: 'globex', slug: 'weekly-review' }] });
      const del = makeRes();
      await handleAgentsDelete(post({ withRoutines: true }), del.res, { slug: 'critic' }, contextRoot);
      expect(del.status()).toBe(200);
      expect(existsSync(join(otherCtx, 'automations', 'weekly-review.md'))).toBe(false);
      expect(getAgent(contextRoot, 'critic')).toBeNull();
      expect(getAgent(otherCtx, 'critic')).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
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
