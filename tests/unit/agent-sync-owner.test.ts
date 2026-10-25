/**
 * AI Team v2, wave B1: owner-only write, read-only for everyone else, and the machine-local
 * records that keep synced fields from starting anything.
 *
 * One process is one machine: `$HOME` is the machine (its login in `.secrets.json`, its id in
 * `machine.json`, its M0 store and approval registry). A teammate's agent is a manifest whose
 * `owner:` is another login, exactly as it arrives by the brain sync.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setGlobalGitHubLogin } from '../../src/lib/git-sync/auth-store.js';
import { readMachineIdentity } from '../../src/lib/machine-id.js';
import { readVaultFileSafe } from '../../src/lib/vault-read.js';
import { currentLogin, foreignOwner, isNotOwnerError, ownedBy, UNOWNED } from '../../src/lib/agents/owner.js';
import { createAgent, getAgent, removeAgent, setAgentPlacement, setAgentShared, updateAgent } from '../../src/lib/agents/store.js';
import { createAutomation, getRunTarget, updateAutomation } from '../../src/lib/automations/store.js';
import {
  approveAutomation,
  checkApproval,
  manifestHash,
  readAutomationsRegistry,
  writeAutomationsRegistry,
} from '../../src/lib/automations/registry.js';
import { renderAutomationsSection } from '../../src/lib/automations/snapshot.js';
import { prepareAssignment, commitAssignment, consumeAssignmentStart } from '../../src/lib/agents/task-assignment.js';
import { prepareAgentChat } from '../../src/lib/whiteboards/card-chat.js';
import { resolveSpawnScope } from '../../src/lib/automations/board-scope.js';
import { mergeAgentActive, mergeAgentManifest, mergeConfigJson, classifyPath } from '../../src/lib/git-sync/semantic-merge.js';
import { appendThreadEntry, readThread, threadDayPath } from '../../src/lib/automations/threads.js';
import { buildRecentHistoryBlock } from '../../src/lib/automations/history.js';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { adoptPattern, confirmAgentSyncHere, effectivePattern, readPendingRestores, recordThreadEntryHere, resolvePendingRestores, stampOwners } from '../../src/lib/agents/agent-sync.js';
import { currentOwnAssignments, scanOutsideAssignments } from '../../src/lib/agents/outside-assignments.js';
import { forgetTaskAssignments, readAssignmentLedger, seedAssignmentLedger } from '../../src/lib/agents/assignment-ledger.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { placement, writeActiveHere } from '../../src/lib/agents/active.js';
import { handleAgentsApprove, handleAgentsDelete, handleAgentsPlace, handleAgentsUpdate, handleAgentsList, type AgentSummary } from '../../src/server/routes/agents.js';
import { handleAgentsBringHere } from '../../src/server/routes/agent-sync.js';
import { handleAutomationsSay, handleAutomationsThreadReply, handleAutomationsApprove } from '../../src/server/routes/automations.js';
import { handleTasksAssignAgent } from '../../src/server/routes/tasks.js';

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
  return Object.assign(readable, { method: 'POST', headers: {} }) as unknown as IncomingMessage;
}

const NOW = new Date('2026-10-25T09:00:00.000Z');

let projectRoot: string;
let contextRoot: string;
let realHome: string | undefined;
let home: string;

/** Rewrite a manifest's `owner:` as if it had arrived from `owner`'s machine. */
function ownedByTeammate(path: string, owner: string): void {
  const raw = readFileSync(path, 'utf-8');
  writeFileSync(path, raw.replace(/^owner:.*$/m, `owner: ${owner}`), 'utf-8');
}

