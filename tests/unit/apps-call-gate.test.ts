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
    ["a member's own Super", { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_MEMBER_SUPER: 'ua-manager', DREAMCONTEXT_MEMBER_CREW: '' }, 'crew'],
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
    // `automations run` from the Super's shell: the run inherits its crew mark and tab session.
    ['a run started from the Super shell: the run mark beats inherited crew', { DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_TAB_SESSION: 'aaaaaaaa-1111-2222-3333-444444444444', DREAMCONTEXT_AUTOMATION_SLUG: 'ua', DREAMCONTEXT_AUTOMATION_RUN: 'R' }, 'run'],
  ];
  it.each(table)('%s', (_name, env, want) => {
    expect(callClaim(env).class).toBe(want);
  });

  it("a member's crew names its member; main's crew and an unsure mark name none", () => {
    expect(callClaim({ DREAMCONTEXT_SUPER_CREW: '1', DREAMCONTEXT_MEMBER_SUPER: 'ua-manager' })).toEqual({ class: 'crew', member: 'ua-manager' });
    expect(callClaim({ DREAMCONTEXT_MEMBER_CREW: 'ua-manager' })).toEqual({ class: 'crew', member: 'ua-manager' });
    expect(callClaim({ DREAMCONTEXT_MEMBER_CREW: '*' })).toEqual({ class: 'crew' });
    expect(callClaim({ DREAMCONTEXT_SUPER_CREW: '1' })).toEqual({ class: 'crew' });
    expect(decodeClaim(encodeClaim({ class: 'crew', member: 'ua' }))).toEqual({ class: 'crew', member: 'ua' });
    // Only a crew claim carries a member; a bad slug is dropped.
    expect(decodeClaim('{"class":"owner","member":"ua"}')).toEqual({ class: 'owner' });
    expect(decodeClaim('{"class":"crew","member":"../x"}')).toEqual({ class: 'crew' });
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

  it('an enabled schedule of the app passes without confirm and keeps 5 minutes; spawned still never', () => {
    expect(call('POST', '/api/sync', 'owner', { schedule: true })).toMatchObject({ ok: true, effect: 'change', timeoutMs: 300_000 });
    expect(call('POST', '/api/notify-test', 'owner', { schedule: true })).toMatchObject({ ok: true, timeoutMs: 300_000 });
    expect(call('POST', '/api/sync', 'spawned', { schedule: true })).toMatchObject({ ok: false, code: 'needs_owner' });
    // An unlisted path keeps the old 5 minutes; a listed tool its own 60 s.
    expect(call('POST', '/api/sync', 'owner', { confirm: true })).toMatchObject({ ok: true, timeoutMs: 300_000 });
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true })).toMatchObject({ ok: true, timeoutMs: 60_000 });
  });

  it('a name never lowers authority: an encoded or repeated query behind a read tool still changes', () => {
    const two: AppAction[] = [
      { id: 'status', title: 'Status', method: 'GET', path: '/api/run', params: { day: { type: 'string', required: false } } },
      { id: 'live', title: 'Live', method: 'GET', path: '/api/run?mode=live', danger: true },
      { id: 'dry', title: 'Dry', method: 'GET', path: '/api/run?mode=dry', danger: true },
    ];
    const g = (path: string, tool: string) => gate(ctx, rec, two, { method: 'GET', path, confirm: false, claim: { class: 'crew' }, tool }, { home });
    expect(g('/api/run?mode=%6Cive', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('/api/run?mode=dry&mode=live', 'dry')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('/api/run?mode=live', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    // Express 4 reads `mode[]=live` as mode=live: a bracket key names nothing.
    expect(g('/api/run?mode[]=live', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('/api/run?mode%5B%5D=live', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('/api/run?day=1;mode=live', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    // An undeclared key, or a declared one twice, names nothing either.
    expect(g('/api/run?x=1', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('/api/run?day=1&day=2', 'status')).toMatchObject({ ok: false, code: 'needs_confirm' });
    // The read tool's own declared param in plain spelling is still a read.
    expect(g('/api/run?day=2026-11-07', 'status')).toMatchObject({ ok: true, effect: 'read' });
    expect(g('/api/run', 'status')).toMatchObject({ ok: true, effect: 'read' });
  });

  it('a query tool next to a query-less one holds by name on its exact query', async () => {
    const { matchAction } = await import('../../src/server/routes/apps.js');
    const two: AppAction[] = [
      { id: 'status', title: 'Status', method: 'GET', path: '/api/run' },
      { id: 'live', title: 'Live', method: 'GET', path: '/api/run?mode=live', danger: true },
    ];
    expect(matchAction(two, 'GET', '/api/run?mode=live', 'live')?.id).toBe('live');
    expect(matchAction(two, 'GET', '/api/run?mode=live&x=1', 'live')?.id).toBe('live');
    expect(matchAction(two, 'GET', '/api/run?mode=live', 'status')?.id).toBe('live');
  });

  it('a spelling a server routes to a listed tool (case, trailing slash) is that tool, never lower', () => {
    const acts: AppAction[] = [
      { id: 'wipe', title: 'Wipe', method: 'GET', path: '/api/wipe', danger: true },
      { id: 'peek', title: 'Peek', method: 'GET', path: '/api/peek' },
      { id: 'save', title: 'Save', method: 'POST', path: '/api/save' },
    ];
    const g = (method: string, path: string, tool?: string) => gate(ctx, rec, acts, { method, path, confirm: false, claim: { class: 'crew' }, ...(tool ? { tool } : {}) }, { home });
    for (const p of ['/API/WIPE', '/api/wipe/', '/Api/Wipe//']) expect(g('GET', p)).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('GET', '/API/WIPE', 'peek')).toMatchObject({ ok: false, code: 'needs_confirm' });
    expect(g('GET', '/API/PEEK')).toMatchObject({ ok: true, effect: 'read' });
    // A loose POST stays a change.
    expect(g('POST', '/API/SAVE')).toMatchObject({ ok: false, code: 'needs_confirm' });
  });

  it('two tools on one base path: the changing one decides, a query cannot make it a read', async () => {
    const { matchAction } = await import('../../src/server/routes/apps.js');
    const two: AppAction[] = [
      { id: 'dry', title: 'Dry', method: 'GET', path: '/api/run?mode=dry' },
      { id: 'live', title: 'Live', method: 'GET', path: '/api/run?mode=live', danger: true },
    ];
    expect(matchAction(two, 'GET', '/api/run?mode=dry')?.id).toBe('live');
  });

  it('no confirm: 409 needs_confirm with what the tool would do, for every class', () => {
    for (const cls of ['spawned', 'crew', 'chat', 'run', 'owner'] as const) {
      const v = call('POST', '/api/notify-test', cls);
      expect(v).toMatchObject({ ok: false, http: 409, code: 'needs_confirm', tool: { id: 'notify-test', does: 'Sends a banner.' } });
    }
  });

  it('confirm: the owner and a chat pass; spawned and a crew outside the main Super do not, and say how to allow it', () => {
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true })).toMatchObject({ ok: true, effect: 'change' });
    expect(call('POST', '/api/notify-test', 'chat', { confirm: true })).toMatchObject({ ok: true });
    const spawned = call('POST', '/api/notify-test', 'spawned', { confirm: true });
    expect(spawned).toMatchObject({ ok: false, http: 403, code: 'needs_owner' });
    const crew = call('POST', '/api/notify-test', 'crew', { confirm: true });
    expect(crew).toMatchObject({ ok: false, http: 403, code: 'needs_owner' });
    for (const v of [spawned, crew]) expect(v.ok ? '' : v.message).toMatch(/To allow it: /);
    expect(crew.ok ? '' : crew.message).toMatch(/Super Agent/);
    expect(call('POST', '/api/q', 'owner', { confirm: true })).toMatchObject({ ok: true, timeoutMs: 120_000 });
  });

  it("the main Super Agent's own session passes like an owner chat; its child is crew whatever its header claims", async () => {
    const { noteSuperState } = await import('../../src/lib/super/store.js');
    const { emptySuperState } = await import('../../src/lib/super/types.js');
    const kid = '0f0f0f0f-1111-2222-3333-444444444444';
    const main = 'aaaaaaaa-1111-2222-3333-444444444444';
    noteSuperState(ctx, { ...emptySuperState(), session: main, enabled: true, children: { [kid]: { sessionId: kid, brief: '', adopted: true, startedAt: 1 } } } as never);
    expect(call('POST', '/api/notify-test', 'owner', { confirm: true, sessions: [kid] })).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(call('POST', '/api/notify-test', 'crew', { confirm: true, sessions: [main] })).toMatchObject({ ok: true, effect: 'change' });
    expect(call('POST', '/api/notify-test', 'chat', { confirm: true, sessions: [main] })).toMatchObject({ ok: true });
    // Its session never lifts a builder or a peer it started (they carry the spawned mark).
    expect(call('POST', '/api/notify-test', 'spawned', { confirm: true, sessions: [main] })).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(call('POST', '/api/notify-test', 'run', { confirm: true, sessions: [main] })).toMatchObject({ ok: false, code: 'needs_owner' });
    // A turn the inbox opened (a schedule, a routine, results): nobody typed it, so no.
    const { _openEventTurnForTests, markSuperEventTurn } = await import('../../src/lib/super/inbox.js');
    _openEventTurnForTests(main, 'batch-1', ctx);
    const event = call('POST', '/api/notify-test', 'crew', { confirm: true, sessions: [main] });
    expect(event).toMatchObject({ ok: false, code: 'needs_owner' });
    expect(event.ok ? '' : event.message).toMatch(/opened by a schedule or an event/);
    markSuperEventTurn(main, false);
    expect(call('POST', '/api/notify-test', 'crew', { confirm: true, sessions: [main] })).toMatchObject({ ok: true });
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
      // Two changing tools on one route: the named one decides; unnamed, no job vouches for either.
      const twin = [...actions, { id: 'live-send', title: 'Live', method: 'POST' as const, path: '/api/notify-test?mode=live' }];
      const named = (tool?: string) => gate(ctx, rec, twin, { method: 'POST', path: '/api/notify-test?mode=live', confirm: true, claim: { class: 'run', automation: 'tooljob' }, ...(tool ? { tool } : {}) }, { home });
      expect(named('live-send')).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(named()).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(named('notify-test')).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(gate(ctx, rec, twin, { method: 'POST', path: '/api/notify-test', confirm: true, claim: { class: 'run', automation: 'tooljob' }, tool: 'notify-test' }, { home })).toMatchObject({ ok: true });
      // The file changes mid-run (owner 2026-11-08): the run keeps working on the approved job, so
      // the tool that job named still passes, and a tool only the waiting edit names never does.
      const { writeFileSync, readFileSync } = await import('node:fs');
      const path = getAutomation(ctx, 'tooljob', home)!.path;
      writeFileSync(path, readFileSync(path, 'utf-8').replace('p\n', 'p, and more\n'));
      expect(run('tooljob')).toMatchObject({ ok: true });
      writeFileSync(path, readFileSync(path, 'utf-8').replace(/^(\s*)- yuk\/notify-test$/m, '$1- yuk/notify-test\n$1- yuk/send'));
      expect(getAutomation(ctx, 'tooljob', home)!.appTools).toContain('yuk/send');
      expect(other.ok).toBe(false);
      expect(gate(ctx, rec, [...actions, { id: 'send', title: 'Send', method: 'POST', path: '/api/send' }], { method: 'POST', path: '/api/send', confirm: true, claim: { class: 'run', automation: 'tooljob' } }, { home })).toMatchObject({ ok: false, code: 'needs_owner' });
    });

    it('the suggested --app-tools keeps every tool already granted (C3)', async () => {
      const { createAutomation, getAutomation } = await import('../../src/lib/automations/store.js');
      const { approveAutomation } = await import('../../src/lib/automations/registry.js');
      createAutomation(ctx, { slug: 'keepjob', title: 'K', days: 'daily', at: '09:00', prompt: 'p', appTools: ['yuk/notify-test'] });
      approveAutomation(rec.projectRoot, getAutomation(ctx, 'keepjob', home)!, new Date(), home);
      const withSend = [...actions, { id: 'send', title: 'Send', method: 'POST' as const, path: '/api/send' }];
      const r = gate(ctx, rec, withSend, { method: 'POST', path: '/api/send', confirm: true, claim: { class: 'run', automation: 'keepjob' } }, { home });
      expect(r).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(r.ok ? '' : r.message).toContain('automations edit keepjob --app-tools yuk/notify-test,yuk/send`');
      // A job with no tools yet: the ref alone, as before.
      expect((run('nothing-yet') as { message: string }).message).toContain('--app-tools yuk/notify-test`');
    });

    it('a project registered through a symlink: the app still vouches for its own run (C7)', async () => {
      const { symlinkSync } = await import('node:fs');
      const { appendThreadEntry } = await import('../../src/lib/automations/threads.js');
      const link = join(realpathSync(mkdtempSync(join(tmpdir(), 'dc-gate-link-'))), 'proj');
      symlinkSync(rec.projectRoot, link);
      const linkCtx = join(link, '_dream_context');
      const R = '2026-11-07T15:00:00.000Z';
      appendThreadEntry(ctx, 'own7', { runId: R, kind: 'user', text: 'app asks', via: 'app', app: 'yuk' });
      // The job runs under the real path; the gate is asked under the symlinked vault path.
      seed(ctx, { run: { id: `run-${R}`, slug: 'own7', status: 'running' as const, startedAt: 1, finishedAt: null, outcome: null, error: null, runId: R } });
      expect(gate(linkCtx, rec, actions, { method: 'POST', path: '/api/notify-test', confirm: true, claim: { class: 'run', automation: 'own7', run: R } }, { home })).toMatchObject({ ok: true });
      // Another app's run is still refused through the link.
      const other = { ...rec, slug: 'other-app' } as AppRecord;
      expect(gate(linkCtx, other, actions, { method: 'POST', path: '/api/notify-test', confirm: true, claim: { class: 'run', automation: 'own7', run: R } }, { home })).toMatchObject({ ok: false, code: 'needs_owner' });
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

    it('a say run: its opening entry decides while its own job runs; Super\'s say never, an app only on its own tools', async () => {
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
      // The app's own member (owner 2026-11-11): this app started the run, so its tools run; another app's do not.
      const C = '2026-11-07T13:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: C, kind: 'user', text: 'app asks', via: 'app', app: 'yuk' });
      seed(ctx, { run: runJob(C) });
      expect(run('ua', C)).toMatchObject({ ok: true, effect: 'change' });
      // Its LISTED tools only: an unlisted route of the same app stays the owner's.
      const raw = gate(ctx, rec, actions, { method: 'POST', path: '/admin/reset', confirm: true, claim: { class: 'run', automation: 'ua', run: C } }, { home });
      expect(raw).toMatchObject({ ok: false, code: 'needs_owner' });
      const C2 = '2026-11-07T13:30:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: C2, kind: 'user', text: 'other app asks', via: 'app', app: 'other-app' });
      seed(ctx, { run: runJob(C2) });
      const refused = run('ua', C2);
      expect(refused).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(refused.ok ? '' : refused.message).toContain('automations edit ua --app-tools yuk/notify-test');
      // The app's run ended: nothing in flight vouches any more.
      clear();
      expect(run('ua', C)).toMatchObject({ ok: false, code: 'needs_owner' });
      // No job in this process (a scheduled fire): false.
      const D = '2026-11-07T14:00:00.000Z';
      appendThreadEntry(ctx, 'ua', { runId: D, kind: 'user', text: 'owner', via: 'dashboard' });
      expect(run('ua', D)).toMatchObject({ ok: false, code: 'needs_owner' });
    });
  });

  describe("a member's approved call.app_tools (app-arac-izin)", () => {
    const as = (claim: Record<string, unknown>) =>
      gate(ctx, rec, actions, { method: 'POST', path: '/api/notify-test', confirm: true, claim: claim as never }, { home });

    it('its Super, its children and its called runs run the tool once the owner approved it; a pending edit adds none', async () => {
      const { createAgent, setAppTools, getAgent } = await import('../../src/lib/agents/store.js');
      const { getRunTarget } = await import('../../src/lib/automations/store.js');
      const { approveAutomation } = await import('../../src/lib/automations/registry.js');
      createAgent(ctx, { slug: 'kurucu', title: 'Kurucu', prompt: 'p' }, { approve: { now: new Date() } });
      const before = as({ class: 'crew', member: 'kurucu' });
      expect(before).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(before.ok ? '' : before.message).toContain('automations edit kurucu --app-tools yuk/notify-test');

      setAppTools(ctx, 'kurucu', ['yuk/notify-test']);
      expect(getRunTarget(ctx, 'kurucu', 'agent', home)!.appTools).toEqual(['yuk/notify-test']);
      // Written, not approved: the approved version (no tools) is what may run.
      expect(as({ class: 'crew', member: 'kurucu' })).toMatchObject({ ok: false, code: 'needs_owner' });

      approveAutomation(rec.projectRoot, getRunTarget(ctx, 'kurucu', 'agent', home)!, new Date(), home);
      expect(as({ class: 'crew', member: 'kurucu' })).toMatchObject({ ok: true, effect: 'change' });
      expect(as({ class: 'run', automation: 'kurucu', run: 'R' })).toMatchObject({ ok: true });
      // Another member, main's crew and another tool of the app: no.
      expect(as({ class: 'crew', member: 'other' })).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(as({ class: 'crew' })).toMatchObject({ ok: false, code: 'needs_owner' });
      const send = gate(ctx, rec, [...actions, { id: 'send', title: 'Send', method: 'POST', path: '/api/send' }], { method: 'POST', path: '/api/send', confirm: true, claim: { class: 'crew', member: 'kurucu' } }, { home });
      expect(send).toMatchObject({ ok: false, code: 'needs_owner' });

      // An unsplit on-call file (`automations create --mode call --app-tools`): its call target carries them.
      const { createAutomation } = await import('../../src/lib/automations/store.js');
      createAutomation(ctx, { slug: 'callme', title: 'Call me', mode: 'call', prompt: 'p', appTools: ['yuk/notify-test'] });
      expect(getRunTarget(ctx, 'callme', 'agent', home)!.appTools).toEqual(['yuk/notify-test']);
      // `--app` stays a schedule's, and its refusal names the way.
      expect(() => createAutomation(ctx, { slug: 'callme-2', title: 'K2', mode: 'call', prompt: 'p', app: 'yuk' })).toThrow(/takes --app-tools without --app/);

      // Cleared: it stops at once (no approval needed to take a tool away), and the call block loses it.
      setAppTools(ctx, 'kurucu', []);
      expect(as({ class: 'crew', member: 'kurucu' })).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(as({ class: 'run', automation: 'kurucu', run: 'R' })).toMatchObject({ ok: false, code: 'needs_owner' });
      expect(getAgent(ctx, 'kurucu')!.call.appTools).toBeUndefined();
      expect(getRunTarget(ctx, 'kurucu', 'agent', home)!.appTools).toBeUndefined();
    });
  });

  afterAll(() => { rmSync(home, { recursive: true, force: true }); });
});
