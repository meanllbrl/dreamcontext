/**
 * After three rejects of the same kind, the next sleep round neither files nor
 * proposes that candidate (C4, the learning loop end to end).
 *
 * Fixed transcript fixtures (tests/fixtures/sleep-filing/round-1..4.jsonl), one
 * per sleep round. In rounds 1-3 the owner asks, in passing, for a README
 * touch-up; sleep proposes it (quoting the owner's turn) and the owner rejects
 * it on the Tasks screen as too small. Sleep then distils a rule from the three
 * rejects. In round 4 the owner asks for the same kind of thing again: neither
 * `tasks create --by sleep --basis ask` nor `tasks propose` will take it, and the
 * refusal points at a criterion. A different ask in the same round is not
 * blocked by the lesson (the brake, 3/3 rejected, sends it to proposals).
 *
 * Sleep's judgement (which candidates a transcript holds) is the agent's; what
 * this test pins is everything the CLI decides once a candidate reaches it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { handleTaskProposalReject } from '../../src/server/routes/task-proposals.js';
import { readProposals } from '../../src/lib/task-proposals.js';
import { readFeedback } from '../../src/lib/task-feedback.js';
import { readRules, rulesForBrief } from '../../src/lib/task-filing-rules.js';

const FIXTURES = resolve(__dirname, '../fixtures/sleep-filing');

let projectRoot: string;
let root: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const saved: Record<string, string | undefined> = {};
const ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP', 'DREAMCONTEXT_FILING_BAR_SEMANTIC'];

async function cli(...argv: string[]): Promise<number> {
  process.exitCode = undefined;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', ...argv]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

/** `sleep start` for one round: a fresh epoch over that round's fixture session. */
function startRound(n: number): void {
  writeFileSync(join(stateDir, '.sleep.json'), JSON.stringify({
    debt: 10, last_sleep: null, last_sleep_summary: null,
    sleep_started_at: new Date(Date.now() + n).toISOString(),
    last_consolidated_at: null,
    sessions: [{
      session_id: `round-${n}`, transcript_path: join(FIXTURES, `round-${n}.jsonl`), stopped_at: null,
      last_assistant_message: null, change_count: 1, tool_count: 1, score: 3, task_slugs: [],
    }],
    bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [],
  }, null, 2));
}

/** What the owner does on the Tasks screen: one tap on the "too small" chip. */
async function ownerRejects(id: string): Promise<void> {
  const req = Readable.from([Buffer.from(JSON.stringify({ reason: 'too-small' }))]) as unknown as IncomingMessage;
  Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' } });
  let code = 0;
  const res = { writeHead(c: number) { code = c; return res; }, end() { return res; }, setHeader() { return res; } } as unknown as ServerResponse;
  await handleTaskProposalReject(req, res, { id }, root);
  expect(code).toBe(200);
}

/** The candidates sleep draws from each round: name, Why, and the owner's own words. */
const README_CANDIDATES = [
  { name: 'Document the --since flag in the README', why: 'The README does not mention the new --since flag for tasks list, so users never find it.', quote: 'the readme should document the new --since flag for tasks list' },
  { name: 'Document the new column name in the README', why: 'The README does not mention the new column name Someday, so users never find it.', quote: 'the readme needs the column rename documented too' },
  { name: 'Document the proposals --json flag in the README', why: 'The README does not mention the new --json flag for tasks proposals, so users never find it.', quote: 'please put the --json flag for proposals in the readme as well' },
];
const ROUND_4 = {
  readme: { name: 'Document the --quiet flag in the README', why: 'The README does not mention the new --quiet flag for sleep done, so users never find it.', quote: 'please update the readme to document the new --quiet flag for sleep done' },
  retry: { name: 'Export retries when the network drops', why: 'The export died twice on the train when the network dropped, and the owner had to start it again by hand.', quote: 'please make the export retry when the network drops' },
};