function writeTask(slug: string, fields: Record<string, string>): void {
  const fm = Object.entries({ id: `task_${slug}`, name: slug, status: 'todo', ...fields }).map(([k, v]) => `${k}: ${v}`).join('\n');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  writeFileSync(join(contextRoot, 'state', `${slug}.md`), `---\n${fm}\n---\n\n## Why\n\nx\n\n## Changelog\n`, 'utf-8');
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-b1-owner-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(join(contextRoot, 'automations'), { recursive: true });
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-b1-owner-home-'));
  process.env.HOME = home;
  setGlobalGitHubLogin('bob', home);
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('owner identity (B1-1, B1-3)', () => {
  it('is the signed-in login, else machine:<id>; a stamped member is owned only by that identity', () => {
    expect(currentLogin()).toBe('bob');
    expect(ownedBy('bob')).toBe(true);
    expect(ownedBy('BOB')).toBe(true);
    expect(ownedBy('alice')).toBe(false);
    expect(ownedBy(UNOWNED)).toBe(false);
    // Unstamped (predates owners): still behind the approval hash, owned until the migration stamps it.
    expect(ownedBy(null)).toBe(true);
    expect(ownedBy(`machine:${readMachineIdentity().id}`)).toBe(true);
    expect(ownedBy('machine:000000000000')).toBe(false);
    expect(foreignOwner({ owner: 'bob', jobOwner: 'alice' })).toBe('alice');
  });

  it('create stamps owner: and updated: on agents and routines', () => {
    const a = createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'Research.' }, { approve: { now: NOW } });
    expect(a.owner).toBe('bob');
    expect(a.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    createAutomation(contextRoot, { slug: 'daily-brief', title: 'Daily brief', agent: 'researcher', days: 'daily', at: '09:00' });
    expect(readFileSync(join(contextRoot, 'automations', 'daily-brief.md'), 'utf-8')).toMatch(/^owner: bob$/m);
  });
});

describe('a teammate\'s agent is read-only here (B1-4, AC-B1-2)', () => {
  beforeEach(() => {
    createAgent(contextRoot, { slug: 'helper', title: 'Helper', prompt: 'Help.' }, { approve: { now: NOW } });
    // The approval this machine held from before (a formerly shared slug) stays in the registry.
    ownedByTeammate(join(contextRoot, 'agents', 'helper.md'), 'alice');
  });

  it('checkApproval returns not_owner FIRST, even with a matching approval held here', () => {
    const target = getRunTarget(contextRoot, 'helper', 'agent')!;
    // Re-grant the exact current hash behind the gate's back: not_owner must still win.
    const reg = readAutomationsRegistry();
    const key = Object.keys(reg.projects)[0];
    reg.projects[key].agentApprovals = { helper: { manifestSha256: manifestHash(target), approvedAt: NOW.toISOString(), payloadVersion: reg.projects[key].agentApprovals!.helper.payloadVersion } };
    writeAutomationsRegistry(reg);
    for (const use of ['run', 'identity'] as const) {
      const v = checkApproval(projectRoot, target, undefined, use);
      expect(v.approved).toBe(false);
      if (!v.approved) expect(v.reason).toBe('not_owner');
    }
  });

  it('every store write refuses not_owner, and nothing on disk changes', () => {
    const before = readFileSync(join(contextRoot, 'agents', 'helper.md'), 'utf-8');
    const attempts: Array<[string, () => unknown]> = [
      ['edit', () => updateAgent(contextRoot, 'helper', { title: 'Mine now' })],
      ['autonomy', () => updateAgent(contextRoot, 'helper', { autonomy: 'free' })],
      ['delete', () => removeAgent(contextRoot, 'helper')],
      ['share', () => setAgentShared(contextRoot, 'helper', true)],
      ['place', () => setAgentPlacement(contextRoot, 'helper', { team: 'mine' })],
      ['approve', () => approveAutomation(projectRoot, getRunTarget(contextRoot, 'helper', 'agent')!, NOW)],
      ['routine create', () => createAutomation(contextRoot, { slug: 'nightly', title: 'Nightly', agent: 'helper', days: 'daily', at: '02:00' })],
      ['automation edit', () => updateAutomation(contextRoot, 'helper', { title: 'x' })],
    ];
    for (const [what, fn] of attempts) {
      let err: unknown = null;
      try { fn(); } catch (e) { err = e; }
      expect(isNotOwnerError(err), what).toBe(true);
    }
    expect(readFileSync(join(contextRoot, 'agents', 'helper.md'), 'utf-8')).toBe(before);
  });

  it('assigning a task to it refuses not_owner (the shared step behind the CLI and the server)', () => {
    writeTask('write-docs', {});
    const prep = prepareAssignment(contextRoot, 'write-docs', 'helper', { source: 'cli' });
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.code).toBe('not_owner');
  });

  it('the stage chat and card chat refuse it as read-only', () => {
    const prep = prepareAgentChat(contextRoot, 'helper');
    expect(prep.ok).toBe(false);
    if (!prep.ok) expect(prep.reason).toMatch(/read-only here/);
    // Card chat and every spawn go through the same scope gate.
    for (const use of ['identity', 'run'] as const) {
      const scoped = resolveSpawnScope(contextRoot, getRunTarget(contextRoot, 'helper', 'agent')!, undefined, use);
      expect(scoped.ok).toBe(false);
      if (!scoped.ok) expect(scoped.reason).toMatch(/read-only here/);
    }
  });

  it('the snapshot carries no "needs approval" line for it, only one read-only line', () => {
    const snap = renderAutomationsSection(contextRoot, { now: NOW }).join('\n');
    expect(snap).not.toMatch(/helper.*needs approval/);
    expect(snap).toMatch(/1 teammates' agent \(read-only\)/);
  });

  it('every HTTP write route answers 403 not_owner', async () => {
    writeTask('write-docs', {});
    const routes: Array<[string, (res: ServerResponse) => Promise<void>]> = [
      ['update', (res) => handleAgentsUpdate(post({ title: 'x' }), res, { slug: 'helper' }, contextRoot)],
      ['place', (res) => handleAgentsPlace(post({ team: 'x' }), res, { slug: 'helper' }, contextRoot)],
      ['delete', (res) => handleAgentsDelete(post(), res, { slug: 'helper' }, contextRoot)],
      ['approve', (res) => handleAgentsApprove(post(), res, { slug: 'helper' }, contextRoot)],
      ['bring-here', (res) => handleAgentsBringHere(post(), res, { slug: 'helper' }, contextRoot)],
      ['automation approve', (res) => handleAutomationsApprove(post(), res, { slug: 'helper' }, contextRoot)],
      ['say', (res) => handleAutomationsSay(post({ slug: 'helper', text: 'hi' }), res, {}, contextRoot)],
      ['thread reply', (res) => handleAutomationsThreadReply(post({ text: 'hi' }), res, { slug: 'helper' }, contextRoot)],
      ['assign task', (res) => handleTasksAssignAgent(post({ agent: 'helper' }), res, { slug: 'write-docs' }, contextRoot)],
    ];
    for (const [what, call] of routes) {
      const { res, status, body } = makeRes();
      await call(res);
      expect(status(), what).toBe(403);
      expect(body().error, what).toBe('not_owner');
    }
  });

  it('the agents list reports readOnly and the owner, with no approval reason', async () => {
    const { res, body } = makeRes();
    await handleAgentsList({ method: 'GET', headers: {} } as unknown as IncomingMessage, res, {}, contextRoot);
    const helper = (body().agents as AgentSummary[]).find((a) => a.slug === 'helper')!;
    expect(helper.readOnly).toBe(true);
    expect(helper.owner).toBe('alice');
    expect(helper.approvalReason).toBeNull();
    expect(helper.approvedToRun).toBe(false);
  });
});

