/**
 * AI Team v2, wave A1: the server contract (plan-r9 AC-A1-1 … AC-A1-6).
 *
 *   1. autonomy: saved and reloaded; an existing approved agent stays approved (the default is
 *      not hashed); `ask` and `free` change the hash; an edit from inside an agent run is refused
 *      (CLI and route).
 *   2. M4: `levelPermissionArgs` for every level × step; the chat envelope per level; the level
 *      brief in the identity briefing and in a task job's prompt.
 *   3. account protection: owner's order, "Only mine", signed out, refused, a stale reading
 *      probed, both windows, the earliest wake; a routine on a full machine waits until `wakeAt`
 *      and runs on the first tick after.
 *   4. the stage: its route's shape and desktop gate; the home session written once, in the
 *      machine-local store, nothing new under `_dream_context/state/`.
 *   5. the figure: same slug → same face; all 64 pairs reachable; collisions in creation order;
 *      the backfill is idempotent; no green or magenta tone.
 *   6. filing approval: route, CLI and refusals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProgram } from '../../src/cli/program.js';
import { createAgent, getAgent, withRestamp } from '../../src/lib/agents/store.js';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { approveAutomation, checkApproval, manifestHash } from '../../src/lib/automations/registry.js';
import { AGENT_CHAT_ENV, AGENT_SELF_ENV, insideAgentRun } from '../../src/lib/automations/types.js';
import { resumeRunsBypass } from '../../src/server/routes/agent-chat.js';
import { levelBrief, levelPermissionArgs, REVIEW_DISALLOWED_TOOLS, TASK_DOER_ALLOWED, TASK_REVIEWER_ALLOWED } from '../../src/lib/agents/permission.js';
import { composePrompt } from '../../src/lib/automations/runner.js';
import { prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';
import {
  protectedAutomationAccount, readAccountWait, recordAccountWait, withoutOwnerOnly,
} from '../../src/lib/automations/account.js';
import {
  agentThresholdFor, sandboxDirFor, setAccountOwnerOnly, setAgentThreshold, setAutoSwitchEnabled, upsertClaudeAccount,
} from '../../src/lib/claude-accounts.js';
import { recordAccountRejection } from '../../src/lib/claude-limit-rejections.js';
import type { ProbeOutcome } from '../../src/lib/claude-usage-probe.js';
import { tickProject } from '../../src/lib/automations/tick.js';
import type { RunOutcome } from '../../src/lib/automations/runner.js';
import { localDir, projectKey, readStageHomeSession, recordStageHomeSession } from '../../src/lib/local-store.js';
import { buildStageView, handleAgentsStage, handleAgentsUpdate, stageFileKind } from '../../src/server/routes/agents.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import {
  agentFigure, assignFigures, baseFigure, faceKey, FIGURE_TONES, fnv1a32,
} from '../../src/lib/agents/figure.js';
import { backfillFaces, nextFreeFace } from '../../src/lib/agents/faces.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { approveFiling } from '../../src/lib/task-filing-approval.js';
import { handleTasksFilingApproval } from '../../src/server/routes/tasks.js';

let projectRoot: string;
let contextRoot: string;
let home: string;
let cwd: string;
let realHome: string | undefined;
const NOW = new Date('2026-10-24T09:00:00.000Z');

beforeEach(() => {
  cwd = process.cwd();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dc-a1-')));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-a1-home-')));
  realHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.chdir(cwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env[AGENT_SELF_ENV];
  delete process.env.DREAMCONTEXT_AUTOMATION_RUN;
  delete process.env.DREAMCONTEXT_DESKTOP;
  delete process.env[AGENT_CHAT_ENV];
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeAgent(slug = 'scout', extra: { autonomy?: 'ask' | 'balanced' | 'free'; whiteboard?: string } = {}) {
  return createAgent(contextRoot, { slug, title: slug, prompt: `${slug} watches the funnel.`, learning: false, ...extra }, { approve: { now: NOW, home } });
}

async function runCli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); }));
  process.exitCode = undefined;
  process.chdir(projectRoot);
  try {
    await createProgram().parseAsync(argv, { from: 'user' });
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return { code, out: lines.join('\n') };
}

function fakeReq(body: unknown = null, remote = '127.0.0.1'): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (req as unknown as { headers: Record<string, string> }).headers = { 'content-type': 'application/json', host: '127.0.0.1' };
  (req as unknown as { method: string }).method = 'POST';
  (req as unknown as { socket: { remoteAddress: string } }).socket = { remoteAddress: remote };
  setImmediate(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function fakeRes(): ServerResponse & { status: number; json: () => Record<string, unknown> } {
  let status = 0;
  let text = '';
  const res = {
    statusCode: 200,
    setHeader() { /* headers are not asserted */ },
    writeHead(s: number) { status = s; return res; },
    end(chunk?: string) { if (chunk) text += chunk; if (!status) status = res.statusCode; },
    get status() { return status || res.statusCode; },
    json: () => JSON.parse(text || '{}') as Record<string, unknown>,
  };
  return res as unknown as ServerResponse & { status: number; json: () => Record<string, unknown> };
}

