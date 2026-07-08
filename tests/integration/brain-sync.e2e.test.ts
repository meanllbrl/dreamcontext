import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig, readBrainLocal } from '../../src/lib/setup-config.js';
import { readConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { bootstrapBrainRepo, attachBrainRepo } from '../../src/lib/git-sync/brain-repo.js';
import { runBrainSync } from '../../src/lib/git-sync/sync-engine.js';
import { detachBrain } from '../../src/lib/git-sync/detach.js';
import { setupPlatformLayer } from '../../src/lib/git-sync/platform-layer.js';

/**
 * Scripted, no-network E2E for the brain-repo sync engine
 * (github-cloud-collaboration-brain-repo-sync, M1). A `git init --bare` repo
 * plays the "remote" — everything else is the real git binary + the real
 * library code (no fakes). `GITHUB_TOKEN` is set to a dummy value: a
 * LOCAL-PATH remote needs no real credential at all (askpass is never
 * invoked for `file://`-less local paths), so a bogus token is harmless and
 * lets `resolveBrainSyncToken`/`withGitCredentials` run for real.
 *
 * Scenarios run SEQUENTIALLY in one flow (each depends on the previous
 * clone/remote state), mirroring the plan's Test Plan section.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function setLocalIdentity(cwd: string): void {
  git(cwd, ['config', 'user.email', 'e2e@dreamcontext.local']);
  git(cwd, ['config', 'user.name', 'E2E Test']);
}

function bareHead(bareDir: string): string | null {
  try {
    return git(bareDir, ['rev-parse', 'refs/heads/main']).trim();
  } catch {
    return null;
  }
}

describe('e2e: brain-sync (local bare repo as remote, no network)', () => {
  let bareDir: string;
  let projectRootA: string;
  let contextRootA: string;
  let projectRootB: string;
  let contextRootB: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token'; // local-path remote: never actually used for auth
    bareDir = mkdtempSync(join(tmpdir(), 'dc-e2e-bare-'));
    execFileSync('git', ['init', '--bare', bareDir]);

    projectRootA = mkdtempSync(join(tmpdir(), 'dc-e2e-a-'));
    contextRootA = join(projectRootA, '_dream_context');
    mkdirSync(contextRootA, { recursive: true });
    git(contextRootA, ['init']);
    setLocalIdentity(contextRootA);
    updateSetupConfig(projectRootA, { brainRepo: { mode: 'separate', enabled: true, remote: bareDir, autoSync: true } });
  });

  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const dir of [bareDir, projectRootA, projectRootB].filter(Boolean)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1. brain-init-scrub (S3): a ghp_ token blocks the first push; a clean tree pushes with a token-free remote (S1)', async () => {
    mkdirSync(join(contextRootA, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRootA, 'knowledge', 'leak.md'), `oops ghp_${'a'.repeat(36)}\n`);

    const blockedResult = await bootstrapBrainRepo({ contextRoot: contextRootA, projectRoot: projectRootA, remote: bareDir });
    expect(blockedResult.blocked).toBe(true);
    expect(bareHead(bareDir)).toBeNull(); // nothing reached the remote

    writeFileSync(join(contextRootA, 'knowledge', 'leak.md'), 'nothing sensitive here\n');
    const okResult = await bootstrapBrainRepo({ contextRoot: contextRootA, projectRoot: projectRootA, remote: bareDir });
    expect(okResult.blocked).toBe(false);
    expect(okResult.pushed).toBe(true);
    expect(bareHead(bareDir)).not.toBeNull();

    // S1: the stored remote is a clean path/URL — never a token.
    const remoteUrl = git(contextRootA, ['remote', 'get-url', 'origin']).trim();
    expect(remoteUrl).toBe(bareDir);
    expect(remoteUrl).not.toContain('ghp_');
  });

  it('2. sequential semantic merge: JSON/task classes auto-resolve, a prose overlap defers to the agent, --continue completes the union', async () => {
    // Clone B from A's initial push (marker + gitignore + leak.md only).
    projectRootB = mkdtempSync(join(tmpdir(), 'dc-e2e-b-'));
    contextRootB = join(projectRootB, '_dream_context');
    git(projectRootB, ['clone', bareDir, contextRootB]);
    setLocalIdentity(contextRootB);
    updateSetupConfig(projectRootB, { brainRepo: { mode: 'separate', enabled: true, remote: bareDir, autoSync: true } });

    // A adds a task + a knowledge doc, pushes.
    mkdirSync(join(contextRootA, 'state'), { recursive: true });
    writeFileSync(
      join(contextRootA, 'state', 'shared-task.md'),
      ['---', 'status: in_progress', '---', '', '## Changelog', '### 2026-07-01 - A', '- A did a thing', ''].join('\n'),
    );
    writeFileSync(join(contextRootA, 'knowledge', 'shared.md'), ['## Section', 'A wrote this.', ''].join('\n'));
    const aResult = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aResult.action).toBe('pushed');

    // B independently adds the SAME paths, diverging (add/add) — task is
    // deterministic (always CLI-resolved); the knowledge section overlap is not.
    writeFileSync(
      join(contextRootB, 'state', 'shared-task.md'),
      ['---', 'status: in_review', '---', '', '## Changelog', '### 2026-07-02 - B', '- B did a thing', ''].join('\n'),
    );
    writeFileSync(join(contextRootB, 'knowledge', 'shared.md'), ['## Section', 'B wrote this.', ''].join('\n'));

    const bResult = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(bResult.action).toBe('awaiting-agent');
    expect(bResult.conflicts).toContain('knowledge/shared.md');

    const report = readConflictReport(contextRootB);
    expect(report).not.toBeNull();
    expect(report!.resolvedByCli).toContain('state/shared-task.md');
    expect(report!.deferred.map((d) => d.path)).toEqual(['knowledge/shared.md']);

    // The CLI already auto-resolved the task file (both entries, furthest status) — assert that now.
    const taskContent = readFileSync(join(contextRootB, 'state', 'shared-task.md'), 'utf-8');
    expect(taskContent).toContain('A did a thing');
    expect(taskContent).toContain('B did a thing');
    expect(taskContent).toMatch(/status: in_review/); // in_review > in_progress

    // Simulate the agent: read the three snapshots, write a semantic prose merge, stage it.
    const deferred = report!.deferred[0];
    const ours = readFileSync(join(contextRootB, deferred.oursPath), 'utf-8');
    const theirs = readFileSync(join(contextRootB, deferred.theirsPath), 'utf-8');
    expect(ours).toContain('B wrote this');
    expect(theirs).toContain('A wrote this');
    writeFileSync(join(contextRootB, 'knowledge', 'shared.md'), ['## Section', 'A wrote this. B wrote this.', ''].join('\n'));
    git(contextRootB, ['add', 'knowledge/shared.md']);

    const continueResult = await runBrainSync({ cwd: contextRootB, mode: 'auto', continue: true });
    expect(continueResult.action).toBe('pushed');
    expect(readConflictReport(contextRootB)).toBeNull(); // amendment 1: report + snapshots gone

    const mergedKnowledge = readFileSync(join(contextRootB, 'knowledge', 'shared.md'), 'utf-8');
    expect(mergedKnowledge).toContain('A wrote this');
    expect(mergedKnowledge).toContain('B wrote this');

    // A follow-up plain sync runs normally (not wedged).
    const followUp = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(followUp.action).not.toBe('already-awaiting-agent');
  });

  it('3. pull-only content delivery (P2/C6): a clean B merges a non-conflicting remote edit and pushes nothing', async () => {
    writeFileSync(join(contextRootA, 'knowledge', 'new-topic.md'), 'brand new content from A\n');
    const aPush = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aPush.action).toBe('pushed');

    const headBefore = bareHead(bareDir);
    const result = await runBrainSync({ cwd: contextRootB, mode: 'pull-only' });
    expect(result.action).toBe('pulled');
    expect(result.pulledUpdates).toBeGreaterThan(0);
    expect(bareHead(bareDir)).toBe(headBefore); // pull-only never pushes
    expect(existsSync(join(contextRootB, 'knowledge', 'new-topic.md'))).toBe(true);
  });

  it('4. pull-only with a dirty B: auto-checkpoints local work, then merges non-conflicting remote content in', async () => {
    writeFileSync(join(contextRootB, 'knowledge', 'b-local.md'), "B's uncommitted local note\n"); // dirty, untracked-but-will-be-staged

    writeFileSync(join(contextRootA, 'knowledge', 'another.md'), 'another new file from A\n');
    const aPush = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aPush.action).toBe('pushed');

    const result = await runBrainSync({ cwd: contextRootB, mode: 'pull-only' });
    expect(result.action).toBe('pulled');
    expect(existsSync(join(contextRootB, '.git', 'MERGE_HEAD'))).toBe(false); // never left mid-merge
    expect(existsSync(join(contextRootB, 'knowledge', 'b-local.md'))).toBe(true); // B's own work survived
    expect(existsSync(join(contextRootB, 'knowledge', 'another.md'))).toBe(true); // A's content arrived
  });

  it('5. full pull-only -> resume -> resolve -> continue loop (v3.2)', async () => {
    // A and B both edit the SAME section of the already-merged knowledge/shared.md.
    writeFileSync(join(contextRootA, 'knowledge', 'shared.md'), ['## Section', 'A wrote this. B wrote this. Also A edited again.', ''].join('\n'));
    const aPush = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aPush.action).toBe('pushed');

    writeFileSync(join(contextRootB, 'knowledge', 'shared.md'), ['## Section', 'A wrote this. B wrote this. Also B edited independently.', ''].join('\n'));

    const deferResult = await runBrainSync({ cwd: contextRootB, mode: 'pull-only' });
    expect(deferResult.action).toBe('awaiting-agent');
    expect(existsSync(join(contextRootB, '.git', 'MERGE_HEAD'))).toBe(false); // pull-only aborts to a clean tree
    expect(readBrainLocal(projectRootB).pendingAgentMerge).toBe(true);

    const plainAfterDefer = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(plainAfterDefer.action).toBe('already-awaiting-agent');

    const resumeResult = await runBrainSync({ cwd: contextRootB, mode: 'auto', resume: true });
    expect(resumeResult.action).toBe('awaiting-agent');
    // A FRESH report + a REAL in-progress merge now exists for --continue.
    execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: contextRootB });
    const freshReport = readConflictReport(contextRootB);
    expect(freshReport).not.toBeNull();

    const deferred = freshReport!.deferred.find((d) => d.path === 'knowledge/shared.md')!;
    expect(deferred).toBeDefined();
    writeFileSync(
      join(contextRootB, 'knowledge', 'shared.md'),
      ['## Section', 'A wrote this. B wrote this. Also A edited again. Also B edited independently.', ''].join('\n'),
    );
    git(contextRootB, ['add', 'knowledge/shared.md']);

    const continueResult = await runBrainSync({ cwd: contextRootB, mode: 'auto', continue: true });
    expect(continueResult.action).toBe('pushed');
    expect(readConflictReport(contextRootB)).toBeNull();
    expect(readBrainLocal(projectRootB).pendingAgentMerge).toBe(false);

    const finalPlain = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(finalPlain.action).not.toBe('already-awaiting-agent');

    // --resume misuse: no pending handoff left -> invalid-flag.
    const resumeMisuse = await runBrainSync({ cwd: contextRootB, mode: 'auto', resume: true });
    expect(resumeMisuse.action).toBe('invalid-flag');
  });

  it('6. concurrent pushers (C4): a non-fast-forward push retries once via fetch+merge and lands', async () => {
    // B commits a local edit WITHOUT fetching first (simulating a push racing behind A).
    writeFileSync(join(contextRootB, 'knowledge', 'b-race.md'), "B's racing edit\n");
    git(contextRootB, ['add', '-A']);
    git(contextRootB, ['commit', '-m', 'B local race commit']);

    // A pushes first, moving the remote ahead of what B's push-only will target.
    writeFileSync(join(contextRootA, 'knowledge', 'a-race.md'), "A's racing edit\n");
    const aPush = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aPush.action).toBe('pushed');

    // B's push-only does NOT fetch first -> its raw push is rejected non-FF,
    // triggering the C4 fetch+merge+retry-once loop.
    const result = await runBrainSync({ cwd: contextRootB, mode: 'push-only' });
    expect(result.action).toBe('pushed');
    expect(existsSync(join(contextRootB, 'knowledge', 'a-race.md'))).toBe(true); // merged A's content in
    expect(existsSync(join(contextRootB, 'knowledge', 'b-race.md'))).toBe(true); // kept B's own content
  });

  it('7. scrub still blocks a planted secret in the normal sync path (not just init)', async () => {
    writeFileSync(join(contextRootA, 'knowledge', 'oops2.md'), `ghp_${'b'.repeat(36)}\n`);
    const headBefore = bareHead(bareDir);
    const result = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(result.action).toBe('blocked-scrub');
    expect(bareHead(bareDir)).toBe(headBefore); // nothing new reached the remote
    // Clean up so it doesn't poison subsequent runs of this describe block, if any were added later.
    writeFileSync(join(contextRootA, 'knowledge', 'oops2.md'), 'cleaned\n');
  });

  it('8. post-merge re-scrub (review round 2): a real CLEAN auto-merge that pulls in remote-introduced secret content is blocked before commit, and aborts back to a clean tree', async () => {
    // Flush A's pending "cleaned" edit from test 7 and bring B up to date, so
    // both repos start this scenario clean/in sync.
    const flushA = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(flushA.action).toBe('pushed');
    const syncB = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(syncB.action).not.toBe('blocked-scrub');

    // Someone/something ELSE lands a secret directly on the remote, bypassing
    // dreamcontext's own scrub entirely (e.g. an old client, or a manual
    // `git push`) — a raw clone with no dreamcontext involvement at all.
    const rawClone = mkdtempSync(join(tmpdir(), 'dc-e2e-raw-'));
    execFileSync('git', ['clone', bareDir, rawClone]);
    setLocalIdentity(rawClone);
    writeFileSync(join(rawClone, 'knowledge', 'planted-by-someone-else.md'), `ghp_${'c'.repeat(36)}\n`);
    git(rawClone, ['add', '-A']);
    git(rawClone, ['commit', '-m', 'raw push bypassing dreamcontext scrub entirely']);
    git(rawClone, ['push', 'origin', 'main']);
    rmSync(rawClone, { recursive: true, force: true });

    // B makes an UNRELATED local edit so the fetch+merge is a REAL merge (not
    // a pure fast-forward — a pure FF has nothing staged to scrub, by design:
    // nothing NEW is being introduced by US in that case).
    writeFileSync(join(contextRootB, 'knowledge', 'b-unrelated.md'), 'B unrelated local edit\n');

    const headBefore = bareHead(bareDir);
    const result = await runBrainSync({ cwd: contextRootB, mode: 'auto' });

    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.blocks.some((b) => b.file === 'knowledge/planted-by-someone-else.md')).toBe(true);
    expect(bareHead(bareDir)).toBe(headBefore); // B never pushed anything either
    expect(existsSync(join(contextRootB, '.git', 'MERGE_HEAD'))).toBe(false); // aborted back to a clean tree
    expect(existsSync(join(contextRootB, 'knowledge', 'planted-by-someone-else.md'))).toBe(false); // merge fully undone

    // The abort didn't wedge B into a weird state — a retry deterministically
    // re-blocks (the secret is still on the remote) rather than silently proceeding.
    const retryResult = await runBrainSync({ cwd: contextRootB, mode: 'auto' });
    expect(retryResult.action).toBe('blocked-scrub');
    expect(existsSync(join(contextRootB, '.git', 'MERGE_HEAD'))).toBe(false);
  });
});

/**
 * e2e: `brain detach`'s "fresh single commit by default" contract (M3 review
 * fix 2). Real git throughout — no fakes. `scrubStagedFiles` only ever scans
 * `git diff --cached` (index vs HEAD); the bug this closes was that an
 * already-separate brain being re-targeted at a DIFFERENT remote with NO
 * `--preserve-history` skipped re-init entirely, so a pre-existing secret
 * sitting UNCHANGED in HEAD's tree never showed up as "staged" and shipped —
 * to the new remote — completely unscanned. Real git proves both halves:
 * the squash actually happens, and the full tree (not just this run's diff)
 * gets scrub-scanned.
 */
describe('e2e: brain detach — fresh single-commit squash + full-tree scrub (M3 review fix 2)', () => {
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  let dirs: string[];

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token'; // local-path remotes never actually use it
    dirs = [];
  });
  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeBrainRepo(): { projectRoot: string; contextRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dc-e2e-detach-'));
    const contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(contextRoot, { recursive: true });
    dirs.push(projectRoot);
    return { projectRoot, contextRoot };
  }

  function makeBareRemote(): string {
    const bareDir = mkdtempSync(join(tmpdir(), 'dc-e2e-detach-bare-'));
    execFileSync('git', ['init', '--bare', bareDir]);
    dirs.push(bareDir);
    return bareDir;
  }

  it('re-detaching an ALREADY-separate brain to a DIFFERENT remote (no --preserve-history) squashes to a single fresh commit', async () => {
    const { projectRoot, contextRoot } = makeBrainRepo();
    git(contextRoot, ['init']);
    setLocalIdentity(contextRoot);

    mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRoot, 'knowledge', 'a.md'), 'first\n');
    git(contextRoot, ['add', '-A']);
    git(contextRoot, ['commit', '-m', 'first commit']);
    writeFileSync(join(contextRoot, 'knowledge', 'b.md'), 'second\n');
    git(contextRoot, ['add', '-A']);
    git(contextRoot, ['commit', '-m', 'second commit']);
    expect(git(contextRoot, ['log', '--oneline']).trim().split('\n')).toHaveLength(2);

    const oldRemote = makeBareRemote();
    git(contextRoot, ['remote', 'add', 'origin', oldRemote]);
    const newRemote = makeBareRemote();

    const result = await detachBrain({ contextRoot, projectRoot, remote: newRemote, keepTracked: true });

    expect(result.action).toBe('detached');
    expect(git(contextRoot, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
    expect(bareHead(newRemote)).not.toBeNull();
    expect(git(newRemote, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
  });

  it('a secret sitting UNCHANGED in the pre-existing committed tree is caught by the full-tree scrub and BLOCKS the detach', async () => {
    const { projectRoot, contextRoot } = makeBrainRepo();
    git(contextRoot, ['init']);
    setLocalIdentity(contextRoot);

    mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRoot, 'knowledge', 'a.md'), 'clean\n');
    git(contextRoot, ['add', '-A']);
    git(contextRoot, ['commit', '-m', 'clean commit']);
    // The secret lands in an OLD commit and is NEVER removed — it's still
    // sitting in HEAD's current tree, unchanged, when detach runs.
    writeFileSync(join(contextRoot, 'knowledge', 'leak.md'), `oops ghp_${'a'.repeat(36)}\n`);
    git(contextRoot, ['add', '-A']);
    git(contextRoot, ['commit', '-m', 'oops, committed a token']);

    const oldRemote = makeBareRemote();
    git(contextRoot, ['remote', 'add', 'origin', oldRemote]);
    const newRemote = makeBareRemote();

    const result = await detachBrain({ contextRoot, projectRoot, remote: newRemote, keepTracked: true });

    expect(result.action).toBe('blocked-scrub');
    expect(result.scrub.blocks.some((b) => b.file === 'knowledge/leak.md')).toBe(true);
    expect(bareHead(newRemote)).toBeNull(); // nothing reached the new remote
  });

  it('re-detaching to the SAME remote it is already on is idempotent — no destructive re-init, no needless re-push', async () => {
    const { projectRoot, contextRoot } = makeBrainRepo();
    git(contextRoot, ['init']);
    setLocalIdentity(contextRoot);
    mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRoot, 'knowledge', 'a.md'), 'clean\n');
    git(contextRoot, ['add', '-A']);
    git(contextRoot, ['commit', '-m', 'first commit']);

    const remote = makeBareRemote();
    const first = await detachBrain({ contextRoot, projectRoot, remote, keepTracked: true });
    expect(first.action).toBe('detached');
    expect(git(contextRoot, ['log', '--oneline']).trim().split('\n')).toHaveLength(1);
    const shaAfterFirst = git(contextRoot, ['rev-parse', 'HEAD']).trim();

    const second = await detachBrain({ contextRoot, projectRoot, remote, keepTracked: true });
    expect(second.action).toBe('already-detached');
    // Same remote, nothing changed — the commit is untouched (no destructive re-init happened).
    expect(git(contextRoot, ['rev-parse', 'HEAD']).trim()).toBe(shaAfterFirst);
  });
});

