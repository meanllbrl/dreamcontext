/**
 * Writer inventory: EVERY path that writes task history goes to the journal, and
 * a migrated card never regains `## Changelog` through any of them.
 *
 * One test per writer named by the plan (A3/A5): `tasks log`, `tasks status` /
 * `complete` / `handoff`, `tasks insert changelog`, the dashboard changelog and
 * insert routes, agent assignment (status + result), dedup, the agent shelf's
 * reader, a GitHub pull, and the git merge driver. Each starts from a MIGRATED
 * card (legacy Changelog folded into the journal) and asserts both halves: the
 * entry landed in the journal, and the card has no Changelog.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { foldCardChangelog } from '../../src/lib/task-card.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { applyAssignmentStatus, logAssignmentResult } from '../../src/lib/agents/task-assignment.js';
import { applyDedup, planDedup } from '../../src/lib/task-backend/dedup.js';
import { computeTaskProgress } from '../../src/server/routes/agent-shelf.js';
import { handleTasksChangelog, handleTasksInsert } from '../../src/server/routes/tasks.js';
import { mergeTaskJournal, mergeTaskMd } from '../../src/lib/git-sync/semantic-merge.js';
import { ApiAdapter } from '../../src/lib/task-backend/api-adapter.js';
import { GitHubTaskBackend } from '../../src/lib/task-backend/github.js';
import { makeFakeGitHub } from './github-fake.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';

let projectRoot: string;
let contextRoot: string;
let stateDir: string;
let prevCwd: string;

const LEGACY_CARD = (slug: string, name: string) => [
  '---', `id: task_${slug.replace(/-/g, '').slice(0, 8)}`, `name: ${name}`, 'status: todo',
  'created_at: "2026-10-01"', 'updated_at: "2026-10-01"', '---', '',
  '## Why', '<!-- What problem does this solve? What breaks if we don\'t do it? Be concrete — name the user, the friction, the cost. -->', '',
  'Because it matters.', '',
  '## Acceptance Criteria', '', '- [ ] It works', '',
  '## Changelog', '<!-- LIFO: newest at top. Auto-prepended by `dreamcontext tasks log`. -->', '',
  '### 2026-10-02 - Session Update', '- legacy progress', '### 2026-10-01 - Created', '- Task created.', '',
].join('\n');

function card(slug: string): string {
  return readFileSync(join(stateDir, `${slug}.md`), 'utf-8');
}
function journalBodies(slug: string): string {
  return readJournal(stateDir, slug).map((e) => e.body).join('\n');
}
/** A legacy card, then the fold the migration runs: history in the journal, card lean. */
function migratedCard(slug: string, name = 'Fix login'): void {
  writeFileSync(join(stateDir, `${slug}.md`), LEGACY_CARD(slug, name));
  foldCardChangelog(join(stateDir, `${slug}.md`));
  expect(card(slug)).not.toContain('## Changelog');
  expect(journalBodies(slug)).toContain('legacy progress');
}
function expectLean(slug: string): void {
  expect(card(slug)).not.toMatch(/^##\s+Changelog/m);
  expect(journalBodies(slug)).toContain('legacy progress');
}

async function cli(...argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
}

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { headers: {}, method: 'POST' });
  return req;
}
function makeRes(): ServerResponse & { statusCode: number } {
  const res = {
    statusCode: 0,
    writeHead(code: number) { res.statusCode = code; return res; },
    end() { return res; },
    setHeader() { return res; },
  };
  return res as unknown as ServerResponse & { statusCode: number };
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-writers-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectRoot);
});
afterEach(() => {
  process.exitCode = undefined;
  process.chdir(prevCwd);
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('every history writer lands in the journal; a migrated card never regains a Changelog', () => {
  it('tasks log', async () => {
    migratedCard('fix-login');
    await cli('tasks', 'log', 'fix-login', 'wrote the parser');
    expectLean('fix-login');
    expect(readJournal(stateDir, 'fix-login')[0]).toMatchObject({ kind: 'log', body: '- wrote the parser' });
  });

  it('tasks status, complete and handoff', async () => {
    migratedCard('fix-login');
    await cli('tasks', 'status', 'fix-login', 'in_progress', 'picked up');
    expect(readJournal(stateDir, 'fix-login')[0]).toMatchObject({ kind: 'status' });
    await cli('tasks', 'handoff', 'fix-login',
      '--done', 'Parser done and green: 14 unit tests pass.', '--next', 'Write the serializer in src/writer.ts.',
      '--decisions', 'Kept the tokenizer streaming.', '--learned', 'none',
      '--style', 'npm test after every edit.', '--files', 'src/writer.ts:40');
    expect(journalBodies('fix-login')).toContain('**Done:** Parser done and green');
    expectLean('fix-login');
  });

  it('tasks insert changelog (CLI)', async () => {
    migratedCard('fix-login');
    await cli('tasks', 'insert', 'fix-login', 'changelog', 'inserted line');
    expectLean('fix-login');
    expect(journalBodies('fix-login')).toContain('- inserted line');
  });

  it('dashboard changelog and insert routes', async () => {
    migratedCard('fix-login');
    const r1 = makeRes();
    await handleTasksChangelog(makeReq({ content: 'from the dashboard' }), r1, { slug: 'fix-login' }, contextRoot);
    expect(r1.statusCode).toBe(200);
    const r2 = makeRes();
    await handleTasksInsert(makeReq({ section: 'changelog', content: 'inserted from the dashboard' }), r2, { slug: 'fix-login' }, contextRoot);
    expect(r2.statusCode).toBe(200);
    expectLean('fix-login');
    expect(journalBodies('fix-login')).toContain('from the dashboard');
    expect(journalBodies('fix-login')).toContain('inserted from the dashboard');
  });

  it('agent assignment: the status move and the run result', () => {
    migratedCard('fix-login');
    applyAssignmentStatus(contextRoot, 'fix-login', { slug: 'scout', title: 'Scout' });
    logAssignmentResult(contextRoot, 'fix-login', { slug: 'scout', title: 'Scout' }, { status: 'ok', outputPath: null, runId: 'r1' });
    expectLean('fix-login');
    const [result, moved] = readJournal(stateDir, 'fix-login');
    expect(result).toMatchObject({ kind: 'log', actor: 'agent:scout' });
    expect(moved).toMatchObject({ kind: 'status', label: 'in_progress' });
  });

  it('dedup merges the family journals into the canonical one', () => {
    migratedCard('fix-login');
    migratedCard('fix-login-2');
    writeFileSync(join(stateDir, 'fix-login-2.md'), card('fix-login-2').replace(/^id: .*$/m, 'id: task_other22').replace('updated_at: "2026-10-01"', 'updated_at: "2026-10-09"'));
    const plan = planDedup(contextRoot);
    expect(plan.families.length).toBe(1);
    applyDedup(contextRoot, plan);
    const keep = plan.families[0].canonicalSlug;
    expectLean(keep);
    // The two copies of the same legacy entries collapse to one.
    expect(readJournal(stateDir, keep).filter((e) => e.body === '- legacy progress')).toHaveLength(1);
  });

  it('the agent shelf reads its newest entry from the journal', async () => {
    migratedCard('fix-login');
    await cli('tasks', 'log', 'fix-login', 'newest thing');
    const progress = computeTaskProgress(contextRoot, 'fix-login') as { last: string | null };
    expect(progress.last).toBe('newest thing');
    expectLean('fix-login');
  });

  it('a GitHub pull folds remote comments into the journal, never the card', async () => {
    const fake = makeFakeGitHub();
    const config: SetupConfig = {
      platforms: [], packs: [], multiProduct: false, setupVersion: '0.0.0', disableNativeMemory: true,
      taskBackend: 'github', cloudTaskManagement: true,
      github: { owner: 'meanllbrl', repo: 'dreamcontext', changelogTarget: 'comments' },
    };
    let clock = 1000;
    const now = () => (clock += 7);
    const sleep = async () => { clock += 1; };
    const adapter = new ApiAdapter({
      baseUrl: 'https://api.github.com', authHeaders: () => ({ Authorization: 'Bearer ghp_test' }),
      fetchImpl: fake.fetchImpl, now, sleep,
    });
    const backend = new GitHubTaskBackend(contextRoot, config, { adapter, now, sleep });
    await backend.create({ name: 'Pulled', variant: 'cli' });
    await backend.sync('push');
    const number = [...fake.issues.keys()][0];
    fake.addRemoteComment(number, '### 2026-10-05 - Note\n- teammate said hi', 'alice');
    await backend.sync('pull');
    expect(card('pulled')).not.toMatch(/^##\s+Changelog/m);
    expect(readJournal(stateDir, 'pulled')[0]).toMatchObject({ kind: 'remote', actor: 'remote:alice' });
  });

  it('the git merge driver: card merge never adds a Changelog, journal merge unions', () => {
    migratedCard('fix-login');
    const base = card('fix-login');
    const ours = base.replace('Because it matters.', 'Because it matters a lot.');
    expect(mergeTaskMd(base, ours, base).merged).not.toMatch(/^##\s+Changelog/m);
    const j = readFileSync(join(stateDir, 'journal', 'fix-login.md'), 'utf-8');
    const theirs = `### 2026-10-16 09:00 - log [je_theirs0001]\n- theirs\n\n${j}`;
    expect(mergeTaskJournal(j, j, theirs).merged).toContain('- theirs');
  });

  it('an old CLI that writes a Changelog back onto the card is folded on the next write', async () => {
    migratedCard('fix-login');
    writeFileSync(join(stateDir, 'fix-login.md'), `${card('fix-login')}\n## Changelog\n\n### 2026-10-10 - Session Update\n- written by an old CLI\n`);
    await cli('tasks', 'log', 'fix-login', 'new CLI line');
    expectLean('fix-login');
    expect(journalBodies('fix-login')).toContain('written by an old CLI');
    expect(existsSync(join(stateDir, 'journal', 'fix-login.md'))).toBe(true);
  });
});
