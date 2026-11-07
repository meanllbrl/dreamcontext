/**
 * The owner's Super agenda on a teammate's computer (2026-11-07). The Super record itself had
 * been kept out of git since 0.40.2, but `state/.sleep.json` had not: it holds every session's
 * last reply and the bookmarks caught from it, and a Super turn ends on what waits on the owner.
 * An install from before its ignore line committed it, `.gitignore` never untracks a tracked file,
 * and every sync pushed it on, peer mail beside it. Reproduced here with an owner repo, a bare
 * team remote and a teammate's clone, proved by GIT (what the remote's tree holds), never by
 * reading our own lists back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAIN_LOCAL_GITIGNORE_ENTRIES, FULL_REPO_LOCAL_GITIGNORE_ENTRIES, ensureBrainGitignore } from '../../src/lib/git-sync/brain-repo.js';
import { untrackSuperRecords } from '../../src/migrations/0.40.2.js';
import { SESSION_LOCAL_PATHSPECS, incomingSessionFiles, incomingSuperRecords, superStagePass } from '../../src/lib/super/pull-guard.js';
import { resetSuperIndex } from '../../src/lib/super/store.js';
import { resetBindingCache } from '../../src/lib/super/record-binding.js';

let base: string;
let home: string;
let prevHome: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const tracked = (cwd: string, rel: string) => git(cwd, 'ls-files', '--', rel).trim().length > 0;
/** Every path the team remote's main holds under the brain's state/. */
const remoteState = (bare: string) => git(bare, 'ls-tree', '-r', '--name-only', 'main', '--', '_dream_context/state/').split('\n').filter(Boolean);

/** The ignore file a Tilki-era install wrote: it never listed peer mail, and its sleep line came
 *  AFTER the file was already committed (modelled by committing with no ignore at all). */
const OLD_GITIGNORE = ['state/.secrets.json', 'tmp/', ''].join('\n');

/** What a Super turn leaves in the sleep state: its last reply and the bookmark caught from it. */
const OWNER_LINE = 'Plan hazir, kararini soran bir kart seni bekliyor';
const sleepState = (line: string) => JSON.stringify({
  debt: 3,
  sessions: [{ session_id: 's-owner-1', last_assistant_message: line }],
  bookmarks: [{ id: 'bm-1', message: `Decision: ${line}`, capture: true, session_id: 's-owner-1' }],
});