// ─── 1. autonomy ─────────────────────────────────────────────────────────────

describe('AC-A1-1 autonomy', () => {
  it('defaults to balanced, writes nothing for it, and the default does not move the hash', () => {
    const a = makeAgent();
    expect(a.autonomy).toBe('balanced');
    expect(readFileSync(a.path, 'utf-8')).not.toContain('autonomy');
    const target = getRunTarget(contextRoot, 'scout', 'agent')!;
    const { autonomy: _drop, ...withoutField } = target;
    // An agent approved before the field existed hashes exactly as it did: still approved.
    expect(manifestHash(target)).toBe(manifestHash(withoutField as typeof target));
    expect(checkApproval(projectRoot, target, home, 'run').approved).toBe(true);
  });

  it('saves and reloads ask and free; both change the hash; the owner edit re-approves', () => {
    makeAgent();
    const before = manifestHash(getRunTarget(contextRoot, 'scout', 'agent')!);
    withRestamp(contextRoot, projectRoot, 'scout', { autonomy: 'free' }, home, NOW);
    expect(getAgent(contextRoot, 'scout')!.autonomy).toBe('free');
    const free = getRunTarget(contextRoot, 'scout', 'agent')!;
    expect(manifestHash(free)).not.toBe(before);
    expect(checkApproval(projectRoot, free, home, 'run').approved).toBe(true);
    withRestamp(contextRoot, projectRoot, 'scout', { autonomy: 'ask' }, home, NOW);
    const ask = getRunTarget(contextRoot, 'scout', 'agent')!;
    expect(ask.autonomy).toBe('ask');
    expect(manifestHash(ask)).not.toBe(manifestHash(free));
    // Back to the default: the key leaves the file and the original hash comes back.
    withRestamp(contextRoot, projectRoot, 'scout', { autonomy: 'balanced' }, home, NOW);
    expect(readFileSync(getAgent(contextRoot, 'scout')!.path, 'utf-8')).not.toContain('autonomy');
    expect(manifestHash(getRunTarget(contextRoot, 'scout', 'agent')!)).toBe(before);
  });

  it('a synced edit of the level (no restamp) blocks the agent until re-approved', () => {
    const a = makeAgent();
    writeFileSync(a.path, readFileSync(a.path, 'utf-8').replace('shared: false', 'shared: false\nautonomy: free'));
    const target = getRunTarget(contextRoot, 'scout', 'agent')!;
    expect(target.autonomy).toBe('free');
    expect(checkApproval(projectRoot, target, home, 'run').approved).toBe(false);
  });

  it('`agents edit --autonomy` sets it, and is refused inside an agent run', async () => {
    makeAgent();
    expect((await runCli(['agents', 'edit', 'scout', '--autonomy', 'ask'])).code).toBe(0);
    expect(getAgent(contextRoot, 'scout')!.autonomy).toBe('ask');
    expect((await runCli(['agents', 'edit', 'scout', '--autonomy', 'loud'])).code).toBe(1);
    process.env[AGENT_SELF_ENV] = 'scout';
    const refused = await runCli(['agents', 'edit', 'scout', '--autonomy', 'free']);
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/agent cannot change an autonomy/);
    expect(getAgent(contextRoot, 'scout')!.autonomy).toBe('ask');
  });

  it('the dashboard route sets it and refuses anything that is not a level', async () => {
    // The agent-run refusal is the CLI verb's (the server cannot see a caller's environment; a run
    // that reaches the local API directly is plan-r9's named residual).
    makeAgent();
    const res = fakeRes();
    await handleAgentsUpdate(fakeReq({ autonomy: 'free' }), res, { slug: 'scout' }, contextRoot);
    expect(res.status).toBe(200);
    expect((res.json().agent as { autonomy: string }).autonomy).toBe('free');
    const bad = fakeRes();
    await handleAgentsUpdate(fakeReq({ autonomy: 'loud' }), bad, { slug: 'scout' }, contextRoot);
    expect(bad.status).toBe(400);
    expect(getAgent(contextRoot, 'scout')!.autonomy).toBe('free');
  });
});

// ─── 2. M4 ───────────────────────────────────────────────────────────────────

