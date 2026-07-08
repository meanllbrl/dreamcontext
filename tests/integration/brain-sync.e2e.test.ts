import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateSetupConfig, readBrainLocal } from '../../src/lib/setup-config.js';
import { readConflictReport } from '../../src/lib/git-sync/conflict-report.js';
import { runBrainSync } from '../../src/lib/git-sync/sync-engine.js';

/**
 * Scripted, no-network E2E for the whole-project (`full-repo`) sync engine
 * (github-cloud-collaboration-brain-repo-sync). A `git init --bare` repo plays
 * the project's "origin" — everything else is the real git binary + the real
 * library code (no fakes). `GITHUB_TOKEN` is set to a dummy value: a LOCAL-PATH
 * remote needs no real credential (askpass is never invoked for a plain local
 * path), so a bogus token lets `resolveBrainSyncToken`/`withGitCredentials` run
 * for real while never authenticating.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function setLocalIdentity(cwd: string): void {
  git(cwd, ['config', 'user.email', 'e2e@dreamcontext.local']);
  git(cwd, ['config', 'user.name', 'E2E Test']);
}

function bareHead(bareDir: string, branch = 'main'): string | null {
  try {
    return git(bareDir, ['rev-parse', `refs/heads/${branch}`]).trim();
  } catch {
    return null;
  }
}

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

  // ── prose conflict: brain-prose overlap defers to the agent, --continue completes ──
  it('a brain-prose add/add conflict auto-resolves the task, defers the knowledge overlap to the agent, and --continue completes the union', async () => {
    const bareP = mkdtempSync(join(tmpdir(), 'dc-e2e-prose-bare-'));
    execFileSync('git', ['init', '--bare', bareP]);
    const a = mkdtempSync(join(tmpdir(), 'dc-e2e-prose-a-'));
    git(a, ['init']);
    setLocalIdentity(a);
    git(a, ['checkout', '-b', 'main']);
    git(a, ['remote', 'add', 'origin', bareP]);
    mkdirSync(join(a, '_dream_context', 'knowledge'), { recursive: true });
    mkdirSync(join(a, '_dream_context', 'state'), { recursive: true });
    writeFileSync(join(a, '_dream_context', 'knowledge', 'shared.md'), '# base\n');
    updateSetupConfig(a, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });
    expect((await runBrainSync({ cwd: join(a, '_dream_context'), mode: 'auto' })).action).toBe('pushed');

    // Clone B; both A and B add the SAME task + knowledge paths, diverging (add/add).
    const b = mkdtempSync(join(tmpdir(), 'dc-e2e-prose-b-'));
    git(b, ['clone', '--branch', 'main', bareP, join(b, 'repo')]);
    const repoB = join(b, 'repo');
    setLocalIdentity(repoB);
    updateSetupConfig(repoB, { brainRepo: { mode: 'full-repo', enabled: true, autoSync: true } });

    // A: task in_progress + a knowledge section, push.
    writeFileSync(
      join(a, '_dream_context', 'state', 'shared-task.md'),
      ['---', 'status: in_progress', '---', '', '## Changelog', '### 2026-07-01 - A', '- A did a thing', ''].join('\n'),
    );
    writeFileSync(join(a, '_dream_context', 'knowledge', 'shared.md'), ['# base', '', '## Section', 'A wrote this.', ''].join('\n'));
    expect((await runBrainSync({ cwd: join(a, '_dream_context'), mode: 'auto' })).action).toBe('pushed');

    // B: same paths, diverging — task is deterministic (always CLI-resolved); the
    // knowledge section overlap is not.
    writeFileSync(
      join(repoB, '_dream_context', 'state', 'shared-task.md'),
      ['---', 'status: in_review', '---', '', '## Changelog', '### 2026-07-02 - B', '- B did a thing', ''].join('\n'),
    );
    writeFileSync(join(repoB, '_dream_context', 'knowledge', 'shared.md'), ['# base', '', '## Section', 'B wrote this.', ''].join('\n'));

    const bResult = await runBrainSync({ cwd: join(repoB, '_dream_context'), mode: 'auto' });
    expect(bResult.action).toBe('awaiting-agent');
    expect(bResult.conflicts).toContain('_dream_context/knowledge/shared.md');

    const report = readConflictReport(join(repoB, '_dream_context'));
    expect(report).not.toBeNull();
    expect(report!.resolvedByCli).toContain('_dream_context/state/shared-task.md');
    expect(report!.deferred.map((d) => d.path)).toEqual(['_dream_context/knowledge/shared.md']);

    // The CLI already auto-resolved the task file (both entries, furthest status).
    const taskContent = readFileSync(join(repoB, '_dream_context', 'state', 'shared-task.md'), 'utf-8');
    expect(taskContent).toContain('A did a thing');
    expect(taskContent).toContain('B did a thing');
    expect(taskContent).toMatch(/status: in_review/); // in_review > in_progress

    // Simulate the agent: write a semantic prose merge, stage it, --continue.
    writeFileSync(join(repoB, '_dream_context', 'knowledge', 'shared.md'), ['# base', '', '## Section', 'A wrote this. B wrote this.', ''].join('\n'));
    git(repoB, ['add', '_dream_context/knowledge/shared.md']);

    const continueResult = await runBrainSync({ cwd: join(repoB, '_dream_context'), mode: 'auto', continue: true });
    expect(continueResult.action).toBe('pushed');
    expect(readConflictReport(join(repoB, '_dream_context'))).toBeNull(); // report + snapshots gone
    expect(readBrainLocal(repoB).pendingAgentMerge).toBeFalsy();

    const merged = readFileSync(join(repoB, '_dream_context', 'knowledge', 'shared.md'), 'utf-8');
    expect(merged).toContain('A wrote this');
    expect(merged).toContain('B wrote this');

    rmSync(bareP, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
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