function brain(dir: string): string {
  const ctx = join(dir, '_dream_context');
  mkdirSync(join(ctx, 'state', '.peer-mail'), { recursive: true });
  mkdirSync(join(ctx, 'state', '.session-digests'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge'), { recursive: true });
  return ctx;
}
function initRepo(dir: string): void {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dev@example.test');
  git(dir, 'config', 'user.name', 'Dev');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

/** The owner's brain as an old install left it: sleep state, a digest, peer mail and the retired
 *  Sleepy chat all committed and pushed; a teammate cloned it. */
function team(): { owner: string; ctx: string; bare: string; mate: string; mateCtx: string } {
  const owner = join(base, 'owner');
  mkdirSync(owner, { recursive: true });
  initRepo(owner);
  const ctx = brain(owner);
  writeFileSync(join(ctx, '.gitignore'), OLD_GITIGNORE);
  writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState(OWNER_LINE));
  writeFileSync(join(ctx, 'state', '.sleep-history.json'), '[]');
  writeFileSync(join(ctx, 'state', '.session-digests', 's-owner-1.md'), '# Session Digest\n');
  writeFileSync(join(ctx, 'state', '.peer-mail', '1-a.json'), '{"kind":"question","body":"from the Super"}');
  writeFileSync(join(ctx, 'state', '.sleepy-chat.json'), '{"messages":[]}');
  writeFileSync(join(ctx, 'state', 'a-task.md'), '# a task\n');
  writeFileSync(join(ctx, 'knowledge', 'k.md'), '# k\n');
  git(owner, 'add', '-A');
  git(owner, 'commit', '-q', '-m', 'old install');
  const bare = join(base, 'team.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(owner, 'remote', 'add', 'origin', bare);
  git(owner, 'push', '-q', 'origin', 'main');
  const mate = join(base, 'mate');
  git(base, 'clone', '-q', bare, mate);
  git(mate, 'config', 'user.email', 'mate@example.test');
  git(mate, 'config', 'user.name', 'Mate');
  git(mate, 'config', 'commit.gpgsign', 'false');
  return { owner, ctx, bare, mate, mateCtx: join(mate, '_dream_context') };
}

/** One sync's commit on the owner's Mac: stage everything, the stage pass, commit, push. */
function ownerSync(owner: string, ctx: string, msg: string): void {
  git(owner, 'add', '-A');
  superStagePass(owner, ctx);
  git(owner, 'commit', '-q', '--allow-empty', '-m', msg);
  git(owner, 'push', '-q', 'origin', 'main');
}

beforeEach(() => {
  resetSuperIndex();
  resetBindingCache();
  base = realpathSync(mkdtempSync(join(tmpdir(), 'session-leak-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  prevHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(base, { recursive: true, force: true });
});

describe('the leak, reproduced: a committed sleep state carries the Super\'s lines to a teammate', () => {
  it('before any fix runs, the teammate\'s clone holds the owner\'s waiting-on-you line', () => {
    const { mateCtx } = team();
    expect(readFileSync(join(mateCtx, 'state', '.sleep.json'), 'utf-8')).toContain(OWNER_LINE);
  });
});

describe('a sync never carries a session file, whatever an old install committed', () => {
  it('the owner\'s next sync removes every session file from the team remote, keeps them on his disk, keeps the task', () => {
    const { owner, ctx, bare } = team();
    const NEW_LINE = 'Uyku bir izin bekliyor, karar sana kaldi';
    writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState(NEW_LINE));
    writeFileSync(join(ctx, 'state', '.peer-mail', '2-b.json'), '{"kind":"note"}');
    ownerSync(owner, ctx, 'sync');
    const onRemote = remoteState(bare);
    for (const rel of ['.sleep.json', '.sleep-history.json', '.session-digests/s-owner-1.md', '.peer-mail/1-a.json', '.peer-mail/2-b.json', '.sleepy-chat.json']) {
      expect(onRemote, rel).not.toContain(`_dream_context/state/${rel}`);
    }
    expect(onRemote).toContain('_dream_context/state/a-task.md');
    const grepRemote = () => { try { return git(bare, 'grep', '-l', '-F', NEW_LINE, 'main', '--'); } catch { return ''; } };
    expect(grepRemote()).toBe('');
    // Still on the owner's Mac, untouched.
    expect(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8')).toContain(NEW_LINE);
    expect(existsSync(join(ctx, 'state', '.peer-mail', '2-b.json'))).toBe(true);
  });

  it('the teammate\'s pull of that sync takes the owner\'s copy off the teammate\'s disk', () => {
    const { owner, ctx, mate, mateCtx } = team();
    ownerSync(owner, ctx, 'sync');
    git(mate, 'pull', '-q', '--no-rebase', 'origin', 'main');
    expect(existsSync(join(mateCtx, 'state', '.sleep.json'))).toBe(false);
    expect(existsSync(join(mateCtx, 'state', '.peer-mail', '1-a.json'))).toBe(false);
    expect(existsSync(join(mateCtx, 'state', 'a-task.md'))).toBe(true);
  });
});

describe('update takes them out of the index (migration 0.40.2, every run)', () => {
  it('untracks the session files, names a few, keeps every file on disk; a second run finds nothing', () => {
    const { owner, ctx } = team();
    for (let i = 0; i < 8; i++) writeFileSync(join(ctx, 'state', '.peer-mail', `9-${i}.json`), '{}');
    git(owner, 'add', '-A');
    git(owner, 'commit', '-q', '-m', 'more mail');
    const r = untrackSuperRecords(ctx);
    expect(r.failedCount ?? 0).toBe(0);
    expect(r.detected).toBe(false);
    expect(r.summary).toMatch(/and \d+ more/);
    for (const rel of ['.sleep.json', '.sleep-history.json', '.session-digests/s-owner-1.md', '.peer-mail/1-a.json', '.sleepy-chat.json']) {
      expect(tracked(owner, `_dream_context/state/${rel}`), rel).toBe(false);
      expect(existsSync(join(ctx, 'state', rel)), rel).toBe(true);
    }
    expect(tracked(owner, '_dream_context/state/a-task.md')).toBe(true);
    expect(untrackSuperRecords(ctx).detected).toBe(true);
  });

  it('the brain .gitignore gains the lines an old install lacked, and git then ignores every session file', () => {
    const { ctx, owner } = team();
    ensureBrainGitignore(ctx);
    const ignored = (rel: string) => { try { git(owner, 'check-ignore', '-q', '--no-index', rel); return true; } catch { return false; } };
    for (const rel of ['.sleep.json', '.sleep-history.json', '.sleep-runs.jsonl', '.handoff-log.jsonl', '.session-titles.json', '.session-digests/x.md', '.agent-session-map/x', '.active-task', '.tool-handoff/x', '.run-sessions/x', '.peer-mail/x.json', '.sleepy-chat.json']) {
      expect(ignored(`_dream_context/state/${rel}`), rel).toBe(true);
    }
  });

  it('both ignore lists and the stage list name the same session files', () => {
    for (const p of SESSION_LOCAL_PATHSPECS) {
      const rel = p.slice('state/'.length);
      const asDir = `${p}/`;
      const inBrain = BRAIN_LOCAL_GITIGNORE_ENTRIES.includes(p) || BRAIN_LOCAL_GITIGNORE_ENTRIES.includes(asDir);
      const inFull = FULL_REPO_LOCAL_GITIGNORE_ENTRIES.includes(`_dream_context/${p}`) || FULL_REPO_LOCAL_GITIGNORE_ENTRIES.includes(`_dream_context/${asDir}`);
      expect(inBrain, rel).toBe(true);
      expect(inFull, rel).toBe(true);
    }
  });
});

describe('a pull that carries another Mac\'s session files stops', () => {
  it('a teammate force-adding a sleep state or a letter is seen (any case); the owner\'s removal is not', () => {
    const { owner, ctx, mate, mateCtx } = team();
    // The owner's removal, seen from the teammate's clone: a deletion passes.
    ownerSync(owner, ctx, 'sync');
    git(mate, 'fetch', '-q', 'origin');
    expect(incomingSessionFiles(mate, mateCtx, 'origin/main')).toEqual([]);
    git(mate, 'merge', '-q', 'origin/main');
    // The teammate (an old install) pushes sleep state and a letter back.
    writeFileSync(join(mateCtx, 'state', '.Sleep.json'), sleepState('the teammate'));
    // The merge took the owner's letters away, and git leaves no empty folder behind.
    mkdirSync(join(mateCtx, 'state', '.peer-mail'), { recursive: true });
    writeFileSync(join(mateCtx, 'state', '.peer-mail', '7-x.json'), '{}');
    git(mate, 'add', '-f', '--', '_dream_context/state/.Sleep.json', '_dream_context/state/.peer-mail/7-x.json');
    git(mate, 'commit', '-q', '-m', 'old install');
    git(mate, 'push', '-q', 'origin', 'main');
    git(owner, 'fetch', '-q', 'origin');
    expect(incomingSessionFiles(owner, ctx, 'origin/main')?.sort()).toEqual(['_dream_context/state/.Sleep.json', '_dream_context/state/.peer-mail/7-x.json']);
    // The Super guard's answer is unchanged: no Super record came in.
    expect(incomingSuperRecords(owner, ctx, 'origin/main')).toEqual([]);
  });

  it('an update that touches no session file passes', () => {
    const { owner, ctx, mate, mateCtx } = team();
    ownerSync(owner, ctx, 'sync');
    git(mate, 'pull', '-q', '--no-rebase', 'origin', 'main');
    writeFileSync(join(mateCtx, 'knowledge', 'n.md'), '# n\n');
    git(mate, 'add', '-A'); git(mate, 'commit', '-q', '-m', 'note'); git(mate, 'push', '-q', 'origin', 'main');
    git(owner, 'fetch', '-q', 'origin');
    expect(incomingSessionFiles(owner, ctx, 'origin/main')).toEqual([]);
  });
});
