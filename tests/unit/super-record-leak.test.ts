/**
 * The Super record leak (2026-11-03): a repo with the brain inside, set up by an older version,
 * committed `state/.super-agent.json`, and a friend's clone opened the owner's last question.
 * Proved by GIT (`check-ignore`, `ls-files`), not by reading our own `.gitignore` back:
 *   - an existing brain `.gitignore` gains the machine-local lines on update, negations still work;
 *   - a tracked Super file leaves the index and stays on disk;
 *   - a record stamped for another Mac or folder, or an unstamped one from a commit, is not loaded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAIN_LOCAL_GITIGNORE_ENTRIES, FULL_REPO_LOCAL_GITIGNORE_ENTRIES, ensureBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';
import { migration0402, untrackSuperRecords } from '../../src/migrations/0.40.2.js';
import { REGISTRY } from '../../src/migrations/index.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex, updateSuperState } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { readMachineIdentity } from '../../src/lib/machine-id.js';
import { resetBindingCache } from '../../src/lib/super/record-binding.js';
import { superHandoffContext } from '../../src/lib/super/handoff-task.js';

let dir: string;
let project: string;
let root: string;
let home: string;
let prevHome: string | undefined;

const git = (args: string[], cwd = project) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const ignored = (rel: string): boolean => {
  try { git(['check-ignore', '-q', '--no-index', rel]); return true; } catch { return false; }
};
const tracked = (rel: string) => git(['ls-files', '--', rel]).trim().length > 0;
const SESSION = '0b6f2c1e-7d4a-4c1b-9a2e-3f5d6c7b8a90';
const record = (over: Record<string, unknown> = {}) => ({ ...emptySuperState(), session: SESSION, enabled: true, ...over });
const writeRecord = (body: unknown) => writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(body));

/** The gitignore an install from before 0.40.2 wrote: no Super lines, no session roster wildcard. */
const OLD_GITIGNORE = ['state/.secrets.json', 'state/.sleep.json', 'state/.agent-sessions.json', 'tmp/', '!lab/credentials.example.json', ''].join('\n');