describe('e2e: freshly attached EMPTY remote (zero refs) — first sync bootstraps main', () => {
  let bare: string;
  let projectRoot: string;
  let contextRoot: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token';
    bare = mkdtempSync(join(tmpdir(), 'dc-e2e-empty-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-e2e-empty-'));
    contextRoot = join(projectRoot, '_dream_context');
    mkdirSync(join(contextRoot, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRoot, 'knowledge', 'note.md'), '# a knowledge note\n');
  });
  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const dir of [bare, projectRoot].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
  });

  it('attach → pull-only noops (no crash) → auto births main with the first commit → auto again noops', async () => {
    const att = attachBrainRepo({ contextRoot, projectRoot, url: bare, confirmed: true });
    expect(att.ok).toBe(true);
    setLocalIdentity(contextRoot);
    updateSetupConfig(projectRoot, { brainRepo: { mode: 'separate', enabled: true, remote: bare, autoSync: true } });

    // The background/session-start path fires first in real life — it must
    // NOT die with `couldn't find remote ref main` on the ref-less remote.
    const pull = await runBrainSync({ cwd: contextRoot, mode: 'pull-only' });
    expect(pull.action).toBe('noop');
    expect(pull.note).toMatch(/empty/i);
    expect(bareHead(bare)).toBeNull();

    // First real sync: root commit on the unborn HEAD, push births main.
    const auto = await runBrainSync({ cwd: contextRoot, mode: 'auto' });
    expect(auto.action).toBe('pushed');
    expect(bareHead(bare)).not.toBeNull();
    expect(git(bare, ['ls-tree', '--name-only', 'main']).trim()).toContain('knowledge');

    // Converged: nothing further to do.
    const again = await runBrainSync({ cwd: contextRoot, mode: 'auto' });
    expect(again.action).toBe('noop');
  });
});