describe('merge classes (B1-7, B1-8) and the switch', () => {
  it('classifies agent paths', () => {
    expect(classifyPath('_dream_context/agents/researcher.md')).toBe('agent-manifest');
    expect(classifyPath('_dream_context/automations/daily-brief.md')).toBe('agent-manifest');
    expect(classifyPath('_dream_context/agents/.active/researcher.json')).toBe('agent-active');
    expect(classifyPath('_dream_context/automations/output/researcher/2026-10-25.md')).toBe('agent-file');
    expect(classifyPath('_dream_context/automations/threads/researcher/2026-10-25-aaaaaaaaaaaa.md')).toBe('agent-file');
  });

  it('agent-active: later since wins, tie goes to the lower machine id, a future since loses', () => {
    const rec = (machine: string, since: string) => JSON.stringify({ machine, since, by: 'bob' });
    expect(mergeAgentActive(rec('aaa', '2026-10-25T07:00:00Z'), rec('bbb', '2026-10-25T08:30:00Z'), NOW).merged).toContain('bbb');
    expect(mergeAgentActive(rec('bbb', '2026-10-25T08:00:00Z'), rec('aaa', '2026-10-25T08:00:00Z'), NOW).merged).toContain('aaa');
    expect(mergeAgentActive(rec('aaa', '2026-10-25T08:00:00Z'), rec('bbb', '2027-01-01T00:00:00Z'), NOW).merged).toContain('aaa');
  });

  it('agent-manifest: never blended; same id keeps the owner\'s copy, two ids park ours', () => {
    const m = (id: string, owner: string, updated: string, body: string) => `---\nid: ${id}\nowner: ${owner}\nupdated: ${updated}\n---\n\n${body}\n`;
    const ours = m('agt_1', 'bob', '2026-10-25T08:00:00Z', 'mine');
    // Same login, two machines: the later `updated` wins.
    expect(mergeAgentManifest(ours, m('agt_1', 'bob', '2026-10-25T09:00:00Z', 'newer'), 'bob')).toEqual({ kind: 'take', merged: m('agt_1', 'bob', '2026-10-25T09:00:00Z', 'newer') });
    expect(mergeAgentManifest(ours, m('agt_1', 'bob', '2026-10-25T07:00:00Z', 'older'), 'bob').merged).toBe(ours);
    // On any other machine the incoming copy wins (read-only there).
    expect(mergeAgentManifest(ours, m('agt_1', 'bob', '2026-10-25T07:00:00Z', 'theirs'), 'carol').merged).toContain('theirs');
    // Two creators, one slug.
    expect(mergeAgentManifest(ours, m('agt_2', 'alice', '2026-10-25T07:00:00Z', 'alice'), 'bob').kind).toBe('park-ours');
  });

  it('config-json ORs agentSync and never writes it false', () => {
    const merged = JSON.parse(mergeConfigJson('{}', JSON.stringify({ packs: [] }), JSON.stringify({ packs: [], agentSync: true })).merged);
    expect(merged.agentSync).toBe(true);
    const off = JSON.parse(mergeConfigJson('{}', JSON.stringify({ packs: [], agentSync: false }), JSON.stringify({ packs: [] })).merged);
    expect(off.agentSync).toBeUndefined();
  });
});

