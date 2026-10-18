/**
 * The proposals inbox and the tasks sleep files itself (C4), through the CLI.
 *
 * propose → proposals → accept / reject; accept is the owner's (refused from an
 * agent environment) and lands the task in the Next queue; every reject carries
 * a reason, goes to the feedback file and the declined store. A task sleep
 * files directly is recorded (created_by, filing_basis, the ledger), never
 * planned into a cycle, and can be kept or rejected (cancelled) the same way.
 * `sleep done` prints the counts and the cycle-ending warning.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { cycleEndingWarning, taskFilingLines } from '../../src/cli/commands/sleep.js';
import { readFeedback } from '../../src/lib/task-feedback.js';
import {
  acceptProposal,
  dropFiled,
  filingBrake,
  ProposalError,
  readProposals,
  recordFiled,
  rejectFiled,
  rejectProposal,
  storableQuote,
} from '../../src/lib/task-proposals.js';
import { loadStatuses } from '../../src/lib/overrides.js';
import { readDeclined } from '../../src/lib/task-declined.js';
import { readJournal } from '../../src/lib/task-journal.js';
import { newCycle, startCycle } from '../../src/lib/cycles.js';
import { DEFAULT_STATUSES } from '../../src/lib/task-status.js';
import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';
import { stampRulesRead } from '../../src/lib/task-filing-rules.js';

let projectRoot: string;
let root: string;
let stateDir: string;
let prevCwd: string;
let logs: string[];
const origLog = console.log;
const origErr = console.error;
const AGENT_ENVS = ['CLAUDECODE', 'DREAMCONTEXT_AGENT_SELF', 'DREAMCONTEXT_AUTOMATION_RUN', 'DREAMCONTEXT_AUTO_SLEEP'];
const saved: Record<string, string | undefined> = {};

const ASK = 'please make the export retry on a network error';
const WHY = 'Exports fail on a flaky network and the owner has to start them again by hand every time.';

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
const said = (re: RegExp) => logs.some((l) => re.test(l));
const fm = (slug: string) => readFileSync(join(stateDir, `${slug}.md`), 'utf-8');

beforeEach(() => {
  const raw = join(tmpdir(), `dc-prop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  root = join(projectRoot, '_dream_context');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(join(root, 'overrides', 'task.md'), [
    '---', 'statuses:', '  - { name: Cancelled, key: cancelled, kind: cancelled, order: 99 }', '---', '',
  ].join('\n'));
  // One owner session being consolidated by a live sleep.
  const transcript = join(projectRoot, 'owner.jsonl');
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: `${ASK}, it keeps dying on the train wifi` } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'we could also show export progress in the toolbar' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(join(stateDir, '.sleep.json'), JSON.stringify({
    debt: 10, last_sleep: null, last_sleep_summary: null, sleep_started_at: new Date().toISOString(),
    last_consolidated_at: null, sessions: [{
      session_id: 'owner-1', transcript_path: transcript, stopped_at: null, last_assistant_message: null,
      change_count: 1, tool_count: 1, score: 3, task_slugs: [],
    }], bookmarks: [], triggers: [], knowledge_access: {}, dashboard_changes: [], compaction_log: [],
  }, null, 2));
  // Sleep read the task-filing rules this cycle (enforced while a sleep runs).
  stampRulesRead(root);
  for (const k of AGENT_ENVS) { saved[k] = process.env[k]; delete process.env[k]; }
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
  process.exitCode = undefined;
  process.chdir(prevCwd);
  for (const k of AGENT_ENVS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  delete process.env.DREAMCONTEXT_FILING_BAR_SEMANTIC;
  rmSync(projectRoot, { recursive: true, force: true });
});

async function proposeOne(name = 'Show export progress in the toolbar'): Promise<string> {
  expect(await cli('tasks', 'propose', name, '-w', WHY, '--quote', 'show export progress in the toolbar')).toBe(0);
  return readProposals(root).proposals[0].id;
}

describe('propose → proposals → accept', () => {
  it('stores a proposal with its quote and session; refuses a fabricated quote and a twin', async () => {
    const id = await proposeOne();
    const p = readProposals(root).proposals[0];
    expect(p).toMatchObject({ id, status: 'pending', basis: 'discussion', session: 'owner-1', by: 'sleep' });
    expect(await cli('tasks', 'propose', 'Show export progress in the toolbar', '-w', WHY, '--quote', 'show export progress in the toolbar')).toBe(1);
    expect(said(/Already proposed/)).toBe(true);
    expect(await cli('tasks', 'propose', 'Something else', '-w', WHY, '--quote', 'nobody ever said these words here')).toBe(1);
    logs = [];
    expect(await cli('tasks', 'proposals')).toBe(0);
    expect(said(new RegExp(id))).toBe(true);
  });

  it('accept is refused from an agent environment', async () => {
    const id = await proposeOne();
    process.env.CLAUDECODE = '1';
    expect(await cli('tasks', 'accept', id)).toBe(1);
    expect(said(/owner's step/)).toBe(true);
    expect(readProposals(root).proposals[0].status).toBe('pending');
  });

  it('the owner\'s accept lands the task in the Next queue, created_by human, with the edit as a diff', async () => {
    const id = await proposeOne();
    expect(await cli('tasks', 'accept', id, '--name', 'Export shows its progress')).toBe(0);
    const card = fm('export-shows-its-progress');
    expect(card).toMatch(/^queue: next$/m);
    expect(card).toMatch(/^created_by: human$/m);
    expect(card).not.toMatch(/^cycle:/m);
    expect(readProposals(root).proposals[0]).toMatchObject({ status: 'accepted', slug: 'export-shows-its-progress' });
    const fb = readFeedback(root)[0];
    expect(fb).toMatchObject({ id, verdict: 'keep', source: 'proposal' });
    expect(fb.diff?.name).toEqual({ from: 'Show export progress in the toolbar', to: 'Export shows its progress' });
    const journal = readJournal(stateDir, 'export-shows-its-progress');
    expect(journal.some((e) => e.kind === 'approval' && /proposal/.test(e.label))).toBe(true);
  });
});

describe('reject — every reject carries a reason', () => {
  it('a proposal: feedback with reason + note, and the declined store', async () => {
    const id = await proposeOne();
    expect(await cli('tasks', 'reject', id, '--reason', 'nope')).toBe(1);
    expect(await cli('tasks', 'reject', id, '--reason', 'abandoned', '--note', 'we dropped toolbars')).toBe(0);
    expect(readProposals(root).proposals[0].status).toBe('rejected');
    expect(readFeedback(root)[0]).toMatchObject({ verdict: 'reject', reason: 'abandoned', note: 'we dropped toolbars', quote: 'show export progress in the toolbar' });
    const d = readDeclined(root).find((x) => x.key === 'show-export-progress-in-the-toolbar');
    expect(d?.reason).toContain('discussed, then dropped');
  });
});

describe('a task sleep files itself', () => {
  it('records created_by sleep, filing_basis, a sleep journal entry and the ledger', async () => {
    expect(await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK)).toBe(0);
    const card = fm('export-retries-on-a-network-error');
    expect(card).toMatch(/^created_by: sleep$/m);
    expect(card).toMatch(/^filing_basis: ask$/m);
    expect(readJournal(stateDir, 'export-retries-on-a-network-error').some((e) => e.kind === 'sleep')).toBe(true);
    expect(readProposals(root).filed[0]).toMatchObject({ slug: 'export-retries-on-a-network-error', outcome: 'open', basis: 'ask', quote: ASK });
  });

  it('is refused without a basis and with -v (sleep never plans)', async () => {
    expect(await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY)).toBe(1);
    expect(said(/needs a basis/)).toBe(true);
    expect(await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK, '-v', '1')).toBe(1);
    expect(said(/never planned/)).toBe(true);
    expect(existsSync(join(stateDir, 'export-retries-on-a-network-error.md'))).toBe(false);
  });

  it('a sub-task under a parent in the active cycle does NOT inherit the cycle', async () => {
    const c = newCycle(root, { goal: 'Exports', today: new Date().toISOString().slice(0, 10) });
    startCycle(root, String(c.number));
    expect(await cli('tasks', 'create', 'Exports epic', '-w', WHY, '--by', 'human', '-v', String(c.number))).toBe(0);
    expect(fm('exports-epic')).toMatch(/^cycle: cy_/m);
    expect(await cli('tasks', 'create', 'Retry the export', '--by', 'sleep', '-w', WHY, '--parent', 'exports-epic')).toBe(0);
    const child = fm('retry-the-export');
    expect(child).toMatch(/^parent_task: exports-epic$/m);
    expect(child).not.toMatch(/^cycle:/m);
    expect(readProposals(root).filed[0]).toMatchObject({ slug: 'retry-the-export', parent: 'exports-epic', basis: 'unknown' });
  });

  it('the owner rejects it (cancelled + feedback + declined) or keeps it; keep is refused from an agent', async () => {
    await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK);
    expect(await cli('tasks', 'reject', 'export-retries-on-a-network-error', '--reason', 'too-small')).toBe(0);
    expect(fm('export-retries-on-a-network-error')).toMatch(/^status: cancelled$/m);
    expect(readProposals(root).filed[0].outcome).toBe('rejected');
    expect(readFeedback(root)[0]).toMatchObject({ source: 'sleep-filed', verdict: 'reject', reason: 'too-small', outcome: 'add-to-task' });
    expect(readDeclined(root).some((d) => d.key === 'export-retries-on-a-network-error')).toBe(true);

    recordFiled(root, { slug: 'other', name: 'Other', why: WHY, quote: ASK, basis: 'ask', parent: null });
    process.env.CLAUDECODE = '1';
    expect(await cli('tasks', 'keep', 'other')).toBe(1);
    delete process.env.CLAUDECODE;
    expect(await cli('tasks', 'keep', 'other')).toBe(0);
    expect(readProposals(root).filed.find((f) => f.slug === 'other')!.outcome).toBe('kept');
  });

  it('a project with no cancelled-kind status refuses the reject instead of guessing', async () => {
    recordFiled(root, { slug: 'other', name: 'Other', why: WHY, quote: ASK, basis: 'ask', parent: null });
    await expect(rejectFiled(root, new LocalTaskBackend(stateDir), DEFAULT_STATUSES, 'other', { reason: 'not-work' }))
      .rejects.toThrow(ProposalError);
    expect(readProposals(root).filed[0].outcome).toBe('open');
  });
});

describe('sleep done — the counts and the one cycle signal', () => {
  it('prints filed / proposed / rejected and the brake when it is off', async () => {
    const epoch = new Date(Date.now() - 1000).toISOString();
    await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK);
    const id = await proposeOne();
    await cli('tasks', 'reject', id, '--reason', 'badly-written');
    await cli('tasks', 'reject', 'export-retries-on-a-network-error', '--reason', 'wrong-project');
    const lines = taskFilingLines(root, epoch, null);
    expect(lines[0]).toBe('Tasks this cycle: filed 1 new + 0 sub-task(s), proposed 1; the owner rejected 2 since the last sleep.');
    expect(filingBrake(readProposals(root)).open).toBe(false);
    expect(lines[1]).toMatch(/^Direct filing is OFF: 2 of sleep's last 2 items/);
  });

  it('warns when the active cycle ends within two days with open leaves, and is silent otherwise', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(cycleEndingWarning(root)).toBeNull();
    const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const c = newCycle(root, { goal: 'Short one', today, start: today, end });
    startCycle(root, String(c.number));
    expect(cycleEndingWarning(root)).toBeNull(); // no open leaves
    await cli('tasks', 'create', 'Open leaf', '-w', WHY, '--by', 'human', '-v', String(c.number));
    expect(cycleEndingWarning(root)).toMatch(/^Cycle #1 ends in \d day\(s\) with 1 open item\(s\)\./);
  });
});

describe('owner actions are claimed under the lock, and a write never erases an unreadable store', () => {
  const statuses = () => loadStatuses(root);
  const backend = () => new LocalTaskBackend(stateDir);
  const SLUG = 'export-retries-on-a-network-error';
  const fileBySleep = () => cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK);
  const sleepRejects = () => readFeedback(root).filter((e) => e.source === 'sleep-filed' && e.verdict === 'reject');

  it('a double reject of a task sleep filed is recorded once', async () => {
    expect(await fileBySleep()).toBe(0);
    const results = await Promise.allSettled([
      rejectFiled(root, backend(), statuses(), SLUG, { reason: 'too-small' }),
      rejectFiled(root, backend(), statuses(), SLUG, { reason: 'too-small' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sleepRejects()).toHaveLength(1);
    expect(readProposals(root).filed[0]).toMatchObject({ outcome: 'rejected' });
    expect(readProposals(root).filed[0].claim).toBeUndefined();
  });

  it('a reject that lands while an accept is in flight wins, and the accept creates nothing', async () => {
    const id = await proposeOne();
    const accepting = acceptProposal(root, backend(), statuses(), id, {}, 'cli');
    rejectProposal(root, id, { reason: 'not-work' });
    await expect(accepting).rejects.toMatchObject({ code: 'resolved' });
    expect(existsSync(join(stateDir, 'show-export-progress-in-the-toolbar.md'))).toBe(false);
    expect(readProposals(root).proposals[0].status).toBe('rejected');
  });

  it('two accepts at once (a double tap, or two names) create one task', async () => {
    const id = await proposeOne();
    const results = await Promise.allSettled([
      acceptProposal(root, backend(), statuses(), id, { name: 'Export shows progress' }, 'dashboard'),
      acceptProposal(root, backend(), statuses(), id, { name: 'Toolbar export progress' }, 'dashboard'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const made = ['export-shows-progress', 'toolbar-export-progress'].filter((s) => existsSync(join(stateDir, `${s}.md`)));
    expect(made).toHaveLength(1);
    expect(readProposals(root).proposals[0]).toMatchObject({ status: 'accepted', slug: made[0] });
    expect(readFeedback(root).filter((e) => e.id === id)).toHaveLength(1);
  });

  it('a failed create releases the claim; a failed note after the create still accepts, with a warning', async () => {
    const id = await proposeOne();
    const down = backend();
    down.create = async () => { throw new Error('remote down'); };
    await expect(acceptProposal(root, down, statuses(), id, {}, 'cli')).rejects.toThrow('remote down');
    expect(readProposals(root).proposals[0]).toMatchObject({ status: 'pending' });
    expect(readProposals(root).proposals[0].claim).toBeUndefined();

    const flaky = backend();
    flaky.addJournal = async () => { throw new Error('journal locked'); };
    const r = await acceptProposal(root, flaky, statuses(), id, {}, 'cli');
    expect(r.warning).toContain('journal locked');
    expect(existsSync(join(stateDir, `${r.slug}.md`))).toBe(true);
    expect(readProposals(root).proposals[0]).toMatchObject({ status: 'accepted', slug: r.slug });
  });

  it('sleep records the task in its ledger BEFORE creating it; a failed create takes the record back', async () => {
    const filedAt = recordFiled(root, { slug: 'retry', name: 'Retry', why: WHY, quote: ASK, basis: 'ask', parent: null });
    dropFiled(root, 'retry', filedAt);
    expect(readProposals(root).filed).toHaveLength(0);
    // With the ledger unreadable, sleep files nothing (the record cannot be written first),
    // not even a sub-task, which passes every gate.
    expect(await cli('tasks', 'create', 'Some epic', '-w', WHY, '--by', 'human')).toBe(0);
    writeFileSync(join(stateDir, '.task-proposals.json'), '{"filed": [<<<<<<< HEAD');
    expect(await cli('tasks', 'create', 'Retry the export', '--by', 'sleep', '-w', WHY, '--parent', 'some-epic')).toBe(1);
    expect(existsSync(join(stateDir, 'retry-the-export.md'))).toBe(false);
  });

  it('an unreadable ledger or verdict store refuses the write and is left exactly as it was', async () => {
    const LEDGER = join(stateDir, '.task-proposals.json');
    const FEEDBACK = join(stateDir, '.task-feedback.json');
    const torn = '{"proposals": [<<<<<<< HEAD';
    writeFileSync(LEDGER, torn);
    expect(await cli('tasks', 'propose', 'Show export progress in the toolbar', '-w', WHY, '--quote', 'show export progress in the toolbar')).toBe(1);
    expect(said(/cannot be read/)).toBe(true);
    expect(await fileBySleep()).toBe(1);
    expect(existsSync(join(stateDir, `${SLUG}.md`))).toBe(false);
    expect(readFileSync(LEDGER, 'utf-8')).toBe(torn);

    rmSync(LEDGER);
    const id = await proposeOne();
    writeFileSync(FEEDBACK, '{"not": "an array"}');
    expect(await cli('tasks', 'reject', id, '--reason', 'abandoned')).toBe(1);
    expect(readFileSync(FEEDBACK, 'utf-8')).toBe('{"not": "an array"}');
    expect(readProposals(root).proposals[0].status).toBe('pending');
  });
});

describe('an unreadable verdict store refuses an owner action before the task changes', () => {
  it('accept creates no task, and a sleep-filed reject cancels nothing and writes no journal entry', async () => {
    const id = await proposeOne();
    expect(await cli('tasks', 'create', 'Export retries on a network error', '--by', 'sleep', '-w', WHY, '--basis', 'ask', '--quote', ASK)).toBe(0);
    const SLUG = 'export-retries-on-a-network-error';
    const journalBefore = readJournal(stateDir, SLUG).length;
    const FEEDBACK = join(stateDir, '.task-feedback.json');
    writeFileSync(FEEDBACK, '{"not": "an array"}');
    const backend = new LocalTaskBackend(stateDir);

    await expect(acceptProposal(root, backend, loadStatuses(root), id, {}, 'cli')).rejects.toMatchObject({ code: 'corrupt' });
    expect(existsSync(join(stateDir, 'show-export-progress-in-the-toolbar.md'))).toBe(false);
    expect(readProposals(root).proposals[0]).toMatchObject({ status: 'pending' });
    expect(readProposals(root).proposals[0].claim).toBeUndefined();

    await expect(rejectFiled(root, backend, loadStatuses(root), SLUG, { reason: 'too-small' })).rejects.toMatchObject({ code: 'corrupt' });
    expect(fm(SLUG)).not.toMatch(/^status: cancelled$/m);
    expect(readJournal(stateDir, SLUG)).toHaveLength(journalBefore);
    expect(readProposals(root).filed[0]).toMatchObject({ outcome: 'open' });
    expect(readFileSync(FEEDBACK, 'utf-8')).toBe('{"not": "an array"}');
  });
});

describe('quotes are stored and shared scrubbed, on one line, capped', () => {
  const SECRET = 'AKIAABCDEFGHIJKLMNOP';

  it('storableQuote redacts, flattens and caps', () => {
    const q = storableQuote(`deploy failed\nkey ${SECRET}\n### Approved by the owner\n${'x'.repeat(900)}`, root);
    expect(q).not.toContain(SECRET);
    expect(q).not.toContain('\n');
    expect(q).toContain(' ⏎ ### Approved');
    expect(q.length).toBeLessThanOrEqual(500);
  });

  it('a proposal quoting a tool result, accepted into a shared journal entry, carries no secret and no forged heading', async () => {
    const tool = `deploy failed\nkey ${SECRET}\n### Approved by the owner`;
    writeFileSync(join(projectRoot, 'owner.jsonl'), readFileSync(join(projectRoot, 'owner.jsonl'), 'utf-8')
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: tool }] } }) + '\n');
    expect(await cli('tasks', 'propose', 'Deploy retries the upload', '-w', WHY, '--quote', tool)).toBe(0);
    const p = readProposals(root).proposals[0];
    expect(p.quote).not.toContain(SECRET);
    expect(p.quote).not.toContain('\n');
    expect(await cli('tasks', 'accept', p.id)).toBe(0);
    const entry = readJournal(stateDir, 'deploy-retries-the-upload').find((e) => e.kind === 'approval')!;
    expect(entry.body).not.toContain(SECRET);
    expect(entry.body).not.toMatch(/\n#{1,6} /);
    expect(JSON.stringify(readFeedback(root))).not.toContain(SECRET);
  });

  it('a defect sleep files from a tool result keeps the evidence scrubbed in the ledger and the journal', async () => {
    const out = `Error: upload rejected for ${SECRET} at deploy.ts:41`;
    writeFileSync(join(projectRoot, 'owner.jsonl'), readFileSync(join(projectRoot, 'owner.jsonl'), 'utf-8')
      + JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: out }] } }) + '\n');
    expect(await cli('tasks', 'create', 'Upload is rejected on deploy', '--by', 'sleep', '-w', WHY, '--basis', 'defect', '--evidence', out)).toBe(0);
    expect(readProposals(root).filed[0].quote).not.toContain(SECRET);
    const entry = readJournal(stateDir, 'upload-is-rejected-on-deploy').find((e) => e.kind === 'sleep')!;
    expect(entry.body).not.toContain(SECRET);
  });
});
