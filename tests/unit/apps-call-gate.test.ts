import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callClaim, decodeClaim, encodeClaim, type CallClass } from '../../src/lib/apps/call-claim.js';
import { runHeader } from '../../src/lib/apps/client.js';
import type { AppAction } from '../../src/lib/apps/manifest.js';
import type { AppRecord } from '../../src/lib/apps/registry.js';

/**
 * The one gate every app tool call passes (app-araclari plan r3 §4.1, §4.2, and the security
 * re-review of 2026-11-07): who is asking (the class an env names, first match wins), a change
 * needs `confirm`, Super and its children never, an unattended run only with its approved
 * `app_tools` or in a turn the owner started from the dashboard.
 */

describe('callClaim: every real env names its class (first match wins)', () => {
  // Each row is a real spawner's env, named by where it is set.
  const table: Array<[string, NodeJS.ProcessEnv, CallClass]> = [
    ["owner's main Chat (SUPER_CREW cleared to '')", { DREAMCONTEXT_SUPER_CREW: '', DREAMCONTEXT_MEMBER_SUPER: '', DREAMCONTEXT_MEMBER_CREW: '', DREAMCONTEXT_CHAT_TAB: '1' }, 'owner'],
    ["owner's terminal", {}, 'owner'],
    ['app own chat (AGENT_CHAT=app-<slug>)', { DREAMCONTEXT_AGENT_CHAT: 'app-yuk-izleme', DREAMCONTEXT_SUPER_CREW: '' }, 'chat'],
    ['member chat tab', { DREAMCONTEXT_AGENT_CHAT: 'ua-manager', DREAMCONTEXT_SUPER_CREW: '' }, 'chat'],
    ['board card chat, scoped (AGENT_SELF too, no run)', { DREAMCONTEXT_AGENT_CHAT: 'ua-manager', DREAMCONTEXT_AGENT_SELF: 'ua-manager', DREAMCONTEXT_AGENT_BOARD: 'b' }, 'chat'],
    ['board card chat, unscoped', { DREAMCONTEXT_AGENT_CHAT: 'card-x' }, 'chat'],
    ['Super session', { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_CHAT_TAB: '1' }, 'crew'],
    ['Super child', { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_AGENT_CHAT: '' }, 'crew'],
    ["a member Super's child", { DREAMCONTEXT_MEMBER_CREW: 'ua-manager', DREAMCONTEXT_AGENT_CHAT: 'ua-manager' }, 'crew'],
    ['automation run env (runner.ts)', { DREAMCONTEXT_AUTOMATION_SLUG: 'nightly', DREAMCONTEXT_AUTOMATION_RUN: '2026-11-07T08:00:00.000Z', DREAMCONTEXT_AUTOMATION_SLOT: '' }, 'run'],
    ['agent run with AGENT_SELF and a chat mark (run wins over chat)', { DREAMCONTEXT_AGENT_CHAT: 'x', DREAMCONTEXT_AGENT_SELF: 'ua', DREAMCONTEXT_AUTOMATION_RUN: 'r' }, 'run'],
    ['scoped agent run with only AGENT_SELF', { DREAMCONTEXT_AGENT_SELF: 'ua' }, 'run'],
    ['reply job env (automation-job.ts)', { DREAMCONTEXT_AUTOMATION_SLUG: 'ua', DREAMCONTEXT_AUTOMATION_RUN: 'r1' }, 'run'],
    ['peer delivery', { DREAMCONTEXT_SPAWNED: 'peer' }, 'spawned'],
    ['cross-tool ask', { DREAMCONTEXT_ASK_DEPTH: '1', DREAMCONTEXT_SPAWNED: 'other' }, 'spawned'],
    ['builder', { DREAMCONTEXT_SPAWNED: 'develop' }, 'spawned'],
    ['background sleep', { DREAMCONTEXT_AUTO_SLEEP: '1' }, 'spawned'],
    ['a peer inside an automation run: spawned beats run', { DREAMCONTEXT_SPAWNED: 'peer', DREAMCONTEXT_AUTOMATION_RUN: 'r' }, 'spawned'],
    ['Super crew inside a chat: crew beats chat', { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_AGENT_CHAT: 'x' }, 'crew'],
  ];
  it.each(table)('%s', (_name, env, want) => {
    expect(callClaim(env).class).toBe(want);
  });

  it('a run carries its job and run id; empty strings count as unset', () => {
    expect(callClaim({ DREAMCONTEXT_AUTOMATION_SLUG: 'nightly', DREAMCONTEXT_AUTOMATION_RUN: 'R' })).toEqual({ class: 'run', automation: 'nightly', run: 'R' });
    expect(callClaim({ DREAMCONTEXT_SPAWNED: '', DREAMCONTEXT_SUPER_CREW: '  ', DREAMCONTEXT_AGENT_CHAT: '' }).class).toBe('owner');
  });

  it('the header: absent is the owner, unreadable or unknown only takes rights away', () => {
    expect(decodeClaim(undefined).class).toBe('owner');
    expect(decodeClaim('not json').class).toBe('spawned');
    expect(decodeClaim('{"class":"admin"}').class).toBe('spawned');
    expect(decodeClaim(encodeClaim({ class: 'run', automation: 'n', run: 'r' }))).toEqual({ class: 'run', automation: 'n', run: 'r' });
    expect(JSON.parse(runHeader({ DREAMCONTEXT_TAB_SESSION: '11111111-2222-3333-4444-555555555555', DREAMCONTEXT_SUPER_CREW: '1' })['x-dc-run'])).toEqual({ class: 'crew', sessions: ['11111111-2222-3333-4444-555555555555'] });
  });
});

