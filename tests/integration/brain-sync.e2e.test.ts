import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig, readBrainLocal } from '../../src/lib/setup-config.js';
import { readConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { bootstrapBrainRepo } from '../../src/lib/git-sync/brain-repo.js';
import { runBrainSync } from '../../src/lib/git-sync/sync-engine.js';

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