describe('AC-A1-2 level → permission envelope', () => {
  const mode = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
  const disallowed = (args: string[]) => (args.includes('--disallowedTools') ? args[args.indexOf('--disallowedTools') + 1] : null);
  const allowed = (args: string[]) => (args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1] : null);

  it('every level × step of the table', () => {
    expect(mode(levelPermissionArgs('ask', 'chat'))).toBe('default');
    expect(mode(levelPermissionArgs('balanced', 'chat'))).toBe('auto');
    expect(mode(levelPermissionArgs('free', 'chat'))).toBe('bypassPermissions');
    const plan = levelPermissionArgs('ask', 'plan');
    expect(mode(plan)).toBe('plan');
    expect(disallowed(plan)).toMatch(/\bTask\b/);
    expect(disallowed(plan)).toMatch(/\bWorkflow\b/);
    expect(() => levelPermissionArgs('balanced', 'plan')).toThrow(/Ask level/);
    expect(() => levelPermissionArgs('free', 'plan')).toThrow(/Ask level/);
    for (const step of ['work', 'rework'] as const) {
      expect(mode(levelPermissionArgs('ask', step))).toBe('auto');
      expect(mode(levelPermissionArgs('balanced', step))).toBe('auto');
      expect(mode(levelPermissionArgs('free', step))).toBe('bypassPermissions');
      expect(disallowed(levelPermissionArgs('free', step))).toBeNull();
    }
    for (const level of ['ask', 'balanced', 'free'] as const) {
      const review = levelPermissionArgs(level, 'review');
      expect(mode(review)).toBe(level === 'free' ? 'bypassPermissions' : 'auto');
      expect(disallowed(review)).toBe(REVIEW_DISALLOWED_TOOLS.join(' '));
      // Under auto a task step's own verbs are pre-approved (C1, M4); bypass needs nothing.
      expect(allowed(review)).toBe(level === 'free' ? null : TASK_REVIEWER_ALLOWED);
      expect(allowed(levelPermissionArgs(level, 'work'))).toBe(level === 'free' ? null : TASK_DOER_ALLOWED);
    }
  });

  it('the agent chat envelope follows the manifest, and the brief rides the briefing', () => {
    makeAgent('asker', { autonomy: 'ask' });
    makeAgent('middle');
    makeAgent('roamer', { autonomy: 'free' });
    for (const [slug, expected, label] of [['asker', 'default', 'Ask'], ['middle', 'auto', 'Balanced'], ['roamer', 'bypassPermissions', 'Free']] as const) {
      const prep = prepareAgentChat(contextRoot, slug, home);
      expect(prep.ok).toBe(true);
      if (!prep.ok) continue;
      expect(prep.permissionArgs).toBeNull();
      expect(prep.levelArgs).toEqual(['--permission-mode', expected]);
      expect(prep.briefing).toContain(`--- YOUR AUTONOMY: ${label} ---`);
      prep.dispose();
    }
  });

  it('the brief says when to ask, and a headless brief says to stop on a denied step', () => {
    expect(levelBrief('ask')).toMatch(/Ask the owner before you act/);
    expect(levelBrief('balanced')).toMatch(/before a push/);
    expect(levelBrief('free')).toMatch(/Decide for yourself/);
    expect(levelBrief('ask')).not.toMatch(/Nobody is watching/);
    expect(levelBrief('balanced', true)).toMatch(/post your question and stop/);
  });

  it("a task job's prompt carries the agent's level", () => {
    makeAgent('roamer', { autonomy: 'free' });
    const target = getRunTarget(contextRoot, 'roamer', 'agent')!;
    const task = { slug: 'fix-signup', name: 'Fix the signup step', file: 'state/fix-signup.md' } as never;
    const prompt = composePrompt(target, projectRoot, NOW, join(projectRoot, 'out.md'), undefined, null, null, null, task);
    expect(prompt).toContain('--- YOUR AUTONOMY: Free ---');
    expect(prompt).toMatch(/Nobody is watching/);
    expect(composePrompt(target, projectRoot, NOW, join(projectRoot, 'out.md'))).not.toContain('YOUR AUTONOMY');
  });
});

// ─── 3. account protection ───────────────────────────────────────────────────