describe('e2e: platform layer — CLAUDE.md + .claude travel with the brain repo', () => {
  let bare: string;
  let projectRootA: string;
  let contextRootA: string;
  let projectRootB: string;
  let contextRootB: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token';
    bare = mkdtempSync(join(tmpdir(), 'dc-e2e-platform-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
    projectRootA = mkdtempSync(join(tmpdir(), 'dc-e2e-platform-a-'));
    contextRootA = join(projectRootA, '_dream_context');
    mkdirSync(join(contextRootA, 'knowledge'), { recursive: true });
    writeFileSync(join(contextRootA, 'knowledge', 'note.md'), '# note\n');
  });
  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const dir of [bare, projectRootA, projectRootB].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
  });

  it('A migrates + pushes; a fresh clone B pulls and the sync itself heals the root symlinks; settings.local.json never syncs', async () => {
    // A has a real Claude Code layer at the project root.
    writeFileSync(join(projectRootA, 'CLAUDE.md'), '# team rules\n');
    mkdirSync(join(projectRootA, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(projectRootA, '.claude', 'settings.json'), '{"shared":true}\n');
    writeFileSync(join(projectRootA, '.claude', 'settings.local.json'), '{"machineLocal":true}\n');

    const setup = setupPlatformLayer(projectRootA, contextRootA);
    expect(setup.moved.sort()).toEqual(['.claude', 'CLAUDE.md']);

    git(contextRootA, ['init']);
    setLocalIdentity(contextRootA);
    const boot = await bootstrapBrainRepo({ contextRoot: contextRootA, projectRoot: projectRootA, remote: bare });
    expect(boot.pushed).toBe(true);
    updateSetupConfig(projectRootA, { brainRepo: { mode: 'separate', enabled: true, remote: bare, autoSync: true } });

    // The shared layer is on the remote; the machine-local file is NOT.
    const tree = git(bare, ['ls-tree', '-r', '--name-only', 'main']);
    expect(tree).toContain('platform/CLAUDE.md');
    expect(tree).toContain('platform/.claude/settings.json');
    expect(tree).not.toContain('platform/.claude/settings.local.json');

    // B: fresh clone of the brain — no root CLAUDE.md/.claude yet.
    projectRootB = mkdtempSync(join(tmpdir(), 'dc-e2e-platform-b-'));
    contextRootB = join(projectRootB, '_dream_context');
    git(projectRootB, ['clone', bare, contextRootB]);
    setLocalIdentity(contextRootB);
    updateSetupConfig(projectRootB, { brainRepo: { mode: 'separate', enabled: true, remote: bare, autoSync: true } });
    expect(existsSync(join(projectRootB, 'CLAUDE.md'))).toBe(false);

    // Any sync (here: the background pull-only path) heals the links.
    const pull = await runBrainSync({ cwd: contextRootB, mode: 'pull-only' });
    expect(pull.action).toBe('noop'); // clone is already current — heal still runs
    expect(readFileSync(join(projectRootB, 'CLAUDE.md'), 'utf-8')).toBe('# team rules\n');
    expect(readFileSync(join(projectRootB, '.claude', 'settings.json'), 'utf-8')).toBe('{"shared":true}\n');
    expect(existsSync(join(projectRootB, '.claude', 'settings.local.json'))).toBe(false);

    // A edits the shared CLAUDE.md through the ROOT SYMLINK; sync pushes it; B pulls the edit.
    writeFileSync(join(projectRootA, 'CLAUDE.md'), '# team rules v2\n');
    const aPush = await runBrainSync({ cwd: contextRootA, mode: 'auto' });
    expect(aPush.action).toBe('pushed');
    const bPull = await runBrainSync({ cwd: contextRootB, mode: 'pull-only' });
    expect(bPull.action).toBe('pulled');
    expect(readFileSync(join(projectRootB, 'CLAUDE.md'), 'utf-8')).toBe('# team rules v2\n');
  });
});

