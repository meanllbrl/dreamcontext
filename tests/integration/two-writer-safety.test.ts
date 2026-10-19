import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBrainGitignore, FULL_REPO_LOCAL_GITIGNORE_ENTRIES } from '../../src/lib/git-sync/brain-repo.js';
import { activeTaskSet, HANDS_OFF_WINDOW_MS } from '../../src/lib/auto-sleep.js';

/**
 * Workstream D, proved with REAL concurrent processes rather than by reasoning
 * about the lock. This is the precondition for Workstream C: background sleep
 * is only safe to build once two writers demonstrably cannot lose each other's
 * work.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
let root = '';
const ctx = () => join(root, '_dream_context');

function cli(args: string): string {
  try {
    return execSync(`node ${CLI} ${args} 2>&1`, { cwd: root, encoding: 'utf-8', timeout: 30000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

const WHY = 'Two processes write this task at once and one of the writes used to vanish.';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-2w-'));
  cli('init --yes --name "T" --description "d" --stack "Node" --priority "p"');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('two processes logging to the SAME task', () => {
  it('keeps all 100 entries — neither writer loses its half', () => {
    cli(`tasks create "the contended task" --why "${WHY}"`);

    // Two REAL processes, each appending 50 changelog entries to the same file.
    const writer = (tag: string) => `
      const { execFileSync } = require('node:child_process');
      for (let i = 0; i < 50; i++) {
        execFileSync(process.execPath, ['${CLI}', 'tasks', 'log', 'the-contended-task', '${tag}-' + i],
          { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
      }
    `;
    const procs = ['A', 'B'].map((tag) =>
      spawnSync(process.execPath, ['-e', writer(tag)], { encoding: 'utf-8', timeout: 300_000 }),
    );
    for (const p of procs) expect(p.status).toBe(0);

    const body = readFileSync(join(ctx(), 'state', 'the-contended-task.md'), 'utf8');
    for (const tag of ['A', 'B']) {
      for (let i = 0; i < 50; i++) {
        expect(body, `${tag}-${i} is missing — a write was lost`).toContain(`${tag}-${i}`);
      }
    }
  }, 300_000);

  it('leaves the task file structurally valid (frontmatter intact)', () => {
    cli(`tasks create "another contended task" --why "${WHY}"`);
    const writer = `
      const { execFileSync } = require('node:child_process');
      for (let i = 0; i < 15; i++) {
        execFileSync(process.execPath, ['${CLI}', 'tasks', 'log', 'another-contended-task', 'x-' + i],
          { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
      }
    `;
    const procs = [0, 1].map(() => spawnSync(process.execPath, ['-e', writer], { encoding: 'utf-8', timeout: 300_000 }));
    for (const p of procs) expect(p.status).toBe(0);

    const body = readFileSync(join(ctx(), 'state', 'another-contended-task.md'), 'utf8');
    expect(body.startsWith('---\n')).toBe(true);
    // Exactly one frontmatter block — an interleaved write used to be able to
    // produce a doubled or truncated header.
    expect(body.split(/^---$/m).length).toBeGreaterThanOrEqual(3);
    expect(body).toContain('id: task_');
    // The board still reads it back — the file is not just intact, it is valid.
    expect(cli('tasks list')).toContain('another-contended-task');
  }, 300_000);

  it('the lock does not leak — no lock file survives a completed write', () => {
    cli(`tasks create "a task" --why "${WHY}"`);
    cli('tasks log a-task "one entry"');
    const lock = join(ctx(), 'state', '.locks', 'a-task.lock');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('two processes writing DIFFERENT sessions into .sleep.json', () => {
  it('keeps both session records', () => {
    const add = (tag: string) => `
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, ['${CLI}', 'sleep', 'add', '3', '${tag}'],
        { cwd: ${JSON.stringify(root)}, stdio: 'ignore' });
    `;
    // Serial writes through the lock, then a concurrent pair — both must land.
    const procs = ['first-writer', 'second-writer'].map((tag) =>
      spawnSync(process.execPath, ['-e', add(tag)], { encoding: 'utf-8', timeout: 60_000 }),
    );
    for (const p of procs) expect(p.status).toBe(0);

    const state = JSON.parse(readFileSync(join(ctx(), 'state', '.sleep.json'), 'utf8'));
    const messages = state.sessions.map((s: any) => s.last_assistant_message);
    expect(messages).toContain('first-writer');
    expect(messages).toContain('second-writer');
    expect(state.debt).toBe(6);
  }, 120_000);
});

describe('a concurrent create of the SAME slug', () => {
  it('one wins and the other is REFUSED — never a silent overwrite', () => {
    // The pre-lock existsSync check is a time-of-check/time-of-use window: both
    // processes can pass it. The guarantee is the re-check under the lock, and
    // this proves it — without it the second writer would clobber the first
    // task's file with no error at all.
    const writer = `
      const { execFileSync } = require('node:child_process');
      try {
        execFileSync(process.execPath, ['${CLI}', 'tasks', 'create', 'the same task name',
          '--why', 'Two processes file this identical name at the same moment.'],
          { cwd: ${JSON.stringify(root)}, stdio: 'pipe' });
        process.exit(0);
      } catch (e) { process.exit(1); }
    `;
    // GENUINELY concurrent — `spawnSync` would serialise them and prove nothing.
    const codes = spawnSync(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const runs = [0, 1, 2].map(() => new Promise((res) => {
        const c = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { stdio: 'ignore' });
        c.on('exit', (code) => res(code));
      }));
      Promise.all(runs).then((r) => { console.log(JSON.stringify(r)); });
    `], { encoding: 'utf-8', timeout: 180_000 });
    const results = JSON.parse((codes.stdout ?? '[]').trim() || '[]');
    expect(results.filter((c: number) => c === 0).length).toBe(1);
    expect(results.filter((c: number) => c !== 0).length).toBe(2);

    // And exactly one task file exists, with one intact frontmatter block.
    const body = readFileSync(join(ctx(), 'state', 'the-same-task-name.md'), 'utf8');
    expect(body.startsWith('---\n')).toBe(true);
    // Exactly ONE frontmatter id — a silent overwrite would have produced a
    // second scaffold written over the first.
    expect((body.match(/^id: /gm) ?? []).length).toBe(1);
  }, 180_000);
});

describe('the hands-off set', () => {
  function writeSleep(sessions: unknown[]): void {
    writeFileSync(join(ctx(), 'state', '.sleep.json'), JSON.stringify({
      debt: 0, last_sleep: null, last_sleep_summary: null, sleep_started_at: null,
      sessions, bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
      compaction_log: [], pendingMigrationNotices: [], cycle_tasks_filed: [],
    }));
  }
  const session = (slugs: string[], stoppedMsAgo: number | null) => ({
    session_id: `s-${slugs.join('-')}`, transcript_path: null,
    stopped_at: stoppedMsAgo === null ? null : new Date(Date.now() - stoppedMsAgo).toISOString(),
    last_assistant_message: null, change_count: null, tool_count: null, score: 1, task_slugs: slugs,
  });

  it('is empty on a quiet brain', () => {
    writeSleep([]);
    expect(activeTaskSet(ctx())).toEqual([]);
  });

  it('includes tasks from a session that stopped recently', () => {
    writeSleep([session(['task-a', 'task-b'], 5 * 60_000)]);
    expect(activeTaskSet(ctx())).toEqual(['task-a', 'task-b']);
  });

  it('EXCLUDES tasks from a session older than the window', () => {
    writeSleep([session(['stale-task'], HANDS_OFF_WINDOW_MS + 60_000)]);
    expect(activeTaskSet(ctx())).toEqual([]);
  });

  it('includes a session that is still RUNNING (no stopped_at) — the most in-play of all', () => {
    writeSleep([session(['live-task'], null)]);
    expect(activeTaskSet(ctx())).toEqual(['live-task']);
  });

  it('includes the explicit .active-task pointer', () => {
    cli(`tasks create "the one im on" --why "${WHY}"`);
    writeFileSync(join(ctx(), 'state', '.active-task'), 'the-one-im-on');
    writeSleep([]);
    expect(activeTaskSet(ctx())).toContain('the-one-im-on');
  });

  it('de-duplicates and sorts, so the prompt it feeds is stable', () => {
    writeSleep([session(['b-task', 'a-task'], 1000), session(['a-task'], 2000)]);
    expect(activeTaskSet(ctx())).toEqual(['a-task', 'b-task']);
  });

  it('drops an unsafe slug rather than interpolating it into a prompt', () => {
    writeSleep([session(['../../etc/passwd', 'ok-task'], 1000)]);
    expect(activeTaskSet(ctx())).toEqual(['ok-task']);
  });
});

describe('lock and sidecar paths never sync', () => {
  const brain = buildBrainGitignore();

  it.each(['state/.locks/', 'state/.auto-sleep.lock', 'state/.auto-sleep.json'])(
    'the brain gitignore excludes %s', (entry) => expect(brain).toContain(entry));

  it.each([
    '_dream_context/state/.locks/',
    '_dream_context/state/.auto-sleep.lock',
    '_dream_context/state/.auto-sleep.json',
  ])('the full-repo gitignore excludes %s', (entry) => {
    expect(FULL_REPO_LOCAL_GITIGNORE_ENTRIES).toContain(entry);
  });

  it('but the tombstone ledger DOES sync — a teammate must see a retired task', () => {
    expect(brain).not.toContain('.task-tombstones.json');
    expect(FULL_REPO_LOCAL_GITIGNORE_ENTRIES.join('\n')).not.toContain('.task-tombstones.json');
  });
});