describe('M2 safe reader', () => {
  it('refuses a symlink and a path outside the root', () => {
    writeFileSync(join(projectRoot, 'secret.txt'), 'nope', 'utf-8');
    mkdirSync(join(contextRoot, 'agents'), { recursive: true });
    symlinkSync(join(projectRoot, 'secret.txt'), join(contextRoot, 'agents', 'evil.md'));
    writeFileSync(join(contextRoot, 'agents', 'ok.md'), 'fine', 'utf-8');
    expect(readVaultFileSafe(contextRoot, 'agents/evil.md')).toBeNull();
    expect(readVaultFileSafe(contextRoot, '../secret.txt')).toBeNull();
    expect(readVaultFileSafe(contextRoot, 'agents/ok.md')).toBe('fine');
  });
});

describe('threads per machine, and history only from this machine (B1-6, B1-7, AC-B1-5)', () => {
  beforeEach(() => {
    createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'Research.', learning: true }, { approve: { now: NOW } });
  });

  it('a day file is named for this machine; a teammate\'s file of the same day is read too', () => {
    const own = appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'mine', via: 'cli', now: NOW });
    expect(threadDayPath(contextRoot, 'researcher', NOW)).toMatch(new RegExp(`2026-10-25-${readMachineIdentity().id}\\.md$`));
    const theirs = `---\nslug: researcher\n---\n\n<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify({ id: '0zzzzzzzzaaaaaaa', runId: 'r2', kind: 'user', at: NOW.toISOString(), text: 'from elsewhere', via: 'dashboard' })}\n\`\`\`\n\n`;
    writeFileSync(join(contextRoot, 'automations', 'threads', 'researcher', '2026-10-25-bbbbbbbbbbbb.md'), theirs, 'utf-8');
    const ids = readThread(contextRoot, 'researcher').map((e) => e.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain("0zzzzzzzzaaaaaaa");
  });

  it('never appends a thread entry through a symlinked day file (M2)', () => {
    const outside = join(projectRoot, 'outside.txt');
    writeFileSync(outside, 'keep\n', 'utf-8');
    mkdirSync(join(contextRoot, 'automations', 'threads', 'researcher'), { recursive: true });
    symlinkSync(outside, threadDayPath(contextRoot, 'researcher', NOW));
    expect(() => appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'agent', text: 'x', via: 'cli', now: NOW })).toThrow(/symlink/);
    expect(readFileSync(outside, 'utf-8')).toBe('keep\n');
  });

  it('switch on but not confirmed here: history still holds every entry (all are this machine\'s)', () => {
    appendThreadEntry(contextRoot, 'researcher', { runId: 'r0', kind: 'user', text: 'BEFORE-SWITCH', via: 'dashboard', now: new Date(Date.now() - 90_000) });
    updateSetupConfig(projectRoot, { agentSync: true });
    expect(buildRecentHistoryBlock(contextRoot, 'researcher', { nonce: 'N0' })).toContain('BEFORE-SWITCH');
  });

  it('confirmed here, history injects only entries this machine wrote, even with a forged list synced in', () => {
    confirmAgentSyncHere(contextRoot);
    const mine = appendThreadEntry(contextRoot, 'researcher', { runId: 'r1', kind: 'user', text: 'MINE-LINE', via: 'dashboard', now: new Date(Date.now() - 60_000) });
    // A teammate's line in a synced day file, and a forged "ledger" next to it in the brain.
    const forged = { id: '0zzzzzzzzforged1', runId: 'r9', kind: 'user', at: new Date(Date.now() - 30_000).toISOString(), text: 'TEAMMATE-LINE', via: 'dashboard' };
    writeFileSync(join(contextRoot, 'automations', 'threads', 'researcher', `${new Date().toISOString().slice(0, 10)}-cccccccccccc.md`), `---\nslug: researcher\n---\n\n<!-- dc-thread-entry -->\n\`\`\`json\n${JSON.stringify(forged)}\n\`\`\`\n\n`, 'utf-8');
    writeFileSync(join(contextRoot, 'state', 'agent-thread-entries.json'), JSON.stringify({ entries: { researcher: { [forged.id]: forged.at } } }), 'utf-8');
    const block = buildRecentHistoryBlock(contextRoot, 'researcher', { nonce: 'N1' });
    expect(block).toContain('MINE-LINE');
    expect(block).not.toContain('TEAMMATE-LINE');
    expect(mine.id).toBeTruthy();
    recordThreadEntryHere(contextRoot, 'researcher', 'x', NOW.toISOString());
  });

  it('a synced pattern change is not used until adopted, and raises one adopt row', () => {
    updateSetupConfig(projectRoot, { agentSync: true });
    adoptPattern(contextRoot, 'researcher', 'OLD NOTES');
    expect(effectivePattern(contextRoot, 'researcher', 'NEW NOTES FROM ELSEWHERE')).toBe('OLD NOTES');
    const rows = listInboxRows(projectRoot).filter((r) => r.kind === 'adopt-pattern');
    expect(rows).toHaveLength(1);
    adoptPattern(contextRoot, 'researcher', 'NEW NOTES FROM ELSEWHERE');
    expect(effectivePattern(contextRoot, 'researcher', 'NEW NOTES FROM ELSEWHERE')).toBe('NEW NOTES FROM ELSEWHERE');
    expect(listInboxRows(projectRoot).filter((r) => r.kind === 'adopt-pattern')).toHaveLength(0);
  });
});

