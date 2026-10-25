/**
 * AI Team v2, wave B1, end to end: agents and automations ride the EXISTING brain sync between
 * machines. Real git, a local bare remote, one fake `$HOME` per machine (its login, its machine id,
 * its M0 store, its approval registry). No network: `GITHUB_TOKEN` is a dummy, a local-path remote
 * never asks for it.
 *
 * AC-B1-1 (migration + secret scan), AC-B1-2 (ownership of a shared agent, read-only on the other
 * login), AC-B1-4 (same login, two machines) and AC-B1-6 (same-slug collisions and their variants).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig } from '../../src/lib/setup-config.js';
import { runBrainSync, type SyncResult } from '../../src/lib/git-sync/sync-engine.js';
import { setGlobalGitHubLogin } from '../../src/lib/git-sync/auth-store.js';
import { readMachineIdentity } from '../../src/lib/machine-id.js';
import { createAgent, getAgent, setAgentShared } from '../../src/lib/agents/store.js';
import { shareAgent } from '../../src/lib/automations/sharing.js';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { checkApproval, manifestHash, readAutomationsRegistry, writeAutomationsRegistry } from '../../src/lib/automations/registry.js';
import { APPROVAL_PAYLOAD_VERSION } from '../../src/lib/automations/types.js';
import { appendThreadEntry, threadDayPath, threadDateStamp } from '../../src/lib/automations/threads.js';
import { agentStagePass, agentSyncState, confirmAgentSyncHere, guardPullCollisions, stampOwners } from '../../src/lib/agents/agent-sync.js';
import { placement, writeActiveHere } from '../../src/lib/agents/active.js';
import { listInboxRows } from '../../src/lib/owner-inbox.js';
import { runAutomation } from '../../src/lib/automations/runner.js';
import { commitAssignment, prepareAssignment } from '../../src/lib/agents/task-assignment.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

interface Machine {
  name: string;
  login: string;
  home: string;
  repo: string;
  ctx: string;
}

const made: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function newBare(): string {
  const bare = tmp('dc-b1-bare-');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare]);
  return bare;
}

function use(m: Machine): void {
  process.env.HOME = m.home;
}

/** A machine signed in as `login`. The first one initialises the project; later ones clone it. */
function machine(name: string, login: string, bare: string, first: boolean): Machine {
  const home = tmp(`dc-b1-home-${name}-`);
  setGlobalGitHubLogin(login, home);
  const parent = tmp(`dc-b1-${name}-`);
  const repo = join(parent, 'repo');
  if (first) {
    mkdirSync(repo, { recursive: true });
    git(repo, ['init', '--initial-branch=main']);
    git(repo, ['remote', 'add', 'origin', bare]);
  } else {
    git(parent, ['clone', '--branch', 'main', bare, 'repo']);
  }
  git(repo, ['config', 'user.email', `${login}@users.noreply.github.com`]);
  git(repo, ['config', 'user.name', login]);
  const ctx = join(repo, '_dream_context');
  if (first) {
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    mkdirSync(join(ctx, 'state'), { recursive: true });
    mkdirSync(join(ctx, 'automations'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'k.md'), '# knowledge\n', 'utf-8');
    updateSetupConfig(repo, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
  }
  return { name, login, home, repo, ctx };
}

async function sync(m: Machine, opts: { mode?: 'auto' | 'pull-only' | 'push-only'; foreground?: boolean; continue?: boolean; resume?: boolean } = {}): Promise<SyncResult> {
  use(m);
  return runBrainSync({ cwd: m.ctx, mode: opts.mode ?? 'auto', foreground: opts.foreground, continue: opts.continue, resume: opts.resume });
}

function remoteTree(bare: string): string[] {
  return git(bare, ['ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean);
}

function remoteShow(bare: string, path: string): string {
  return git(bare, ['show', `main:${path}`]);
}

const NOW = new Date();
const TODAY = threadDateStamp(NOW);
const GHP = `ghp_${'a'.repeat(36)}`;

function makeAgent(m: Machine, slug: string, extra: Record<string, unknown> = {}): void {
  use(m);
  createAgent(m.ctx, { slug, title: slug, prompt: `${slug} prompt from ${m.login}.`, ...extra }, { approve: { now: NOW } });
}

function makeRoutine(m: Machine, slug: string, agent: string): void {
  use(m);
  createAutomation(m.ctx, { slug, title: slug, agent, days: 'daily', at: '09:00' }, { approve: { now: NOW } });
}

function note(m: Machine, slug: string, text: string): void {
  use(m);
  appendThreadEntry(m.ctx, slug, { runId: `run-${m.name}`, kind: 'agent', text, via: 'cli' });
}

function output(m: Machine, slug: string, name: string, text: string): string {
  const p = join(m.ctx, 'automations', 'output', slug, name);
  mkdirSync(join(m.ctx, 'automations', 'output', slug), { recursive: true });
  writeFileSync(p, text, 'utf-8');
  return p;
}

const P = '_dream_context/';

beforeAll(() => {
  process.env.GITHUB_TOKEN = 'b1-dummy-token';
});

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_TOKEN === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe('B1 e2e: agents ride the brain sync', { timeout: 120_000 }, () => {
  it('AC-B1-1: nothing tracked before the switch; after confirm everything but cache rides; owner first; idempotent; secrets held', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    makeAgent(m1, 'researcher');
    note(m1, 'researcher', 'first note');
    output(m1, 'researcher', '2026-10-24.md', '# out\n');
    mkdirSync(join(m1.ctx, 'automations', 'cache'), { recursive: true });
    writeFileSync(join(m1.ctx, 'automations', 'cache', '.researcher.lock'), '{"pid":1}', 'utf-8');
    writeFileSync(join(m1.ctx, 'automations', 'cache', 'researcher.json'), '{}', 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    let tree = remoteTree(bare);
    expect(tree).toContain(`${P}knowledge/k.md`);
    expect(tree.filter((p) => p.startsWith(`${P}agents/`) || p.startsWith(`${P}automations/`))).toEqual([]);

    // The owner is stamped at create, before anything un-ignores.
    expect(readFileSync(join(m1.ctx, 'agents', 'researcher.md'), 'utf-8')).toMatch(/^owner: alice$/m);
    use(m1);
    confirmAgentSyncHere(m1.ctx);
    expect((await sync(m1)).action).toBe('pushed');
    tree = remoteTree(bare);
    const m1id = readMachineIdentity(m1.home).id;
    expect(tree).toContain(`${P}agents/researcher.md`);
    expect(tree).toContain(`${P}automations/threads/researcher/${TODAY}-${m1id}.md`);
    expect(tree).toContain(`${P}automations/output/researcher/2026-10-24.md`);
    expect(tree).toContain(`${P}agents/.active/researcher.json`);
    expect(tree).not.toContain(`${P}automations/cache/.researcher.lock`);
    expect(tree).not.toContain(`${P}automations/cache/researcher.json`);
    expect(remoteShow(bare, `${P}agents/researcher.md`)).toMatch(/^owner: alice$/m);
    expect(JSON.parse(remoteShow(bare, `${P}state/.config.json`)).agentSync).toBe(true);

    // Idempotent: confirming again changes nothing.
    use(m1);
    confirmAgentSyncHere(m1.ctx);
    expect((await sync(m1)).action).toBe('noop');

    // A planted token in a NEW thread is never staged; one appended to an ALREADY-PUSHED day file
    // is in neither the next commit nor the remote, while the rest of the brain syncs.
    makeAgent(m1, 'scout');
    note(m1, 'scout', `my key ${GHP}`);
    use(m1);
    appendFileSync(threadDayPath(m1.ctx, 'researcher', NOW), `\nleaked ${GHP}\n`, 'utf-8');
    writeFileSync(join(m1.ctx, 'knowledge', 'new.md'), '# new\n', 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    tree = remoteTree(bare);
    expect(tree).toContain(`${P}knowledge/new.md`);
    expect(tree).toContain(`${P}agents/scout.md`);
    expect(tree).not.toContain(`${P}automations/threads/scout/${TODAY}-${m1id}.md`);
    expect(remoteShow(bare, `${P}automations/threads/researcher/${TODAY}-${m1id}.md`)).not.toContain('ghp_');
    use(m1);
    expect(listInboxRows(m1.repo).filter((r) => r.kind === 'secret-held').map((r) => r.ref).sort()).toEqual([
      `${P}automations/threads/researcher/${TODAY}-${m1id}.md`,
      `${P}automations/threads/scout/${TODAY}-${m1id}.md`,
    ]);
    // Still held on the next pass; the row stays until the secret is gone.
    expect((await sync(m1)).action).toBe('noop');
  });

  it('AC-B1-1/2: a shared agent is stamped with its adder\'s login on the other machine; unconfirmed machines push nothing private; home paths never abort a headless pull; an incoming token does', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    // An agent shared the OLD way, written before owners existed (no owner: line).
    makeAgent(m1, 'helper');
    use(m1);
    setAgentShared(m1.ctx, 'helper', true);
    shareAgent(m1.ctx, 'helper');
    const helperPath = join(m1.ctx, 'agents', 'helper.md');
    writeFileSync(helperPath, readFileSync(helperPath, 'utf-8').replace(/^owner:.*\n/m, ''), 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    expect(remoteTree(bare)).toContain(`${P}agents/helper.md`);

    // Machine 2 (bob) migrates FIRST: it stamps alice (the commit that added it), never bob.
    const m2 = machine('m2', 'bob', bare, false);
    use(m2);
    stampOwners(m2.ctx);
    expect(getAgent(m2.ctx, 'helper')?.owner).toBe('alice');
    // A registry on machine 2 that already holds an approval for the formerly shared slug runs nothing.
    const target = getRunTarget(m2.ctx, 'helper', 'agent')!;
    const reg = readAutomationsRegistry();
    reg.projects[m2.repo] = { approvals: {}, agentApprovals: { helper: { manifestSha256: manifestHash(target), approvedAt: NOW.toISOString(), payloadVersion: APPROVAL_PAYLOAD_VERSION } } };
    writeAutomationsRegistry(reg);
    const verdict = checkApproval(m2.repo, target, undefined, 'run');
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) expect(verdict.reason).toBe('not_owner');
    const run = await runAutomation(m2.ctx, 'helper', { host: 'cli', force: true, target: 'agent' });
    expect(run.status).toBe('blocked');

    // Machine 2's own private agent, created while the switch is off.
    makeAgent(m2, 'scribe');
    note(m2, 'scribe', 'private');

    // Machine 1 turns agent sync on and confirms there; machine 2 receives the switch.
    use(m1);
    confirmAgentSyncHere(m1.ctx);
    expect((await sync(m1)).action).toBe('pushed');
    expect((await sync(m2, { mode: 'pull-only' })).action).toBe('pulled');
    use(m2);
    expect(agentSyncState(m2.ctx)).toEqual({ switchOn: true, confirmedHere: false, active: false });
    note(m2, 'scribe', 'more');
    writeFileSync(join(m2.ctx, 'knowledge', 'bob.md'), '# bob\n', 'utf-8');
    expect((await sync(m2)).action).toBe('pushed');
    let tree = remoteTree(bare);
    expect(tree).toContain(`${P}knowledge/bob.md`);
    expect(tree.filter((p) => p.includes('scribe'))).toEqual([]);

    // A confirmed machine's dirty thread with a home path does not block its headless pull.
    note(m1, 'helper', 'saw /Users/x/project');
    writeFileSync(join(m2.ctx, 'knowledge', 'bob2.md'), '# bob2\n', 'utf-8');
    expect((await sync(m2)).action).toBe('pushed');
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');

    // An INCOMING output and manifest with a home path: the headless pull merges and commits.
    expect((await sync(m1)).action).toBe('pushed');
    output(m1, 'helper', '2026-10-25.md', 'wrote /Users/x/report.md\n');
    const helper = readFileSync(helperPath, 'utf-8');
    writeFileSync(helperPath, helper.replace('helper prompt from alice.', 'helper prompt from alice, see /Users/x/notes.'), 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    writeFileSync(join(m2.ctx, 'knowledge', 'dirty.md'), '# local edit\n', 'utf-8');
    expect((await sync(m2, { mode: 'pull-only' })).action).toBe('pulled');
    expect(readFileSync(join(m2.ctx, 'automations', 'output', 'helper', '2026-10-25.md'), 'utf-8')).toContain('/Users/x/');

    // An incoming token (committed inside the brain and pushed by hand) still aborts it.
    output(m1, 'helper', '2026-10-26.md', `key ${GHP}\n`);
    git(m1.repo, ['add', '-f', `${P}automations/output/helper/2026-10-26.md`]);
    git(m1.repo, ['commit', '-m', 'agent wrote a key']);
    git(m1.repo, ['push', 'origin', 'main']);
    const blocked = await sync(m2, { mode: 'pull-only' });
    expect(blocked.action).toBe('blocked-scrub');
    tree = remoteTree(bare);
    expect(existsSync(join(m2.ctx, 'automations', 'output', 'helper', '2026-10-26.md'))).toBe(false);
  });

  it('AC-B1-1: on an unconfirmed machine, a --continue merge with an incoming generic-assignment output commits it unchanged; the teammate\'s file is intact after both sync', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    writeFileSync(join(m1.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nbase\n', 'utf-8');
    makeAgent(m1, 'researcher');
    use(m1);
    confirmAgentSyncHere(m1.ctx);
    expect((await sync(m1)).action).toBe('pushed');
    const m2 = machine('m2', 'bob', bare, false);
    const warnText = 'config: token = "abcdefghijklmnopqrst"\n';
    output(m1, 'researcher', '2026-10-25.md', warnText);
    writeFileSync(join(m1.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nalice\n', 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    writeFileSync(join(m2.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nbob\n', 'utf-8');
    const deferred = await sync(m2);
    expect(deferred.action).toBe('awaiting-agent');
    writeFileSync(join(m2.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nalice\nbob\n', 'utf-8');
    expect((await sync(m2, { continue: true })).action).toBe('pushed');
    expect(readFileSync(join(m2.ctx, 'automations', 'output', 'researcher', '2026-10-25.md'), 'utf-8')).toBe(warnText);
    await sync(m1);
    await sync(m2);
    expect(readFileSync(join(m1.ctx, 'automations', 'output', 'researcher', '2026-10-25.md'), 'utf-8')).toBe(warnText);
    expect(remoteShow(bare, `${P}automations/output/researcher/2026-10-25.md`)).toBe(warnText);
  });

  it('security: a teammate\'s .gitignore negation never publishes an unconfirmed machine\'s agents; an incoming symlink under agents/ is never taken in', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    expect((await sync(m1)).action).toBe('pushed');
    const m2 = machine('m2', 'bob', bare, false);
    makeAgent(m2, 'diary');
    note(m2, 'diary', 'private thoughts');
    // bob's create wrote the ignore lines; both machines hold them before alice edits them.
    expect((await sync(m2)).action).toBe('pushed');
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');
    // alice pushes ignore files that re-include every agent file.
    appendFileSync(join(m1.repo, '.gitignore'), '\n!_dream_context/agents/*.md\n!_dream_context/automations/threads/*/*\n', 'utf-8');
    appendFileSync(join(m1.ctx, '.gitignore'), '\n!agents/*.md\n!automations/threads/*/*\n', 'utf-8');
    expect((await sync(m1)).action).toBe('pushed');
    writeFileSync(join(m2.ctx, 'knowledge', 'bob.md'), '# bob\n', 'utf-8');
    expect((await sync(m2)).action).toBe('pushed');
    const tree = remoteTree(bare);
    expect(tree).toContain(`${P}knowledge/bob.md`);
    expect(tree.filter((p) => p.includes('diary'))).toEqual([]);

    // alice commits a symlink in a thread folder by hand; bob's pull refuses to take it in.
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');
    mkdirSync(join(m1.ctx, 'automations', 'threads', 'diary'), { recursive: true });
    execFileSync('ln', ['-s', '../../../../../.zshrc', join(m1.ctx, 'automations', 'threads', 'diary', `${TODAY}-${readMachineIdentity(m2.home).id}.md`)]);
    git(m1.repo, ['add', '-f', `${P}automations/threads/diary`]);
    git(m1.repo, ['commit', '-m', 'a link']);
    git(m1.repo, ['push', 'origin', 'main']);
    const refused = await sync(m2, { mode: 'pull-only' });
    expect(refused.action).toBe('noop');
    expect(refused.note).toMatch(/symlink/);
    expect(existsSync(join(m2.ctx, 'automations', 'threads', 'diary', `${TODAY}-${readMachineIdentity(m2.home).id}.md`))).toBe(true);
    // the file there is bob's own day file, never the link
    expect(readFileSync(join(m2.ctx, 'automations', 'threads', 'diary', `${TODAY}-${readMachineIdentity(m2.home).id}.md`), 'utf-8')).toContain('private thoughts');
  });

  it('security: a teammate\'s shared: true manifest named after a private agent publishes nothing; a folder pushed as a symlink or a file is never taken in; a guard that cannot answer skips the pull', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    expect((await sync(m1)).action).toBe('pushed');
    const m2 = machine('m2', 'bob', bare, false);
    makeAgent(m2, 'diary');
    note(m2, 'diary', 'private thoughts');
    expect((await sync(m2)).action).toBe('pushed');
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');
    // alice re-includes every thread file and pushes a legacy-shared manifest with bob's slug.
    appendFileSync(join(m1.repo, '.gitignore'), '\n!_dream_context/automations/threads/*/*\n', 'utf-8');
    appendFileSync(join(m1.ctx, '.gitignore'), '\n!automations/threads/*/*\n', 'utf-8');
    writeFileSync(join(m1.ctx, 'automations', 'diary.md'), '---\nslug: diary\ntitle: diary\nshared: true\n---\n\nguessed.\n', 'utf-8');
    git(m1.repo, ['add', '-f', '.gitignore', `${P}.gitignore`, `${P}automations/diary.md`]);
    git(m1.repo, ['commit', '-m', 'shared diary']);
    git(m1.repo, ['push', 'origin', 'main']);
    expect((await sync(m2, { mode: 'pull-only' })).action).toBe('pulled');
    note(m2, 'diary', 'more private thoughts');
    writeFileSync(join(m2.ctx, 'knowledge', 'bob.md'), '# bob\n', 'utf-8');
    expect((await sync(m2)).action).toBe('pushed');
    const tree = remoteTree(bare);
    expect(tree).toContain(`${P}knowledge/bob.md`);
    expect(tree.filter((p) => p.includes('threads/diary'))).toEqual([]);

    // alice replaces the whole agents/ folder with a symlink: bob's pull refuses it and keeps his files.
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');
    git(m1.repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', `${P}agents`]);
    rmSync(join(m1.ctx, 'agents'), { recursive: true, force: true });
    symlinkSync(tmpdir(), join(m1.ctx, 'agents'));
    git(m1.repo, ['add', '-f', `${P}agents`]);
    git(m1.repo, ['commit', '-m', 'agents is a link']);
    git(m1.repo, ['push', 'origin', 'main']);
    const linked = await sync(m2, { mode: 'pull-only' });
    expect(linked.action).toBe('noop');
    expect(linked.note).toMatch(/_dream_context\/agents/);
    expect(lstatSync(join(m2.ctx, 'agents')).isDirectory()).toBe(true);
    expect(existsSync(join(m2.ctx, 'agents', 'diary.md'))).toBe(true);

    // ... then automations/threads as a plain file, over bob's folder: refused, his threads stay.
    git(m1.repo, ['rm', '-q', '--cached', `${P}agents`]);
    rmSync(join(m1.ctx, 'agents'), { force: true });
    git(m1.repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', `${P}automations/threads`]);
    rmSync(join(m1.ctx, 'automations', 'threads'), { recursive: true, force: true });
    writeFileSync(join(m1.ctx, 'automations', 'threads'), 'not a folder\n', 'utf-8');
    git(m1.repo, ['add', '-f', `${P}automations/threads`]);
    git(m1.repo, ['commit', '-m', 'threads is a file']);
    git(m1.repo, ['push', 'origin', 'main']);
    const overFolder = await sync(m2, { mode: 'pull-only' });
    expect(overFolder.action).toBe('noop');
    expect(overFolder.note).toMatch(/_dream_context\/automations\/threads/);
    expect(lstatSync(join(m2.ctx, 'automations', 'threads')).isDirectory()).toBe(true);

    // ... then automations/ as a plain file: refused the same way, bob's threads stay.
    git(m1.repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', `${P}automations`]);
    rmSync(join(m1.ctx, 'automations'), { recursive: true, force: true });
    writeFileSync(join(m1.ctx, 'automations'), 'not a folder\n', 'utf-8');
    git(m1.repo, ['add', '-f', `${P}automations`]);
    git(m1.repo, ['commit', '-m', 'automations is a file']);
    git(m1.repo, ['push', 'origin', 'main']);
    const filed = await sync(m2, { mode: 'pull-only' });
    expect(filed.action).toBe('noop');
    expect(filed.note).toMatch(/_dream_context\/automations/);
    expect(readFileSync(join(m2.ctx, 'automations', 'threads', 'diary', `${TODAY}-${readMachineIdentity(m2.home).id}.md`), 'utf-8')).toContain('more private thoughts');

    // A guard that cannot read the incoming side fails closed.
    use(m2);
    const blind = guardPullCollisions(m2.repo, m2.ctx, 'refs/remotes/origin/no-such-branch', m2.home);
    expect(blind).toMatchObject({ ok: false, note: expect.stringMatching(/could not check/) });
  });

  it.each([['proj'], ['Masau\u0308stu\u0308']])('security: a project in a subfolder (%s) of its repo never sends its agent files and skips a pull that changes them', (sub) => {
    const bare = newBare();
    const home = tmp('dc-b1-home-nested-');
    process.env.HOME = home;
    const mk = (name: string): { repo: string; proj: string; ctx: string } => {
      const repo = join(tmp(`dc-b1-nested-${name}-`), 'repo');
      execFileSync('git', ['clone', '--quiet', bare, repo], { stdio: 'ignore' });
      git(repo, ['config', 'user.email', `${name}@users.noreply.github.com`]);
      git(repo, ['config', 'user.name', name]);
      const proj = join(repo, sub);
      const ctx = join(proj, '_dream_context');
      mkdirSync(join(ctx, 'agents'), { recursive: true });
      return { repo, proj, ctx };
    };
    const a = mk('alice');
    writeFileSync(join(a.ctx, 'notes.md'), '# notes\n', 'utf-8');
    git(a.repo, ['add', '-A']);
    git(a.repo, ['commit', '-q', '-m', 'init']);
    git(a.repo, ['push', '-q', 'origin', 'HEAD:main']);
    const b = mk('bob');
    git(b.repo, ['checkout', '-q', 'main']);
    // bob's private agent and thread are staged by a sync's `git add -A`: the pass holds them all.
    writeFileSync(join(b.ctx, 'agents', 'diary.md'), '---\nslug: diary\n---\n\nprivate.\n', 'utf-8');
    mkdirSync(join(b.ctx, 'automations', 'threads', 'diary'), { recursive: true });
    writeFileSync(join(b.ctx, 'automations', 'threads', 'diary', `${TODAY}.md`), 'private thoughts\n', 'utf-8');
    git(b.proj, ['add', '-A']);
    const pass = agentStagePass(b.proj, b.ctx, { home });
    const nfc = sub.normalize('NFC');
    expect(pass.held.sort()).toEqual([`${nfc}/_dream_context/agents/diary.md`, `${nfc}/_dream_context/automations/threads/diary/${TODAY}.md`]);
    expect(git(b.repo, ['diff', '--cached', '--name-only'])).toBe('');
    // alice pushes an agent file of the same name: bob's pull is skipped, his file stays.
    writeFileSync(join(a.ctx, 'agents', 'diary.md'), '---\nslug: diary\n---\n\nalice.\n', 'utf-8');
    git(a.repo, ['add', '-A']);
    git(a.repo, ['commit', '-q', '-m', 'diary']);
    git(a.repo, ['push', '-q', 'origin', 'HEAD:main']);
    git(b.repo, ['fetch', '-q', 'origin']);
    const guard = guardPullCollisions(b.proj, b.ctx, 'origin/main', home);
    expect(guard).toMatchObject({ ok: false, note: expect.stringMatching(/top folder of its git repository/) });
    expect(readFileSync(join(b.ctx, 'agents', 'diary.md'), 'utf-8')).toContain('private.');
  });

  it('security: an incoming path that differs only in letter case from agents/ or automations/ is never taken in', () => {
    const bare = newBare();
    const home = tmp('dc-b1-home-case-');
    process.env.HOME = home;
    const clone = (name: string): { repo: string; ctx: string } => {
      const repo = join(tmp(`dc-b1-case-${name}-`), 'repo');
      execFileSync('git', ['clone', '--quiet', bare, repo], { stdio: 'ignore' });
      git(repo, ['config', 'user.email', `${name}@users.noreply.github.com`]);
      git(repo, ['config', 'user.name', name]);
      return { repo, ctx: join(repo, '_dream_context') };
    };
    const a = clone('alice');
    mkdirSync(join(a.ctx, 'automations'), { recursive: true });
    writeFileSync(join(a.ctx, 'automations', 'r.md'), '---\nslug: r\n---\n', 'utf-8');
    git(a.repo, ['add', '-A']);
    git(a.repo, ['commit', '-q', '-m', 'init']);
    git(a.repo, ['push', '-q', 'origin', 'HEAD:main']);
    const b = clone('bob');
    git(b.repo, ['checkout', '-q', 'main']);
    mkdirSync(join(b.ctx, 'automations', 'threads', 'diary'), { recursive: true });
    writeFileSync(join(b.ctx, 'automations', 'threads', 'diary', `${TODAY}.md`), 'private thoughts\n', 'utf-8');
    // Written straight into alice's index: a case-insensitive disk cannot hold both spellings.
    const push = (path: string, mode: string, msg: string): void => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: a.repo, input: 'x\n', encoding: 'utf-8' }).trim();
      git(a.repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`]);
      git(a.repo, ['commit', '-q', '-m', msg]);
      git(a.repo, ['push', '-q', 'origin', 'HEAD:main']);
      git(b.repo, ['fetch', '-q', 'origin']);
    };
    push(`${P}Automations/threads`, '100644', 'threads as a file, other case');
    expect(guardPullCollisions(b.repo, b.ctx, 'origin/main', home)).toMatchObject({ ok: false, note: expect.stringMatching(/_dream_context\/Automations/) });
    git(a.repo, ['rm', '-q', '--cached', `${P}Automations/threads`]);
    push(`${P}AGENTS`, '120000', 'agents as a link, other case');
    expect(guardPullCollisions(b.repo, b.ctx, 'origin/main', home)).toMatchObject({ ok: false, note: expect.stringMatching(/_dream_context\/AGENTS/) });
    expect(readFileSync(join(b.ctx, 'automations', 'threads', 'diary', `${TODAY}.md`), 'utf-8')).toBe('private thoughts\n');
  });

  it('AC-B1-4: same login on two machines: only the active one runs; Bring it here moves it after sync; concurrent .active writes merge without a handoff', async () => {
    const bare = newBare();
    const m1 = machine('m1', 'alice', bare, true);
    makeAgent(m1, 'researcher');
    use(m1);
    confirmAgentSyncHere(m1.ctx);
    expect((await sync(m1)).action).toBe('pushed');
    const m2 = machine('m2', 'alice', bare, false);
    use(m2);
    confirmAgentSyncHere(m2.ctx);
    // m2 holds alice's registry too: same person, own machine approves it.
    expect(placement(m2.ctx, 'researcher', 'alice').here).toBe(false);
    use(m1);
    expect(placement(m1.ctx, 'researcher', 'alice').here).toBe(true);

    // Bring it here on m2, push; m1 learns at its next pull.
    use(m2);
    writeActiveHere(m2.ctx, 'researcher', 'alice');
    expect((await sync(m2)).action).toBe('pushed');
    expect((await sync(m1, { mode: 'pull-only' })).action).toBe('pulled');
    use(m1);
    expect(placement(m1.ctx, 'researcher', 'alice')).toMatchObject({ here: false, name: readMachineIdentity(m2.home).name });
    const refused = await runAutomation(m1.ctx, 'researcher', { host: 'cli', force: true, target: 'agent' });
    expect(refused.status).toBe('blocked');

    // Both write .active at once: merged by the rule (later since wins), never an agent handoff.
    use(m1);
    writeActiveHere(m1.ctx, 'researcher', 'alice', undefined, new Date(Date.now() - 2000));
    use(m2);
    writeActiveHere(m2.ctx, 'researcher', 'alice', undefined, new Date(Date.now() - 1000));
    expect((await sync(m1)).action).toBe('pushed');
    const merged = await sync(m2);
    expect(merged.action).toBe('pushed');
    expect(JSON.parse(remoteShow(bare, `${P}agents/.active/researcher.json`)).machine).toBe(readMachineIdentity(m2.home).id);
  });

  it('AC-B1-6: two logins, one slug each: four distinct members, no blend, no handoff, one renamed row; machine 1 files untouched', async () => {
    const bare = newBare();
    const a = machine('a', 'alice', bare, true);
    expect((await sync(a)).action).toBe('pushed');
    const b = machine('b', 'bob', bare, false);
    for (const m of [a, b]) {
      makeAgent(m, 'researcher');
      makeRoutine(m, 'daily-brief', 'researcher');
      note(m, 'researcher', `note by ${m.login}`);
      output(m, 'researcher', '2026-10-25.md', `# output by ${m.login}\n`);
    }
    use(a);
    confirmAgentSyncHere(a.ctx);
    expect((await sync(a)).action).toBe('pushed');
    const aId = readMachineIdentity(a.home).id;
    const aThread = readFileSync(join(a.ctx, 'automations', 'threads', 'researcher', `${TODAY}-${aId}.md`), 'utf-8');
    const aOutput = readFileSync(join(a.ctx, 'automations', 'output', 'researcher', '2026-10-25.md'), 'utf-8');

    // bob assigned one of his tasks to his researcher before the sync reached him.
    use(b);
    writeFileSync(join(b.ctx, 'state', 'bob-task.md'), '---\nid: task_bob\nname: Bob task\nstatus: todo\n---\n\n## Why\n\nx\n', 'utf-8');
    const prep = prepareAssignment(b.ctx, 'bob-task', 'researcher', { source: 'cli' });
    if (!prep.ok) throw new Error(prep.message);
    commitAssignment(b.ctx, prep, NOW);
    confirmAgentSyncHere(b.ctx);
    const bSync = await sync(b);
    expect(bSync.action).toBe('pushed');
    use(b);
    expect(getAgent(b.ctx, 'researcher')?.owner).toBe('alice');
    expect(getAgent(b.ctx, 'researcher-2')?.owner).toBe('bob');
    expect(readFileSync(join(b.ctx, 'automations', 'daily-brief-2.md'), 'utf-8')).toMatch(/^agent: researcher-2$/m);
    expect(readFileSync(join(b.ctx, 'automations', 'output', 'researcher-2', '2026-10-25.md'), 'utf-8')).toContain('bob');
    expect(listInboxRows(b.repo).filter((r) => r.kind === 'renamed')).toHaveLength(1);
    // Exactly one row: nothing reads as "replaced through sync".
    expect(listInboxRows(b.repo).filter((r) => r.kind === 'replaced-by-sync')).toEqual([]);
    // bob's task follows his renamed agent.
    expect(readFileSync(join(b.ctx, 'state', 'bob-task.md'), 'utf-8')).toMatch(/^agent: researcher-2$/m);
    // Bob's renamed copies stay approved (the hash covers no slug).
    expect(checkApproval(b.repo, getRunTarget(b.ctx, 'researcher-2', 'agent')!, undefined, 'run').approved).toBe(true);

    // Both sync twice more: machine 1's files byte-identical on machine 1 and on the remote.
    for (let i = 0; i < 2; i++) {
      await sync(b);
      await sync(a);
    }
    const tree = remoteTree(bare);
    for (const p of ['agents/researcher.md', 'agents/researcher-2.md', 'automations/daily-brief.md', 'automations/daily-brief-2.md']) {
      expect(tree, p).toContain(`${P}${p}`);
    }
    expect(readFileSync(join(a.ctx, 'automations', 'threads', 'researcher', `${TODAY}-${aId}.md`), 'utf-8')).toBe(aThread);
    expect(readFileSync(join(a.ctx, 'automations', 'output', 'researcher', '2026-10-25.md'), 'utf-8')).toBe(aOutput);
    expect(remoteShow(bare, `${P}automations/threads/researcher/${TODAY}-${aId}.md`)).toBe(aThread);
    expect(remoteShow(bare, `${P}automations/output/researcher/2026-10-25.md`)).toBe(aOutput);
    use(a);
    expect(getAgent(a.ctx, 'researcher')?.owner).toBe('alice');
    expect(getAgent(a.ctx, 'researcher-2')?.owner).toBe('bob');
  });

  it('AC-B1-6 variants: a machine the switch has not reached yet keeps its researcher as researcher-2, through an aborted pull, a blocked pull and a deferred merge', async () => {
    const bare = newBare();
    const a = machine('a', 'alice', bare, true);
    writeFileSync(join(a.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nbase\n', 'utf-8');
    expect((await sync(a)).action).toBe('pushed');
    const c = machine('c', 'carol', bare, false);
    makeAgent(c, 'researcher');
    makeAgent(a, 'researcher');
    use(a);
    confirmAgentSyncHere(a.ctx);

    // (a) The pull also carries a prose conflict: pull-only aborts; the local researcher is back in place.
    writeFileSync(join(a.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nalice wrote this\n', 'utf-8');
    expect((await sync(a)).action).toBe('pushed');
    writeFileSync(join(c.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\ncarol wrote that\n', 'utf-8');
    const aborted = await sync(c, { mode: 'pull-only' });
    expect(aborted.action).toBe('awaiting-agent');
    expect(readFileSync(join(c.ctx, 'agents', 'researcher.md'), 'utf-8')).toContain('from carol');
    expect(existsSync(join(c.ctx, 'agents', 'researcher-2.md'))).toBe(false);

    // (c) The attended redo leaves the merge open (deferred): still pending, still in place.
    const resumed = await sync(c, { resume: true });
    expect(resumed.action).toBe('awaiting-agent');
    expect(existsSync(join(c.ctx, 'agents', 'researcher-2.md'))).toBe(false);
    // The human resolves the prose and continues: the merge commits, researcher-2 appears, one row.
    writeFileSync(join(c.ctx, 'knowledge', 'shared.md'), '# shared\n\n## Notes\n\nalice wrote this\ncarol wrote that\n', 'utf-8');
    const continued = await sync(c, { continue: true });
    expect(continued.action).toBe('pushed');
    use(c);
    expect(getAgent(c.ctx, 'researcher')?.owner).toBe('alice');
    expect(readFileSync(join(c.ctx, 'agents', 'researcher-2.md'), 'utf-8')).toContain('from carol');
    expect(listInboxRows(c.repo).filter((r) => r.kind === 'renamed')).toHaveLength(1);
    // Carol has not confirmed: her researcher-2 stays on her machine.
    expect(remoteTree(bare).filter((p) => p.includes('researcher-2'))).toEqual([]);
  });

  it('AC-B1-6 variant (b): a headless pull that also brings a token aborts, the local copy stays; the next clean pull renames it', async () => {
    const bare = newBare();
    const a = machine('a', 'alice', bare, true);
    expect((await sync(a)).action).toBe('pushed');
    const c = machine('c', 'carol', bare, false);
    makeAgent(c, 'researcher');
    makeAgent(a, 'researcher');
    use(a);
    confirmAgentSyncHere(a.ctx);
    expect((await sync(a)).action).toBe('pushed');
    output(a, 'researcher', 'leak.md', `key ${GHP}\n`);
    git(a.repo, ['add', '-f', `${P}automations/output/researcher/leak.md`]);
    git(a.repo, ['commit', '-m', 'agent wrote a key']);
    git(a.repo, ['push', 'origin', 'main']);
    const blocked = await sync(c, { mode: 'pull-only' });
    expect(blocked.action).toBe('blocked-scrub');
    expect(readFileSync(join(c.ctx, 'agents', 'researcher.md'), 'utf-8')).toContain('from carol');
    // Upstream removes the key; the next pull commits and renames.
    git(a.repo, ['rm', '-q', `${P}automations/output/researcher/leak.md`]);
    git(a.repo, ['commit', '-m', 'remove key']);
    git(a.repo, ['push', 'origin', 'main']);
    expect((await sync(c, { mode: 'pull-only' })).action).toBe('pulled');
    use(c);
    expect(readFileSync(join(c.ctx, 'agents', 'researcher-2.md'), 'utf-8')).toContain('from carol');
    expect(getAgent(c.ctx, 'researcher')?.owner).toBe('alice');
    expect(listInboxRows(c.repo).filter((r) => r.kind === 'renamed')).toHaveLength(1);
  });
});