beforeEach(() => {
  resetSuperIndex();
  resetBindingCache();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-leak-')));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = home;
  project = join(dir, 'project');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state', '.super', 'members'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'dev@example.test']);
  git(['config', 'user.name', 'Dev']);
  git(['config', 'commit.gpgsign', 'false']);
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('the ignore lists', () => {
  it('both lists carry the record, its temp files, the members folder and the session rosters', () => {
    for (const e of ['state/.super-agent.json', 'state/.super-agent.json.*', 'state/.super/', 'state/.agent-sessions.*']) {
      expect(BRAIN_LOCAL_GITIGNORE_ENTRIES).toContain(e);
      expect(FULL_REPO_LOCAL_GITIGNORE_ENTRIES).toContain(`_dream_context/${e}`);
    }
  });

  it('the migration is registered, runs on every update', () => {
    expect(REGISTRY).toContain(migration0402);
    expect(migration0402.everyRun).toBe(true);
  });
});

describe('an existing brain .gitignore is brought up to date', () => {
  it('adds what an old install lacked; git then ignores every Super file; idempotent', () => {
    writeFileSync(join(root, '.gitignore'), OLD_GITIGNORE);
    expect(ignored('_dream_context/state/.super-agent.json')).toBe(false);
    const added = ensureBrainGitignore(root);
    expect(added).toContain('state/.super-agent.json');
    for (const rel of ['state/.super-agent.json', 'state/.super-agent.json.123.ab.tmp', 'state/.super-agent.json.foreign-1', 'state/.super/handoff.md', 'state/.super/members/a.json', 'state/.agent-sessions.phone.json']) {
      expect(ignored(`_dream_context/${rel}`), rel).toBe(true);
    }
    // The owner's own lines survive.
    expect(readFileSync(join(root, '.gitignore'), 'utf-8').startsWith(OLD_GITIGNORE)).toBe(true);
    expect(ensureBrainGitignore(root)).toEqual([]);
  });

  it('a negation already in the file still works after the wildcard is appended below it', () => {
    writeFileSync(join(root, '.gitignore'), OLD_GITIGNORE);
    ensureBrainGitignore(root);
    expect(ignored('_dream_context/lab/credentials.json')).toBe(true);
    expect(ignored('_dream_context/lab/credentials.example.json')).toBe(false);
  });

  it('writes the full file when there is none, never through a symlink', () => {
    ensureBrainGitignore(root);
    expect(ignored('_dream_context/state/.super-agent.json')).toBe(true);
    rmSync(join(root, '.gitignore'));
    const target = join(dir, 'elsewhere.txt');
    execFileSync('ln', ['-s', target, join(root, '.gitignore')]);
    expect(() => ensureBrainGitignore(root)).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});

describe('update takes a tracked Super file out of the index (the leak)', () => {
  const commitLeak = () => {
    writeFileSync(join(root, '.gitignore'), OLD_GITIGNORE);
    writeRecord(record({ queue: [] }));
    writeFileSync(join(root, 'state', '.super', 'handoff.md'), 'handoff');
    writeFileSync(join(root, 'state', '.super-agent.json.1.aa.tmp'), '{}');
    writeFileSync(join(root, 'state', 'a-task.md'), '# task');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'leak']);
    expect(tracked('_dream_context/state/.super-agent.json')).toBe(true);
  };

  it('untracks them, keeps the files, keeps the task; a second run finds nothing', () => {
    commitLeak();
    const results = migration0402.steps.map((s) => s(root));
    expect(results.every((r) => !r.failedCount)).toBe(true);
    expect(tracked('_dream_context/state/.super-agent.json')).toBe(false);
    expect(tracked('_dream_context/state/.super/handoff.md')).toBe(false);
    expect(tracked('_dream_context/state/.super-agent.json.1.aa.tmp')).toBe(false);
    expect(tracked('_dream_context/state/a-task.md')).toBe(true);
    expect(existsSync(join(root, 'state', '.super', 'handoff.md'))).toBe(true);
    // A commit now carries the removal and nothing comes back on the next add.
    git(['add', '-A']);
    expect(git(['diff', '--cached', '--name-status'])).toContain('D\t_dream_context/state/.super-agent.json');
    git(['commit', '-q', '-m', 'untrack']);
    git(['add', '-A']);
    expect(git(['status', '--porcelain', '--', '_dream_context/state'])).toBe('');
    expect(untrackSuperRecords(root).detected).toBe(true);
  });

  it('a committed record whose Super session is not on this Mac is set aside, never loaded', async () => {
    commitLeak();
    expect((await readSuperState(root)).session).toBeNull();
    migration0402.steps.forEach((step) => step(root));
    expect(existsSync(join(root, SUPER_STATE_REL))).toBe(false);
    const aside = readdirSync(join(root, 'state')).filter((f) => f.startsWith('.super-agent.json.foreign-'));
    expect(aside).toHaveLength(1);
    expect(ignored(`_dream_context/state/${aside[0]}`)).toBe(true);
  });

  it('a committed record whose Super session IS on this Mac stays and is loaded', async () => {
    mkdirSync(join(home, '.claude', 'projects', '-x'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-x', `${SESSION}.jsonl`), '{}\n');
    commitLeak();
    untrackSuperRecords(root);
    expect(existsSync(join(root, SUPER_STATE_REL))).toBe(true);
    resetBindingCache();
    expect((await readSuperState(root)).session).toBe(SESSION);
  });

  it('outside a git repo it does nothing and reports clean', () => {
    const lone = join(dir, 'lone', '_dream_context');
    mkdirSync(join(lone, 'state'), { recursive: true });
    writeFileSync(join(lone, 'state', '.super-agent.json'), '{}');
    const r = untrackSuperRecords(lone);
    expect(r.failedCount ?? 0).toBe(0);
    expect(existsSync(join(lone, 'state', '.super-agent.json'))).toBe(true);
  });
});

describe('a record from another Mac or another folder is not this Super', () => {
  it('every write stamps this Mac and the real folder; readers never see the stamp', async () => {
    const written = await updateSuperState(root, (s) => { s.session = SESSION; s.enabled = true; });
    const disk = JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8'));
    expect(disk.bound).toEqual({ machine: readMachineIdentity().id, root: realpathSync(root) });
    expect('bound' in written).toBe(false);
    expect('bound' in (await readSuperState(root))).toBe(false);
    expect((await readSuperState(root)).session).toBe(SESSION);
  });

  it('another machine id: empty on read; the next write keeps the foreign file aside', async () => {
    writeRecord(record({ bound: { machine: 'aaaaaaaaaaaa', root: realpathSync(root) } }));
    const s = await readSuperState(root);
    expect(s.session).toBeNull();
    expect(s.queue).toEqual([]);
    expect(superHandoffContext(root, [SESSION])).toBeNull();
    await updateSuperState(root, (d) => { d.view = { mode: 'float' }; });
    expect(readdirSync(join(root, 'state')).some((f) => f.startsWith('.super-agent.json.foreign-'))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).session).toBeNull();
  });

  it('this machine but another folder (a copied project): empty', async () => {
    writeRecord(record({ bound: { machine: readMachineIdentity().id, root: '/Users/someone/projects/other/_dream_context' } }));
    expect((await readSuperState(root)).session).toBeNull();
  });

  it('a malformed stamp is foreign, never adopted', async () => {
    writeRecord(record({ bound: 'yes' }));
    expect((await readSuperState(root)).session).toBeNull();
  });

  it('an unstamped record git never tracked is this Mac\'s (written before the stamp) and is stamped by the next write', async () => {
    writeRecord(record());
    expect((await readSuperState(root)).session).toBe(SESSION);
    expect(superHandoffContext(root, [SESSION])).not.toBeNull();
    await updateSuperState(root, () => {});
    expect(JSON.parse(readFileSync(join(root, SUPER_STATE_REL), 'utf-8')).bound.machine).toBe(readMachineIdentity().id);
  });
});