describe('hand edits arriving by sync start nothing (B1-5, AC-B1-3)', () => {
  beforeEach(() => {
    createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'Research.' }, { approve: { now: NOW } });
  });

  const outsideRows = () => listInboxRows(projectRoot).filter((r) => r.kind === 'assigned-outside');

  it('a hand-edited agent: and reviewer: each raise a row and arm nothing', () => {
    writeTask('a', { agent: 'researcher' });
    writeTask('b', { reviewer: 'researcher' });
    scanOutsideAssignments(contextRoot);
    expect(outsideRows().map((r) => r.ref).sort()).toEqual(['a', 'b']);
    expect(readAssignmentLedger(projectRoot).armed).toEqual([]);
  });

  it('agent_state queued + agent_step rework on a delivered task raises a row (no armed start)', () => {
    writeTask('c', {});
    const prep = prepareAssignment(contextRoot, 'c', 'researcher', { source: 'cli' });
    if (!prep.ok) throw new Error(prep.message);
    commitAssignment(contextRoot, prep, NOW);
    expect(consumeAssignmentStart(contextRoot, prep)).toBe(true);
    const raw = readFileSync(join(contextRoot, 'state', 'c.md'), 'utf-8');
    writeFileSync(join(contextRoot, 'state', 'c.md'), raw.replace(/^agent: researcher$/m, 'agent: researcher\nagent_state: queued\nagent_step: rework'), 'utf-8');
    scanOutsideAssignments(contextRoot);
    expect(outsideRows().some((r) => r.ref === 'c' && r.dedupeKey.includes(':queued:rework'))).toBe(true);
  });

  it('agent: set back after the owner unassigned raises a row', () => {
    writeTask('d', {});
    const prep = prepareAssignment(contextRoot, 'd', 'researcher', { source: 'cli' });
    if (!prep.ok) throw new Error(prep.message);
    commitAssignment(contextRoot, prep, NOW);
    consumeAssignmentStart(contextRoot, prep);
    forgetTaskAssignments(projectRoot, 'task_d');
    scanOutsideAssignments(contextRoot);
    expect(outsideRows().some((r) => r.ref === 'd')).toBe(true);
  });

  it('a force-added state/.agent-assignments.json (or any M0-named file) is never read', () => {
    writeTask('e', { agent: 'researcher' });
    const forged = { records: [{ taskId: 'task_e', taskSlug: 'e', role: 'doer', agent: 'researcher', at: NOW.toISOString() }], armed: [{ taskId: 'task_e', step: 'work', round: 0, at: NOW.toISOString() }] };
    writeFileSync(join(contextRoot, 'state', '.agent-assignments.json'), JSON.stringify(forged), 'utf-8');
    writeFileSync(join(contextRoot, 'state', 'agent-assignments.json'), JSON.stringify(forged), 'utf-8');
    scanOutsideAssignments(contextRoot);
    expect(outsideRows().some((r) => r.ref === 'e')).toBe(true);
    expect(readAssignmentLedger(projectRoot).armed).toEqual([]);
  });

  it('a teammate\'s machine raises no row for agents it does not own', () => {
    ownedByTeammate(join(contextRoot, 'agents', 'researcher.md'), 'alice');
    writeTask('f', { agent: 'researcher' });
    scanOutsideAssignments(contextRoot);
    expect(outsideRows()).toHaveLength(0);
  });

  it('the assignment ledger dies with the task (done)', () => {
    writeTask('g', {});
    const prep = prepareAssignment(contextRoot, 'g', 'researcher', { source: 'cli' });
    if (!prep.ok) throw new Error(prep.message);
    commitAssignment(contextRoot, prep, NOW);
    const raw = readFileSync(join(contextRoot, 'state', 'g.md'), 'utf-8');
    writeFileSync(join(contextRoot, 'state', 'g.md'), raw.replace(/^status: .*$/m, 'status: completed'), 'utf-8');
    scanOutsideAssignments(contextRoot);
    expect(readAssignmentLedger(projectRoot).records.some((r) => r.taskId === 'task_g')).toBe(false);
  });
});