/**
 * full-repo mode: the WHOLE project folder (code + _dream_context) is the synced
 * unit, pushed to the project's OWN origin on the CURRENT branch — no separate
 * brain repo. Real git, local bare remote, no network.
 */
describe('e2e: full-repo sync (whole project → origin, current branch)', () => {
  let bare: string;
  let projectA: string;
  let projectB: string;
  const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  beforeAll(() => {
    process.env.GITHUB_TOKEN = 'e2e-dummy-token';
    bare = mkdtempSync(join(tmpdir(), 'dc-e2e-full-bare-'));
    execFileSync('git', ['init', '--bare', bare]);
  });

  afterAll(() => {
    if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
    for (const dir of [bare, projectA, projectB].filter(Boolean)) rmSync(dir, { recursive: true, force: true });
  });

  it('pushes the whole folder (code + brain) to origin on a non-main branch; a second clone pulls it and a round-trip merge lands', async () => {
    // Project A: a real code repo with an origin, on a FEATURE branch (proves we
    // never hardcode `main`), with brain files nested inside it.
    projectA = mkdtempSync(join(tmpdir(), 'dc-e2e-full-a-'));
    git(projectA, ['init']);
    setLocalIdentity(projectA);
    git(projectA, ['checkout', '-b', 'feature/x']);
    git(projectA, ['remote', 'add', 'origin', bare]);
    mkdirSync(join(projectA, 'src'), { recursive: true });
    mkdirSync(join(projectA, '_dream_context', 'knowledge'), { recursive: true });
    mkdirSync(join(projectA, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(projectA, 'src', 'app.ts'), 'export const x = 1;\n');
    writeFileSync(join(projectA, '_dream_context', 'knowledge', 'k.md'), '# knowledge\nA wrote this.\n');
    updateSetupConfig(projectA, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });

    // Auto sync commits the WHOLE tree and pushes to origin/feature/x.
    const push = await runBrainSync({ cwd: join(projectA, '_dream_context'), mode: 'auto' });
    expect(push.action).toBe('pushed');

    // The remote branch is feature/x (NOT main), and it carries BOTH code + brain.
    const branches = git(bare, ['branch', '--list']);
    expect(branches).toContain('feature/x');
    const tree = git(bare, ['ls-tree', '-r', '--name-only', 'feature/x']);
    expect(tree).toContain('src/app.ts');
    expect(tree).toContain('_dream_context/knowledge/k.md');
    // SAFETY: gitignore-first excludes the machine-local sync lock (a leaked lock
    // poisons every clone with a foreign live PID → "locked") and, critically,
    // secrets — even though `git add -A` staged the whole tree.
    expect(tree).not.toContain('_dream_context/state/.brain-merge');
    expect(tree).not.toContain('_dream_context/state/.brain-local.json');
    expect(tree).not.toContain('.secrets.json');

    // Project B: a fresh clone of the whole project on the same branch.
    projectB = mkdtempSync(join(tmpdir(), 'dc-e2e-full-b-'));
    git(projectB, ['clone', '--branch', 'feature/x', bare, join(projectB, 'repo')]);
    const repoB = join(projectB, 'repo');
    setLocalIdentity(repoB);
    updateSetupConfig(repoB, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    expect(readFileSync(join(repoB, 'src', 'app.ts'), 'utf-8')).toBe('export const x = 1;\n');

    // B edits code + brain and pushes.
    writeFileSync(join(repoB, 'src', 'app.ts'), 'export const x = 2;\n');
    writeFileSync(join(repoB, '_dream_context', 'knowledge', 'k2.md'), '# more\nB wrote this.\n');
    const bPush = await runBrainSync({ cwd: join(repoB, '_dream_context'), mode: 'auto' });
    expect(bPush.action).toBe('pushed');

    // A makes a NON-conflicting edit; auto sync fetches B's work, merges, pushes.
    writeFileSync(join(projectA, 'README.md'), '# project\n');
    const aMerge = await runBrainSync({ cwd: join(projectA, '_dream_context'), mode: 'auto' });
    expect(aMerge.action).toBe('pushed');
    // A now has B's changes merged into its working tree — nothing lost either side.
    expect(readFileSync(join(projectA, 'src', 'app.ts'), 'utf-8')).toBe('export const x = 2;\n');
    expect(existsSync(join(projectA, '_dream_context', 'knowledge', 'k2.md'))).toBe(true);
  });

  // ── item 4: a genuine CODE conflict is never semantically merged ──
  it('two clones conflict on src/app.ts → code-conflict (git markers for the human), no mangling, no silent loss, then converges after a human resolve', async () => {
    // Fresh A on `main` with a 3-line code file (so a middle-line edit truly conflicts)
    // and a brain file (to prove brain files are NOT lost when code conflicts).
    const codeBare = mkdtempSync(join(tmpdir(), 'dc-e2e-code-bare-'));
    execFileSync('git', ['init', '--bare', codeBare]);
    const a = mkdtempSync(join(tmpdir(), 'dc-e2e-code-a-'));
    git(a, ['init']);
    setLocalIdentity(a);
    git(a, ['checkout', '-b', 'main']);
    git(a, ['remote', 'add', 'origin', codeBare]);
    mkdirSync(join(a, 'src'), { recursive: true });
    mkdirSync(join(a, '_dream_context', 'knowledge'), { recursive: true });
    mkdirSync(join(a, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(a, 'src', 'app.ts'), 'const a = 1;\nconst shared = "ORIGINAL";\nconst c = 3;\n');
    writeFileSync(join(a, '_dream_context', 'knowledge', 'k.md'), '# k\nbase\n');
    updateSetupConfig(a, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    expect((await runBrainSync({ cwd: join(a, '_dream_context'), mode: 'auto' })).action).toBe('pushed');

    // Clone B, change the SAME middle line differently, push first.
    const b = mkdtempSync(join(tmpdir(), 'dc-e2e-code-b-'));
    git(b, ['clone', '--branch', 'main', codeBare, join(b, 'repo')]);
    const repoB = join(b, 'repo');
    setLocalIdentity(repoB);
    updateSetupConfig(repoB, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    writeFileSync(join(repoB, 'src', 'app.ts'), 'const a = 1;\nconst shared = "FROM_B";\nconst c = 3;\n');
    expect((await runBrainSync({ cwd: join(repoB, '_dream_context'), mode: 'auto' })).action).toBe('pushed');
    const headAfterB = bareHead(codeBare);

    // A changes the same middle line (conflicting) AND a brain file (non-conflicting).
    writeFileSync(join(a, 'src', 'app.ts'), 'const a = 1;\nconst shared = "FROM_A";\nconst c = 3;\n');
    writeFileSync(join(a, '_dream_context', 'knowledge', 'k.md'), '# k\nbase\nA added a brain line.\n');

    // Foreground auto (the dashboard's manual sync): git's native 3-way markers are
    // left for the human — NEVER a semantic merge of source, NEVER an agent handoff.
    const conflict = await runBrainSync({ cwd: join(a, '_dream_context'), mode: 'auto', foreground: true });
    expect(conflict.action).toBe('code-conflict');
    expect(conflict.codeConflicts).toEqual(['src/app.ts']);

    // NO MANGLING + NO SILENT LOSS: both sides survive verbatim inside git's markers.
    const conflicted = readFileSync(join(a, 'src', 'app.ts'), 'utf-8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('FROM_A');
    expect(conflicted).toContain('FROM_B');
    expect(conflicted).toContain('>>>>>>>');

    // The remote was NOT advanced (nothing pushed over the conflict).
    expect(bareHead(codeBare)).toBe(headAfterB);

    // The report separates the code file from brain files (deferred/agent list empty).
    const report = readConflictReport(join(a, '_dream_context'));
    expect(report?.codeConflicts).toEqual(['src/app.ts']);
    expect(report?.deferred).toEqual([]);

    // HUMAN-RESOLVABLE: resolve the file in the editor, finish the merge natively.
    writeFileSync(join(a, 'src', 'app.ts'), 'const a = 1;\nconst shared = "FROM_A_AND_B";\nconst c = 3;\n');
    git(a, ['add', '-A']);
    git(a, ['commit', '--no-edit']);

    // A follow-up sync now converges: the stale code-conflict report is cleared and
    // the resolved merge (with A's brain edit too) is pushed cleanly.
    const done = await runBrainSync({ cwd: join(a, '_dream_context'), mode: 'auto', foreground: true });
    expect(done.action).toBe('pushed');
    expect(readConflictReport(join(a, '_dream_context'))).toBeNull();

    // B pulls and sees the resolved code + A's brain line — nothing lost end to end.
    expect((await runBrainSync({ cwd: join(repoB, '_dream_context'), mode: 'pull-only', foreground: true })).action).toBe('pulled');
    expect(readFileSync(join(repoB, 'src', 'app.ts'), 'utf-8')).toContain('FROM_A_AND_B');
    expect(readFileSync(join(repoB, '_dream_context', 'knowledge', 'k.md'), 'utf-8')).toContain('A added a brain line.');

    rmSync(codeBare, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });
});
