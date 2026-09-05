import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * B, end to end through the REAL binary: the bar, the cap, the tombstone and
 * the `--into` marker. Unit tests prove the predicate; this proves the wiring —
 * that `tasks create` actually consults it and actually refuses.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
let root = '';

function cli(args: string): { out: string; code: number } {
  try {
    return { out: execSync(`node ${CLI} ${args} 2>&1`, { cwd: root, encoding: 'utf-8', timeout: 30000 }), code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

const taskFile = (slug: string) => join(root, '_dream_context', 'state', `${slug}.md`);
const sleepPath = () => join(root, '_dream_context', 'state', '.sleep.json');

/** Stamp the epoch the way `sleep start` does. `.sleep.json` is written lazily
 *  (the hooks create it), so a fresh brain may not have one yet. */
function startCycle(): void {
  const base = existsSync(sleepPath()) ? JSON.parse(readFileSync(sleepPath(), 'utf8')) : {
    debt: 0, last_sleep: null, last_sleep_summary: null,
    sessions: [], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [],
    compaction_log: [], pendingMigrationNotices: [],
  };
  base.sleep_started_at = new Date().toISOString();
  base.cycle_tasks_filed = [];
  writeFileSync(sleepPath(), JSON.stringify(base, null, 2));
}

const WHY = 'Users lose the draft when the tab reloads because nothing persists it before unload.';
/** Non-empty (the CLI has always required that) but under the sleep bar's floor. */
const THIN_WHY = 'tidy this up';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-bar-e2e-'));
  cli('init --yes --name "T" --description "d" --stack "Node" --priority "p"');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('tasks create under a live sleep cycle', () => {
  it('files freely when no cycle is running', () => {
    const r = cli(`tasks create "a normal task" --why "${THIN_WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile('a-normal-task'))).toBe(true);
  });

  it('REFUSES an unjustified task during a cycle, and writes no file', () => {
    startCycle();
    const r = cli(`tasks create "some vague chore" --why "${THIN_WHY}"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('at least 40 characters');
    expect(existsSync(taskFile('some-vague-chore'))).toBe(false);
  });

  it('accepts the same task WITH a real justification', () => {
    startCycle();
    const r = cli(`tasks create "a justified task" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(0);
    expect(existsSync(taskFile('a-justified-task'))).toBe(true);
  });

  it('lets a HUMAN through mid-cycle, and tells an unknown caller how', () => {
    startCycle();
    expect(cli(`tasks create "my own task" --by human --why "${THIN_WHY}"`).code).toBe(0);
    expect(cli(`tasks create "another vague one" --why "${THIN_WHY}"`).out).toContain('--by human');
  });

  it('counts filed tasks against the cap and then refuses', () => {
    cli('sleep config set max-new-tasks 2');
    startCycle();
    expect(cli(`tasks create "first one" --by sleep --why "${WHY}"`).code).toBe(0);
    expect(cli(`tasks create "second one" --by sleep --why "${WHY}"`).code).toBe(0);
    const third = cli(`tasks create "third one" --by sleep --why "${WHY}"`);
    expect(third.code).toBe(1);
    expect(third.out).toContain('2/2');
    expect(existsSync(taskFile('third-one'))).toBe(false);
  });

  it('a human is not counted against the cap', () => {
    cli('sleep config set max-new-tasks 1');
    startCycle();
    cli(`tasks create "human one" --by human --why "${THIN_WHY}"`);
    cli(`tasks create "human two" --by human --why "${THIN_WHY}"`);
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual([]);
  });

  it('the counter is cleared when the cycle ends', () => {
    startCycle();
    cli(`tasks create "counted" --by sleep --why "${WHY}"`);
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual(['counted']);
    cli('sleep done "wrapped up"');
    expect(JSON.parse(readFileSync(sleepPath(), 'utf8')).cycle_tasks_filed).toEqual([]);
  });
});

describe('the pre-existing why requirement', () => {
  it('refuses an empty why with a NON-ZERO exit, so a script can tell', () => {
    const r = cli('tasks create "no reason given"');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Every task must say why it exists');
    expect(existsSync(taskFile('no-reason-given'))).toBe(false);
  });
});

describe('tombstones through the CLI', () => {
  it('deleting a task records it, and `tombstones` lists it', () => {
    cli(`tasks create "a doomed task" --why "${WHY}"`);
    cli('tasks delete "a doomed task" --yes');
    const out = cli('tasks tombstones').out;
    expect(out).toContain('a-doomed-task');
    expect(out).toContain('dropped, not merged');
  });

  it('--into records where the work went', () => {
    cli(`tasks create "the real home" --why "${WHY}"`);
    cli(`tasks create "a duplicate chore" --why "${WHY}"`);
    const del = cli('tasks delete "a duplicate chore" --yes --into "the real home"');
    expect(del.code).toBe(0);
    expect(del.out).toContain('absorbed by the-real-home');
    expect(cli('tasks tombstones').out).toContain('→ absorbed by the-real-home');
  });

  it('--into refuses a target that does not exist, and deletes nothing', () => {
    cli(`tasks create "a task" --why "${WHY}"`);
    const r = cli('tasks delete "a task" --yes --into "no-such-task"');
    expect(r.code).toBe(1);
    expect(existsSync(taskFile('a-task'))).toBe(true);
  });

  it('THE REGRESSION: a merged-away slug cannot be re-filed by a cycle', () => {
    cli(`tasks create "the real home" --why "${WHY}"`);
    cli(`tasks create "a duplicate chore" --why "${WHY}"`);
    cli('tasks delete "a duplicate chore" --yes --into "the real home"');

    startCycle();
    const r = cli(`tasks create "a duplicate chore" --by sleep --why "${WHY}"`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the-real-home');
    expect(existsSync(taskFile('a-duplicate-chore'))).toBe(false);
  });

  it('a rename leaves a marker pointing at the new slug', () => {
    cli(`tasks create "the old name" --why "${WHY}"`);
    cli('tasks rename "the old name" "the new name"');
    expect(cli('tasks tombstones').out).toContain('the-old-name');
    expect(cli('tasks tombstones').out).toContain('absorbed by the-new-name');
  });

  it('the tombstone ledger is brain CONTENT — it is not gitignored', () => {
    cli(`tasks create "x" --why "${WHY}"`);
    cli('tasks delete "x" --yes');
    const gi = join(root, '_dream_context', '.gitignore');
    if (existsSync(gi)) expect(readFileSync(gi, 'utf8')).not.toContain('.task-tombstones.json');
    expect(existsSync(join(root, '_dream_context', 'state', '.task-tombstones.json'))).toBe(true);
  });
});