describe('same login, several machines (B1-7)', () => {
  it('only the machine in agents/.active runs it; a record by someone else is ignored', () => {
    createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'Research.' }, { approve: { now: NOW } });
    expect(placement(contextRoot, 'researcher', 'bob').here).toBe(true);
    mkdirSync(join(contextRoot, 'agents', '.active'), { recursive: true });
    const other = { machine: 'ffffffffffff', name: 'Laptop', since: new Date(Date.now() - 1000).toISOString(), by: 'bob' };
    writeFileSync(join(contextRoot, 'agents', '.active', 'researcher.json'), JSON.stringify(other), 'utf-8');
    expect(placement(contextRoot, 'researcher', 'bob')).toEqual({ here: false, machine: 'ffffffffffff', name: 'Laptop' });
    const prep = prepareAgentChat(contextRoot, 'researcher');
    expect(prep.ok).toBe(false);
    // Written by a teammate: ignored.
    writeFileSync(join(contextRoot, 'agents', '.active', 'researcher.json'), JSON.stringify({ ...other, by: 'alice' }), 'utf-8');
    expect(placement(contextRoot, 'researcher', 'bob').here).toBe(true);
    // Bring it here.
    writeFileSync(join(contextRoot, 'agents', '.active', 'researcher.json'), JSON.stringify(other), 'utf-8');
    const rec = writeActiveHere(contextRoot, 'researcher', 'bob');
    expect(rec.from?.name).toBe('Laptop');
    expect(placement(contextRoot, 'researcher', 'bob').here).toBe(true);
    expect(getAgent(contextRoot, 'researcher')).not.toBeNull();
  });
});