describe('gateAppCall', () => {
  let ctx: string;
  let home: string;
  const savedHome = process.env.HOME;
  const actions: AppAction[] = [
    { id: 'snapshot', title: 'One reading', method: 'GET', path: '/api/yuk' },
    { id: 'notify-test', title: 'Send a test notification', method: 'POST', path: '/api/notify-test', does: 'Sends a banner.' },
    { id: 'wipe', title: 'Wipe', method: 'GET', path: '/api/wipe', danger: true },
    { id: 'claims-read', title: 'A POST that says it reads', method: 'POST', path: '/api/q', effect: 'read', timeoutSec: 120 },
  ];
  let rec: AppRecord;
  type Gate = typeof import('../../src/server/routes/apps.js').gateAppCall;
  let gate: Gate;
  let seed: typeof import('../../src/server/automation-job.js').__seedJobForTest;
  let clear: typeof import('../../src/server/automation-job.js').__clearJobsForTest;

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gate-home-')));
    process.env.HOME = home;
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'dc-gate-proj-')));
    ctx = join(project, '_dream_context');
    mkdirSync(join(ctx, 'automations'), { recursive: true });
    rec = { slug: 'yuk', name: 'Yük', projectRoot: project, root: join(project, 'yuk'), vault: 'v', hash: 'abcdef0123456789' } as AppRecord;
    ({ gateAppCall: gate } = await import('../../src/server/routes/apps.js'));
    ({ __seedJobForTest: seed, __clearJobsForTest: clear } = await import('../../src/server/automation-job.js'));
  });
  afterAll(() => { process.env.HOME = savedHome; });
  afterEach(() => clear());

  const call = (method: string, path: string, cls: CallClass, extra: Record<string, unknown> = {}) =>
    gate(ctx, rec, actions, { method, path, confirm: false, claim: { class: cls }, ...extra }, { home });

  it('a read passes for every class, even spawned; its timeout is the tool\'s', () => {
    for (const cls of ['spawned', 'crew', 'chat', 'run', 'owner'] as const) {
      const v = call('GET', '/api/yuk?x=1', cls);
      expect(v).toMatchObject({ ok: true, effect: 'read', timeoutMs: 60_000 });
    }
  });

  it('effect: GET reads, danger changes, a POST that says "read" still changes, unlisted non-GET changes', () => {
    expect(call('GET', '/api/wipe', 'owner')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(call('POST', '/api/q', 'owner')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(call('DELETE', '/anything', 'owner')).toMatchObject({ ok: false, code: 'needs_confirm', http: 409 });
    expect(call('GET', '/not-listed', 'owner')).toMatchObject({ ok: true, effect: 'read' });
  });

  it('no confirm: 409 needs_confirm with what the tool would do, for every class', () => {
    for (const cls of ['spawned', 'crew', 'chat', 'run', 'owner'] as const) {
      const v = call('POST', '/api/notify-test', cls);
      expect(v).toMatchObject({ ok: false, http: 409, code: 'needs_confirm', tool: { id: 'notify-test', does: 'Sends a banner.' } });
    }
  });

  it('confirm: the owner and a chat pass; spawned and crew never', () => {
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true })).toMatchObject({ ok: true, effect: 'change' });
    expect(call('POST', '/api/notify-test', 'chat', { confirm: true })).toMatchObject({ ok: true });
    expect(call('POST', '/api/notify-test', 'spawned', { confirm: true })).toMatchObject({ ok: false, http: 403, code: 'needs_owner' });
    expect(call('POST', '/api/notify-test', 'crew', { confirm: true })).toMatchObject({ ok: false, http: 403, code: 'needs_owner' });
    expect(call('POST', '/api/q', 'owner', { confirm: true })).toMatchObject({ ok: true, timeoutMs: 120_000 });
  });

  it('a Super conversation is crew whatever its header claims (an adopted owner chat)', async () => {
    const { noteSuperState } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    const kid = '0f0f0f0f-1111-2222-3333-444444444444';
    noteSuperState(ctx, { ...emptySuperState(), session: 'aaaaaaaa-1111-2222-3333-444444444444', enabled: true, children: { [kid]: { sessionId: kid, brief: '', adopted: true, startedAt: 1 } } } as never);
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true, sessions: [kid] })).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(call('POST', '/api/notify-test', 'chat', { confirm: true, sessions: ['aaaaaaaa-1111-2222-3333-444444444444'] })).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true, sessions: ['99999999-1111-2222-3333-444444444444'] })).toMatchObject({ ok: true });
    noteSuperState(ctx, emptySuperState() as never);
  });

  describe('an unattended run', () => {
    const run = (automation: string | undefined, runId?: string) =>
      gate(ctx, rec, actions, { method: 'POST', path: '/api/notify-test', confirm: true, claim: { class: 'run', ...(automation ? { automation } : {}), ...(runId ? { run: runId } : {}) } }, { home });

    it('with no approved app_tools and no owner turn: needs_owner', () => {
      expect(run('nightly', 'R')).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(run(undefined)).toMatchObject({ ok: false, code: 'needs_owner' });
    });

    it('passes only with this tool in its APPROVED job; an edit after approval refuses', async () => {
      const { createAutomation, getAutomation } = await import('../../src/lib/automations/store.js');
      const { approveAutomation } = await import('../../src/lib/automations/registry.js');
      createAutomation(ctx, { slug: 'tooljob', title: 'T', days: 'daily', at: '09:00', prompt: 'p', appTools: ['yuk/notify-test'] });
      expect(run('tooljob')).toMatchObject({ ok: false, code: 'needs_owner' }); // not approved yet
      approveAutomation(rec.projectRoot, getAutomation(ctx, 'tooljob', home)!, new Date(), home);
      expect(run('tooljob')).toMatchObject({ ok: true });
      // Another tool of the same app is not named.
      const other = gate(ctx, rec, [...actions, { id: 'send', title: 'Send', method: 'POST', path: '/api/send' }], { method: 'POST', path: '/api/send', confirm: true, claim: { class: 'run', automation: 'tooljob' } }, { home });
      expect(other).toMatchObject({ ok: false, code: 'needs_owner' });
      // The file changes mid-run: the hash no longer matches what was approved.
      const { writeFileSync, readFileSync } = await import('node:fs');
      const path = getAutomation(ctx, 'tooljob', home)!.path;
      writeFileSync(path, readFileSync(path, 'utf-8').replace('p\n', 'p, and more\n'));
      expect(run('tooljob')).toMatchObject({ ok: false, code: 'needs_owner' });
    });

    it("jobStartedByOwner: the owner's dashboard reply delivering now passes; Super's, a settled one, or two do not", async () => {
      const { appendThreadEntry } = await import('../../src/lib/automations/threads.js');
      const R = '2026-11-07T10:00:00.000Z';
      const owner = appendThreadEntry(ctx, 'ua', { runId: R, kind: 'user', text: 'send it', via: 'dashboard' });
      const sup = appendThreadEntry(ctx, 'ua', { runId: R, kind: 'user', text: 'now send', via: 'super' });
      const job = (id: string, entryId: string, status: 'running' | 'ok', phase: 'waiting' | 'delivering') => ({ id, slug: 'ua', runId: R, entryId, status, phase, reason: null, startedAt: '', finishedAt: null });
      seed(ctx, { reply: job('j1', owner.id, 'running', 'delivering') });
      expect(run('ua', R)).toMatchObject({ ok: true });
      clear();
      // The owner's reply settled (its phase stays "delivering"); Super's follow-up delivers now.
      seed(ctx, { reply: job('j1', owner.id, 'ok', 'delivering') });
      seed(ctx, { reply: job('j2', sup.id, 'running', 'delivering') });
      expect(run('ua', R)).toMatchObject({ ok: false, code: 'needs_owner' });
      clear();
      seed(ctx, { reply: job('j1', owner.id, 'ok', 'delivering') });
      expect(run('ua', R)).toMatchObject({ ok: false, code: 'needs_owner' }); // nothing in flight
      clear();
      seed(ctx, { reply: job('j1', owner.id, 'running', 'delivering') });
      seed(ctx, { reply: job('j2', owner.id, 'running', 'delivering') });
      expect(run('ua', R)).toMatchObject({ ok: false, code: 'needs_owner' }); // two at once: false
    });

    it('a say run: its opening entry decides while its own job runs; Super\'s say and an app\'s words never', async () => {
      const { appendThreadEntry } = await import('../../src/lib/automations/threads.js');
      const runJob = (runId: string) => ({ id: `run-${runId}`, slug: 'ua', status: 'running' as const, startedAt: 1, finishedAt: null, outcome: null, error: null, runId });
      const A = '2026-11-07T11:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: A, kind: 'user', text: 'owner asks', via: 'dashboard' });
      seed(ctx, { run: runJob(A) });
      expect(run('ua', A)).toMatchObject({ ok: true });
      const B = '2026-11-07T12:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: B, kind: 'user', text: 'super asks', via: 'super' });
      seed(ctx, { run: runJob(B) });
      expect(run('ua', B)).toMatchObject({ ok: false, code: 'needs_owner' });
      const C = '2026-11-07T13:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: C, kind: 'user', text: 'app asks', via: 'app', app: 'yuk' });
      seed(ctx, { run: runJob(C) });
      expect(run('ua', C)).toMatchObject({ ok: false, code: 'needs_owner' });
      // No job in this process (a scheduled fire): false.
      const D = '2026-11-07T14:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: D, kind: 'user', text: 'owner', via: 'dashboard' });
      expect(run('ua', D)).toMatchObject({ ok: false, code: 'needs_owner' });
    });
  });

  afterAll(() => { rmSync(home, { recursive: true, force: true }); });
});
