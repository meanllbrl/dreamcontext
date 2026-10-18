import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { runBacklogStep } from '../../src/lib/backlog-migration.js';
import { appendLedger, readLedger } from '../../src/lib/migration-ledger.js';

/**
 * The agent half of the 0.33.0 task migration through the real CLI: what a
 * sleep-migration agent runs (as an agent: CLAUDECODE set), and the record
 * guard that keeps the ledger honest.
 */

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
const AGENT = { CLAUDECODE: '1' };

let dir: string;
let ctx: string;
let stateDir: string;

function run(cmd: string, env: NodeJS.ProcessEnv = {}): { out: string; code: number } {
  const base = { ...process.env };
  delete base.CLAUDECODE;
  delete base.DREAMCONTEXT_AUTOMATION_RUN;
  try {
    const out = execSync(`node ${CLI} ${cmd} 2>&1`, { cwd: dir, encoding: 'utf-8', timeout: 20000, env: { ...base, ...env } });
    return { out, code: 0 };
  } catch (e: any) {
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

function card(slug: string, extra: string[] = []): void {
  writeFileSync(join(stateDir, `${slug}.md`), [
    '---', `id: task_${slug}`, `name: ${slug.replace(/-/g, ' ')}`, `description: ${slug.replace(/-/g, ' ')}`,
    'status: todo', "created_at: '2026-09-01'", "updated_at: '2026-10-01'", ...extra, '---', '', '## Why', '', 'Because.', '',
  ].join('\n'));
}
const fm = (slug: string) => readFileSync(join(stateDir, `${slug}.md`), 'utf-8');

beforeEach(() => {
  const raw = join(tmpdir(), `dc-backlog-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  dir = realpathSync(raw);
  ctx = join(dir, '_dream_context');
  stateDir = join(ctx, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'overrides'), { recursive: true });
  writeFileSync(join(ctx, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
  writeFileSync(join(ctx, 'core', 'RELEASES.json'), JSON.stringify([
    { id: 'rel_b', version: 'BACKLOG', date: '', summary: '', status: 'planning', tasks: [] },
  ], null, 2));
  card('export-csv', ['version: v0.32.0']);
  card('export-pdf', ['version: v0.32.0']);
  card('export-xlsx-later', ['version: BACKLOG']);
  card('dup-export-csv');
  card('dead-checklist-v0-28-0');
  mkdirSync(join(ctx, 'knowledge', 'features'), { recursive: true });
  writeFileSync(join(ctx, 'knowledge', 'features', 'exports.md'), ['---', 'name: exports', 'type: feature', 'related_tasks: []', '---', ''].join('\n'));
  runBacklogStep(ctx);
  appendLedger(ctx, { version: '0.33.0', step: 'retire-planning-and-place-open-tasks', executor: 'code', timestamp: '', filesTouched: [], summary: '' });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('migrations backlog (CLI)', () => {
  it('lists what waits, takes decisions from an agent, groups a family, reports, and only then records', () => {
    // (`migrations pending` lists it once the CLI itself is 0.33.0 — the release
    // gate every registry migration has; the unit tests cover that list.)
    const show = run('migrations backlog show --pending', AGENT);
    expect(show.out).toContain('Waiting for an outcome (5)');
    expect(show.out).toContain('export-xlsx-later');
    expect(show.out).toMatch(/Features \(the areas a task can belong to, 1\)\s+exports/);

    // Recording early is refused: work remains.
    const early = run('migrations record --version 0.33.0 --step reorganize-open-tasks --executor agent --summary x', AGENT);
    expect(early.code).toBe(1);
    expect(early.out).toContain('still has work');
    expect(readLedger(ctx).some((e) => e.executor === 'agent')).toBe(false);

    const noCriterion = run('migrations backlog parent "Exports reach every format" --why "One deliverable." --children export-csv,export-pdf', AGENT);
    expect(noCriterion.code).toBe(1);
    expect(noCriterion.out).toContain('--criterion');
    const parent = run('migrations backlog parent "Exports reach every format" --why "One deliverable." --criterion "Every format exports" --children export-csv,export-pdf --feature exports', AGENT);
    expect(parent.code).toBe(0);
    const slug = /Created (\S+)/.exec(parent.out)![1];
    expect(fm('export-csv')).toContain(`parent_task: ${slug}`);
    expect(fm('export-csv')).toContain('related_feature: exports');
    expect(fm(slug)).toContain('- [ ] Every format exports');

    expect(run('migrations backlog decide dup-export-csv merge --into export-csv --reason "same work"', AGENT).code).toBe(0);
    expect(fm('dup-export-csv')).toContain('status: cancelled');
    expect(fm('dup-export-csv')).toContain('absorbed_by: export-csv');

    const noReason = run('migrations backlog decide dead-checklist-v0-28-0 cancel', AGENT);
    expect(noReason.code).toBe(1);
    expect(run('migrations backlog decide dead-checklist-v0-28-0 cancel --reason "0.28.0 is published"', AGENT).code).toBe(0);
    // An agent's keep carries its own reason.
    const bare = run('migrations backlog decide export-xlsx-later keep --feature exports', AGENT);
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('needs --reason');
    // Not sure: kept as it is, the change waits for the owner on the Tasks screen.
    const proposed = run('migrations backlog propose export-xlsx-later cancel --why "No one touched it since BACKLOG was a version."', AGENT);
    expect(proposed.code).toBe(0);
    expect(proposed.out).toContain('waits for the owner');
    expect(fm('export-xlsx-later')).toContain('status: todo');

    const report = run('migrations backlog report', AGENT);
    expect(report.out).toMatch(/top-level\s+5 → 2/);
    expect(report.out).toContain('keep 4 · merge 1 · cancel 1 · waiting 0');
    expect(report.out).toContain('agent 6');
    expect(report.out).toContain('retired     planning BACKLOG');
    expect(report.out).toContain('proposals   1 waiting on the Tasks screen');
    expect(report.out).toMatch(/by feature\s+5 → 2 groups/);

    const grouped = run('tasks list -g parent', AGENT);
    expect(grouped.out).toContain(slug);
    expect(grouped.out).toContain('2 top-level item(s): 1 family + 1 standalone task(s)');
    const byArea = run('tasks list -g feature', AGENT);
    expect(byArea.out).toContain('exports');
    expect(byArea.out).toContain('(no feature)');

    expect(run('migrations record --version 0.33.0 --step reorganize-open-tasks --executor agent --summary done', AGENT).code).toBe(0);
  }, 90_000);

  it('a decision taken in a person\'s shell is the owner\'s, and an agent cannot overrule it', () => {
    expect(run('migrations backlog decide export-csv keep').code).toBe(0);
    expect(run('migrations backlog show --json').out).toContain('"by": "owner"');
    const overrule = run('migrations backlog decide export-csv cancel --reason x', AGENT);
    expect(overrule.code).toBe(1);
    expect(overrule.out).toContain('owner already decided');
  }, 30_000);
});