describe('review r1 fixes', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf-8' });

  it('owner stamping: a file committed with this machine\'s own git identity is its owner\'s; an unnameable one is unowned until a later run can name it', () => {
    git('init', '-q');
    git('config', 'user.email', 'me@example.test');
    git('config', 'user.name', 'me');
    createAgent(contextRoot, { slug: 'mine', title: 'Mine', prompt: 'x' }, { approve: { now: NOW } });
    createAgent(contextRoot, { slug: 'theirs', title: 'Theirs', prompt: 'y' }, { approve: { now: NOW } });
    for (const slug of ['mine', 'theirs']) {
      const pth = join(contextRoot, 'agents', `${slug}.md`);
      writeFileSync(pth, readFileSync(pth, 'utf-8').replace(/^owner:.*\n/m, ''), 'utf-8');
    }
    git('add', '-f', '_dream_context/agents/mine.md');
    git('commit', '-q', '-m', 'mine');
    git('add', '-f', '_dream_context/agents/theirs.md');
    git('-c', 'user.email=someone@example.test', 'commit', '-q', '-m', 'theirs', '--author', 'Someone <someone@example.test>');
    stampOwners(contextRoot);
    expect(getAgent(contextRoot, 'mine')?.owner).toBe('bob');
    expect(getAgent(contextRoot, 'theirs')?.owner).toBe(UNOWNED);
    // The roster learns who that is: the next run names them.
    updateSetupConfig(projectRoot, { peopleIdentity: { someone: { githubLogin: 'carol' } } });
    mkdirSync(join(contextRoot, 'people'), { recursive: true });
    writeFileSync(join(contextRoot, 'people', 'people.json'), JSON.stringify({ version: 1, people: { someone: { name: 'Someone', emails: ['someone@example.test'] } } }), 'utf-8');
    stampOwners(contextRoot);
    expect(getAgent(contextRoot, 'theirs')?.owner).toBe('carol');
  });

  it('an interrupted rename resumes: its approval follows the new name and the record dies', async () => {
    createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'mine' }, { approve: { now: NOW } });
    // Step 1 happened (the manifest is in place as researcher-2), then the process died.
    renameSync(join(contextRoot, 'agents', 'researcher.md'), join(contextRoot, 'agents', 'researcher-2.md'));
    writeFileSync(join(contextRoot, 'agents', 'researcher.md'), '---\nid: agt_theirs\nowner: alice\ntitle: Researcher\n---\n\n## Prompt\n\ntheirs\n', 'utf-8');
    const dir = join(home, '.dreamcontext', 'local');
    mkdirSync(dir, { recursive: true });
    const { localDir } = await import('../../src/lib/local-store.js');
    mkdirSync(localDir(projectRoot), { recursive: true });
    writeFileSync(join(localDir(projectRoot), 'agent-restores.json'), JSON.stringify({ pending: [{ path: '_dream_context/agents/researcher.md', slug: 'researcher', backup: join(dir, 'gone.md'), remoteSha: '', at: NOW.toISOString(), to: 'researcher-2' }] }), 'utf-8');
    await resolvePendingRestores(projectRoot, contextRoot);
    expect(checkApproval(projectRoot, getRunTarget(contextRoot, 'researcher-2', 'agent')!, undefined, 'run').approved).toBe(true);
    expect(readPendingRestores(projectRoot)).toEqual([]);
  });

  it('the upgrade seeds the ledger from assignments already in flight: no "assigned outside" flood', () => {
    createAgent(contextRoot, { slug: 'researcher', title: 'Researcher', prompt: 'x' }, { approve: { now: NOW } });
    writeTask('old-one', { agent: 'researcher' });
    expect(seedAssignmentLedger(projectRoot, currentOwnAssignments(contextRoot))).toBe(1);
    scanOutsideAssignments(contextRoot);
    expect(listInboxRows(projectRoot).filter((r) => r.kind === 'assigned-outside')).toHaveLength(0);
    // Once only: a later hand edit is not absorbed.
    writeTask('new-one', { agent: 'researcher' });
    expect(seedAssignmentLedger(projectRoot, currentOwnAssignments(contextRoot))).toBe(0);
    scanOutsideAssignments(contextRoot);
    expect(listInboxRows(projectRoot).filter((r) => r.kind === 'assigned-outside').map((r) => r.ref)).toEqual(['new-one']);
  });
});
