import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAutomation, getAutomation } from '../../src/lib/automations/store.js';
import { checkApproval } from '../../src/lib/automations/registry.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { handleAgentsApprove, handleAgentsSetEnabled } from '../../src/server/routes/agents.js';
import { AUTOMATION_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { sanitizeSuperState, SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, type SuperQueueItem } from '../../src/lib/super/types.js';
import { superBriefing } from '../../src/server/chat-modes.js';
import { superApprovals, superApprovalSentence, agendaApprovals } from '../../dashboard/src/components/sleepy/super/superApprovals.js';
import { OWNER_PAGE_HEADERS } from '../helpers/owner-page.js';

/**
 * AI Team approvals are asked on the Super Agent's screen (owner 2026-11-06): what waits for his
 * approval on this Mac is one card above the Super's chat and one Waiting on you row each; his
 * decision reaches the Super as an event; neither the Super nor a child can give it.
 */

function makeRes() {
  let code = 0;
  let body: unknown = null;
  const res = {
    writeHead(c: number) { code = c; },
    end(d: string) { try { body = JSON.parse(d); } catch { body = d; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => code, body: () => body as Record<string, unknown> };
}
function post(body: unknown, headers: Record<string, string>): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body ?? {}), 'utf-8')]);
  return Object.assign(r, { method: 'POST', url: '/', headers }) as unknown as IncomingMessage;
}
const owner = (body?: unknown) => post(body, { ...OWNER_PAGE_HEADERS });
/** What the Super Agent's or a child's `curl` sends: no Origin. */
const bare = (body?: unknown) => post(body, { host: '127.0.0.1:4173' });

const agent = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, title: slug.toUpperCase(), approvedForChat: false, approvedToRun: false, approvalReason: 'never-approved', enabled: true, ...extra,
});
const routine = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug, title: `Routine ${slug}`, agent: 'scout', approved: false, approvalReason: 'never-approved', enabled: true, runKind: 'automation' as const, ...extra,
});