describe('AC-A1-3 account protection', () => {
  const T = NOW.getTime();
  function account(id: string, preferred = false): void {
    upsertClaudeAccount({
      id, accountUuid: `uuid-${id}`, email: `${id}@example.test`, organizationUuid: 'org',
      organizationName: 'Example Org', tier: 'max', configDir: sandboxDirFor(id, home), preferred,
    }, home);
    mkdirSync(sandboxDirFor(id, home), { recursive: true });
    writeFileSync(join(sandboxDirFor(id, home), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.test` } }));
  }
  /** A cached reading on disk, `ageMs` old. */
  function cache(id: string, session: number, weekly: number, ageMs = 0, resets = { session: T + 2 * 3_600_000, weekly: T + 3 * 86_400_000 }): void {
    const dir = sandboxDirFor(id, home);
    const blob = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf-8')) as Record<string, unknown>;
    blob.cachedUsageUtilization = {
      fetchedAtMs: T - ageMs,
      utilization: {
        five_hour: { utilization: session, resets_at: new Date(resets.session).toISOString() },
        seven_day: { utilization: weekly, resets_at: new Date(resets.weekly).toISOString() },
      },
    };
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(blob));
  }
  const probeWith = (map: Record<string, [number, number]>) => vi.fn(async (dir: string): Promise<ProbeOutcome> => {
    const id = Object.keys(map).find((k) => dir === sandboxDirFor(k, home));
    if (!id) return { status: 'unknown' } as ProbeOutcome;
    const [s, w] = map[id];
    return { status: 'ok', limits: { fetchedAtMs: T, limits: [
      { key: 'session', percent: s, resetsAt: T + 3_600_000 }, { key: 'weekly', percent: w, resetsAt: T + 86_400_000 },
    ] } };
  });

  it('takes the first account in the owner order with both windows under the threshold', async () => {
    account('one', true); account('two'); account('three');
    const probe = probeWith({ one: [85, 10], two: [10, 85], three: [20, 30] });
    const pick = await protectedAutomationAccount({ home, probe, now: T });
    expect(pick).toEqual({ account: expect.objectContaining({ id: 'three' }) });
  });

  it('skips Only mine, signed-out and refused accounts', async () => {
    account('one', true); account('two'); account('three'); account('four');
    setAccountOwnerOnly('one', true, home);
    rmSync(join(sandboxDirFor('two', home), '.claude.json'));
    recordAccountRejection('three', { window: 'session', resetsAtMs: Date.now() + 3_600_000, via: 'apiError' }, home);
    const probe = probeWith({ one: [1, 1], two: [1, 1], three: [1, 1], four: [5, 5] });
    const pick = await protectedAutomationAccount({ home, probe, now: Date.now() });
    expect('account' in pick && pick.account.id).toBe('four');
  });

  it('probes a stale reading and decides on a current one without a probe', async () => {
    account('one', true); account('two');
    cache('one', 10, 10, 3 * 3_600_000);
    cache('two', 10, 10, 0);
    const probe = probeWith({ one: [95, 10], two: [50, 50] });
    const pick = await protectedAutomationAccount({ home, probe, now: T });
    expect('account' in pick && pick.account.id).toBe('two');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toBe(sandboxDirFor('one', home));
  });

  it('a reading older than its reset counts as 0%', async () => {
    account('one', true);
    cache('one', 99, 10, 30 * 60_000, { session: T - 60_000, weekly: T + 86_400_000 });
    const probe = vi.fn(async (): Promise<ProbeOutcome> => ({ status: 'unknown' } as ProbeOutcome));
    const pick = await protectedAutomationAccount({ home, probe, now: T });
    expect('account' in pick && pick.account.id).toBe('one');
  });

  it('honours the machine threshold and requires BOTH windows under it', async () => {
    account('one', true);
    cache('one', 70, 70);
    expect(agentThresholdFor(home)).toBe(80);
    expect('account' in await protectedAutomationAccount({ home, now: T })).toBe(true);
    setAgentThreshold(60, home);
    expect(agentThresholdFor(home)).toBe(60);
    const wait = await protectedAutomationAccount({ home, now: T });
    expect('waitUntil' in wait).toBe(true);
  });

  it('none left: waits until the earliest reset or refusal end', async () => {
    account('one', true); account('two');
    cache('one', 90, 10, 0, { session: T + 5 * 3_600_000, weekly: T + 86_400_000 });
    cache('two', 10, 95, 0, { session: T + 3_600_000, weekly: T + 2 * 3_600_000 });
    const pick = await protectedAutomationAccount({ home, now: T });
    expect(pick).toEqual({ waitUntil: T + 2 * 3_600_000 });
  });

  it('auto-switch off keeps the preferred account as the only candidate', async () => {
    account('one', true); account('two');
    cache('one', 90, 10);
    cache('two', 1, 1);
    await setAutoSwitchEnabled(false, home);
    expect('waitUntil' in await protectedAutomationAccount({ home, now: T })).toBe(true);
  });

  it('a resume moves off an Only mine account, never onto a signed-out one', () => {
    account('one', true); account('two');
    setAccountOwnerOnly('one', true, home);
    const moved = withoutOwnerOnly({ id: 'one', configDir: sandboxDirFor('one', home), label: null }, { home });
    expect(moved.id).toBe('two');
    rmSync(join(sandboxDirFor('two', home), '.claude.json'));
    expect(withoutOwnerOnly({ id: 'one', configDir: sandboxDirFor('one', home), label: null }, { home }).id).toBe('one');
  });

  it('Only mine survives a re-add of the account', () => {
    account('one', true);
    setAccountOwnerOnly('one', true, home);
    account('one', true);
    const reg = JSON.parse(readFileSync(join(home, '.dreamcontext', 'claude-accounts.json'), 'utf-8')) as { accounts: { id: string; ownerOnly?: boolean }[] };
    expect(reg.accounts.find((a) => a.id === 'one')?.ownerOnly).toBe(true);
  });

  it('a routine on an all-full machine skips until wakeAt and runs on the first tick after', async () => {
    // Due an hour before NOW in this machine's own zone, so both ticks sit inside the catch-up window.
    const fire = new Date(T - 3_600_000);
    const at = `${String(fire.getHours()).padStart(2, '0')}:${String(fire.getMinutes()).padStart(2, '0')}`;
    createAutomation(contextRoot, { slug: 'daily-brief', title: 'Daily brief', prompt: 'Write the brief.', days: 'daily', at } as never);
    const wakeAt = T + 30 * 60_000;
    recordAccountWait(wakeAt, home, T);
    const calls: { unattended?: boolean }[] = [];
    const runImpl = vi.fn(async (_c: string, slug: string, opts: { unattended?: boolean }) => {
      calls.push(opts);
      return { slug, status: 'ok' } as unknown as RunOutcome;
    });
    const during = await tickProject(projectRoot, { now: new Date(T + 10 * 60_000), home, runImpl: runImpl as never, pollTelegram: async () => ({ processed: 0, unauthorized: 0 }) as never });
    expect(runImpl).not.toHaveBeenCalled();
    expect(during.verdicts).toContainEqual({ slug: 'daily-brief', verdict: 'waiting-for-account' });
    expect(readAccountWait(home, T + 10 * 60_000)).toBe(wakeAt);
    const after = await tickProject(projectRoot, { now: new Date(wakeAt + 60_000), home, runImpl: runImpl as never, pollTelegram: async () => ({ processed: 0, unauthorized: 0 }) as never });
    expect(after.verdicts, JSON.stringify(after.verdicts)).not.toContainEqual({ slug: 'daily-brief', verdict: 'waiting-for-account' });
    expect(runImpl).toHaveBeenCalledTimes(1);
    expect(calls[0].unattended).toBe(true);
  });
});

// ─── 4. the stage ────────────────────────────────────────────────────────────

describe('AC-A1-4 the stage', () => {
  const listState = () => readdirSync(join(contextRoot, 'state')).sort();

  it('writes the home session once, in the machine-local store, and nothing under state/', () => {
    makeAgent();
    const before = listState();
    expect(readStageHomeSession(projectRoot, 'scout', home)).toBeNull();
    expect(recordStageHomeSession(projectRoot, 'scout', 'sess-1', home)).toBe('sess-1');
    expect(recordStageHomeSession(projectRoot, 'scout', 'sess-2', home)).toBe('sess-1');
    expect(readStageHomeSession(projectRoot, 'scout', home)).toBe('sess-1');
    expect(listState()).toEqual(before);
    const dir = localDir(projectRoot, home);
    expect(dir).toBe(join(home, '.dreamcontext', 'local', projectKey(projectRoot)));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(existsSync(join(dir, 'agent-stage.json'))).toBe(true);
  });

  it('the view: autonomy, face, home session, reports, files with a kind, routines', () => {
    makeAgent('scout', { autonomy: 'ask' });
    createAutomation(contextRoot, { slug: 'scout-daily', title: 'Scout daily', agent: 'scout', days: 'daily', at: '08:00' } as never);
    recordStageHomeSession(projectRoot, 'scout', 'sess-home');
    for (let i = 0; i < 7; i++) {
      appendThreadEntry(contextRoot, i % 2 ? 'scout' : 'scout-daily', {
        runId: `2026-10-1${i}T08:00:00.000Z`, kind: 'agent', text: `report ${i}`, via: 'agent', now: new Date(`2026-10-1${i}T08:05:00.000Z`),
        files: [`automations/output/scout/r${i}.md`, ...(i === 6 ? ['whiteboards/funnel.excalidraw.md'] : [])],
      } as never);
    }
    const view = buildStageView(contextRoot, 'scout', NOW)!;
    expect(view.autonomy).toBe('ask');
    expect(view.face).toEqual(getAgent(contextRoot, 'scout')!.face);
    expect(view.homeSessionId).toBe('sess-home');
    expect(view.owner).toBeNull();
    expect(view.reports).toHaveLength(5);
    expect(view.reports[0].text).toBe('report 6');
    expect(view.files.length).toBeLessThanOrEqual(8);
    expect(view.files).toContainEqual(expect.objectContaining({ path: 'whiteboards/funnel.excalidraw.md', kind: 'board' }));
    expect(view.routines).toEqual([expect.objectContaining({ slug: 'scout-daily', enabled: true })]);
    expect(view.liveJobs).toEqual([]);
    expect(view.inbox).toEqual([]);
    expect(stageFileKind('notes/plan.md')).toBe('doc');
    expect(stageFileKind('shots/a.png')).toBe('image');
  });

  it('the route is desktop-gated and 404s an unknown agent', async () => {
    makeAgent();
    const shut = fakeRes();
    await handleAgentsStage(fakeReq(), shut, { slug: 'scout' }, contextRoot);
    expect(shut.status).toBe(403);
    process.env.DREAMCONTEXT_DESKTOP = '1';
    const open = fakeRes();
    await handleAgentsStage(fakeReq(), open, { slug: 'scout' }, contextRoot);
    expect(open.status).toBe(200);
    expect(Object.keys(open.json().stage as object).sort()).toEqual(
      ['autonomy', 'face', 'files', 'homeLive', 'homeSessionId', 'inbox', 'liveJobs', 'owner', 'reports', 'routines', 'slug', 'taskJobs', 'title'].sort(),
    );
    const missing = fakeRes();
    await handleAgentsStage(fakeReq(), missing, { slug: 'nobody' }, contextRoot);
    expect(missing.status).toBe(404);
  });
});

// ─── 5. the figure ───────────────────────────────────────────────────────────

describe('AC-A1-5 the figure', () => {
  it('same slug, same face; the key is the trimmed lowercase slug', () => {
    expect(baseFigure('Daily-Digest ')).toEqual(baseFigure('daily-digest'));
    expect(agentFigure('daily-digest')).toEqual(agentFigure('daily-digest'));
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });

  it('reproduces the approved examples (NOT.md)', () => {
    const slugs = ['daily-digest', 'sleep-tasks', 'inbox-triage', 'release-notes', 'ua-budget-check', 'weekly-brief', 'competitor-watch', 'standup-notes'];
    const faces = assignFigures(slugs.map((slug) => ({ slug, face: null })));
    const named = slugs.map((s) => faceKey(faces.get(s)!));
    // crescent/teal, dreamstone/amber, mochi/amber, egg/rose, mochi/violet, bean/coral, crescent/sky, egg/plum
    expect(named).toEqual(['1:4', '7:6', '2:6', '6:7', '2:0', '3:5', '1:3', '6:1']);
  });

  it('all 64 pairs are reachable', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000 && seen.size < 64; i++) seen.add(faceKey(baseFigure(`agent-${i}`)));
    expect(seen.size).toBe(64);
  });

  it('a collision moves the newcomer: color + 1, then shape + 1; past 64 it may collide', () => {
    const base = baseFigure('scout');
    expect(agentFigure('scout', [faceKey(base)])).toEqual({ shape: base.shape, color: (base.color + 1) % 8 });
    const wholeShape = Array.from({ length: 8 }, (_, c) => `${base.shape}:${c}`);
    expect(agentFigure('scout', wholeShape)).toEqual({ shape: (base.shape + 1) % 8, color: base.color });
    const all = Array.from({ length: 64 }, (_, i) => `${Math.floor(i / 8)}:${i % 8}`);
    expect(agentFigure('scout', all)).toEqual(base);
  });

  it('stamps at create, older members keep their face, the backfill is idempotent', () => {
    // Two unstamped members with the same base face: the older keeps it, the newer moves.
    mkdirSync(join(contextRoot, 'agents'), { recursive: true });
    const twin = (() => {
      const b = faceKey(baseFigure('alpha'));
      for (let i = 0; i < 20000; i++) if (faceKey(baseFigure(`twin-${i}`)) === b) return `twin-${i}`;
      throw new Error('no twin');
    })();
    const older = join(contextRoot, 'agents', `${twin}.md`);
    const newer = join(contextRoot, 'agents', 'alpha.md');
    // The older file is written first, so its birth time (where the filesystem keeps one) and its
    // modification time both come first.
    writeFileSync(older, '---\nid: agt_old\ntitle: Old\nshared: false\n---\n\n## Prompt\n\nOld.\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    writeFileSync(newer, '---\nid: agt_new\ntitle: New\nshared: false\n---\n\n## Prompt\n\nNew.\n');
    const past = new Date(NOW.getTime() - 86_400_000);
    utimesSync(older, past, past);
    const stamped = backfillFaces(contextRoot);
    expect(stamped.sort()).toEqual([newer, older].sort());
    expect(getAgent(contextRoot, twin)!.face).toEqual(baseFigure(twin));
    expect(getAgent(contextRoot, 'alpha')!.face).not.toEqual(baseFigure('alpha'));
    const snapshot = [readFileSync(older, 'utf-8'), readFileSync(newer, 'utf-8')];
    expect(backfillFaces(contextRoot)).toEqual([]);
    expect([readFileSync(older, 'utf-8'), readFileSync(newer, 'utf-8')]).toEqual(snapshot);
    // A new member never takes a face already worn, and creating it moves nobody.
    const expected = nextFreeFace(contextRoot, 'gamma');
    const fresh = makeAgent('gamma');
    expect([faceKey(getAgent(contextRoot, twin)!.face!), faceKey(getAgent(contextRoot, 'alpha')!.face!)]).not.toContain(faceKey(fresh.face!));
    expect(fresh.face).toEqual(expected);
    expect(readFileSync(older, 'utf-8')).toBe(snapshot[0]);
  });

  it('automations are stamped at create too, and the face is not hashed', () => {
    makeAgent();
    const m = createAutomation(contextRoot, { slug: 'scout-daily', title: 'Scout daily', agent: 'scout', days: 'daily', at: '08:00' } as never);
    expect(readFileSync(m.path, 'utf-8')).toMatch(/face:\n\s+shape: \d\n\s+color: \d/);
    const target = getRunTarget(contextRoot, 'scout', 'agent')!;
    approveAutomation(projectRoot, target, NOW, home);
    backfillFaces(contextRoot);
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'scout', 'agent')!, home, 'run').approved).toBe(true);
  });

  it('no green or magenta identity tone', () => {
    expect(FIGURE_TONES).toHaveLength(8);
    for (const t of FIGURE_TONES) expect(['green', 'magenta', 'lime', 'emerald', 'fuchsia']).not.toContain(t);
  });
});

// ─── 6. filing approval ──────────────────────────────────────────────────────

describe('AC-A1-6 filing approval', () => {
  function task(slug: string, filedBy: string | null, status = 'todo'): void {
    mkdirSync(join(contextRoot, 'overrides'), { recursive: true });
    writeFileSync(join(contextRoot, 'overrides', 'task.md'), '---\nstatuses:\n  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }\n---\n', 'utf-8');
    writeFileSync(join(contextRoot, 'state', `${slug}.md`), [
      '---', `id: task_${slug}`, `name: ${slug}`, `description: ${slug}`, 'priority: medium', 'urgency: medium',
      `status: ${status}`, "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []',
      ...(filedBy ? [`filed_by: ${filedBy}`] : []), '---', '', '## Why', '', 'Because.', '', '## Changelog', '',
    ].join('\n'));
  }

  it('records the approval and a changelog line, leaves the status, and is idempotent', async () => {
    task('agent-task', 'agent');
    const backend = new LocalTaskBackend(join(contextRoot, 'state'));
    const r = await approveFiling(contextRoot, backend, 'agent-task', { now: NOW, env: {} });
    expect(r.ok && r.already).toBe(false);
    const t = await backend.get('agent-task');
    expect(t!.filing_approved).toEqual({ at: NOW.toISOString() });
    expect(t!.status).toBe('todo');
    expect(readFileSync(join(contextRoot, 'state', 'agent-task.md'), 'utf-8')).toMatch(/### \d{4}-\d{2}-\d{2} - Approved \(owner\)/);
    const again = await approveFiling(contextRoot, backend, 'agent-task', { env: {} });
    expect(again.ok && again.already).toBe(true);
  });

  it('refuses an owner-filed task, a cancelled one, an unknown one and an agent run', async () => {
    task('mine', 'human');
    task('gone', 'sleep', 'cancelled');
    task('fine', 'plan');
    const backend = new LocalTaskBackend(join(contextRoot, 'state'));
    expect(await approveFiling(contextRoot, backend, 'mine', { env: {} })).toMatchObject({ ok: false, code: 'filed_by_owner', status: 409 });
    expect(await approveFiling(contextRoot, backend, 'gone', { env: {} })).toMatchObject({ ok: false, code: 'cancelled', status: 409 });
    expect(await approveFiling(contextRoot, backend, 'nope', { env: {} })).toMatchObject({ ok: false, status: 404 });
    expect(await approveFiling(contextRoot, backend, 'fine', { env: { [AGENT_SELF_ENV]: 'scout' } })).toMatchObject({ ok: false, code: 'agent_run', status: 403 });
    expect((await backend.get('fine'))!.filing_approved).toBeUndefined();
  });

  it('the route and the CLI verb', async () => {
    task('route-task', 'agent');
    task('cli-task', 'sleep');
    task('mine', 'human');
    const res = fakeRes();
    await handleTasksFilingApproval(fakeReq(), res, { slug: 'route-task' }, contextRoot);
    expect(res.status).toBe(200);
    expect((res.json().task as { filing_approved?: unknown }).filing_approved).toBeTruthy();
    const refused = fakeRes();
    await handleTasksFilingApproval(fakeReq(), refused, { slug: 'mine' }, contextRoot);
    expect(refused.status).toBe(409);
    expect((await runCli(['tasks', 'approve-filing', 'cli-task'])).code).toBe(0);
    expect(readFileSync(join(contextRoot, 'state', 'cli-task.md'), 'utf-8')).toContain('filing_approved:');
    expect((await runCli(['tasks', 'approve-filing', 'mine'])).code).toBe(1);
  });
});

// ─── End-review fixes (multi-review r1) ──────────────────────────────────────

describe('review r1: an agent conversation is an agent run for owner-only verbs', () => {
  it('every agent conversation carries the marker, scoped or not', () => {
    makeAgent();
    const prep = prepareAgentChat(contextRoot, 'scout', home);
    expect(prep.ok && prep.env[AGENT_CHAT_ENV]).toBe('scout');
    expect(insideAgentRun({ [AGENT_CHAT_ENV]: 'scout' })).toBe(true);
    expect(insideAgentRun({})).toBe(false);
  });

  it('`agents edit --autonomy`, `tasks approve-filing` and `tasks assign-agent` refuse it', async () => {
    makeAgent();
    writeFileSync(join(contextRoot, 'state', 'opened.md'), ['---', 'id: task_opened', 'name: opened', "description: ''", 'priority: medium', 'urgency: medium', 'status: todo', "created_at: '2026-10-24'", "updated_at: '2026-10-24'", 'tags: []', 'filed_by: agent', '---', '', '## Why', '', 'x', ''].join('\n'));
    process.env[AGENT_CHAT_ENV] = 'scout';
    const edit = await runCli(['agents', 'edit', 'scout', '--autonomy', 'free']);
    expect(edit.code).toBe(1);
    expect(getAgent(contextRoot, 'scout')!.autonomy).toBe('balanced');
    expect((await runCli(['tasks', 'approve-filing', 'opened'])).code).toBe(1);
    expect(readFileSync(join(contextRoot, 'state', 'opened.md'), 'utf-8')).not.toContain('filing_approved');
    expect((await runCli(['tasks', 'assign-agent', 'opened', 'scout'])).code).toBe(1);
  });

  it('a Free agent conversation counts as a bypass resume for the T24 gate', () => {
    makeAgent('roamer', { autonomy: 'free' });
    makeAgent('middle');
    expect(resumeRunsBypass(false, contextRoot, 'roamer')).toBe(true);
    expect(resumeRunsBypass(false, contextRoot, 'middle')).toBe(false);
    expect(resumeRunsBypass(false, contextRoot, null)).toBe(false);
    expect(resumeRunsBypass(true, contextRoot, null)).toBe(true);
  });
});

describe('review r1: a change to the account register voids a standing wait', () => {
  it('adding an account after the wait was recorded lets the next start decide afresh', async () => {
    const t0 = Date.now();
    recordAccountWait(t0 + 3 * 86_400_000, home, t0 - 1000);
    expect(readAccountWait(home, t0)).toBe(t0 + 3 * 86_400_000);
    upsertClaudeAccount({
      id: 'later', accountUuid: 'u', email: 'later@example.test', organizationUuid: 'o', organizationName: 'O', tier: 'max', configDir: sandboxDirFor('later', home), preferred: true,
    }, home);
    expect(readAccountWait(home, t0)).toBeNull();
  });
});

describe('review r1: the backfill never stamps a shared file', () => {
  it('a shared member keeps drawing its bare hash; a private one is stamped', () => {
    mkdirSync(join(contextRoot, 'agents'), { recursive: true });
    const shared = join(contextRoot, 'agents', 'team-scout.md');
    const own = join(contextRoot, 'agents', 'own-scout.md');
    writeFileSync(shared, '---\nid: agt_s\ntitle: Team scout\nshared: true\n---\n\n## Prompt\n\nS.\n');
    writeFileSync(own, '---\nid: agt_o\ntitle: Own scout\nshared: false\n---\n\n## Prompt\n\nO.\n');
    const before = readFileSync(shared, 'utf-8');
    expect(backfillFaces(contextRoot)).toEqual([own]);
    expect(readFileSync(shared, 'utf-8')).toBe(before);
    expect(backfillFaces(contextRoot)).toEqual([]);
  });
});