beforeEach(() => {
  const raw = join(tmpdir(), `dc-learn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC = '0';
  prevCwd = process.cwd();
  process.chdir(projectRoot);
  logs = [];
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  process.chdir(prevCwd);
  for (const k of ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('three rejects of one kind teach the next sleep round', () => {
  it('rounds 1-3 propose and get rejected; round 4 neither files nor proposes that kind, and a different ask still files', async () => {
    // Rounds 1-3: sleep reads the rules, proposes the README touch-up quoting the
    // owner's turn, and the owner rejects it as too small.
    for (let n = 1; n <= 3; n++) {
      startRound(n);
      expect(await cli('tasks', 'rules')).toBe(0);
      const c = README_CANDIDATES[n - 1];
      expect(await cli('tasks', 'propose', c.name, '-w', c.why, '--quote', c.quote)).toBe(0);
      const p = readProposals(root).proposals.find((x) => x.name === c.name)!;
      expect(p.session).toBe(`round-${n}`);
      await ownerRejects(p.id);
    }
    const rejects = readFeedback(root).filter((e) => e.verdict === 'reject');
    expect(rejects.map((e) => e.reason)).toEqual(['too-small', 'too-small', 'too-small']);

    // End of round 3: sleep distils the three rejects into a rule.
    expect(await cli('tasks', 'rules', 'set',
      '--title', 'A README touch-up is a criterion on the task that shipped the change',
      '--dont', 'Document the --since flag in the README (filed as its own task)',
      '--do', 'Add "README documents the flag" as a criterion on the task that shipped it',
      '--rests-on', rejects.map((e) => e.id).join(','))).toBe(0);
    expect(readRules(root)[0].restsOn).toHaveLength(3);

    // Round 4: a fresh epoch, so the rules must be read again before anything is filed.
    startRound(4);
    logs = [];
    expect(await cli('tasks', 'propose', ROUND_4.readme.name, '-w', ROUND_4.readme.why, '--quote', ROUND_4.readme.quote)).toBe(1);
    expect(logs.join('\n')).toMatch(/Read the task-filing rules/);
    expect(await cli('tasks', 'rules')).toBe(0);
    expect(rulesForBrief(root)).toContain('A README touch-up is a criterion');

    // The same kind of candidate: neither filed nor proposed, and pointed at a criterion.
    logs = [];
    expect(await cli('tasks', 'create', ROUND_4.readme.name, '--by', 'sleep', '-w', ROUND_4.readme.why, '--basis', 'ask', '--quote', ROUND_4.readme.quote)).toBe(1);
    expect(logs.join('\n')).toMatch(/rejected 3 candidates like this as too small/);
    expect(logs.join('\n')).toMatch(/acceptance_criteria/);
    logs = [];
    expect(await cli('tasks', 'propose', ROUND_4.readme.name, '-w', ROUND_4.readme.why, '--quote', ROUND_4.readme.quote)).toBe(1);
    expect(logs.join('\n')).toMatch(/rejected 3 candidates like this as too small/);
    expect(existsSync(join(stateDir, 'document-the-quiet-flag-in-the-readme.md'))).toBe(false);
    expect(readProposals(root).proposals.some((p) => p.name === ROUND_4.readme.name)).toBe(false);

    // A different ask in the same fixture round is untouched by the lesson. Three
    // of sleep's last three items were rejected, so the brake has also turned
    // direct filing off: the ask goes to the owner as a proposal instead.
    logs = [];
    expect(await cli('tasks', 'create', ROUND_4.retry.name, '--by', 'sleep', '-w', ROUND_4.retry.why, '--basis', 'ask', '--quote', ROUND_4.retry.quote)).toBe(1);
    expect(logs.join('\n')).toMatch(/Direct filing is off: the owner rejected 3 of sleep's last 3 items/);
    expect(await cli('tasks', 'propose', ROUND_4.retry.name, '-w', ROUND_4.retry.why, '--quote', ROUND_4.retry.quote, '--basis', 'ask')).toBe(0);
    expect(readProposals(root).proposals[0]).toMatchObject({ name: ROUND_4.retry.name, basis: 'ask', session: 'round-4', status: 'pending' });
  });

  it('round 4 cannot launder the hook-context line into an ask', async () => {
    startRound(4);
    await cli('tasks', 'rules');
    logs = [];
    expect(await cli('tasks', 'create', 'Update the readme for the quiet flag', '--by', 'sleep',
      '-w', 'The README is missing the new --quiet flag and users cannot find it at all.',
      '--basis', 'ask', '--quote', 'update the readme for the new --quiet flag (from task docs)')).toBe(1);
    expect(logs.join('\n')).toMatch(/It appears only in: hook context/);
  });
});