describe('what waits for his approval (superApprovals)', () => {
  it('lists an unapproved member that is on and an unapproved routine that is on, nothing else', () => {
    const rows = superApprovals(
      [
        agent('scout'),
        agent('approved', { approvedForChat: true, approvedToRun: true, approvalReason: null }),
        agent('teammate', { readOnly: true }),
        agent('foreign', { approvalReason: 'not_owner' }),
        agent('switched-off', { enabled: false }),
        agent('changed', { approvalReason: 'manifest-changed' }),
        // An older server sends no `enabled`: it still waits.
        { slug: 'old', title: 'Old', approvedForChat: true, approvedToRun: false, approvalReason: 'never-approved' },
      ] as never,
      [
        routine('daily'),
        routine('off-one', { enabled: false }),
        routine('done', { approved: true, approvalReason: null }),
        routine('theirs', { approvalReason: 'not_owner' }),
        routine('scout', { runKind: 'agent' }),
        routine('changed-r', { approvalReason: 'manifest-changed' }),
      ] as never,
    );
    expect(rows.map((r) => r.key)).toEqual(['agent:scout', 'agent:changed', 'agent:old', 'routine:daily', 'routine:changed-r']);
    expect(rows.find((r) => r.key === 'agent:changed')?.changed).toBe(true);
    expect(rows.find((r) => r.key === 'routine:daily')).toMatchObject({ memberTitle: 'SCOUT', changed: false });
  });

  it('a split member\'s scheduled job is a grant of its own: both rows wait', () => {
    const rows = superApprovals([agent('scout')], [routine('scout', { agent: 'scout' })]);
    expect(rows.map((r) => r.key)).toEqual(['agent:scout', 'routine:scout']);
  });

  it('Waiting on you does not list twice what a `super team ask` already asks about (either kind)', () => {
    const rows = superApprovals([agent('scout'), agent('writer')], [routine('scout', { agent: 'scout' }), routine('daily')]);
    const queue = [
      { kind: 'approval', state: 'pending', member: 'scout' },
      { kind: 'approval', state: 'done', member: 'writer' },
      { kind: 'question', state: 'pending', member: 'daily' },
    ];
    expect(agendaApprovals(rows, queue).map((r) => r.key)).toEqual(['agent:writer', 'routine:daily']);
    expect(agendaApprovals(rows, []).length).toBe(4);
  });

  it('a member or routine working on its approved version while a change waits is listed, said as such (owner 2026-11-08)', () => {
    const change = { member: 'scout', by: 'teammate' as const, who: 'mate', at: null, fields: ['prompt'], risks: [], runsOnApproved: true };
    const rows = superApprovals(
      [agent('scout', { approvedForChat: true, approvedToRun: true, approvalReason: null, pendingChange: change } as never), agent('calm', { approvedForChat: true, approvedToRun: true, approvalReason: null })],
      [routine('daily', { approved: true, approvalReason: null, changeWaits: true } as never), routine('quiet', { approved: true, approvalReason: null })],
    );
    expect(rows.map((r) => `${r.key}:${r.keepsWorking === true}`)).toEqual(['agent:scout:true', 'routine:daily:true']);
    const t = (k: string) => ({ 'aiteam.approval.keepsWorking': '{name} keeps working', 'aiteam.approval.routineKeepsWorking': '{routine} keeps running' } as Record<string, string>)[k] ?? k;
    expect(rows.map((r) => superApprovalSentence(r, t))).toEqual(['SCOUT keeps working', 'Routine daily keeps running'].map((x, i) => (i === 0 ? x.replace('SCOUT', rows[0].title) : x.replace('Routine daily', rows[1].title))));
  });

  it('nothing loaded yet is nothing waiting', () => {
    expect(superApprovals(undefined, undefined)).toEqual([]);
  });

  it('a row is said in the AI Team page\'s own words', () => {
    const t = (k: string) => ({
      'aiteam.approval.talkNew': '{name} new', 'aiteam.approval.talkChanged': '{name} changed',
      'aiteam.approval.routineNew': '{routine} new', 'aiteam.approval.routineChanged': '{routine} changed',
    } as Record<string, string>)[k] ?? k;
    const [m, r] = superApprovals([agent('scout')] as never, [routine('daily', { approvalReason: 'manifest-changed' })] as never);
    expect(superApprovalSentence(m, t)).toBe('SCOUT new');
    expect(superApprovalSentence(r, t)).toBe('Routine daily changed');
  });
});

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-superappr-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  realHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), 'dc-superappr-home-'));
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('only the owner\'s page decides', () => {
  it('the Super Agent or a child (no Origin) can neither approve nor decline a member', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes the weekly note.' });
    for (const call of [
      (req: IncomingMessage, res: ServerResponse) => handleAgentsApprove(req, res, { slug: 'writer' }, contextRoot),
      (req: IncomingMessage, res: ServerResponse) => handleAgentsSetEnabled(req, res, { slug: 'writer' }, contextRoot),
    ]) {
      const r = makeRes();
      await call(bare({ enabled: false, sessionId: 'sup-1' }), r.res);
      expect([r.status(), r.body().error]).toEqual([403, 'owner_page_only']);
    }
    const m = getAutomation(contextRoot, 'writer')!;
    expect(checkApproval(projectRoot, m, undefined, 'run').approved).toBe(false);
    expect(m.enabled).toBe(true);
  });

  it('his Approve grants it, his Decline turns it off and keeps the file', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes the weekly note.' });
    const a = makeRes();
    // A session id that belongs to no Super: still approved, nobody told.
    await handleAgentsApprove(owner({ sessionId: 'not-a-super' }), a.res, { slug: 'writer' }, contextRoot);
    expect(a.status()).toBe(200);
    expect(checkApproval(projectRoot, getAutomation(contextRoot, 'writer')!, undefined, 'run').approved).toBe(true);
    expect((a.body().agent as { enabled: boolean }).enabled).toBe(true);
    const d = makeRes();
    await handleAgentsSetEnabled(owner({ enabled: false, sessionId: 'not-a-super' }), d.res, { slug: 'writer' }, contextRoot);
    expect(d.status()).toBe(200);
    expect(getAutomation(contextRoot, 'writer')!.enabled).toBe(false);
    expect((d.body().agent as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('the Super Agent hears a member decision', () => {
  it('a member decision survives the sanitizer with its member and decision, never with a hostile slug', () => {
    const base = { ...emptySuperState(), session: 'sup', enabled: true };
    const items = [
      { id: 'q-m1', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 1, member: 'writer', decision: 'rejected' },
      { id: 'q-m2', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 2, member: '../x', decision: 'approved' },
      { id: 'q-m3', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 3, member: 'writer' },
      // Both named: the member wins, the automation is dropped (one subject per decision).
      { id: 'q-m4', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 4, member: 'writer', automation: 'daily', decision: 'approved' },
    ];
    const s = sanitizeSuperState({ ...base, queue: items });
    expect(s.queue.map((q) => q.id)).toEqual(['q-m1', 'q-m4']);
    expect(s.queue[0]).toMatchObject({ member: 'writer', decision: 'rejected' });
    expect(s.queue[1].automation).toBeUndefined();
  });

  it('its event line names the member and its live state, and the batch says what to do', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes the weekly note.' });
    const state = { ...emptySuperState(), session: 'sup', enabled: true };
    const item: SuperQueueItem = { id: 'q-m1', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 1, member: 'writer', decision: 'approved' };
    expect(superBatchText(contextRoot, state, [item], 'b-0')).toContain('- item=q-m1 event=automation member=writer decision=approved state=not-approved');
    await handleAgentsApprove(owner({}), makeRes().res, { slug: 'writer' }, contextRoot);
    const text = superBatchText(contextRoot, state, [item], 'b-1');
    expect(text).toContain('- item=q-m1 event=automation member=writer decision=approved state=on');
    expect(text).toContain('title: "Writer"');
    expect(text).toContain(AUTOMATION_LINE);
    expect(AUTOMATION_LINE).toContain('member=<slug>');
    const gone: SuperQueueItem = { ...item, id: 'q-m2', member: 'removed-since' };
    expect(superBatchText(contextRoot, state, [gone], 'b-2')).toContain('member=removed-since decision=approved state=gone');
  });

  it('an automation decision still reads as before', () => {
    const m = createAutomation(contextRoot, { slug: 'daily', title: 'Daily', days: 'daily', at: '09:00', prompt: 'Post the digest.\n' });
    const item: SuperQueueItem = { id: 'q-a1', sessionId: 'sup', kind: 'automation', state: 'pending', createdAt: 1, automation: m.slug, decision: 'rejected' };
    expect(superBatchText(contextRoot, { ...emptySuperState(), session: 'sup', enabled: true }, [item], 'b-1')).toContain(`event=automation automation=${m.slug} decision=rejected`);
  });
});

describe('his decision reaches the live Super', () => {
  const SUP = 'sup-live-1';
  beforeEach(async () => {
    resetSuperIndex();
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUP, enabled: true }));
    await readSuperState(contextRoot);
  });
  afterEach(() => resetSuperIndex());

  it('Approve and Decline from his page queue a member event in the main Super, the decision intact', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes the weekly note.' });
    const a = makeRes();
    await handleAgentsApprove(owner({ sessionId: SUP }), a.res, { slug: 'writer' }, contextRoot);
    expect(a.status()).toBe(200);
    const d = makeRes();
    await handleAgentsSetEnabled(owner({ enabled: false, sessionId: SUP }), d.res, { slug: 'writer' }, contextRoot);
    expect(d.status()).toBe(200);
    const events = (await readSuperState(contextRoot)).queue.filter((q) => q.kind === 'automation');
    expect(events.map((q) => [q.member, q.decision, q.automation, q.sessionId])).toEqual([
      ['writer', 'approved', undefined, SUP],
      ['writer', 'rejected', undefined, SUP],
    ]);
  });

  it('turning a member back ON is not a decision: nothing is queued', async () => {
    createAgent(contextRoot, { slug: 'writer', title: 'Writer', prompt: 'Writes the weekly note.' });
    await handleAgentsSetEnabled(owner({ enabled: true, sessionId: SUP }), makeRes().res, { slug: 'writer' }, contextRoot);
    expect((await readSuperState(contextRoot)).queue.filter((q) => q.kind === 'automation')).toEqual([]);
  });

  it('the member event reads the MEMBER, never its same-slug scheduled job', async () => {
    createAgent(contextRoot, { slug: 'scout', title: 'Scout', prompt: 'Scouts the market.' });
    createAutomation(contextRoot, { slug: 'scout', title: 'Scout weekly', days: 'daily', at: '09:00', prompt: 'Scan.\n', agent: 'scout' } as Parameters<typeof createAutomation>[1]);
    await handleAgentsApprove(owner({}), makeRes().res, { slug: 'scout' }, contextRoot);
    const item: SuperQueueItem = { id: 'q-s1', sessionId: SUP, kind: 'automation', state: 'pending', createdAt: 1, member: 'scout', decision: 'approved' };
    const text = superBatchText(contextRoot, { ...emptySuperState(), session: SUP, enabled: true }, [item], 'b-s');
    expect(text).toContain('member=scout decision=approved state=on');
  });
});

describe('the Super is told where his approvals are, and never to give one', () => {
  it('the main Super\'s briefing says it in one bullet; a member\'s Super has no AI Team section', () => {
    const b = superBriefing();
    expect(b).toContain('Set up something that waits for his approval here');
    expect(b).toContain('never approve it.');
  });

  it('the card posts the super\'s session to the owner-only routes, and the agenda lists the rows', () => {
    const band = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperApprovalBand.tsx', import.meta.url), 'utf-8');
    expect(band).toContain('`/automations/${slug}/${decision === \'approved\' ? \'approve\' : \'reject\'}`, { sessionId }');
    expect(band).toContain('`/agents/${slug}/approve`, { sessionId }');
    expect(band).toContain('`/agents/${slug}/enabled`, { enabled: false, sessionId }');
    const surface = readFileSync(new URL('../../dashboard/src/components/sleepy/super/SuperSurface.tsx', import.meta.url), 'utf-8');
    expect(surface).toContain('approvals={agendaApprovals}');
    expect(surface).toContain('<SuperApprovalBand items={approvals} superId={superId} toast={approvalNote} onToast={setApprovalNote} />');
    expect(surface).toContain('agendaApprovalRows(approvals, state.queue)');
  });
});
