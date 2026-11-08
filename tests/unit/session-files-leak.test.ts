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
import { migration0402, untrackSuperRecords } from '../../src/migrations/0.40.2.js';
import { SESSION_LOCAL_PATHSPECS, dropMachineLocalFromPushRange, incomingSessionFiles, incomingSuperRecords, machineLocalInPushRange, sessionChanges, superStagePass } from '../../src/lib/super/pull-guard.js';
import { parkSessionFiles, restoreLeftoverSessionPark, restoreSessionPark, settleSessionMerge } from '../../src/lib/git-sync/session-merge.js';
import { setAsideForeignSleepLines } from '../../src/lib/super/sleep-foreign.js';
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
/** The owner's session: its transcript is on this Mac (the test process plays the owner's Mac). */
const OWNER_SID = '0b6f2c1e-7d4a-4c1b-9a2e-3f5d6c7b8a90';
const sleepState = (line: string, sid: string = OWNER_SID) => JSON.stringify({
  debt: 3,
  sessions: [{ session_id: sid, last_assistant_message: line }],
  bookmarks: [{ id: 'bm-1', message: `Decision: ${line}`, capture: true, session_id: sid }],
});
/** A Claude transcript for `sid` under HOME: the session ran on this Mac. */
const transcriptHere = (sid: string) => {
  mkdirSync(join(home, '.claude', 'projects', '-p'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', '-p', `${sid}.jsonl`), '{}\n');
};

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
  transcriptHere(OWNER_SID);
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

// ── review round 1 (multi-review 2026-11-07): what the first fix left open ──────────────────────

const MATE_SID = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const MATE_LINE = 'the teammate wrote this in its own session';

/** The sync's defused pull, as `mergeAndMaybeDefer` runs it: park, merge, settle, put back. */
function defusedPull(repo: string, ctx: string): { rest: string[] } {
  git(repo, 'fetch', '-q', 'origin');
  const changes = sessionChanges(repo, ctx, 'origin/main');
  expect(changes).not.toBeNull();
  const parks = parkSessionFiles(repo, ctx, changes ?? [], home);
  expect(parks).not.toBeNull();
  let conflicts: string[] = [];
  try { git(repo, 'merge', '--no-commit', '--no-edit', 'origin/main'); } catch {
    conflicts = git(repo, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
  }
  const settled = settleSessionMerge(repo, ctx, changes ?? []);
  restoreSessionPark(ctx, parks, home);
  return { rest: conflicts.filter((c) => !settled.has(c.toLowerCase())) };
}
const commitPull = (repo: string) => git(repo, 'commit', '-q', '--allow-empty', '-m', 'pull');

describe('S1: a case twin is the same file on a Mac, and leaves the index too', () => {
  it('a tracked `.Sleep.json` never rides a sync commit', () => {
    const { owner, ctx } = team();
    // The twin replaces the old name (on a Mac's disk both names are one file).
    git(owner, 'rm', '-q', '--cached', '--', '_dream_context/state/.sleep.json');
    rmSync(join(ctx, 'state', '.sleep.json'));
    writeFileSync(join(ctx, 'state', '.Sleep.json'), sleepState(OWNER_LINE));
    git(owner, 'add', '-f', '--', '_dream_context/state/.Sleep.json');
    git(owner, 'commit', '-q', '-m', 'twin');
    writeFileSync(join(ctx, 'state', '.Sleep.json'), sleepState('a newer waiting-on-you line'));
    git(owner, 'add', '-A');
    superStagePass(owner, ctx);
    git(owner, 'commit', '-q', '-m', 'sync');
    const tree = git(owner, 'ls-tree', '-r', '--name-only', 'HEAD', '--', '_dream_context/state/').toLowerCase();
    expect(tree).not.toContain('.sleep.json');
  });
});

describe('S2: a negated session line is countered, and a commit made outside the sync holds the push', () => {
  it('update puts the session lines after a teammate\'s `!state/.sleep.json`', () => {
    const { owner, ctx } = team();
    ensureBrainGitignore(ctx);
    writeFileSync(join(ctx, '.gitignore'), `${readFileSync(join(ctx, '.gitignore'), 'utf-8')}!state/.sleep.json\n`);
    const ignored = (rel: string) => { try { git(owner, 'check-ignore', '-q', '--no-index', rel); return true; } catch { return false; } };
    expect(ignored('_dream_context/state/.sleep.json')).toBe(false);
    migration0402.steps[0](ctx);
    expect(ignored('_dream_context/state/.sleep.json')).toBe(true);
    expect(ignored('_dream_context/state/.peer-mail/x.json')).toBe(true);
    expect(migration0402.steps[0](ctx).detected).toBe(true);
  });

  it('a commit that adds or changes a session file is named by the push gate; a removal passes', () => {
    const { owner, ctx } = team();
    // The removal (a sync commit) passes.
    git(owner, 'add', '-A'); superStagePass(owner, ctx); git(owner, 'commit', '-q', '-m', 'sync');
    git(owner, 'fetch', '-q', 'origin');
    expect(machineLocalInPushRange(owner, ctx, 'origin/main')).toBeNull();
    git(owner, 'push', '-q', 'origin', 'main');
    // A hand commit that force-adds it back is held.
    writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState('a hand commit'));
    git(owner, 'add', '-f', '--', '_dream_context/state/.sleep.json');
    git(owner, 'commit', '-q', '-m', 'by hand');
    const sha = git(owner, 'rev-parse', 'HEAD').trim();
    git(owner, 'fetch', '-q', 'origin');
    expect(machineLocalInPushRange(owner, ctx, 'origin/main')).toBe(sha);
  });
});

describe('E1: an old teammate\'s ordinary sync never locks an updated one out', () => {
  it('the old copy\'s change merges in settled: no conflict left, this Mac\'s sleep state kept, the remote converges', () => {
    const { owner, ctx, mate, mateCtx, bare } = team();
    // The old install changes its tracked copy and pushes, as every ordinary sync of it does.
    writeFileSync(join(mateCtx, 'state', '.sleep.json'), sleepState(MATE_LINE, MATE_SID));
    writeFileSync(join(mateCtx, 'state', '.peer-mail', '8-m.json'), '{"kind":"note"}');
    git(mate, 'add', '-A'); git(mate, 'commit', '-q', '-m', 'old sync'); git(mate, 'push', '-q', 'origin', 'main');
    // The updated owner's sync commit drops the files; its pull meets the old copy's change.
    const NEW_LINE = 'the owner, after the update';
    writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState(NEW_LINE));
    git(owner, 'add', '-A'); superStagePass(owner, ctx); git(owner, 'commit', '-q', '-m', 'sync');
    git(owner, 'fetch', '-q', 'origin');
    expect(incomingSessionFiles(owner, ctx, 'origin/main')?.length).toBeGreaterThan(0);
    const { rest } = defusedPull(owner, ctx);
    expect(rest).toEqual([]);
    commitPull(owner);
    const mine = readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8');
    expect(mine).toContain(NEW_LINE);
    expect(mine).not.toContain(MATE_LINE);
    // The other Mac's letter never lands here.
    expect(existsSync(join(ctx, 'state', '.peer-mail', '8-m.json'))).toBe(false);
    git(owner, 'push', '-q', 'origin', 'main');
    for (const rel of ['.sleep.json', '.peer-mail/8-m.json']) expect(remoteState(bare), rel).not.toContain(`_dream_context/state/${rel}`);
  });
});

describe('E2: a teammate who updated first keeps none of the owner\'s lines', () => {
  it('when the tracked sleep state leaves the index, sessions not on this Mac and their bookmarks are set aside', () => {
    const { mate, mateCtx } = team();
    // Updated first: its install wrote today's ignore list (the tracked copy still stages).
    ensureBrainGitignore(mateCtx);
    // The teammate's Mac: its own session ran here, the owner's did not.
    rmSync(join(home, '.claude', 'projects', '-p', `${OWNER_SID}.jsonl`));
    transcriptHere(MATE_SID);
    const both = JSON.parse(sleepState(OWNER_LINE));
    both.sessions.push({ session_id: MATE_SID, last_assistant_message: MATE_LINE });
    both.bookmarks.push({ id: 'bm-2', message: `Decision: ${MATE_LINE}`, session_id: MATE_SID }, { id: 'bm-3', message: 'typed by hand' });
    writeFileSync(join(mateCtx, 'state', '.sleep.json'), JSON.stringify(both));
    git(mate, 'add', '-A');
    superStagePass(mate, mateCtx);
    const kept = readFileSync(join(mateCtx, 'state', '.sleep.json'), 'utf-8');
    expect(kept).not.toContain(OWNER_LINE);
    expect(kept).toContain(MATE_LINE);
    expect(kept).toContain('typed by hand');
    const parsed = JSON.parse(kept);
    expect(parsed.debt).toBe(3);
    // Set aside, never deleted, and never synced.
    const aside = git(mate, 'ls-files', '--others', '--ignored', '--exclude-standard', '--', '_dream_context/state/').split('\n').filter((p) => p.includes('.sleep.json.foreign-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(mate, aside[0]), 'utf-8')).toContain(OWNER_LINE);
    expect(setAsideForeignSleepLines(mateCtx, home)).toBeNull();
  });
});

describe('E3: a teammate\'s own sleep state survives the owner\'s removal', () => {
  it('a clean tracked copy (no sync commit of its own yet) is parked and put back when the removal arrives', () => {
    const { owner, ctx, mate, mateCtx } = team();
    transcriptHere(MATE_SID);
    writeFileSync(join(mateCtx, 'state', '.sleep.json'), sleepState(MATE_LINE, MATE_SID));
    git(mate, 'add', '-A'); git(mate, 'commit', '-q', '-m', 'mine'); git(mate, 'push', '-q', 'origin', 'main');
    git(owner, 'pull', '-q', '--no-rebase', 'origin', 'main');
    ownerSync(owner, ctx, 'sync');
    // The teammate's tree is clean: its copy is still tracked, exactly HEAD's bytes.
    const { rest } = defusedPull(mate, mateCtx);
    expect(rest).toEqual([]);
    commitPull(mate);
    expect(readFileSync(join(mateCtx, 'state', '.sleep.json'), 'utf-8')).toContain(MATE_LINE);
    expect(tracked(mate, '_dream_context/state/.sleep.json')).toBe(false);
  });
});

// ── review round 2 (edge-case re-check 2026-11-07): what the round-1 fix itself broke ──────────

describe('M1: the push gate never holds a sync for good on old history', () => {
  it('an old install\'s unpushed checkpoint is rewritten without the session file; the file stays on disk', () => {
    const { owner, ctx } = team();
    // The old install's checkpoint, never pushed: its tracked sleep state changed.
    writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState('checkpoint line'));
    writeFileSync(join(ctx, 'knowledge', 'k2.md'), '# k2\n');
    git(owner, 'add', '-A'); git(owner, 'commit', '-q', '-m', 'checkpoint');
    git(owner, 'fetch', '-q', 'origin');
    expect(machineLocalInPushRange(owner, ctx, 'origin/main')).not.toBeNull();
    expect(dropMachineLocalFromPushRange(owner, ctx, 'origin/main')).toBe(true);
    expect(machineLocalInPushRange(owner, ctx, 'origin/main')).toBeNull();
    // The rest of the work rode along, and this Mac's sleep state is untouched on disk.
    expect(git(owner, 'ls-tree', '-r', '--name-only', 'HEAD')).toContain('_dream_context/knowledge/k2.md');
    expect(readFileSync(join(ctx, 'state', '.sleep.json'), 'utf-8')).toContain('checkpoint line');
  });

  it('a project\'s code commit is never squashed: the push waits', () => {
    const { owner, ctx } = team();
    writeFileSync(join(ctx, 'state', '.sleep.json'), sleepState('checkpoint line'));
    writeFileSync(join(owner, 'app.ts'), 'export {};\n');
    git(owner, 'add', '-A'); git(owner, 'commit', '-q', '-m', 'code and sleep');
    git(owner, 'fetch', '-q', 'origin');
    const before = git(owner, 'rev-parse', 'HEAD').trim();
    expect(dropMachineLocalFromPushRange(owner, ctx, 'origin/main')).toBe(false);
    expect(git(owner, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(machineLocalInPushRange(owner, ctx, 'origin/main')).toBe(before);
  });

  it('with no remote ref (a first push to an empty remote) only the tip is checked', () => {
    const { owner, ctx } = team();
    // History holds the old leak; the tip, after a sync, does not.
    git(owner, 'add', '-A'); superStagePass(owner, ctx); git(owner, 'commit', '-q', '-m', 'sync');
    git(owner, 'remote', 'remove', 'origin');
    expect(machineLocalInPushRange(owner, ctx, null)).toBeNull();
    git(owner, 'add', '-f', '--', '_dream_context/state/.sleep.json'); git(owner, 'commit', '-q', '-m', 'by hand');
    expect(machineLocalInPushRange(owner, ctx, null)).toBe(git(owner, 'rev-parse', 'HEAD').trim());
  });
});

describe('M2: the put-back never overwrites a newer write of this Mac', () => {
  const sleepPath = (ctx: string) => join(ctx, 'state', '.sleep.json');
  const change = (incoming: string | null) => [{ path: '_dream_context/state/.sleep.json', deleted: incoming === null, incoming }];

  it('a write made during the window is kept, and the parked copy stays in the park folder', () => {
    const { owner, ctx } = team();
    const parks = parkSessionFiles(owner, ctx, change(null), home);
    expect(parks).toHaveLength(1);
    writeFileSync(sleepPath(ctx), sleepState('a Stop hook wrote this during the merge'));
    restoreSessionPark(ctx, parks, home);
    expect(readFileSync(sleepPath(ctx), 'utf-8')).toContain('a Stop hook wrote this');
    expect(readFileSync(parks![0].backup, 'utf-8')).toContain(OWNER_LINE);
  });

  it('the team\'s version at the path is replaced by this Mac\'s copy', () => {
    const { owner, ctx } = team();
    const theirs = sleepState('the other Mac');
    const blob = execFileSync('git', ['hash-object', '--stdin'], { cwd: owner, input: theirs, encoding: 'utf-8' }).trim();
    const parks = parkSessionFiles(owner, ctx, change(blob), home);
    writeFileSync(sleepPath(ctx), theirs);
    restoreSessionPark(ctx, parks, home);
    expect(readFileSync(sleepPath(ctx), 'utf-8')).toContain(OWNER_LINE);
  });

  it('a park a crashed sync left behind goes back only over nothing', () => {
    const { owner, ctx } = team();
    // Crash right after parking an untracked copy: the path is empty.
    git(owner, 'rm', '-q', '--cached', '--', '_dream_context/state/.sleep.json');
    git(owner, 'commit', '-q', '-m', 'untrack');
    const parks = parkSessionFiles(owner, ctx, change(null), home);
    expect(existsSync(sleepPath(ctx))).toBe(false);
    restoreLeftoverSessionPark(ctx, home);
    expect(readFileSync(sleepPath(ctx), 'utf-8')).toContain(OWNER_LINE);
    // A second crash, and hooks wrote a fresh state before the next sync: it is kept.
    const again = parkSessionFiles(owner, ctx, change(null), home);
    writeFileSync(sleepPath(ctx), sleepState('fresh after the crash'));
    restoreLeftoverSessionPark(ctx, home);
    expect(readFileSync(sleepPath(ctx), 'utf-8')).toContain('fresh after the crash');
    expect(existsSync(again![0].backup)).toBe(true);
    expect(parks).toHaveLength(1);
  });

  it('a settle whose index removal git refuses settles nothing', () => {
    const { owner, ctx } = team();
    writeFileSync(join(owner, '.git', 'index.lock'), '');
    try {
      expect(settleSessionMerge(owner, ctx, change('0'.repeat(40))).size).toBe(0);
    } finally {
      rmSync(join(owner, '.git', 'index.lock'));
    }
  });
});
